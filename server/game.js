/* The running game. One Game instance per room, created when the host starts.
 *
 * The server is the referee: it owns the clock, decides when answers are
 * accepted, and is the only place that knows which option is correct while a
 * question is live. Clients are told the minimum they need to render.
 */

import { compactQuestion } from './quizzes.js';

/** Phases a question moves through. */
export const PHASE = {
  LOBBY: 'lobby',
  READING: 'reading', // prompt on screen, media playing, answers not open yet
  ANSWERING: 'answering',
  REVEAL: 'reveal',
  SCOREBOARD: 'scoreboard',
  ENDED: 'ended',
};

// How long the prompt/media sits on screen before answering opens. The host can
// always cut this short, and for a trimmed clip we wait for the clip instead.
const LEAD_IN_NONE_MS = 1500;
const LEAD_IN_IMAGE_MS = 4000;
const LEAD_IN_UNTIMED_MEDIA_MS = 15000;
const LEAD_IN_MAX_MS = 60000;

// Late answers within this window still count — a phone on wifi is not precise.
const LATE_GRACE_MS = 400;

const STREAK_BONUS = 100;
const STREAK_BONUS_CAP = 500;

/** Milliseconds of prompt/media time before the answer pads appear. */
export function leadInFor(question) {
  const media = question.media;
  if (!media) return LEAD_IN_NONE_MS;
  if (media.kind === 'image') return LEAD_IN_IMAGE_MS;

  // Audio or video: if the admin trimmed a clip, play exactly that long.
  if (question.clipEnd != null) {
    const clipMs = (question.clipEnd - question.clipStart) * 1000;
    return Math.min(LEAD_IN_MAX_MS, Math.max(LEAD_IN_NONE_MS, Math.round(clipMs)));
  }
  return LEAD_IN_UNTIMED_MEDIA_MS;
}

/**
 * Kahoot-style scoring: a correct answer is worth full points at t=0 and half
 * at the buzzer, plus a bonus for consecutive correct answers.
 */
export function scoreAnswer({ points, timeLimitMs, elapsedMs, streak }) {
  if (!points) return 0;
  const fraction = Math.min(1, Math.max(0, elapsedMs / timeLimitMs));
  const base = Math.round(points * (1 - fraction / 2));
  const bonus = Math.min(STREAK_BONUS_CAP, Math.max(0, streak - 1) * STREAK_BONUS);
  return base + bonus;
}

export class Game {
  /**
   * @param {object} room   the Room this game belongs to
   * @param {object} quiz   a saved quiz; blank options are stripped here
   * @param {object} hooks  { toHost(event, payload), toPlayers(event, payload),
   *                          toPlayer(player, event, payload) }
   */
  constructor(room, quiz, hooks) {
    this.room = room;
    this.hooks = hooks;
    this.title = quiz.title;
    this.questions = quiz.questions.map(compactQuestion);
    this.index = -1;
    this.phase = PHASE.LOBBY;

    /** @type {Map<string, {optionIndex:number, at:number, correct:boolean, gained:number}>} */
    this.answers = new Map();
    this.openedAt = null;
    this.deadline = null;
    this.timer = null;

    // Score snapshot at the start of the question, so the scoreboard can show
    // how far each player moved.
    this.ranksBefore = new Map();

    for (const player of room.players.values()) {
      player.score = 0;
      player.streak = 0;
    }
  }

  get total() {
    return this.questions.length;
  }

  get current() {
    return this.questions[this.index] ?? null;
  }

  get isLastQuestion() {
    return this.index >= this.total - 1;
  }

  // -------------------------------------------------------------------------
  // Timer plumbing
  // -------------------------------------------------------------------------

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  setTimer(ms, fn) {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  destroy() {
    this.clearTimer();
  }

  // -------------------------------------------------------------------------
  // Views — what each audience is allowed to see
  // -------------------------------------------------------------------------

  /** The host screen renders the media and the answer text, so it gets it all. */
  hostQuestionView() {
    const q = this.current;
    return {
      index: this.index,
      total: this.total,
      prompt: q.prompt,
      media: q.media,
      clipStart: q.clipStart,
      clipEnd: q.clipEnd,
      hideVideo: q.hideVideo,
      timeLimit: q.timeLimit,
      points: q.points,
      options: q.options.map((o) => ({ text: o.text })),
      leadInMs: leadInFor(q),
    };
  }

  /** Players get the option text but never which one is correct. */
  playerQuestionView() {
    const q = this.current;
    return {
      index: this.index,
      total: this.total,
      prompt: q.prompt,
      hasMedia: Boolean(q.media),
      mediaKind: q.media?.kind ?? null,
      optionCount: q.options.length,
      options: q.options.map((o) => ({ text: o.text })),
      timeLimit: q.timeLimit,
      points: q.points,
    };
  }

  leaderboard() {
    return [...this.room.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        streak: p.streak,
        connected: p.connected,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  /** Players who could reasonably be expected to answer right now. */
  activePlayers() {
    return [...this.room.players.values()].filter((p) => p.connected);
  }

  // -------------------------------------------------------------------------
  // Flow
  // -------------------------------------------------------------------------

  start() {
    this.hooks.toHost('game:started', { title: this.title, total: this.total });
    this.hooks.toPlayers('game:started', { title: this.title, total: this.total });
    this.nextQuestion();
  }

  nextQuestion() {
    this.clearTimer();
    this.index += 1;
    if (this.index >= this.total) return this.end();

    this.phase = PHASE.READING;
    this.answers = new Map();
    this.openedAt = null;
    this.deadline = null;
    this.ranksBefore = new Map(this.leaderboard().map((p, i) => [p.id, i + 1]));

    const leadInMs = leadInFor(this.current);
    this.hooks.toHost('game:question', { ...this.hostQuestionView(), phase: PHASE.READING });
    this.hooks.toPlayers('game:question', { ...this.playerQuestionView(), phase: PHASE.READING });

    this.setTimer(leadInMs, () => this.openAnswers());
  }

  openAnswers() {
    if (this.phase !== PHASE.READING) return false;
    this.clearTimer();

    const q = this.current;
    this.phase = PHASE.ANSWERING;
    this.openedAt = Date.now();
    this.deadline = this.openedAt + q.timeLimit * 1000;

    const payload = {
      deadline: this.deadline,
      serverNow: this.openedAt,
      timeLimit: q.timeLimit,
    };
    this.hooks.toHost('game:answers-open', { ...payload, options: q.options.map((o) => ({ text: o.text })) });
    this.hooks.toPlayers('game:answers-open', { ...payload, options: q.options.map((o) => ({ text: o.text })) });

    this.setTimer(q.timeLimit * 1000 + LATE_GRACE_MS, () => this.reveal());
    return true;
  }

  /**
   * Record a player's answer. Returns { ok } or { ok:false, error }.
   * First answer wins — no changing your mind.
   */
  submitAnswer(player, optionIndex) {
    if (this.phase !== PHASE.ANSWERING) return { ok: false, error: 'Answers are closed.' };
    if (this.answers.has(player.id)) return { ok: false, error: 'You already answered.' };

    const at = Date.now();
    if (at > this.deadline + LATE_GRACE_MS) return { ok: false, error: 'Too late.' };

    const q = this.current;
    const index = Number(optionIndex);
    if (!Number.isInteger(index) || index < 0 || index >= q.options.length) {
      return { ok: false, error: 'That is not one of the options.' };
    }

    const correct = index === q.correctIndex;
    // Clamp elapsed time so a late-but-forgiven answer cannot score negatively.
    const elapsedMs = Math.min(Math.max(0, at - this.openedAt), q.timeLimit * 1000);
    const streak = correct ? player.streak + 1 : 0;
    const gained = correct
      ? scoreAnswer({ points: q.points, timeLimitMs: q.timeLimit * 1000, elapsedMs, streak })
      : 0;

    this.answers.set(player.id, { optionIndex: index, at, correct, gained, elapsedMs });
    this.hooks.toHost('game:answer-count', {
      answered: this.answers.size,
      total: this.activePlayers().length,
    });

    // Everyone still connected has answered — no reason to keep waiting.
    if (this.answers.size >= this.activePlayers().length) {
      this.setTimer(600, () => this.reveal());
    }
    return { ok: true, optionIndex: index };
  }

  reveal() {
    if (this.phase !== PHASE.ANSWERING && this.phase !== PHASE.READING) return false;
    this.clearTimer();
    this.phase = PHASE.REVEAL;

    const q = this.current;

    // Apply the scores. Doing it here rather than on submit keeps a question's
    // scoring atomic and makes the leaderboard consistent with the reveal.
    for (const player of this.room.players.values()) {
      const answer = this.answers.get(player.id);
      if (answer?.correct) {
        player.score += answer.gained;
        player.streak += 1;
      } else {
        player.streak = 0;
      }
    }

    const tallies = q.options.map(() => 0);
    for (const answer of this.answers.values()) tallies[answer.optionIndex] += 1;

    const board = this.leaderboard();
    const rankOf = new Map(board.map((p, i) => [p.id, i + 1]));

    this.hooks.toHost('game:reveal', {
      index: this.index,
      total: this.total,
      correctIndex: q.correctIndex,
      correctText: q.options[q.correctIndex].text,
      tallies,
      answered: this.answers.size,
      players: this.activePlayers().length,
      leaderboard: board,
      isLast: this.isLastQuestion,
    });

    for (const player of this.room.players.values()) {
      const answer = this.answers.get(player.id);
      this.hooks.toPlayer(player, 'game:reveal', {
        index: this.index,
        total: this.total,
        answered: Boolean(answer),
        correct: Boolean(answer?.correct),
        yourIndex: answer?.optionIndex ?? null,
        correctIndex: q.correctIndex,
        correctText: q.options[q.correctIndex].text,
        gained: answer?.correct ? answer.gained : 0,
        score: player.score,
        streak: player.streak,
        rank: rankOf.get(player.id) ?? null,
        playerCount: this.room.players.size,
      });
    }
    return true;
  }

  scoreboard() {
    if (this.phase !== PHASE.REVEAL) return false;
    this.clearTimer();
    this.phase = PHASE.SCOREBOARD;

    const board = this.leaderboard();
    this.hooks.toHost('game:scoreboard', {
      index: this.index,
      total: this.total,
      leaderboard: board,
      isLast: this.isLastQuestion,
    });

    board.forEach((entry, i) => {
      const player = this.room.players.get(entry.id);
      if (!player) return;
      const ahead = i > 0 ? board[i - 1] : null;
      this.hooks.toPlayer(player, 'game:scoreboard', {
        rank: i + 1,
        previousRank: this.ranksBefore.get(entry.id) ?? null,
        score: entry.score,
        playerCount: board.length,
        ahead: ahead ? { name: ahead.name, gap: ahead.score - entry.score } : null,
        isLast: this.isLastQuestion,
      });
    });
    return true;
  }

  end() {
    this.clearTimer();
    this.phase = PHASE.ENDED;

    const board = this.leaderboard();
    const podium = board.slice(0, 3);

    this.hooks.toHost('game:ended', { leaderboard: board, podium, total: this.total });
    board.forEach((entry, i) => {
      const player = this.room.players.get(entry.id);
      if (!player) return;
      this.hooks.toPlayer(player, 'game:ended', {
        rank: i + 1,
        score: entry.score,
        playerCount: board.length,
        podium: podium.map((p) => ({ name: p.name, score: p.score })),
      });
    });
    return true;
  }

  /**
   * The host's single "advance" action. What it does depends on where we are,
   * so the host screen only ever needs one forward button.
   */
  advance() {
    switch (this.phase) {
      case PHASE.READING:
        return this.openAnswers();
      case PHASE.ANSWERING:
        return this.reveal();
      case PHASE.REVEAL:
        return this.scoreboard();
      case PHASE.SCOREBOARD:
        this.nextQuestion();
        return true;
      default:
        return false;
    }
  }

  /**
   * Everything a (re)joining player needs to render their current screen.
   * Called on resume, so a refreshed phone lands back where it was.
   */
  stateForPlayer(player) {
    const base = {
      phase: this.phase,
      index: this.index,
      total: this.total,
      score: player.score,
      title: this.title,
    };

    switch (this.phase) {
      case PHASE.READING:
        return { ...base, question: this.playerQuestionView() };
      case PHASE.ANSWERING: {
        const answer = this.answers.get(player.id);
        return {
          ...base,
          question: this.playerQuestionView(),
          deadline: this.deadline,
          serverNow: Date.now(),
          yourIndex: answer?.optionIndex ?? null,
        };
      }
      case PHASE.REVEAL: {
        const answer = this.answers.get(player.id);
        const q = this.current;
        return {
          ...base,
          answered: Boolean(answer),
          correct: Boolean(answer?.correct),
          yourIndex: answer?.optionIndex ?? null,
          correctIndex: q.correctIndex,
          correctText: q.options[q.correctIndex].text,
          gained: answer?.correct ? answer.gained : 0,
          streak: player.streak,
        };
      }
      case PHASE.SCOREBOARD: {
        const board = this.leaderboard();
        const i = board.findIndex((e) => e.id === player.id);
        return {
          ...base,
          rank: i + 1,
          playerCount: board.length,
          ahead: i > 0 ? { name: board[i - 1].name, gap: board[i - 1].score - player.score } : null,
        };
      }
      case PHASE.ENDED: {
        const board = this.leaderboard();
        return {
          ...base,
          rank: board.findIndex((e) => e.id === player.id) + 1,
          playerCount: board.length,
          podium: board.slice(0, 3).map((p) => ({ name: p.name, score: p.score })),
        };
      }
      default:
        return base;
    }
  }
}

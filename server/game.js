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

/** Speed multiplier: 1.0 the instant answers open, 0.5 at the buzzer. */
function speedFactor(elapsedMs, timeLimitMs) {
  return 1 - Math.min(1, Math.max(0, elapsedMs / timeLimitMs)) / 2;
}

/**
 * Scores one submission, single- or multi-answer.
 *
 * A question's points are split evenly across its correct options. Each correct
 * option picked earns its share, scaled by how fast the answer came in. Each
 * wrong option picked costs one full share, unscaled — so picking one right and
 * one wrong always nets zero, however quickly you did it. A question can never
 * score below zero.
 *
 * The streak bonus needs full marks: every correct option and no wrong ones.
 */
export function scoreSelection({
  points,
  timeLimitMs,
  elapsedMs,
  correctCount,
  chosenCorrect,
  chosenWrong,
  streak,
}) {
  if (!points || correctCount <= 0) return 0;

  const share = points / correctCount;
  const credit = chosenCorrect * share * speedFactor(elapsedMs, timeLimitMs);
  const penalty = chosenWrong * share;
  const earned = Math.max(0, Math.round(credit - penalty));

  const fullMarks = chosenCorrect === correctCount && chosenWrong === 0;
  const bonus = fullMarks
    ? Math.min(STREAK_BONUS_CAP, Math.max(0, streak - 1) * STREAK_BONUS)
    : 0;

  return earned + bonus;
}

/** The single-answer case: one correct option, picked or not. */
export function scoreAnswer({ points, timeLimitMs, elapsedMs, streak }) {
  return scoreSelection({
    points,
    timeLimitMs,
    elapsedMs,
    correctCount: 1,
    chosenCorrect: 1,
    chosenWrong: 0,
    streak,
  });
}

/**
 * Turns whatever a client sent into a clean, de-duplicated list of option
 * indexes. Returns null if anything about it is wrong.
 */
function normaliseSelection(selection, optionCount) {
  const raw = Array.isArray(selection) ? selection : [selection];
  if (raw.length === 0 || raw.length > optionCount) return null;

  const indexes = new Set();
  for (const value of raw) {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= optionCount) return null;
    indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
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
      multiSelect: q.multiSelect,
      leadInMs: leadInFor(q),
    };
  }

  /**
   * Players get the option text but never which ones are correct — and not how
   * many are correct either, since the host screen is in the room with them.
   */
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
      multiSelect: q.multiSelect,
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
   * First submission wins — no changing your mind.
   *
   * `selection` is an option index, or an array of them on a multi-answer
   * question. Both forms are accepted either way round, so an older client
   * sending a bare number still works.
   */
  submitAnswer(player, selection) {
    if (this.phase !== PHASE.ANSWERING) return { ok: false, error: 'Answers are closed.' };
    if (this.answers.has(player.id)) return { ok: false, error: 'You already answered.' };

    const at = Date.now();
    if (at > this.deadline + LATE_GRACE_MS) return { ok: false, error: 'Too late.' };

    const q = this.current;
    const indexes = normaliseSelection(selection, q.options.length);
    if (!indexes) return { ok: false, error: 'That is not one of the options.' };
    if (!q.multiSelect && indexes.length > 1) {
      return { ok: false, error: 'Pick one answer.' };
    }

    const correct = new Set(q.correctIndexes);
    const chosenCorrect = indexes.filter((i) => correct.has(i)).length;
    const chosenWrong = indexes.length - chosenCorrect;
    const fullMarks = chosenCorrect === correct.size && chosenWrong === 0;

    // Clamp elapsed time so a late-but-forgiven answer cannot score negatively.
    const elapsedMs = Math.min(Math.max(0, at - this.openedAt), q.timeLimit * 1000);
    const gained = scoreSelection({
      points: q.points,
      timeLimitMs: q.timeLimit * 1000,
      elapsedMs,
      correctCount: correct.size,
      chosenCorrect,
      chosenWrong,
      streak: fullMarks ? player.streak + 1 : 0,
    });

    this.answers.set(player.id, { indexes, at, fullMarks, gained, elapsedMs });
    this.hooks.toHost('game:answer-count', {
      answered: this.answers.size,
      total: this.activePlayers().length,
    });

    // Everyone still connected has answered — no reason to keep waiting.
    if (this.answers.size >= this.activePlayers().length) {
      this.setTimer(600, () => this.reveal());
    }
    return { ok: true, indexes };
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
      player.score += answer?.gained ?? 0;
      // A streak means getting the whole question right, blanks included.
      player.streak = answer?.fullMarks ? player.streak + 1 : 0;
    }

    // With multi-select these count picks, not players, so they can exceed the
    // number of people who answered.
    const tallies = q.options.map(() => 0);
    for (const answer of this.answers.values()) {
      for (const index of answer.indexes) tallies[index] += 1;
    }

    const board = this.leaderboard();
    const rankOf = new Map(board.map((p, i) => [p.id, i + 1]));
    const correctTexts = q.correctIndexes.map((i) => q.options[i].text);

    this.hooks.toHost('game:reveal', {
      index: this.index,
      total: this.total,
      multiSelect: q.multiSelect,
      correctIndexes: q.correctIndexes,
      correctTexts,
      correctText: correctTexts.join(' · '),
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
        multiSelect: q.multiSelect,
        answered: Boolean(answer),
        correct: Boolean(answer?.fullMarks),
        partial: Boolean(answer) && !answer.fullMarks && answer.gained > 0,
        yourIndexes: answer?.indexes ?? [],
        correctIndexes: q.correctIndexes,
        correctTexts,
        correctText: correctTexts.join(' · '),
        gained: answer?.gained ?? 0,
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
          yourIndexes: answer?.indexes ?? null,
        };
      }
      case PHASE.REVEAL: {
        const answer = this.answers.get(player.id);
        const q = this.current;
        const correctTexts = q.correctIndexes.map((i) => q.options[i].text);
        return {
          ...base,
          multiSelect: q.multiSelect,
          answered: Boolean(answer),
          correct: Boolean(answer?.fullMarks),
          partial: Boolean(answer) && !answer.fullMarks && answer.gained > 0,
          yourIndexes: answer?.indexes ?? [],
          correctIndexes: q.correctIndexes,
          correctTexts,
          correctText: correctTexts.join(' · '),
          gained: answer?.gained ?? 0,
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

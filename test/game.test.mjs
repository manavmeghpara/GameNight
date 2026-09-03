import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { io } from 'socket.io-client';

import { leadInFor, scoreAnswer, scoreSelection } from '../server/game.js';

const PORT = 3102;
const URL = `http://localhost:${PORT}`;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

for (let i = 0; i < 50; i++) {
  try {
    await fetch(`${URL}/api/info`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}

let pass = 0,
  fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${extra}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (s, ev, p = {}) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout on ${ev}`)), 5000);
    s.emit(ev, p, (r) => {
      clearTimeout(t);
      res(r ?? {});
    });
  });
const wait = (s, ev, ms = 5000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no event ${ev}`)), ms);
    s.once(ev, (d) => {
      clearTimeout(t);
      res(d ?? true);
    });
  });

const send = async (method, p, body) => {
  const res = await fetch(URL + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// ===========================================================================
// Pure functions first — no sockets involved
// ===========================================================================

console.log('\n-- scoring --');

check('instant correct answer scores full points',
  scoreAnswer({ points: 1000, timeLimitMs: 20000, elapsedMs: 0, streak: 1 }) === 1000);
check('answer at the buzzer scores half',
  scoreAnswer({ points: 1000, timeLimitMs: 20000, elapsedMs: 20000, streak: 1 }) === 500);
check('halfway through scores 75%',
  scoreAnswer({ points: 1000, timeLimitMs: 20000, elapsedMs: 10000, streak: 1 }) === 750);
check('faster always beats slower',
  scoreAnswer({ points: 1000, timeLimitMs: 20000, elapsedMs: 3000, streak: 1 }) >
    scoreAnswer({ points: 1000, timeLimitMs: 20000, elapsedMs: 9000, streak: 1 }));
check('a zero-point question scores nothing',
  scoreAnswer({ points: 0, timeLimitMs: 20000, elapsedMs: 0, streak: 4 }) === 0);
check('second in a row adds a 100 bonus',
  scoreAnswer({ points: 1000, timeLimitMs: 20000, elapsedMs: 0, streak: 2 }) === 1100);
check('streak bonus caps at 500',
  scoreAnswer({ points: 1000, timeLimitMs: 20000, elapsedMs: 0, streak: 99 }) === 1500);
check('double points question doubles the base',
  scoreAnswer({ points: 2000, timeLimitMs: 20000, elapsedMs: 0, streak: 1 }) === 2000);

console.log('\n-- multi-answer scoring --');

// A 1000-point question with 2 correct options: each share is worth 500.
const two = (chosenCorrect, chosenWrong, elapsedMs = 0, streak = 1) =>
  scoreSelection({ points: 1000, timeLimitMs: 20000, elapsedMs, correctCount: 2, chosenCorrect, chosenWrong, streak });

check('both correct, instantly, scores the full points', two(2, 0) === 1000, String(two(2, 0)));
check('one of two correct scores half the points', two(1, 0) === 500, String(two(1, 0)));
check('one correct and one wrong nets zero', two(1, 1) === 0, String(two(1, 1)));
check('one correct and one wrong is still zero when slow',
  two(1, 1, 20000) === 0, String(two(1, 1, 20000)));
check('both correct plus a wrong pick loses one share',
  two(2, 1) === 500, String(two(2, 1)));
check('only wrong picks score zero, never negative', two(0, 2) === 0, String(two(0, 2)));
check('answering nothing scores zero', two(0, 0) === 0, String(two(0, 0)));

// The worked example: 1000 points, 4 correct (share 250), 3 right + 1 wrong,
// halfway through the timer. Credit is speed-scaled, the penalty is flat:
//   credit  = 3 x 250 x 0.75 = 562.5
//   penalty = 1 x 250        = 250
//   net     = 312.5          -> 313
const four = scoreSelection({
  points: 1000, timeLimitMs: 20000, elapsedMs: 10000,
  correctCount: 4, chosenCorrect: 3, chosenWrong: 1, streak: 1,
});
check('3 of 4 correct plus a wrong pick, at half time, scores 313', four === 313, String(four));

check('speed still separates two identical selections',
  two(2, 0, 2000) > two(2, 0, 8000), `${two(2, 0, 2000)} vs ${two(2, 0, 8000)}`);
check('full marks earns the streak bonus', two(2, 0, 0, 3) === 1200, String(two(2, 0, 0, 3)));
check('partial credit earns no streak bonus', two(1, 0, 0, 3) === 500, String(two(1, 0, 0, 3)));
check('a wrong pick forfeits the streak bonus even with all correct',
  two(2, 1, 0, 5) === 500, String(two(2, 1, 0, 5)));
check('a zero-point multi question stays at zero',
  scoreSelection({ points: 0, timeLimitMs: 20000, elapsedMs: 0, correctCount: 2, chosenCorrect: 2, chosenWrong: 0, streak: 3 }) === 0);
check('an odd split rounds sensibly',
  scoreSelection({ points: 1000, timeLimitMs: 20000, elapsedMs: 0, correctCount: 3, chosenCorrect: 3, chosenWrong: 0, streak: 1 }) === 1000);

console.log('\n-- lead-in timing --');

check('no media opens answers almost at once', leadInFor({ media: null }) === 1500);
check('an image gets a few seconds', leadInFor({ media: { kind: 'image' } }) === 4000);
check('a trimmed clip waits exactly the clip length',
  leadInFor({ media: { kind: 'audio' }, clipStart: 10, clipEnd: 22 }) === 12000);
check('an untrimmed clip uses the default',
  leadInFor({ media: { kind: 'video' }, clipStart: 0, clipEnd: null }) === 15000);
check('a very long clip is capped',
  leadInFor({ media: { kind: 'video' }, clipStart: 0, clipEnd: 600 }) === 60000);

// ===========================================================================
// A real game over sockets
// ===========================================================================

console.log('\n-- a played game --');

// Build a two-question quiz: 3 options then 2, with different point values.
const made = await send('POST', '/api/quizzes', { title: 'Engine Test Quiz' });
const quizId = made.body.quiz.id;
const quiz = {
  ...made.body.quiz,
  questions: [
    {
      id: 'a'.repeat(16),
      prompt: 'Which shark movie?',
      media: null,
      clipStart: 0,
      clipEnd: null,
      hideVideo: false,
      timeLimit: 5,
      points: 1000,
      options: [
        { id: '1'.repeat(16), text: 'Jaws' },
        { id: '2'.repeat(16), text: 'Alien' },
        { id: '3'.repeat(16), text: 'The Thing' },
      ],
      correctIndexes: [0],
    },
    {
      id: 'b'.repeat(16),
      prompt: 'Directed by Spielberg?',
      media: null,
      clipStart: 0,
      clipEnd: null,
      hideVideo: false,
      timeLimit: 5,
      points: 2000,
      options: [
        { id: '4'.repeat(16), text: 'Yes' },
        { id: '5'.repeat(16), text: 'No' },
      ],
      correctIndexes: [0],
    },
  ],
};
const savedQuiz = await send('PUT', `/api/quizzes/${quizId}`, { quiz });
check('test quiz is playable', savedQuiz.body.problems.length === 0, JSON.stringify(savedQuiz.body.problems));

const host = io(URL);
await wait(host, 'connect');
const room = await ask(host, 'host:create');
const code = room.code;

async function joinPlayer(name) {
  const s = io(URL);
  await wait(s, 'connect');
  const reply = await ask(s, 'player:join', { code, name });
  return { socket: s, id: reply.playerId, name };
}

const fast = await joinPlayer('Fast');
const slow = await joinPlayer('Slow');
const wrong = await joinPlayer('Wrong');
const silent = await joinPlayer('Silent');

// --- guard rails before starting -------------------------------------------

const notReady = await ask(host, 'host:start', { quizId: 'ffffffffffffffff' });
check('unknown quiz cannot start a game', !notReady.ok, JSON.stringify(notReady));

const blank = await send('POST', '/api/quizzes', { title: 'Blank' });
const blankStart = await ask(host, 'host:start', { quizId: blank.body.quiz.id });
check('an unfinished quiz is refused', !blankStart.ok && Array.isArray(blankStart.problems), JSON.stringify(blankStart));

const playerStart = await ask(fast.socket, 'host:start', { quizId });
check('a player cannot start the game', !playerStart.ok, JSON.stringify(playerStart));

const earlyAnswer = await ask(fast.socket, 'player:answer', { optionIndex: 0 });
check('cannot answer before the game starts', !earlyAnswer.ok, JSON.stringify(earlyAnswer));

// --- question 1 --------------------------------------------------------------

const hostQ1 = wait(host, 'game:question');
const playerQ1 = wait(fast.socket, 'game:question');
const started = await ask(host, 'host:start', { quizId });
check('host starts the game', started.ok && started.total === 2, JSON.stringify(started));

const hq1 = await hostQ1;
const pq1 = await playerQ1;
check('host sees the full question', hq1.prompt === 'Which shark movie?' && hq1.options.length === 3);
check('host is told the time limit and points', hq1.timeLimit === 5 && hq1.points === 1000);
check('player sees the prompt and options', pq1.prompt === 'Which shark movie?' && pq1.options.length === 3);
check('player is NOT told the correct answer',
  !JSON.stringify(pq1).includes('correctIndex'), JSON.stringify(pq1));
check('question starts in the reading phase', pq1.phase === 'reading');

const tooEarly = await ask(fast.socket, 'player:answer', { optionIndex: 0 });
check('cannot answer during the reading phase', !tooEarly.ok, JSON.stringify(tooEarly));

// Host cuts the lead-in short.
const openedHost = wait(host, 'game:answers-open');
const openedPlayer = wait(fast.socket, 'game:answers-open');
await ask(host, 'host:advance');
const open = await openedHost;
await openedPlayer;
check('answers open with a deadline', open.deadline > open.serverNow, JSON.stringify(open));
check('deadline matches the time limit',
  Math.abs(open.deadline - open.serverNow - 5000) < 50, String(open.deadline - open.serverNow));

// Fast answers immediately, slow waits, wrong picks a wrong option.
const fastReply = await ask(fast.socket, 'player:answer', { optionIndex: 0 });
check('fast answer accepted', fastReply.ok, JSON.stringify(fastReply));

const doubleAnswer = await ask(fast.socket, 'player:answer', { optionIndex: 1 });
check('cannot change your answer', !doubleAnswer.ok && /already/.test(doubleAnswer.error), JSON.stringify(doubleAnswer));

const outOfRange = await ask(wrong.socket, 'player:answer', { optionIndex: 99 });
check('out-of-range option refused', !outOfRange.ok, JSON.stringify(outOfRange));

const negative = await ask(wrong.socket, 'player:answer', { optionIndex: -1 });
check('negative option refused', !negative.ok, JSON.stringify(negative));

const notANumber = await ask(wrong.socket, 'player:answer', { optionIndex: '0; DROP' });
check('non-numeric option refused', !notANumber.ok, JSON.stringify(notANumber));

await ask(wrong.socket, 'player:answer', { optionIndex: 1 }); // wrong answer
await sleep(2000);
await ask(slow.socket, 'player:answer', { optionIndex: 0 }); // correct, but late
// 'silent' never answers.

const hostReveal = wait(host, 'game:reveal');
const fastReveal = wait(fast.socket, 'game:reveal');
const silentReveal = wait(silent.socket, 'game:reveal');
await ask(host, 'host:advance'); // close answers early
const hr1 = await hostReveal;
const fr1 = await fastReveal;
const sr1 = await silentReveal;

check('reveal names the correct answer',
  JSON.stringify(hr1.correctIndexes) === '[0]' && hr1.correctText === 'Jaws');
check('reveal tallies each option', JSON.stringify(hr1.tallies) === JSON.stringify([2, 1, 0]), JSON.stringify(hr1.tallies));
check('reveal counts who answered', hr1.answered === 3 && hr1.players === 4, `${hr1.answered}/${hr1.players}`);
check('correct player is told so', fr1.correct === true && fr1.gained > 0, JSON.stringify(fr1));
check('non-answerer gets zero', sr1.answered === false && sr1.gained === 0 && sr1.score === 0, JSON.stringify(sr1));

const board1 = hr1.leaderboard;
const scoreOf = (b, name) => b.find((p) => p.name === name)?.score;
check('fast beats slow on the same answer',
  scoreOf(board1, 'Fast') > scoreOf(board1, 'Slow'), JSON.stringify(board1));
check('wrong answer scores nothing', scoreOf(board1, 'Wrong') === 0);
check('slow but correct still scores', scoreOf(board1, 'Slow') > 0);
check('leaderboard is sorted by score', board1[0].name === 'Fast', JSON.stringify(board1));

// --- scoreboard --------------------------------------------------------------

const hostBoard = wait(host, 'game:scoreboard');
const slowBoard = wait(slow.socket, 'game:scoreboard');
await ask(host, 'host:advance');
const hb = await hostBoard;
const sb = await slowBoard;
check('host gets the scoreboard', hb.leaderboard.length === 4 && hb.isLast === false);
check('player is told their rank', sb.rank >= 1 && sb.rank <= 4, JSON.stringify(sb));
check('player is told who is ahead', sb.ahead?.name === 'Fast' && sb.ahead.gap > 0, JSON.stringify(sb.ahead));

// --- question 2: the streak bonus -------------------------------------------

const hostQ2 = wait(host, 'game:question');
await ask(host, 'host:advance');
const hq2 = await hostQ2;
check('advances to question 2', hq2.index === 1 && hq2.options.length === 2, JSON.stringify({ i: hq2.index }));

const scoreBeforeQ2 = scoreOf(board1, 'Fast');
// Question 2 has no media, so the short lead-in opens answers on its own.
await wait(fast.socket, 'game:answers-open', 6000);
check('answers open by themselves after the lead-in', true);

await ask(fast.socket, 'player:answer', { optionIndex: 0 }); // correct again -> streak 2
await ask(slow.socket, 'player:answer', { optionIndex: 1 }); // wrong -> streak broken

const hostReveal2 = wait(host, 'game:reveal');
const fastReveal2 = wait(fast.socket, 'game:reveal');
await ask(host, 'host:advance');
const hr2 = await hostReveal2;
const fr2 = await fastReveal2;

check('second correct in a row sets streak 2', fr2.streak === 2, String(fr2.streak));
check('streak bonus is included', fr2.gained > 2000, String(fr2.gained));
check('score accumulates across questions', fr2.score === scoreBeforeQ2 + fr2.gained, `${fr2.score} vs ${scoreBeforeQ2}+${fr2.gained}`);
check('a wrong answer resets the streak',
  hr2.leaderboard.find((p) => p.name === 'Slow')?.streak === 0, JSON.stringify(hr2.leaderboard));
check('reveal knows it is the last question', hr2.isLast === true);

// --- ending ------------------------------------------------------------------

await ask(host, 'host:advance'); // reveal -> scoreboard
const hostEnd = wait(host, 'game:ended');
const fastEnd = wait(fast.socket, 'game:ended');
await ask(host, 'host:advance'); // scoreboard -> ended
const he = await hostEnd;
const fe = await fastEnd;

check('game ends with a podium', he.podium.length === 3, JSON.stringify(he.podium));
check('podium is the top three', he.podium[0].name === 'Fast');
check('winner is told they are first', fe.rank === 1, JSON.stringify(fe));
check('final scores match the leaderboard', fe.score === he.leaderboard[0].score);

const afterEnd = await ask(fast.socket, 'player:answer', { optionIndex: 0 });
check('cannot answer after the game ends', !afterEnd.ok, JSON.stringify(afterEnd));

// --- rematch -----------------------------------------------------------------

const resetNotice = wait(fast.socket, 'game:reset');
await ask(host, 'host:reset');
await resetNotice;
const rejoinable = await ask(host, 'host:start', { quizId });
check('host can start again after a reset', rejoinable.ok, JSON.stringify(rejoinable));

// --- mid-game reconnect ------------------------------------------------------

await wait(fast.socket, 'game:answers-open', 6000);
await ask(fast.socket, 'player:answer', { optionIndex: 0 });

fast.socket.disconnect();
await sleep(200);
const fastAgain = io(URL);
await wait(fastAgain, 'connect');
const resumed = await ask(fastAgain, 'player:resume', { code, playerId: fast.id });
check('mid-game resume returns game state', resumed.ok && resumed.state.game?.phase === 'answering', JSON.stringify(resumed.state?.game).slice(0, 160));
check('resumed player sees their own answer',
  JSON.stringify(resumed.state.game.yourIndexes) === '[0]', JSON.stringify(resumed.state.game.yourIndexes));
check('resumed state does not leak the answer',
  !JSON.stringify(resumed.state.game).includes('correctIndex'),
  JSON.stringify(Object.keys(resumed.state.game)));

// --- joining a game in progress ----------------------------------------------

const latecomer = io(URL);
await wait(latecomer, 'connect');
const lateJoin = await ask(latecomer, 'player:join', { code, name: 'Latecomer' });
check('cannot join a game already in progress', !lateJoin.ok && /already started/.test(lateJoin.error), JSON.stringify(lateJoin));

// --- auto-close when the timer runs out --------------------------------------

const autoReveal = wait(host, 'game:reveal', 8000);
await autoReveal;
check('the question closes itself when time runs out', true);

// ===========================================================================
console.log('\n-- a multi-answer question --');
// ===========================================================================

await ask(host, 'host:reset');

const multiMade = await send('POST', '/api/quizzes', { title: 'Multi Test' });
const multiId = multiMade.body.quiz.id;
const multiSave = await send('PUT', `/api/quizzes/${multiId}`, {
  quiz: {
    ...multiMade.body.quiz,
    title: 'Multi Test',
    questions: [
      {
        id: 'c'.repeat(16),
        prompt: 'Which of these did Spielberg direct?',
        media: null, clipStart: 0, clipEnd: null, hideVideo: false,
        timeLimit: 5,
        points: 1000,
        options: [
          { id: '6'.repeat(16), text: 'Jaws' },
          { id: '7'.repeat(16), text: 'E.T.' },
          { id: '8'.repeat(16), text: 'Alien' },
          { id: '9'.repeat(16), text: 'The Thing' },
        ],
        multiSelect: true,
        correctIndexes: [0, 1],
      },
    ],
  },
});
check('a multi-answer quiz is playable', multiSave.body.problems.length === 0, JSON.stringify(multiSave.body.problems));
check('multiSelect survives saving', multiSave.body.quiz.questions[0].multiSelect === true);
check('both correct answers survive saving',
  JSON.stringify(multiSave.body.quiz.questions[0].correctIndexes) === '[0,1]',
  JSON.stringify(multiSave.body.quiz.questions[0].correctIndexes));

// Every option marked correct is refused — there would be nothing to get wrong.
const allCorrect = await send('PUT', `/api/quizzes/${multiId}`, {
  quiz: {
    title: 'All correct',
    questions: [{
      prompt: 'Pick them all', options: [{ text: 'A' }, { text: 'B' }],
      multiSelect: true, correctIndexes: [0, 1],
    }],
  },
});
check('a question where every option is correct is flagged',
  allCorrect.body.problems.some((p) => /every option/i.test(p)), JSON.stringify(allCorrect.body.problems));
await send('PUT', `/api/quizzes/${multiId}`, { quiz: multiSave.body.quiz });

const mPerfect = await joinPlayer('Perfect');
const mPartial = await joinPlayer('Partial');
const mMixed = await joinPlayer('Mixed');

const mQuestion = wait(mPerfect.socket, 'game:question');
await ask(host, 'host:start', { quizId: multiId });
const mq = await mQuestion;
check('player is told it is a multi-answer question', mq.multiSelect === true, JSON.stringify(mq.multiSelect));
check('player is not told how many are correct',
  !JSON.stringify(mq).includes('correctCount') && !JSON.stringify(mq).includes('correctIndex'), JSON.stringify(mq));

await wait(mPerfect.socket, 'game:answers-open', 6000);

const perfectReply = await ask(mPerfect.socket, 'player:answer', { indexes: [0, 1] });
check('a multi selection is accepted', perfectReply.ok, JSON.stringify(perfectReply));
check('the accepted selection is echoed back',
  JSON.stringify(perfectReply.indexes) === '[0,1]', JSON.stringify(perfectReply.indexes));

const dupeIndexes = await ask(mPartial.socket, 'player:answer', { indexes: [0, 0, 0] });
check('duplicate indexes collapse to one', dupeIndexes.ok && JSON.stringify(dupeIndexes.indexes) === '[0]',
  JSON.stringify(dupeIndexes));

const badMulti = await ask(mMixed.socket, 'player:answer', { indexes: [0, 99] });
check('a selection containing a bad index is refused', !badMulti.ok, JSON.stringify(badMulti));

const emptyMulti = await ask(mMixed.socket, 'player:answer', { indexes: [] });
check('an empty selection is refused', !emptyMulti.ok, JSON.stringify(emptyMulti));

await ask(mMixed.socket, 'player:answer', { indexes: [0, 2] }); // one right, one wrong

const mReveal = wait(host, 'game:reveal');
const perfectReveal = wait(mPerfect.socket, 'game:reveal');
const partialReveal = wait(mPartial.socket, 'game:reveal');
const mixedReveal = wait(mMixed.socket, 'game:reveal');
await ask(host, 'host:advance');
const mr = await mReveal;
const pr = await perfectReveal;
const par = await partialReveal;
const mir = await mixedReveal;

check('reveal lists every correct answer',
  JSON.stringify(mr.correctIndexes) === '[0,1]', JSON.stringify(mr.correctIndexes));
check('reveal names every correct answer',
  JSON.stringify(mr.correctTexts) === '["Jaws","E.T."]', JSON.stringify(mr.correctTexts));
check('tallies count picks, not players',
  JSON.stringify(mr.tallies) === '[3,1,1,0]', JSON.stringify(mr.tallies));

// Scores here are speed-scaled against a real 5s clock, so allow for the few
// milliseconds of latency between answers-open and the answer landing.
const near = (actual, expected) => Math.abs(actual - expected) <= expected * 0.02;

check('full marks reads as correct', pr.correct === true && pr.partial === false, JSON.stringify(pr));
check('full marks scores the whole question', near(pr.gained, 1000), String(pr.gained));
check('full marks advances the streak', pr.streak === 1, String(pr.streak));

check('half the answers reads as partial', par.correct === false && par.partial === true, JSON.stringify(par));
check('half the answers scores half', near(par.gained, 500), String(par.gained));
check('partial credit does not advance the streak', par.streak === 0, String(par.streak));

check('one right and one wrong scores zero', mir.gained === 0, String(mir.gained));
check('one right and one wrong is not partial', mir.partial === false, JSON.stringify(mir));
check('the player sees their own selection',
  JSON.stringify(mir.yourIndexes) === '[0,2]', JSON.stringify(mir.yourIndexes));

const mBoard = mr.leaderboard;
check('perfect beats partial beats mixed',
  mBoard[0].name === 'Perfect' &&
  near(mBoard[0].score, 1000) &&
  near(mBoard.find((p) => p.name === 'Partial').score, 500) &&
  mBoard.find((p) => p.name === 'Mixed').score === 0,
  JSON.stringify(mBoard.map((p) => `${p.name}:${p.score}`)));

// A single-answer question must still refuse a multi selection.
await ask(host, 'host:reset');
await ask(host, 'host:start', { quizId });
await wait(mPerfect.socket, 'game:answers-open', 6000);
const multiOnSingle = await ask(mPerfect.socket, 'player:answer', { indexes: [0, 1] });
check('a single-answer question refuses multiple picks',
  !multiOnSingle.ok && /one answer/i.test(multiOnSingle.error), JSON.stringify(multiOnSingle));
const singleStillWorks = await ask(mPartial.socket, 'player:answer', { optionIndex: 0 });
check('a single-answer question still accepts one pick', singleStillWorks.ok, JSON.stringify(singleStillWorks));

// --- cleanup -----------------------------------------------------------------

await ask(host, 'host:close');
await send('DELETE', `/api/quizzes/${multiId}`);
for (const s of [mPerfect.socket, mPartial.socket, mMixed.socket]) s.close();
await send('DELETE', `/api/quizzes/${quizId}`);
await send('DELETE', `/api/quizzes/${blank.body.quiz.id}`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
for (const s of [host, fast.socket, fastAgain, slow.socket, wrong.socket, silent.socket, latecomer]) s.close();
server.kill();
process.exit(fail ? 1 : 0);

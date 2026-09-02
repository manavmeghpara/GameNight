/* Drives the real host and player scripts through a whole game inside jsdom,
   with a fake socket, and asserts on the DOM they produce. Catches the render
   bugs the server-side tests cannot see. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

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

/** A stand-in for socket.io's client: records emits, lets tests fire events. */
function fakeSocket() {
  const handlers = new Map();
  const sent = [];
  return {
    sent,
    on(event, fn) {
      handlers.set(event, fn);
    },
    once(event, fn) {
      handlers.set(event, fn);
    },
    emit(event, payload, ack) {
      sent.push({ event, payload });
      // Acknowledge the handshakes the page waits on.
      if (event === 'host:create') ack?.({ ok: true, code: 'TEST', hostToken: 't', players: [] });
      else if (event === 'player:join') {
        ack?.({
          ok: true,
          playerId: 'p1',
          state: { code: 'TEST', phase: 'lobby', player: { name: 'Sofia' }, playerCount: 1, game: null },
        });
      } else ack?.({ ok: true });
    },
    fire(event, payload) {
      const fn = handlers.get(event);
      if (!fn) throw new Error(`page never subscribed to "${event}"`);
      fn(payload);
    },
    has: (event) => handlers.has(event),
  };
}

/** Loads one of our pages into jsdom with its scripts executed. */
async function loadPage(file, scripts) {
  const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');

  // jsdom has no media pipeline; play()/pause()/load() log "not implemented"
  // noise we do not care about. Everything else still reaches the console.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    if (!/Not implemented: HTMLMediaElement/.test(err.message)) console.error(err.message);
  });
  virtualConsole.on('error', (...args) => console.error(...args));

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    // The host page only swaps in the LAN address when served from localhost.
    url: `http://localhost:3000/${file}`,
    virtualConsole,
  });
  const { window } = dom;

  const socket = fakeSocket();
  window.io = () => socket;
  window.fetch = async (url) => ({
    ok: true,
    json: async () =>
      url.includes('/api/info')
        ? { port: 3000, addresses: ['192.168.1.5'] }
        : { quizzes: [{ id: 'a'.repeat(16), title: 'Movies', questionCount: 2, updatedAt: Date.now(), problems: 0 }] },
  });
  window.confirm = () => true;
  window.alert = () => {};

  // One eval for all of them: top-level `const` inside an eval is scoped to
  // that eval call, so separate calls would not see each other's bindings.
  window.eval(
    scripts.map((s) => fs.readFileSync(path.join(PUBLIC, 'js', s), 'utf8')).join('\n;\n'),
  );
  // Let the connect handler and any fetch chains settle.
  socket.fire('connect');
  await new Promise((r) => setTimeout(r, 30));

  return { window, doc: window.document, socket };
}

const visible = (doc, id) => !doc.getElementById(id).classList.contains('hidden');
const text = (doc, id) => doc.getElementById(id).textContent.trim();
const shownScreen = (doc, ids) => ids.find((id) => visible(doc, id)) ?? '(none)';

const PLAYER_SCREENS = [
  'screen-join',
  'screen-wait',
  'screen-ready',
  'screen-answer',
  'screen-result',
  'screen-board',
  'screen-final',
  'screen-over',
];
const HOST_SCREENS = ['screen-idle', 'screen-lobby', 'screen-game', 'screen-board', 'screen-podium'];

const QUESTION = {
  index: 0,
  total: 2,
  prompt: 'Which shark movie?',
  media: null,
  clipStart: 0,
  clipEnd: null,
  hideVideo: false,
  timeLimit: 20,
  points: 1000,
  options: [{ text: 'Jaws' }, { text: 'Alien' }, { text: 'The Thing' }],
  leadInMs: 1500,
};
const OPTIONS = QUESTION.options;

// ===========================================================================
console.log('\n-- player screens --');
// ===========================================================================
{
  const { doc, socket, window } = await loadPage('index.html', [
    'common.js',
    'shapes.js',
    'pads.js',
    'join.js',
  ]);

  check('player starts on the join form', shownScreen(doc, PLAYER_SCREENS) === 'screen-join');

  // Join.
  doc.getElementById('code').value = 'TEST';
  doc.getElementById('name').value = 'Sofia';
  doc.getElementById('join-form').dispatchEvent(new window.Event('submit'));
  await new Promise((r) => setTimeout(r, 20));
  check('joining moves to the waiting room', shownScreen(doc, PLAYER_SCREENS) === 'screen-wait',
    shownScreen(doc, PLAYER_SCREENS));
  check('waiting room shows the nickname', text(doc, 'wait-name') === 'Sofia');

  // Question opens in the reading phase.
  socket.fire('game:question', {
    index: 0,
    total: 2,
    prompt: 'Which shark movie?',
    hasMedia: true,
    mediaKind: 'video',
    optionCount: 3,
    options: OPTIONS,
    timeLimit: 20,
    points: 1000,
    phase: 'reading',
  });
  check('reading phase shows the get-ready screen', shownScreen(doc, PLAYER_SCREENS) === 'screen-ready');
  check('get-ready shows the prompt', text(doc, 'ready-prompt') === 'Which shark movie?');
  check('get-ready mentions the media', /video/.test(text(doc, 'ready-hint')), text(doc, 'ready-hint'));
  check('no answer pads exist yet', doc.getElementById('answer-pads').children.length === 0);

  // Answers open.
  const deadline = Date.now() + 20000;
  socket.fire('game:answers-open', { options: OPTIONS, deadline, serverNow: Date.now(), timeLimit: 20 });
  check('answers-open shows the pad screen', shownScreen(doc, PLAYER_SCREENS) === 'screen-answer');

  const padEls = [...doc.getElementById('answer-pads').children];
  check('one pad per option', padEls.length === 3, String(padEls.length));
  check('pads are buttons', padEls.every((p) => p.tagName === 'BUTTON'));
  check('pads carry the option text',
    padEls.map((p) => p.querySelector('.pad__text').textContent).join('|') === 'Jaws|Alien|The Thing');
  check('pads carry distinct colours', new Set(padEls.map((p) => p.style.background)).size === 3);
  check('pad grid class matches the option count',
    doc.getElementById('answer-pads').className.includes('pads--n3'),
    doc.getElementById('answer-pads').className);

  // Tap an answer.
  padEls[0].dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 20));
  const answerEmit = socket.sent.filter((s) => s.event === 'player:answer');
  check('tapping a pad sends the answer', answerEmit.length === 1 && answerEmit[0].payload.optionIndex === 0,
    JSON.stringify(answerEmit));
  check('chosen pad is marked', padEls[0].classList.contains('pad--chosen'));
  check('other pads are dimmed and disabled',
    padEls[1].classList.contains('pad--dim') && padEls[1].disabled);
  check('status says locked in', /locked in/i.test(text(doc, 'answer-status')), text(doc, 'answer-status'));

  // A second tap must not send anything.
  padEls[1].dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 20));
  check('a second tap sends nothing more',
    socket.sent.filter((s) => s.event === 'player:answer').length === 1);

  // Reveal — correct.
  socket.fire('game:reveal', {
    index: 0, total: 2, answered: true, correct: true, yourIndex: 0, correctIndex: 0,
    correctText: 'Jaws', gained: 950, score: 950, streak: 1, rank: 1, playerCount: 4,
  });
  check('correct reveal shows the result screen', shownScreen(doc, PLAYER_SCREENS) === 'screen-result');
  check('correct reveal is styled as a win',
    doc.getElementById('screen-result').className.includes('result--right'));
  check('correct reveal shows a tick', text(doc, 'result-mark') === '✓');
  check('correct reveal shows the points gained', text(doc, 'result-gain') === '+950');
  check('correct reveal shows rank', /1st of 4/.test(text(doc, 'result-rank')), text(doc, 'result-rank'));

  // Reveal — wrong, with the answer named.
  socket.fire('game:reveal', {
    index: 1, total: 2, answered: true, correct: false, yourIndex: 2, correctIndex: 0,
    correctText: 'Jaws', gained: 0, score: 950, streak: 0, rank: 3, playerCount: 4,
  });
  check('wrong reveal is styled as a loss',
    doc.getElementById('screen-result').className.includes('result--wrong'));
  check('wrong reveal names the right answer', /Jaws/.test(text(doc, 'result-detail')), text(doc, 'result-detail'));
  check('wrong reveal shows no points', text(doc, 'result-gain') === '');

  // Reveal — never answered.
  socket.fire('game:reveal', {
    index: 1, total: 2, answered: false, correct: false, yourIndex: null, correctIndex: 0,
    correctText: 'Jaws', gained: 0, score: 950, streak: 0, rank: 4, playerCount: 4,
  });
  check('no answer reads as time up', /time/i.test(text(doc, 'result-title')), text(doc, 'result-title'));

  // Streak wording.
  socket.fire('game:reveal', {
    index: 1, total: 2, answered: true, correct: true, yourIndex: 0, correctIndex: 0,
    correctText: 'Jaws', gained: 1200, score: 2150, streak: 3, rank: 1, playerCount: 4,
  });
  check('a streak is called out', /3 in a row/.test(text(doc, 'result-detail')), text(doc, 'result-detail'));

  // Scoreboard.
  socket.fire('game:scoreboard', { rank: 2, previousRank: 3, score: 950, playerCount: 4, ahead: { name: 'Manav', gap: 300 }, isLast: false });
  check('scoreboard shows the ordinal rank', text(doc, 'board-rank') === '2nd', text(doc, 'board-rank'));
  check('scoreboard shows the gap to the leader',
    /300 behind Manav/.test(text(doc, 'board-ahead')), text(doc, 'board-ahead'));

  socket.fire('game:scoreboard', { rank: 1, previousRank: 1, score: 3000, playerCount: 4, ahead: null, isLast: true });
  check('first place is told they lead', /lead/i.test(text(doc, 'board-ahead')), text(doc, 'board-ahead'));

  // End.
  socket.fire('game:ended', {
    rank: 1, score: 3000, playerCount: 4,
    podium: [{ name: 'Sofia', score: 3000 }, { name: 'Manav', score: 2400 }, { name: 'Alex', score: 900 }],
  });
  check('winner sees the final screen', shownScreen(doc, PLAYER_SCREENS) === 'screen-final');
  check('winner is congratulated', /winner/i.test(text(doc, 'final-blurb')), text(doc, 'final-blurb'));
  check('final podium lists three', doc.getElementById('final-podium').children.length === 3);

  // Ordinals, including the awkward ones.
  socket.fire('game:ended', { rank: 11, score: 10, playerCount: 20, podium: [] });
  check('11th is not 11st', text(doc, 'final-rank') === '11th', text(doc, 'final-rank'));
  socket.fire('game:ended', { rank: 22, score: 10, playerCount: 30, podium: [] });
  check('22nd is right', text(doc, 'final-rank') === '22nd', text(doc, 'final-rank'));
  socket.fire('game:ended', { rank: 13, score: 10, playerCount: 30, podium: [] });
  check('13th is not 13rd', text(doc, 'final-rank') === '13th', text(doc, 'final-rank'));

  // Reset returns to the lobby.
  socket.fire('game:reset');
  check('reset returns to the waiting room', shownScreen(doc, PLAYER_SCREENS) === 'screen-wait');
}

// ===========================================================================
console.log('\n-- player reconnect mid-question --');
// ===========================================================================
{
  const { doc, socket, window } = await loadPage('index.html', [
    'common.js', 'shapes.js', 'pads.js', 'join.js',
  ]);

  // Simulate a resume that lands mid-answering with an answer already given.
  doc.getElementById('code').value = 'TEST';
  doc.getElementById('name').value = 'Sofia';
  socket.emit = ((original) => (event, payload, ack) => {
    socket.sent.push({ event, payload });
    if (event === 'player:join') {
      ack?.({
        ok: true,
        playerId: 'p1',
        state: {
          code: 'TEST', phase: 'answering', player: { name: 'Sofia' }, playerCount: 4,
          game: {
            phase: 'answering', index: 0, total: 2, score: 0, title: 'Movies',
            question: { index: 0, total: 2, prompt: 'Which shark movie?', hasMedia: false, mediaKind: null, optionCount: 3, options: OPTIONS, timeLimit: 20, points: 1000 },
            deadline: Date.now() + 12000, serverNow: Date.now(), yourIndex: 2,
          },
        },
      });
    } else ack?.({ ok: true });
  })(socket.emit);

  doc.getElementById('join-form').dispatchEvent(new window.Event('submit'));
  await new Promise((r) => setTimeout(r, 20));

  check('resume lands on the answer screen', shownScreen(doc, PLAYER_SCREENS) === 'screen-answer',
    shownScreen(doc, PLAYER_SCREENS));
  const padEls = [...doc.getElementById('answer-pads').children];
  check('resume rebuilds the pads', padEls.length === 3);
  check('resume restores the chosen answer', padEls[2].classList.contains('pad--chosen'));
  check('resume keeps the pads locked', padEls.every((p) => p.disabled));
}

// ===========================================================================
console.log('\n-- host screens --');
// ===========================================================================
{
  const { doc, socket, window } = await loadPage('host.html', [
    'common.js', 'shapes.js', 'pads.js', 'stage.js', 'host.js',
  ]);

  check('host starts idle', shownScreen(doc, HOST_SCREENS) === 'screen-idle');

  doc.getElementById('create-btn').dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 30));
  check('creating a room shows the lobby', shownScreen(doc, HOST_SCREENS) === 'screen-lobby',
    shownScreen(doc, HOST_SCREENS));
  check('lobby shows the game PIN', text(doc, 'room-code') === 'TEST');
  check('lobby shows the LAN address players should use',
    text(doc, 'join-url') === '192.168.1.5:3000', text(doc, 'join-url'));
  check('quiz picker is populated', doc.getElementById('quiz-select').children.length === 1);
  check('start is blocked with no players', doc.getElementById('start-btn').disabled);

  socket.fire('room:players', { players: [{ id: 'p1', name: 'Sofia', connected: true, score: 0 }], connected: 1 });
  check('a joined player enables start', !doc.getElementById('start-btn').disabled);
  check('roster shows the player', /Sofia/.test(text(doc, 'roster-list')));

  // Closing from the lobby must shut the room down and go back to the start.
  doc.getElementById('close-btn').dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 30));
  check('lobby Close game tells the server to close',
    socket.sent.some((s) => s.event === 'host:close'), JSON.stringify(socket.sent.map((s) => s.event)));
  check('lobby Close game returns to the opening screen',
    shownScreen(doc, HOST_SCREENS) === 'screen-idle', shownScreen(doc, HOST_SCREENS));
  check('closing clears the roster', doc.getElementById('roster-list').children.length === 0);
  check('closing forgets the saved room',
    !window.localStorage.getItem('gamenight:host'), window.localStorage.getItem('gamenight:host'));

  // Re-open a room to carry on testing the game screens.
  doc.getElementById('create-btn').dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 30));
  socket.fire('room:players', { players: [{ id: 'p1', name: 'Sofia', connected: true, score: 0 }], connected: 1 });
  check('a new room can be created after closing',
    shownScreen(doc, HOST_SCREENS) === 'screen-lobby', shownScreen(doc, HOST_SCREENS));

  // Question.
  socket.fire('game:started', { title: 'Movies', total: 2 });
  socket.fire('game:question', QUESTION);
  check('question shows the stage', shownScreen(doc, HOST_SCREENS) === 'screen-game');
  check('stage shows the prompt', text(doc, 'q-prompt') === 'Which shark movie?');
  check('stage shows the progress', text(doc, 'q-progress') === 'Question 1 of 2');
  check('stage shows the point value', text(doc, 'q-points') === '1000 pts');
  check('options are hidden during the lead-in',
    doc.getElementById('q-options').children.length === 0);
  check('the forward button offers to open answers',
    text(doc, 'advance-btn') === 'Open answers');

  // Answers open.
  const deadline = Date.now() + 20000;
  socket.fire('game:answers-open', { options: OPTIONS, deadline, serverNow: Date.now(), timeLimit: 20 });
  const hostPads = [...doc.getElementById('q-options').children];
  check('host pads appear when answers open', hostPads.length === 3);
  check('host pads are not clickable', hostPads.every((p) => p.tagName === 'DIV'));
  check('host countdown is running', /^\d+$/.test(text(doc, 'q-seconds')), text(doc, 'q-seconds'));
  check('answer tally starts at zero', /0 of/.test(text(doc, 'q-answered')), text(doc, 'q-answered'));

  socket.fire('game:answer-count', { answered: 3, total: 4 });
  check('answer tally updates', text(doc, 'q-answered') === '3 of 4 answered');

  // Reveal.
  socket.fire('game:reveal', {
    index: 0, total: 2, correctIndex: 0, correctText: 'Jaws', tallies: [3, 1, 0],
    answered: 4, players: 4,
    leaderboard: [
      { id: 'p1', name: 'Sofia', score: 950, streak: 1, connected: true },
      { id: 'p2', name: 'Manav', score: 800, streak: 2, connected: true },
    ],
    isLast: false,
  });
  check('reveal highlights the correct pad', hostPads[0].classList.contains('pad--right'));
  check('reveal dims the wrong pads',
    hostPads[1].classList.contains('pad--dim') && hostPads[2].classList.contains('pad--dim'));
  check('reveal shows per-option tallies',
    hostPads.map((p) => p.querySelector('.pad__tally')?.textContent).join(',') === '3,1,0',
    hostPads.map((p) => p.querySelector('.pad__tally')?.textContent).join(','));
  check('reveal names the answer on the stage', text(doc, 'q-prompt') === 'Jaws');

  // Scoreboard.
  socket.fire('game:scoreboard', {
    index: 0, total: 2,
    leaderboard: [
      { id: 'p1', name: 'Sofia', score: 950, streak: 1, connected: true },
      { id: 'p2', name: 'Manav', score: 800, streak: 3, connected: false },
    ],
    isLast: false,
  });
  check('scoreboard screen is shown', shownScreen(doc, HOST_SCREENS) === 'screen-board');
  check('scoreboard lists both players', doc.getElementById('board-list').children.length === 2);
  check('scoreboard shows scores', /950/.test(text(doc, 'board-list')));
  check('a streak is flagged', /🔥 3/.test(text(doc, 'board-list')), text(doc, 'board-list'));
  check('an offline player is marked', /offline/.test(text(doc, 'board-list')));
  check('next button reads as the next question', text(doc, 'board-next') === 'Next question');

  socket.fire('game:scoreboard', { index: 1, total: 2, leaderboard: [], isLast: true });
  check('last question changes the button wording', text(doc, 'board-next') === 'Show final results');

  // Podium.
  socket.fire('game:ended', {
    total: 2,
    podium: [
      { id: 'p1', name: 'Sofia', score: 3000, streak: 2, connected: true },
      { id: 'p2', name: 'Manav', score: 2400, streak: 0, connected: true },
      { id: 'p3', name: 'Alex', score: 900, streak: 0, connected: true },
    ],
    leaderboard: [
      { id: 'p1', name: 'Sofia', score: 3000, streak: 2, connected: true },
      { id: 'p2', name: 'Manav', score: 2400, streak: 0, connected: true },
      { id: 'p3', name: 'Alex', score: 900, streak: 0, connected: true },
      { id: 'p4', name: 'Sam', score: 400, streak: 0, connected: true },
    ],
  });
  check('podium screen is shown', shownScreen(doc, HOST_SCREENS) === 'screen-podium');
  const slots = [...doc.getElementById('podium').children];
  check('podium has three slots', slots.length === 3);
  check('winner stands in the middle',
    slots[1].className.includes('podium__slot--1') && /Sofia/.test(slots[1].textContent),
    slots.map((s) => s.className).join(' | '));
  check('runner-up is on the left', /Manav/.test(slots[0].textContent));
  check('fourth place is listed below the podium',
    doc.getElementById('podium-rest').children.length === 1 && /Sam/.test(text(doc, 'podium-rest')));

  // A two-player game must not render an empty third slot.
  socket.fire('game:ended', {
    total: 2,
    podium: [
      { id: 'p1', name: 'Sofia', score: 3000, streak: 0, connected: true },
      { id: 'p2', name: 'Manav', score: 2400, streak: 0, connected: true },
    ],
    leaderboard: [
      { id: 'p1', name: 'Sofia', score: 3000, streak: 0, connected: true },
      { id: 'p2', name: 'Manav', score: 2400, streak: 0, connected: true },
    ],
  });
  check('a two-player podium has two slots', doc.getElementById('podium').children.length === 2,
    String(doc.getElementById('podium').children.length));

  // Closing from the podium goes to the start screen too, not just the lobby.
  const before = socket.sent.length;
  doc.getElementById('podium-close').dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 30));
  check('podium Close game tells the server to close',
    socket.sent.slice(before).some((s) => s.event === 'host:close'));
  check('podium Close game returns to the opening screen',
    shownScreen(doc, HOST_SCREENS) === 'screen-idle', shownScreen(doc, HOST_SCREENS));
}

// ===========================================================================
console.log('\n-- host media stage --');
// ===========================================================================
{
  const { doc, socket } = await loadPage('host.html', [
    'common.js', 'shapes.js', 'pads.js', 'stage.js', 'host.js',
  ]);

  const stage = doc.getElementById('q-media');

  socket.fire('game:question', { ...QUESTION, media: { kind: 'image', url: '/uploads/a.png', name: 'a.png' } });
  check('an image question renders an img',
    stage.querySelector('img')?.getAttribute('src') === '/uploads/a.png', stage.innerHTML.slice(0, 80));

  socket.fire('game:question', { ...QUESTION, media: { kind: 'audio', url: '/uploads/a.mp3', name: 'a.mp3' } });
  check('an audio question renders an audio element', Boolean(stage.querySelector('audio')));
  check('an audio question hides the raw player', stage.querySelector('audio').hidden === true);
  check('an audio question shows the equaliser', Boolean(stage.querySelector('.eq')));

  socket.fire('game:question', { ...QUESTION, media: { kind: 'video', url: '/uploads/a.mp4', name: 'a.mp4' } });
  check('a video question renders a video element', Boolean(stage.querySelector('video')));
  check('a visible video has no equaliser', !stage.querySelector('.eq'));
  check('previous media is cleared between questions', !stage.querySelector('audio'));

  socket.fire('game:question', {
    ...QUESTION,
    media: { kind: 'video', url: '/uploads/a.mp4', name: 'a.mp4' },
    hideVideo: true,
  });
  check('audio-only video hides the picture', stage.querySelector('video').hidden === true);
  check('audio-only video shows the equaliser', Boolean(stage.querySelector('.eq')));

  socket.fire('game:question', { ...QUESTION, media: null });
  check('a question with no media clears the stage', stage.children.length === 0, stage.innerHTML);
}

// ===========================================================================
console.log('\n-- pad layouts across option counts --');
// ===========================================================================
{
  const { doc, socket } = await loadPage('host.html', [
    'common.js', 'shapes.js', 'pads.js', 'stage.js', 'host.js',
  ]);

  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    const options = Array.from({ length: n }, (_, i) => ({ text: `Option ${i + 1}` }));
    socket.fire('game:question', { ...QUESTION, options });
    socket.fire('game:answers-open', {
      options, deadline: Date.now() + 20000, serverNow: Date.now(), timeLimit: 20,
    });
    const grid = doc.getElementById('q-options');
    const glyphs = [...grid.children].map((p) => p.querySelector('.pad__glyph').textContent);
    check(`${n} options render ${n} pads with distinct shapes`,
      grid.children.length === n && new Set(glyphs).size === n && grid.className.includes(`pads--n${n}`),
      `${grid.children.length} pads, ${new Set(glyphs).size} shapes, ${grid.className}`);
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

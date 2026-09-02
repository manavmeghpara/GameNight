/* Host page: open a room, fill the lobby, then run the game on the big screen. */

const SCREENS = ['screen-idle', 'screen-lobby', 'screen-game', 'screen-board', 'screen-podium'];
const HOST_KEY = 'gamenight:host';

const socket = io();
let hostSession = store.get(HOST_KEY); // { code, hostToken }
let joinHost = location.host; // replaced with the LAN address if we can find one

// --- work out the address players should type -------------------------------

fetch('/api/info')
  .then((r) => r.json())
  .then(({ addresses, port }) => {
    // Prefer a real LAN address over "localhost", which phones cannot reach.
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      if (addresses.length) joinHost = `${addresses[0]}:${port}`;
    }
    $('join-url').textContent = joinHost;
  })
  .catch(() => {
    $('join-url').textContent = joinHost;
  });

// --- connection state -------------------------------------------------------

socket.on('connect', async () => {
  banner('');
  if (hostSession?.code && hostSession?.hostToken) {
    const reply = await ask(socket, 'host:resume', hostSession);
    if (reply.ok) {
      enterLobby(reply);
      return;
    }
    store.clear(HOST_KEY);
    hostSession = null;
  }
  showScreen('screen-idle', SCREENS);
});

socket.on('disconnect', () => banner('Reconnecting…'));

// --- creating a room --------------------------------------------------------

$('create-btn').addEventListener('click', async () => {
  $('idle-error').textContent = '';
  $('create-btn').disabled = true;
  const reply = await ask(socket, 'host:create');
  $('create-btn').disabled = false;

  if (!reply.ok) {
    $('idle-error').textContent = reply.error ?? 'Could not create a game.';
    return;
  }
  hostSession = { code: reply.code, hostToken: reply.hostToken };
  store.set(HOST_KEY, hostSession);
  enterLobby(reply);
});

function enterLobby(reply) {
  $('room-code').textContent = reply.code;
  $('join-url').textContent = joinHost;
  renderPlayers(reply.players ?? []);
  loadQuizzes();
  // Resuming into a game already in progress: the next server event repaints.
  showScreen(reply.phase && reply.phase !== 'lobby' ? 'screen-game' : 'screen-lobby', SCREENS);
}

// --- roster -----------------------------------------------------------------

socket.on('room:players', ({ players }) => renderPlayers(players));

function renderPlayers(players) {
  const list = $('roster-list');
  list.textContent = '';

  playerCount = players.length;
  $('player-count').textContent =
    players.length === 1 ? '1 joined' : `${players.length} joined`;
  $('roster-empty').classList.toggle('hidden', players.length > 0);
  updateStartButton();

  for (const p of players) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (p.connected ? '' : ' chip--offline');

    const label = document.createElement('span');
    label.textContent = p.name;
    chip.appendChild(label);

    const kick = document.createElement('button');
    kick.className = 'chip__kick';
    kick.type = 'button';
    kick.title = `Remove ${p.name}`;
    kick.textContent = '✕';
    kick.addEventListener('click', () => socket.emit('host:kick', { playerId: p.id }));
    chip.appendChild(kick);

    list.appendChild(chip);
  }
}

// --- lobby actions ----------------------------------------------------------

// ---------------------------------------------------------------------------
// Choosing a quiz
// ---------------------------------------------------------------------------

let playerCount = 0;

async function loadQuizzes() {
  const select = $('quiz-select');
  select.textContent = '';
  try {
    const { quizzes } = await (await fetch('/api/quizzes')).json();
    const playable = quizzes.filter((q) => q.problems === 0);

    if (!quizzes.length) {
      select.appendChild(new Option('No quizzes yet — build one first', ''));
    } else if (!playable.length) {
      select.appendChild(new Option('No finished quizzes — check them in the builder', ''));
    } else {
      for (const q of playable) {
        select.appendChild(
          new Option(`${q.title} · ${q.questionCount} question${q.questionCount === 1 ? '' : 's'}`, q.id),
        );
      }
    }
  } catch {
    select.appendChild(new Option('Could not load quizzes', ''));
  }
  updateStartButton();
}

function updateStartButton() {
  const hasQuiz = Boolean($('quiz-select').value);
  $('start-btn').disabled = playerCount === 0 || !hasQuiz;
  $('start-btn').textContent = !hasQuiz
    ? 'Pick a quiz'
    : playerCount === 0
      ? 'Waiting for players'
      : 'Start game';
}

$('quiz-select').addEventListener('change', updateStartButton);

$('start-btn').addEventListener('click', async () => {
  $('lobby-error').textContent = '';
  $('start-btn').disabled = true;
  const reply = await ask(socket, 'host:start', { quizId: $('quiz-select').value });
  if (!reply.ok) {
    $('lobby-error').textContent = [reply.error, ...(reply.problems ?? [])].join(' ');
    updateStartButton();
  }
});

// ---------------------------------------------------------------------------
// Running the game
// ---------------------------------------------------------------------------

let question = null; // the current host-side question view
let pads = [];
let unmountMedia = () => {};

function clearStage() {
  stopRing();
  unmountMedia();
  unmountMedia = () => {};
}

socket.on('game:started', () => showScreen('screen-game', SCREENS));

socket.on('game:question', (q) => {
  question = q;
  showScreen('screen-game', SCREENS);

  $('q-progress').textContent = `Question ${q.index + 1} of ${q.total}`;
  $('q-prompt').textContent = q.prompt;
  $('q-points').textContent = q.points === 0 ? 'Just for fun' : `${q.points} pts`;
  $('q-answered').textContent = '';

  // Options stay off screen until answers open, so nobody can read ahead.
  $('q-options').textContent = '';
  pads = [];

  // The ring first drains through the lead-in, then through the answer time.
  showRing(true);
  $('q-seconds').textContent = '…';
  runRing(Date.now(), Date.now() + q.leadInMs, { label: false });

  unmountMedia();
  unmountMedia = mountMedia($('q-media'), q);

  $('advance-btn').textContent = 'Open answers';
});

socket.on('game:answers-open', ({ options, deadline, serverNow, timeLimit }) => {
  syncClock(serverNow);
  pads = buildPads($('q-options'), options, { host: true });
  $('q-answered').textContent = `0 of ${playerCount} answered`;
  $('advance-btn').textContent = 'Close answers';

  showRing(true);
  runRing(deadline - timeLimit * 1000, deadline, { label: true });
});

socket.on('game:answer-count', ({ answered, total }) => {
  $('q-answered').textContent = `${answered} of ${total} answered`;
});

socket.on('game:reveal', (r) => {
  clearStage();
  showRing(false);

  // If the host revealed during the lead-in, the pads were never built.
  if (!pads.length && question) {
    pads = buildPads($('q-options'), question.options, { host: true });
  }
  revealPads(pads, r.correctIndex, { tallies: r.tallies });

  $('q-progress').textContent = 'Correct answer';
  $('q-prompt').textContent = r.correctText;
  $('q-answered').textContent = `${r.answered} of ${r.players} answered`;
  $('advance-btn').textContent = 'Scoreboard';
});

socket.on('game:scoreboard', (s) => {
  renderBoard($('board-list'), s.leaderboard);
  $('board-title').textContent = s.isLast ? 'Last question · final results next' : 'Scoreboard';
  $('board-next').textContent = s.isLast ? 'Show final results' : 'Next question';
  showScreen('screen-board', SCREENS);
});

socket.on('game:ended', (e) => {
  clearStage();
  renderPodium(e.podium);
  renderBoard($('podium-rest'), e.leaderboard.slice(3), 4);
  showScreen('screen-podium', SCREENS);
});

socket.on('game:reset', () => {
  clearStage();
  showScreen('screen-lobby', SCREENS);
});

// --- leaderboard and podium -------------------------------------------------

function renderBoard(list, leaderboard, startRank = 1) {
  list.textContent = '';
  list.style.counterReset = `rank ${startRank - 1}`;

  for (const entry of leaderboard.slice(0, 8)) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.textContent = entry.connected ? entry.name : `${entry.name} (offline)`;
    li.appendChild(name);

    if (entry.streak >= 2) {
      const streak = document.createElement('span');
      streak.className = 'move move--up';
      streak.textContent = `🔥 ${entry.streak}`;
      streak.title = `${entry.streak} correct in a row`;
      li.appendChild(streak);
    }

    const score = document.createElement('strong');
    score.textContent = entry.score;
    li.appendChild(score);

    list.appendChild(li);
  }
}

function renderPodium(podium) {
  const wrap = $('podium');
  wrap.textContent = '';

  // Second, first, third — so the winner stands in the middle.
  for (const i of [1, 0, 2]) {
    const entry = podium[i];
    if (!entry) continue;

    const slot = document.createElement('div');
    slot.className = `podium__slot podium__slot--${i + 1}`;

    const name = document.createElement('div');
    name.className = 'podium__name';
    name.textContent = entry.name;

    const score = document.createElement('div');
    score.className = 'podium__score';
    score.textContent = `${entry.score} pts`;

    const block = document.createElement('div');
    block.className = 'podium__block';
    block.textContent = ['🥇', '🥈', '🥉'][i];

    slot.append(name, score, block);
    wrap.appendChild(slot);
  }
}

// --- countdown ring ---------------------------------------------------------

const RING_CIRCUMFERENCE = 326.7; // 2 * pi * 52, matching the SVG
const LOW_TIME_SECONDS = 5;

let ringTimer = null;
let clockOffset = 0; // serverNow minus our clock, so deadlines line up

function syncClock(serverNow) {
  clockOffset = serverNow - Date.now();
}

const serverTime = () => Date.now() + clockOffset;

function showRing(visible) {
  $('q-timer').classList.toggle('hidden', !visible);
}

/** Animates the ring emptying between two timestamps on the server's clock. */
function runRing(from, to, { label }) {
  stopRing();
  const span = Math.max(1, to - from);
  const fill = $('ring-fill');

  const tick = () => {
    const left = Math.max(0, to - serverTime());
    fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - Math.min(1, left / span)));

    if (label) {
      const seconds = Math.ceil(left / 1000);
      $('q-seconds').textContent = seconds;
      fill.classList.toggle('ring__fill--low', seconds <= LOW_TIME_SECONDS);
    }
    if (left <= 0) stopRing();
  };

  tick();
  ringTimer = setInterval(tick, 100);
}

function stopRing() {
  clearInterval(ringTimer);
  ringTimer = null;
  $('ring-fill').classList.remove('ring__fill--low');
}

// --- host controls ----------------------------------------------------------

$('advance-btn').addEventListener('click', () => socket.emit('host:advance'));
$('board-next').addEventListener('click', () => socket.emit('host:advance'));

async function backToLobby() {
  clearStage();
  await ask(socket, 'host:reset');
  showScreen('screen-lobby', SCREENS);
  loadQuizzes();
}

async function confirmEndGame() {
  if (!confirm('End this game and send everyone back to the lobby?')) return;
  await backToLobby();
}

/** Shuts the room down entirely and returns to the opening screen. */
async function closeGame() {
  if (!confirm('Close this game and disconnect all players?')) return;
  clearStage();
  await ask(socket, 'host:close');

  // Forget the room so a refresh does not try to resume a room that is gone.
  store.clear(HOST_KEY);
  hostSession = null;
  renderPlayers([]);
  $('lobby-error').textContent = '';
  $('idle-error').textContent = '';
  showScreen('screen-idle', SCREENS);
}

$('reset-btn').addEventListener('click', confirmEndGame);
$('board-end').addEventListener('click', confirmEndGame);
$('podium-again').addEventListener('click', backToLobby);
$('close-btn').addEventListener('click', closeGame);
$('podium-close').addEventListener('click', closeGame);


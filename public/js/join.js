/* Player page: join a room, then sit in the waiting room. */

const SCREENS = [
  'screen-join',
  'screen-wait',
  'screen-ready',
  'screen-answer',
  'screen-result',
  'screen-board',
  'screen-final',
  'screen-over',
];
const SESSION_KEY = 'gamenight:player';

const socket = io();
let session = store.get(SESSION_KEY); // { code, playerId }
let resuming = false;

// --- prefill the PIN from ?pin=ABCD so a QR code can carry it ---------------
const pinParam = new URLSearchParams(location.search).get('pin');
if (pinParam) $('code').value = pinParam.toUpperCase().slice(0, 4);

$('code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// --- connection state -------------------------------------------------------

socket.on('connect', async () => {
  banner('');
  if (session?.code && session?.playerId) {
    resuming = true;
    const reply = await ask(socket, 'player:resume', session);
    resuming = false;
    if (reply.ok) {
      enterWaitingRoom(reply.state);
    } else {
      store.clear(SESSION_KEY);
      session = null;
      showScreen('screen-join', SCREENS);
    }
  }
});

socket.on('disconnect', () => banner('Reconnecting…'));

// --- joining ----------------------------------------------------------------

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('code').value.trim().toUpperCase();
  const name = $('name').value.trim();
  $('join-error').textContent = '';
  $('join-btn').disabled = true;

  const reply = await ask(socket, 'player:join', { code, name });
  $('join-btn').disabled = false;

  if (!reply.ok) {
    $('join-error').textContent = reply.error;
    return;
  }
  session = { code, playerId: reply.playerId };
  store.set(SESSION_KEY, session);
  enterWaitingRoom(reply.state);
});

function enterWaitingRoom(state) {
  $('wait-name').textContent = state.player.name;
  $('wait-code').textContent = state.code;
  $('wait-count').textContent = state.playerCount;

  // Rejoining a game already under way: rebuild whatever screen we were on.
  if (state.game) {
    restoreGameScreen(state.game);
    return;
  }
  showScreen('screen-wait', SCREENS);
}

// --- leaving / being removed ------------------------------------------------

$('leave-btn').addEventListener('click', () => {
  store.clear(SESSION_KEY);
  location.reload();
});

function endSession(title, text) {
  store.clear(SESSION_KEY);
  session = null;
  $('over-title').textContent = title;
  $('over-text').textContent = text;
  showScreen('screen-over', SCREENS);
}

socket.on('player:kicked', () => endSession('Removed', 'The host removed you from the game.'));
socket.on('room:closed', () => endSession('Game closed', 'The host ended this game.'));
socket.on('host:disconnected', () => {
  if (!resuming) banner('Host disconnected — hang tight…');
});
socket.on('host:reconnected', () => banner(''));

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

let pads = [];
let selected = []; // ticked but not yet submitted (multi-answer questions)
let submitted = false;
let multiSelect = false;
let clockOffset = 0;
let clockTimer = null;

const serverTime = () => Date.now() + clockOffset;

socket.on('game:started', () => {
  $('ready-progress').textContent = 'Get ready';
  $('ready-prompt').textContent = '';
  showScreen('screen-ready', SCREENS);
});

socket.on('game:question', (q) => showReady(q));

function showReady(q) {
  selected = [];
  submitted = false;
  multiSelect = Boolean(q.multiSelect);
  pads = [];
  $('ready-progress').textContent = `Question ${q.index + 1} of ${q.total}`;
  $('ready-prompt').textContent = q.prompt;
  $('ready-hint').textContent = q.hasMedia
    ? `Watch the big screen — ${q.mediaKind} playing…`
    : 'Answers coming up…';
  showScreen('screen-ready', SCREENS);
}

socket.on('game:answers-open', ({ options, deadline, serverNow }) => {
  clockOffset = serverNow - Date.now();
  openAnswers(options, deadline);
});

function openAnswers(options, deadline, alreadyChosen = null) {
  $('answer-progress').textContent = $('ready-progress').textContent;
  $('answer-prompt').textContent = $('ready-prompt').textContent;
  $('answer-status').textContent = '';
  $('answer-hint').classList.toggle('hidden', !multiSelect);
  $('answer-submit').classList.toggle('hidden', !multiSelect);

  pads = buildPads($('answer-pads'), options, {
    interactive: true,
    onPick: (index) => (multiSelect ? toggleOption(index) : submitAnswer([index])),
  });

  if (alreadyChosen?.length) {
    // Reconnecting after already answering.
    selected = alreadyChosen;
    submitted = true;
    markLocked(selected);
  } else {
    selected = [];
    submitted = false;
    updateSubmitButton();
  }

  startClock(deadline);
  showScreen('screen-answer', SCREENS);
}

/** Multi-answer: tick an option on or off until they press Submit. */
function toggleOption(index) {
  if (submitted) return;
  selected = selected.includes(index)
    ? selected.filter((i) => i !== index)
    : [...selected, index].sort((a, b) => a - b);
  markSelected(pads, selected);
  updateSubmitButton();
}

function updateSubmitButton() {
  if (!multiSelect) return;
  const button = $('answer-submit');
  button.disabled = selected.length === 0 || submitted;
  button.textContent = selected.length
    ? `Submit ${selected.length} answer${selected.length === 1 ? '' : 's'}`
    : 'Pick your answers';
}

async function submitAnswer(indexes) {
  if (submitted || !indexes.length) return;
  submitted = true; // lock immediately so a double tap cannot double-send
  selected = indexes;
  markLocked(indexes);

  const reply = await ask(socket, 'player:answer', { indexes });
  if (!reply.ok) {
    // The server refused it — let them try again if there is still time.
    submitted = false;
    selected = [];
    pads.forEach((pad) => {
      pad.disabled = false;
      pad.classList.remove('pad--chosen', 'pad--dim', 'pad--picked');
    });
    updateSubmitButton();
    $('answer-status').textContent = reply.error;
  }
}

function markLocked(indexes) {
  lockPads(pads, indexes);
  $('answer-submit').disabled = true;
  $('answer-submit').textContent = 'Locked in';
  $('answer-status').textContent = 'Locked in — hang tight';
}

$('answer-submit').addEventListener('click', () => submitAnswer(selected));

socket.on('game:reveal', (r) => {
  stopClock();
  renderResult(r);
  $('result-rank').textContent = `${r.score} points · ${ordinal(r.rank)} of ${r.playerCount}`;
  showScreen('screen-result', SCREENS);
});

/** Shared by the live reveal and by a reconnect that lands during one. */
function renderResult(r) {
  // Three outcomes now: full marks, partial credit, or nothing.
  const tone = r.correct ? 'right' : r.partial ? 'partial' : 'wrong';
  $('screen-result').className = `screen result result--${tone}`;
  $('result-mark').textContent = r.correct ? '✓' : r.partial ? '±' : '✕';

  $('result-title').textContent = r.correct
    ? 'Correct!'
    : r.partial
      ? 'Partly right'
      : r.answered
        ? 'Not quite'
        : "Time's up";

  const answerLabel =
    r.correctTexts?.length > 1
      ? `The answers were ${r.correctTexts.map((t) => `“${t}”`).join(', ')}`
      : `The answer was “${r.correctText}”`;

  $('result-detail').textContent = r.correct
    ? r.streak >= 2
      ? `${r.streak} in a row 🔥`
      : ''
    : answerLabel;

  $('result-gain').textContent = r.gained > 0 ? `+${r.gained}` : '';
}

socket.on('game:scoreboard', (s) => {
  $('board-rank').textContent = ordinal(s.rank);
  $('board-score').textContent = `${s.score} point${s.score === 1 ? '' : 's'}`;
  $('board-ahead').textContent = s.ahead
    ? `${s.ahead.gap} behind ${s.ahead.name}`
    : s.playerCount > 1
      ? 'You are in the lead 🏆'
      : '';
  showScreen('screen-board', SCREENS);
});

socket.on('game:ended', (e) => {
  stopClock();
  const won = e.rank === 1;
  $('final-blurb').textContent = won ? 'Winner!' : 'You finished';
  $('final-rank').textContent = ordinal(e.rank);
  $('final-score').textContent = `${e.score} point${e.score === 1 ? '' : 's'} · ${e.playerCount} player${e.playerCount === 1 ? '' : 's'}`;

  const list = $('final-podium');
  list.textContent = '';
  for (const entry of e.podium) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = entry.name;
    const score = document.createElement('strong');
    score.textContent = entry.score;
    li.append(name, score);
    list.appendChild(li);
  }
  showScreen('screen-final', SCREENS);
});

socket.on('game:reset', () => {
  stopClock();
  selected = [];
  submitted = false;
  pads = [];
  showScreen('screen-wait', SCREENS);
});

/** Rebuilds the right screen after a refresh or a dropped connection. */
function restoreGameScreen(game) {
  switch (game.phase) {
    case 'reading':
      showReady(game.question);
      break;
    case 'answering':
      clockOffset = game.serverNow - Date.now();
      showReady(game.question);
      openAnswers(game.question.options, game.deadline, game.yourIndexes);
      break;
    case 'reveal':
      renderResult(game);
      $('result-rank').textContent = `${game.score} points`;
      showScreen('screen-result', SCREENS);
      break;
    case 'scoreboard':
      $('board-rank').textContent = ordinal(game.rank);
      $('board-score').textContent = `${game.score} point${game.score === 1 ? '' : 's'}`;
      $('board-ahead').textContent = game.ahead ? `${game.ahead.gap} behind ${game.ahead.name}` : '';
      showScreen('screen-board', SCREENS);
      break;
    case 'ended':
      $('final-blurb').textContent = game.rank === 1 ? 'Winner!' : 'You finished';
      $('final-rank').textContent = ordinal(game.rank);
      $('final-score').textContent = `${game.score} points`;
      showScreen('screen-final', SCREENS);
      break;
    default:
      showScreen('screen-wait', SCREENS);
  }
}

// --- countdown --------------------------------------------------------------

function startClock(deadline) {
  stopClock();
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - serverTime()) / 1000));
    $('answer-clock').textContent = `${left}s`;
    $('answer-clock').classList.toggle('play__clock--low', left <= 5);
    if (left <= 0) {
      stopClock();
      if (submitted) return;
      if (selected.length) {
        // They ticked options but never pressed Submit — send it rather than
        // score them zero. The server allows a small grace past the deadline.
        submitAnswer(selected);
      } else {
        lockPads(pads, []);
        $('answer-status').textContent = "Time's up";
      }
    }
  };
  tick();
  clockTimer = setInterval(tick, 200);
}

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
}

function ordinal(n) {
  if (!n) return '—';
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

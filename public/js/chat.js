/* The movie assistant panel in the quiz builder.
 *
 * Keys live on the server — this only ever talks to /api/chat. The transcript
 * and the model's step history are kept per tab so the panel survives a
 * refresh but does not leak between browsers.
 */

const CHAT_KEY = 'gamenight:chat';
const MAX_STORED_HISTORY = 40;

const SUGGESTIONS = [
  'Best Hindi films of the 1990s',
  'Who directed Sholay?',
  'Films with both Shah Rukh Khan and Kajol',
  'Give me 3 trivia questions about Pixar',
];

let history = []; // model items, opaque to us — sent back verbatim
let transcript = []; // { role, text } for redrawing after a refresh
let provider = null; // which model provider produced `history`
let busy = false;
let ready = false;

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

function openPanel() {
  $('chat-panel').classList.remove('hidden');
  $('chat-fab').classList.add('fab--tucked');
  $('chat-fab').setAttribute('aria-expanded', 'true');
  if (ready) $('chat-input').focus();
  scrollLog();
}

function closePanel() {
  $('chat-panel').classList.add('hidden');
  $('chat-fab').classList.remove('fab--tucked');
  $('chat-fab').setAttribute('aria-expanded', 'false');
}

$('chat-fab').addEventListener('click', openPanel);
$('chat-close').addEventListener('click', closePanel);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('chat-panel').classList.contains('hidden')) closePanel();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const scrollLog = () => {
  const log = $('chat-log');
  log.scrollTop = log.scrollHeight;
};

function renderTranscript() {
  const log = $('chat-log');
  log.textContent = '';

  if (transcript.length === 0) {
    log.appendChild(introBlock());
    return;
  }
  for (const entry of transcript) addBubble(entry.role, entry.text, false);
  scrollLog();
}

function introBlock() {
  const wrap = document.createElement('div');
  wrap.className = 'chat__intro';

  const line = document.createElement('div');
  line.textContent = 'Ask me anything about films — cast, years, box office, who directed what. I look every answer up, so I will tell you when I cannot find something.';
  wrap.appendChild(line);

  const chips = document.createElement('div');
  chips.className = 'chat__chips';
  for (const suggestion of SUGGESTIONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip-btn';
    chip.textContent = suggestion;
    chip.addEventListener('click', () => send(suggestion));
    chips.appendChild(chip);
  }
  wrap.appendChild(chips);
  return wrap;
}

/** @param {'you'|'bot'|'error'} role */
function addBubble(role, text, scroll = true) {
  const bubble = document.createElement('div');
  bubble.className = `msg msg--${role}`;
  if (role === 'bot') renderMarkdown(bubble, text);
  else bubble.textContent = text;

  $('chat-log').appendChild(bubble);
  if (scroll) scrollLog();
  return bubble;
}

function showThinking() {
  const bubble = document.createElement('div');
  bubble.className = 'msg msg--bot thinking';

  const dots = document.createElement('div');
  dots.className = 'thinking__dots';
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));

  const label = document.createElement('span');
  label.className = 'thinking__what';
  label.textContent = 'Looking that up…';

  bubble.append(dots, label);
  $('chat-log').appendChild(bubble);
  scrollLog();
  return bubble;
}

// ---------------------------------------------------------------------------
// A very small markdown renderer
//
// The reply is model output built partly from TMDB text, so it is untrusted:
// everything below builds DOM nodes and sets textContent. Never innerHTML.
// ---------------------------------------------------------------------------

function renderMarkdown(container, markdown) {
  const lines = String(markdown).split('\n');
  let list = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInline(p, paragraph.join(' '));
    container.appendChild(p);
    paragraph = [];
  };
  const flushList = () => {
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line);

    if (bullet || numbered) {
      flushParagraph();
      const wanted = bullet ? 'UL' : 'OL';
      if (!list || list.tagName !== wanted) {
        list = document.createElement(bullet ? 'ul' : 'ol');
        container.appendChild(list);
      }
      const li = document.createElement('li');
      appendInline(li, bullet ? bullet[1] : numbered[2]);
      list.appendChild(li);
      continue;
    }

    flushList();
    // Drop heading markers rather than rendering huge text in a small bubble.
    paragraph.push(line.replace(/^#{1,6}\s+/, ''));
  }

  flushParagraph();
  if (!container.childNodes.length) container.textContent = markdown;
}

/** Handles **bold** and `code` inside a line of text. */
function appendInline(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    if (match.index > last) {
      parent.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    }
    last = match.index + token.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

async function send(message) {
  const text = String(message ?? '').trim();
  if (!text || busy || !ready) return;

  // Clear the intro the first time someone asks something.
  if (transcript.length === 0) $('chat-log').textContent = '';

  transcript.push({ role: 'you', text });
  addBubble('you', text);

  $('chat-input').value = '';
  resizeInput();
  setBusy(true);
  const thinking = showThinking();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history }),
    });
    const body = await response.json().catch(() => ({}));
    thinking.remove();

    if (!response.ok) {
      addBubble('error', body.error ?? `Request failed (${response.status})`);
      // Keep the failed turn out of history so the next question starts clean.
      transcript.push({ role: 'error', text: body.error ?? 'Request failed.' });
      return;
    }

    history = body.history ?? history;
    provider = body.provider ?? provider;
    transcript.push({ role: 'bot', text: body.reply });
    addBubble('bot', body.reply);
  } catch {
    thinking.remove();
    const message = 'Could not reach the server — is it still running?';
    addBubble('error', message);
    transcript.push({ role: 'error', text: message });
  } finally {
    setBusy(false);
    save();
    $('chat-input').focus();
  }
}

function setBusy(value) {
  busy = value;
  $('chat-send').disabled = value || !ready;
  $('chat-input').disabled = value || !ready;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function resizeInput() {
  const input = $('chat-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
}

$('chat-input').addEventListener('input', resizeInput);

$('chat-input').addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter is a newline.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send($('chat-input').value);
  }
});

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  send($('chat-input').value);
});

$('chat-clear').addEventListener('click', () => {
  history = [];
  transcript = [];
  store.clear(CHAT_KEY);
  renderTranscript();
  $('chat-input').focus();
});

// ---------------------------------------------------------------------------
// Persistence — per tab, capped so a long chat cannot fill storage
// ---------------------------------------------------------------------------

function save() {
  store.set(CHAT_KEY, {
    provider,
    transcript: transcript.slice(-30),
    history: history.slice(-MAX_STORED_HISTORY),
  });
}

function restore() {
  const saved = store.get(CHAT_KEY);
  if (!saved) return;
  transcript = Array.isArray(saved.transcript) ? saved.transcript : [];
  history = Array.isArray(saved.history) ? saved.history : [];
  provider = saved.provider ?? null;
}

/** The two providers shape their history differently, so a switch resets it. */
function dropHistoryIfProviderChanged(current) {
  if (!provider || provider === current) return;
  history = [];
  transcript = [];
  provider = current;
  store.clear(CHAT_KEY);
  renderTranscript();
}

// ---------------------------------------------------------------------------
// Setup state
// ---------------------------------------------------------------------------

function showSetup(status) {
  const panel = $('chat-setup');
  panel.textContent = '';
  panel.classList.remove('hidden');
  $('chat-sub').textContent = 'Needs setup';

  const missing = [];
  if (!status.llm) {
    missing.push({ name: status.providerKey ?? 'OPENAI_API_KEY', where: status.providerSignup ?? 'https://platform.openai.com/api-keys' });
  }
  if (!status.tmdb) missing.push({ name: 'TMDB_API_KEY', where: 'https://www.themoviedb.org/settings/api' });

  const lead = document.createElement('div');
  lead.textContent = missing.length === 2
    ? `The assistant needs an API key for ${status.providerLabel ?? 'your model provider'} and one for TMDB.`
    : 'One more API key and the assistant is ready.';
  panel.appendChild(lead);

  const steps = document.createElement('ol');

  for (const item of missing) {
    const li = document.createElement('li');
    li.appendChild(document.createTextNode('Get a key at '));
    const link = document.createElement('a');
    link.href = item.where;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = item.where.replace('https://', '');
    li.appendChild(link);
    steps.appendChild(li);
  }

  const last = document.createElement('li');
  last.appendChild(document.createTextNode('Copy '));
  last.appendChild(codeSpan('.env.example'));
  last.appendChild(document.createTextNode(' to '));
  last.appendChild(codeSpan('.env'));
  last.appendChild(document.createTextNode(`, fill in ${missing.map((m) => m.name).join(' and ')}, then restart the server.`));
  steps.appendChild(last);

  panel.appendChild(steps);

  $('chat-input').placeholder = 'Add your API keys to start chatting';
}

function codeSpan(text) {
  const code = document.createElement('code');
  code.textContent = text;
  return code;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function start() {
  restore();
  renderTranscript();
  setBusy(false);

  try {
    const status = await (await fetch('/api/chat/status')).json();
    ready = Boolean(status.ready);
    dropHistoryIfProviderChanged(status.provider);
    if (!ready) {
      showSetup(status);
    } else {
      $('chat-sub').textContent = 'Ask about any film';
    }
  } catch {
    ready = false;
    $('chat-sub').textContent = 'Offline';
  }
  setBusy(false);
})();

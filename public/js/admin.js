/* Quiz builder. Library view lists saved quizzes; editor view edits one,
   autosaving to /api/quizzes/:id a moment after you stop typing. */

const SCREENS = ['screen-library', 'screen-editor'];
const SAVE_DELAY_MS = 700;

let config = { minOptions: 2, maxOptions: 8, timeLimits: [20], pointValues: [1000], maxUploadBytes: 0 };
let quiz = null;
let activeIndex = 0;
let saveTimer = null;
let saving = false;
let saveAgain = false;

const activeQuestion = () => quiz?.questions[activeIndex] ?? null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function apiGet(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

async function apiSend(method, url, payload) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

/** "1:23" or "83" or "1:23.5" -> seconds. Returns null when unparseable. */
function parseTime(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const parts = text.split(':');
  if (parts.length > 3 || parts.some((p) => p !== '' && !/^\d*\.?\d*$/.test(p))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + (Number(part) || 0);
  return Number.isFinite(seconds) ? seconds : null;
}

function formatTime(seconds) {
  if (seconds == null) return '';
  const total = Math.max(0, seconds);
  const mins = Math.floor(total / 60);
  const [whole, frac] = (Math.round((total - mins * 60) * 10) / 10).toString().split('.');
  return `${mins}:${whole.padStart(2, '0')}${frac ? `.${frac}` : ''}`;
}

const humanBytes = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB max`;

const relativeTime = (ts) => {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

/** Client-side mirror of the server's playability rules, for inline warnings. */
function questionProblems(q) {
  const problems = [];
  if (!q.prompt.trim()) problems.push('Needs a question to ask.');
  const filled = q.options.filter((o) => o.text.trim());
  if (filled.length < config.minOptions) {
    problems.push(`Needs at least ${config.minOptions} answer options.`);
  }
  if (!q.options[q.correctIndex]?.text.trim()) problems.push('The correct answer is blank.');
  const seen = new Set();
  for (const o of filled) {
    const key = o.text.trim().toLowerCase();
    if (seen.has(key)) {
      problems.push(`"${o.text}" is listed twice.`);
      break;
    }
    seen.add(key);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

async function loadLibrary() {
  $('library-error').textContent = '';
  try {
    const { quizzes } = await apiGet('/api/quizzes');
    renderLibrary(quizzes);
  } catch (err) {
    $('library-error').textContent = err.message;
  }
}

function renderLibrary(quizzes) {
  const list = $('library-list');
  list.textContent = '';
  $('library-empty').classList.toggle('hidden', quizzes.length > 0);

  for (const q of quizzes) {
    const card = document.createElement('div');
    card.className = 'quiz-card';

    const title = document.createElement('div');
    title.className = 'quiz-card__title';
    title.textContent = q.title;
    card.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'quiz-card__meta';
    meta.textContent = `${q.questionCount} question${q.questionCount === 1 ? '' : 's'} · edited ${relativeTime(q.updatedAt)}`;
    card.appendChild(meta);

    if (q.problems > 0) {
      const warn = document.createElement('div');
      warn.className = 'quiz-card__warn';
      warn.textContent = `⚠ ${q.problems} thing${q.problems === 1 ? '' : 's'} to fix`;
      card.appendChild(warn);
    }

    const row = document.createElement('div');
    row.className = 'quiz-card__row';

    const edit = document.createElement('button');
    edit.className = 'btn btn--sm';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => {
      location.hash = `#/quiz/${q.id}`;
    });
    row.appendChild(edit);

    const dup = document.createElement('button');
    dup.className = 'btn btn--ghost btn--sm';
    dup.textContent = 'Copy';
    dup.title = 'Duplicate this quiz';
    dup.addEventListener('click', async () => {
      try {
        await apiSend('POST', `/api/quizzes/${q.id}/duplicate`);
        loadLibrary();
      } catch (err) {
        $('library-error').textContent = err.message;
      }
    });
    row.appendChild(dup);

    const del = document.createElement('button');
    del.className = 'btn btn--ghost btn--sm';
    del.textContent = '🗑';
    del.title = 'Delete this quiz';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${q.title}" and its uploaded media? This cannot be undone.`)) return;
      try {
        await apiSend('DELETE', `/api/quizzes/${q.id}`);
        loadLibrary();
      } catch (err) {
        $('library-error').textContent = err.message;
      }
    });
    row.appendChild(del);

    card.appendChild(row);
    list.appendChild(card);
  }
}

$('new-quiz-btn').addEventListener('click', async () => {
  try {
    const { quiz: created } = await apiSend('POST', '/api/quizzes', { title: 'Untitled quiz' });
    location.hash = `#/quiz/${created.id}`;
  } catch (err) {
    $('library-error').textContent = err.message;
  }
});

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function setSaveState(text, modifier = '') {
  const el = $('save-state');
  el.textContent = text;
  el.className = `save-state${modifier ? ` save-state--${modifier}` : ''}`;
}

function markDirty() {
  setSaveState('Unsaved…', 'dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

async function save() {
  if (!quiz) return;
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  try {
    await apiSend('PUT', `/api/quizzes/${quiz.id}`, { quiz });
    setSaveState('Saved');
  } catch (err) {
    setSaveState('Save failed', 'error');
    console.error(err);
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      save();
    }
  }
}

// Don't let a quick tab-close swallow the last few keystrokes.
window.addEventListener('beforeunload', (e) => {
  if ($('save-state').textContent === 'Unsaved…') {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------------------
// Editor: question list
// ---------------------------------------------------------------------------

function renderQuestionList() {
  const wrap = $('qlist-items');
  wrap.textContent = '';

  quiz.questions.forEach((q, i) => {
    const card = document.createElement('div');
    card.className = 'qcard' + (i === activeIndex ? ' qcard--active' : '');
    card.addEventListener('click', () => selectQuestion(i));

    const top = document.createElement('div');
    top.className = 'qcard__top';

    const num = document.createElement('span');
    num.className = 'qcard__num';
    num.textContent = i + 1;
    top.appendChild(num);

    if (q.media) {
      const badge = document.createElement('span');
      badge.className = 'qcard__badge';
      badge.textContent = { image: '🖼', audio: '🎵', video: '🎬' }[q.media.kind] ?? '';
      badge.title = q.media.kind;
      top.appendChild(badge);
    }

    const count = document.createElement('span');
    count.textContent = `${q.options.filter((o) => o.text.trim()).length} opts`;
    top.appendChild(count);

    if (questionProblems(q).length) {
      const warn = document.createElement('span');
      warn.className = 'qcard__warn';
      warn.textContent = '⚠';
      warn.title = questionProblems(q).join('\n');
      top.appendChild(warn);
    }

    card.appendChild(top);

    const text = document.createElement('div');
    text.className = 'qcard__text' + (q.prompt.trim() ? '' : ' qcard__text--empty');
    text.textContent = q.prompt.trim() || 'Empty question';
    card.appendChild(text);

    const tools = document.createElement('div');
    tools.className = 'qcard__tools';
    tools.appendChild(toolButton('↑', 'Move up', i === 0, () => moveQuestion(i, -1)));
    tools.appendChild(
      toolButton('↓', 'Move down', i === quiz.questions.length - 1, () => moveQuestion(i, 1)),
    );
    tools.appendChild(toolButton('⧉', 'Duplicate', false, () => duplicateQuestion(i)));
    tools.appendChild(
      toolButton('🗑', 'Delete', quiz.questions.length === 1, () => deleteQuestion(i), true),
    );
    card.appendChild(tools);

    wrap.appendChild(card);
  });
}

function toolButton(label, title, disabled, onClick, danger = false) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn' + (danger ? ' icon-btn--danger' : '');
  btn.textContent = label;
  btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function selectQuestion(index) {
  activeIndex = Math.min(Math.max(0, index), quiz.questions.length - 1);
  renderQuestionList();
  renderQuestionEditor();
}

function moveQuestion(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= quiz.questions.length) return;
  const [q] = quiz.questions.splice(index, 1);
  quiz.questions.splice(target, 0, q);
  activeIndex = target;
  renderQuestionList();
  markDirty();
}

function duplicateQuestion(index) {
  const copy = structuredClone(quiz.questions[index]);
  copy.id = randomId();
  copy.options = copy.options.map((o) => ({
    ...o,
    id: randomId(),
  }));
  quiz.questions.splice(index + 1, 0, copy);
  selectQuestion(index + 1);
  markDirty();
}

function deleteQuestion(index) {
  if (quiz.questions.length === 1) return;
  if (!confirm(`Delete question ${index + 1}?`)) return;
  quiz.questions.splice(index, 1);
  selectQuestion(Math.min(index, quiz.questions.length - 1));
  markDirty();
}

$('add-question-btn').addEventListener('click', async () => {
  const { question } = await apiGet('/api/blank-question');
  quiz.questions.push(question);
  selectQuestion(quiz.questions.length - 1);
  markDirty();
});

// ---------------------------------------------------------------------------
// Editor: the selected question
// ---------------------------------------------------------------------------

function renderQuestionEditor() {
  const q = activeQuestion();
  if (!q) return;

  $('q-prompt').value = q.prompt;
  $('q-time').value = String(q.timeLimit);
  $('q-points').value = String(q.points);
  renderMedia(q);
  renderOptions(q);
}

$('q-prompt').addEventListener('input', (e) => {
  const q = activeQuestion();
  if (!q) return;
  q.prompt = e.target.value;
  renderQuestionList();
  markDirty();
});

$('q-time').addEventListener('change', (e) => {
  activeQuestion().timeLimit = Number(e.target.value);
  markDirty();
});

$('q-points').addEventListener('change', (e) => {
  activeQuestion().points = Number(e.target.value);
  markDirty();
});

// --- options ---------------------------------------------------------------

function renderOptions(q) {
  const list = $('options-list');
  list.textContent = '';

  q.options.forEach((option, i) => {
    const style = answerStyle(i);
    const row = document.createElement('div');
    row.className = 'option' + (i === q.correctIndex ? ' option--correct' : '');

    const glyph = document.createElement('div');
    glyph.className = 'option__glyph';
    glyph.style.background = style.color;
    glyph.textContent = style.glyph;
    row.appendChild(glyph);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'option__input';
    input.maxLength = 120;
    input.placeholder = `Option ${i + 1}`;
    input.value = option.text;
    input.addEventListener('input', () => {
      option.text = input.value;
      renderQuestionList();
      markDirty();
    });
    // Enter moves to the next option, or adds one at the end.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (i < q.options.length - 1) {
        list.querySelectorAll('.option__input')[i + 1]?.focus();
      } else if (q.options.length < config.maxOptions) {
        addOption();
      }
    });
    row.appendChild(input);

    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'option__mark';
    mark.textContent = '✓';
    mark.title = 'Mark as the correct answer';
    mark.addEventListener('click', () => {
      q.correctIndex = i;
      renderOptions(q);
      renderQuestionList();
      markDirty();
    });
    row.appendChild(mark);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'option__del';
    del.textContent = '✕';
    del.title = 'Remove this option';
    del.disabled = q.options.length <= config.minOptions;
    del.addEventListener('click', () => {
      q.options.splice(i, 1);
      // Keep the correct answer pointing at the same option where possible.
      if (q.correctIndex === i) q.correctIndex = 0;
      else if (q.correctIndex > i) q.correctIndex -= 1;
      renderOptions(q);
      renderQuestionList();
      markDirty();
    });
    row.appendChild(del);

    list.appendChild(row);
  });

  $('add-option-btn').disabled = q.options.length >= config.maxOptions;
  $('add-option-btn').textContent =
    q.options.length >= config.maxOptions
      ? `Maximum ${config.maxOptions} options`
      : '+ Add option';
}

function addOption() {
  const q = activeQuestion();
  if (!q || q.options.length >= config.maxOptions) return;
  q.options.push({ id: randomId(), text: '' });
  renderOptions(q);
  renderQuestionList();
  markDirty();
  const inputs = $('options-list').querySelectorAll('.option__input');
  inputs[inputs.length - 1]?.focus();
}

$('add-option-btn').addEventListener('click', addOption);

// --- media ------------------------------------------------------------------

function renderMedia(q) {
  const hasMedia = Boolean(q.media);
  $('media-empty').classList.toggle('hidden', hasMedia);
  $('media-present').classList.toggle('hidden', !hasMedia);

  const stage = $('media-stage');
  stage.textContent = '';
  if (!hasMedia) return;

  $('media-kind').textContent = q.media.kind;
  $('media-name').textContent = q.media.name;

  let el;
  if (q.media.kind === 'image') {
    el = document.createElement('img');
  } else {
    el = document.createElement(q.media.kind === 'audio' ? 'audio' : 'video');
    el.controls = true;
    el.preload = 'metadata';
  }
  el.src = q.media.url;
  el.id = 'media-el';
  stage.appendChild(el);

  const timed = q.media.kind !== 'image';
  $('clip-row').classList.toggle('hidden', !timed);
  $('hide-video-row').classList.toggle('hidden', q.media.kind !== 'video');
  if (timed) {
    $('clip-start').value = q.clipStart ? formatTime(q.clipStart) : '';
    $('clip-end').value = q.clipEnd == null ? '' : formatTime(q.clipEnd);
    $('hide-video').checked = Boolean(q.hideVideo);
  }
}

function bindDropzone() {
  const drop = $('media-empty');
  const input = $('media-file');

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files?.[0]) uploadMedia(input.files[0]);
    input.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('media__drop--over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove('media__drop--over');
    });
  }
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadMedia(file);
  });
}

function uploadMedia(file) {
  const q = activeQuestion();
  if (!q) return;

  const title = $('media-empty').querySelector('.media__drop-title');
  const progress = $('media-progress');
  const bar = $('media-bar');
  progress.classList.remove('hidden');
  bar.style.width = '0%';
  title.textContent = `Uploading ${file.name}…`;

  const body = new FormData();
  body.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
  });
  xhr.addEventListener('load', () => {
    progress.classList.add('hidden');
    title.textContent = 'Drop an image, audio clip or video here';
    let reply = {};
    try {
      reply = JSON.parse(xhr.responseText);
    } catch {
      /* fall through to the generic error below */
    }
    if (xhr.status !== 201 || !reply.media) {
      alert(reply.error ?? 'Upload failed.');
      return;
    }
    q.media = reply.media;
    q.clipStart = 0;
    q.clipEnd = null;
    q.hideVideo = false;
    renderMedia(q);
    renderQuestionList();
    markDirty();
  });
  xhr.addEventListener('error', () => {
    progress.classList.add('hidden');
    title.textContent = 'Drop an image, audio clip or video here';
    alert('Upload failed — is the server still running?');
  });
  xhr.send(body);
}

$('media-remove').addEventListener('click', async () => {
  const q = activeQuestion();
  if (!q?.media) return;
  const url = q.media.url;
  q.media = null;
  q.clipStart = 0;
  q.clipEnd = null;
  q.hideVideo = false;
  renderMedia(q);
  renderQuestionList();
  markDirty();
  // Best effort: reclaim the disk space too.
  apiSend('POST', '/api/upload/delete', { url }).catch(() => {});
});

function commitClipField(field, input) {
  const q = activeQuestion();
  if (!q) return;
  const raw = input.value.trim();

  if (!raw) {
    q[field] = field === 'clipStart' ? 0 : null;
  } else {
    const seconds = parseTime(raw);
    if (seconds == null) {
      input.value = field === 'clipStart' ? formatTime(q.clipStart) : formatTime(q.clipEnd);
      return;
    }
    q[field] = seconds;
  }

  // An end before the start is meaningless — drop it rather than guess.
  if (q.clipEnd != null && q.clipEnd <= q.clipStart) q.clipEnd = null;

  $('clip-start').value = q.clipStart ? formatTime(q.clipStart) : '';
  $('clip-end').value = q.clipEnd == null ? '' : formatTime(q.clipEnd);
  markDirty();
}

$('clip-start').addEventListener('change', (e) => commitClipField('clipStart', e.target));
$('clip-end').addEventListener('change', (e) => commitClipField('clipEnd', e.target));

$('hide-video').addEventListener('change', (e) => {
  activeQuestion().hideVideo = e.target.checked;
  markDirty();
});

$('clip-preview').addEventListener('click', () => {
  const q = activeQuestion();
  const el = $('media-el');
  if (!q || !el) return;

  el.pause();
  el.currentTime = q.clipStart ?? 0;
  el.play().catch(() => {});

  if (q.clipEnd != null) {
    const stopAt = () => {
      if (el.currentTime >= q.clipEnd) {
        el.pause();
        el.removeEventListener('timeupdate', stopAt);
      }
    };
    el.addEventListener('timeupdate', stopAt);
  }
});

// ---------------------------------------------------------------------------
// Validation report
// ---------------------------------------------------------------------------

$('validate-btn').addEventListener('click', async () => {
  clearTimeout(saveTimer);
  await save();
  try {
    const { problems } = await apiGet(`/api/quizzes/${quiz.id}`);
    showReport(problems);
  } catch (err) {
    showReport([err.message]);
  }
});

function showReport(problems) {
  const list = $('report-list');
  list.textContent = '';
  const ok = problems.length === 0;

  $('report-title').textContent = ok ? 'Ready to play' : `${problems.length} thing${problems.length === 1 ? '' : 's'} to fix`;
  list.className = 'report__list' + (ok ? ' report__list--ok' : '');

  const items = ok
    ? [`"${quiz.title}" has ${quiz.questions.length} question${quiz.questions.length === 1 ? '' : 's'} and is good to go.`]
    : problems;
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
  $('report').classList.remove('hidden');
}

$('report-close').addEventListener('click', () => $('report').classList.add('hidden'));
$('report').addEventListener('click', (e) => {
  if (e.target === $('report')) $('report').classList.add('hidden');
});

// ---------------------------------------------------------------------------
// Editor shell
// ---------------------------------------------------------------------------

$('quiz-title').addEventListener('input', (e) => {
  quiz.title = e.target.value;
  markDirty();
});

$('back-btn').addEventListener('click', async () => {
  clearTimeout(saveTimer);
  await save();
  location.hash = '';
});

async function openQuiz(quizId) {
  try {
    const body = await apiGet(`/api/quizzes/${quizId}`);
    quiz = body.quiz;
  } catch (err) {
    $('library-error').textContent = err.message;
    location.hash = '';
    return;
  }
  activeIndex = 0;
  $('quiz-title').value = quiz.title;
  setSaveState('Saved');
  renderQuestionList();
  renderQuestionEditor();
  showScreen('screen-editor', SCREENS);
}

async function route() {
  const match = /^#\/quiz\/([a-f0-9]{16})$/.exec(location.hash);
  if (match) {
    await openQuiz(match[1]);
  } else {
    quiz = null;
    showScreen('screen-library', SCREENS);
    loadLibrary();
  }
}

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function start() {
  try {
    config = await apiGet('/api/config');
  } catch {
    /* fall back to the defaults above */
  }

  $('media-limit').textContent = humanBytes(config.maxUploadBytes);

  const timeSelect = $('q-time');
  for (const seconds of config.timeLimits) {
    const opt = document.createElement('option');
    opt.value = String(seconds);
    opt.textContent = seconds >= 60 ? `${seconds / 60} min` : `${seconds} seconds`;
    timeSelect.appendChild(opt);
  }

  const pointSelect = $('q-points');
  const pointLabels = { 0: 'No points', 500: 'Half (500)', 1000: 'Standard (1000)', 2000: 'Double (2000)' };
  for (const value of config.pointValues) {
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = pointLabels[value] ?? String(value);
    pointSelect.appendChild(opt);
  }

  bindDropzone();
  route();
})();

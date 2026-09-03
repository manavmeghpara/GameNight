import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 3101;
const URL = `http://localhost:${PORT}`;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data', 'quizzes');
const UPLOAD_DIR = path.join(ROOT, 'uploads');

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

const get = async (p) => (await fetch(URL + p)).json();
const send = async (method, p, body) => {
  const res = await fetch(URL + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const createdQuizIds = [];
const touchedUploads = [];

// --- config -----------------------------------------------------------------

const config = await get('/api/config');
check('config exposes option limits', config.minOptions === 2 && config.maxOptions === 8, JSON.stringify(config));

// --- create -----------------------------------------------------------------

const made = await send('POST', '/api/quizzes', { title: 'Movie Night Vol. 1' });
check('creates a quiz', made.status === 201 && /^[a-f0-9]{16}$/.test(made.body.quiz.id), JSON.stringify(made.body));
const quizId = made.body.quiz.id;
createdQuizIds.push(quizId);
check('new quiz starts with one blank question', made.body.quiz.questions.length === 1);
check('blank quiz is not playable', made.body.problems.length > 0, JSON.stringify(made.body.problems));

// --- uploads ----------------------------------------------------------------

// A 1x1 png, small but genuinely an image file.
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function uploadFile(name, bytes, type) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${URL}/api/upload`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const up = await uploadFile('poster.png', pngBytes, 'image/png');
check('uploads an image', up.status === 201 && up.body.media.kind === 'image', JSON.stringify(up.body));
check('upload url is namespaced', /^\/uploads\/[A-Za-z0-9._-]+\.png$/.test(up.body.media.url ?? ''), up.body.media?.url);
touchedUploads.push(up.body.media.url);

const fetched = await fetch(URL + up.body.media.url);
check('uploaded file is served back', fetched.status === 200 && Number(fetched.headers.get('content-length')) === pngBytes.length);

const mp3 = await uploadFile('theme.mp3', Buffer.from('ID3fake-audio'), 'audio/mpeg');
check('uploads audio', mp3.status === 201 && mp3.body.media.kind === 'audio', JSON.stringify(mp3.body));
touchedUploads.push(mp3.body.media.url);

const mp4 = await uploadFile('scene.mp4', Buffer.from('fake-video-bytes'), 'video/mp4');
check('uploads video', mp4.status === 201 && mp4.body.media.kind === 'video', JSON.stringify(mp4.body));
touchedUploads.push(mp4.body.media.url);

const bad = await uploadFile('sneaky.exe', Buffer.from('MZ'), 'application/octet-stream');
check('rejects an unsupported type', bad.status === 400, JSON.stringify(bad.body));

// A file whose name lies about its type is stored by extension, not mimetype.
const liar = await uploadFile('trojan.png', Buffer.from('not really a png'), 'application/x-msdownload');
check('extension decides the kind, not the mimetype', liar.status === 201 && liar.body.media.kind === 'image');
touchedUploads.push(liar.body.media.url);

// --- saving a real quiz -----------------------------------------------------

const fullQuiz = {
  ...made.body.quiz,
  title: 'Movie Night Vol. 1',
  questions: [
    {
      id: 'a'.repeat(16),
      prompt: 'Which film is this poster from?',
      media: up.body.media,
      clipStart: 0,
      clipEnd: null,
      hideVideo: false,
      timeLimit: 30,
      points: 1000,
      options: [
        { id: '1'.repeat(16), text: 'Jaws' },
        { id: '2'.repeat(16), text: 'Alien' },
        { id: '3'.repeat(16), text: 'The Thing' },
      ],
      correctIndexes: [2],
    },
    {
      id: 'b'.repeat(16),
      prompt: 'Name this theme tune.',
      media: mp3.body.media,
      clipStart: 12.5,
      clipEnd: 30,
      hideVideo: false,
      timeLimit: 20,
      points: 2000,
      options: [
        { id: '4'.repeat(16), text: 'Star Wars' },
        { id: '5'.repeat(16), text: 'Indiana Jones' },
      ],
      correctIndexes: [0],
    },
  ],
};

const saved = await send('PUT', `/api/quizzes/${quizId}`, { quiz: fullQuiz });
check('saves a quiz', saved.status === 200, JSON.stringify(saved.body).slice(0, 200));
check('valid quiz has no problems', saved.body.problems.length === 0, JSON.stringify(saved.body.problems));
check('keeps 3 options on q1', saved.body.quiz.questions[0].options.length === 3);
check('keeps 2 options on q2', saved.body.quiz.questions[1].options.length === 2);
check('keeps the correct answer', JSON.stringify(saved.body.quiz.questions[0].correctIndexes) === '[2]',
  JSON.stringify(saved.body.quiz.questions[0].correctIndexes));
check('keeps clip window', saved.body.quiz.questions[1].clipStart === 12.5 && saved.body.quiz.questions[1].clipEnd === 30);

const reread = await get(`/api/quizzes/${quizId}`);
check('quiz survives a round trip', reread.quiz.questions.length === 2 && reread.quiz.title === 'Movie Night Vol. 1');

// --- normalisation / hostile input -----------------------------------------

const nasty = await send('PUT', `/api/quizzes/${quizId}`, {
  quiz: {
    title: '   ',
    questions: [
      {
        prompt: 'x'.repeat(500),
        media: { kind: 'image', url: '/uploads/../../server/index.js', name: 'hack' },
        timeLimit: 999,
        points: 999999,
        options: [{ text: 'only one' }],
        correctIndexes: [42],
      },
    ],
  },
});
const nq = nasty.body.quiz.questions[0];
check('blank title falls back', nasty.body.quiz.title === 'Untitled quiz', nasty.body.quiz.title);
check('prompt is truncated', nq.prompt.length === 300, String(nq.prompt.length));
check('path traversal media is dropped', nq.media === null, JSON.stringify(nq.media));
check('bogus time limit falls back', nq.timeLimit === 20, String(nq.timeLimit));
check('bogus points fall back', nq.points === 1000, String(nq.points));
check('option count is padded to the minimum', nq.options.length === 2, String(nq.options.length));
check('out-of-range correct answer falls back to the first option',
  JSON.stringify(nq.correctIndexes) === '[0]', JSON.stringify(nq.correctIndexes));
check('single-option question is flagged', nasty.body.problems.length > 0);

const tooMany = await send('PUT', `/api/quizzes/${quizId}`, {
  quiz: {
    title: 'Wide',
    questions: [
      {
        prompt: 'Pick one',
        options: Array.from({ length: 20 }, (_, i) => ({ text: `Option ${i}` })),
        correctIndexes: [0],
      },
    ],
  },
});
check('option count is capped at the maximum', tooMany.body.quiz.questions[0].options.length === 8, String(tooMany.body.quiz.questions[0].options.length));

// duplicate answer text is caught
const dupes = await send('PUT', `/api/quizzes/${quizId}`, {
  quiz: {
    title: 'Dupes',
    questions: [
      {
        prompt: 'Which?',
        options: [{ text: 'Jaws' }, { text: 'jaws' }, { text: 'Alien' }],
        correctIndexes: [0],
      },
    ],
  },
});
check('duplicate answers are flagged', dupes.body.problems.some((p) => /listed twice/.test(p)), JSON.stringify(dupes.body.problems));

// --- unknown ids ------------------------------------------------------------

const missing = await send('PUT', '/api/quizzes/ffffffffffffffff', { quiz: fullQuiz });
check('unknown quiz id is a 404', missing.status === 404);

const junkId = await fetch(`${URL}/api/quizzes/..%2F..%2Fpackage`);
check('traversal in the quiz id is refused', junkId.status === 404 || junkId.status === 400, String(junkId.status));

// --- duplicate --------------------------------------------------------------

await send('PUT', `/api/quizzes/${quizId}`, { quiz: fullQuiz }); // restore the good version
const copy = await send('POST', `/api/quizzes/${quizId}/duplicate`);
check('duplicates a quiz', copy.status === 201 && copy.body.quiz.id !== quizId, JSON.stringify(copy.body).slice(0, 150));
createdQuizIds.push(copy.body.quiz.id);
check('copy is titled as a copy', /\(copy\)$/.test(copy.body.quiz.title), copy.body.quiz.title);

const copiedUrl = copy.body.quiz.questions[0].media.url;
touchedUploads.push(copiedUrl);
check('copy owns its own media file', copiedUrl !== up.body.media.url, copiedUrl);
check('copied media is readable', (await fetch(URL + copiedUrl)).status === 200);

// Deleting the original must not break the copy's media.
await send('DELETE', `/api/quizzes/${quizId}`);
check('original media is gone', (await fetch(URL + up.body.media.url)).status === 404);
check("copy's media survives", (await fetch(URL + copiedUrl)).status === 200);

// --- listing ----------------------------------------------------------------

const listing = await get('/api/quizzes');
check('listing includes the copy', listing.quizzes.some((q) => q.id === copy.body.quiz.id));
check('listing omits the deleted quiz', !listing.quizzes.some((q) => q.id === quizId));

// --- cleanup ----------------------------------------------------------------

for (const id of createdQuizIds) await send('DELETE', `/api/quizzes/${id}`);
for (const url of touchedUploads) {
  if (url) await fs.rm(path.join(UPLOAD_DIR, path.basename(url)), { force: true });
}
const leftovers = await fs.readdir(DATA_DIR).catch(() => []);
check('test quizzes cleaned up', !leftovers.some((f) => createdQuizIds.includes(f.replace('.json', ''))));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
server.kill();
process.exit(fail ? 1 : 0);

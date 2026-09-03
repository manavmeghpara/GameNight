import express from 'express';

import {
  blankQuiz,
  blankQuestion,
  deleteQuiz,
  listQuizzes,
  normaliseQuiz,
  readQuiz,
  validateQuiz,
  writeQuiz,
  MAX_OPTIONS,
  MIN_OPTIONS,
  POINT_VALUES,
  TIME_LIMITS,
} from './quizzes.js';
import { copyUpload, deleteUpload, kindForFilename, upload, MAX_UPLOAD_BYTES } from './media.js';
import { ask, chatStatus } from './chat.js';

export const api = express.Router();

api.use(express.json({ limit: '2mb' }));

/** Shape limits, so the builder never hard-codes what the server enforces. */
api.get('/config', (req, res) => {
  res.json({
    minOptions: MIN_OPTIONS,
    maxOptions: MAX_OPTIONS,
    timeLimits: TIME_LIMITS,
    pointValues: POINT_VALUES,
    maxUploadBytes: MAX_UPLOAD_BYTES,
  });
});

// --- quizzes ----------------------------------------------------------------

api.get('/quizzes', async (req, res) => {
  res.json({ quizzes: await listQuizzes() });
});

api.post('/quizzes', async (req, res) => {
  const quiz = blankQuiz(req.body?.title);
  await writeQuiz(quiz);
  res.status(201).json({ quiz, problems: validateQuiz(quiz) });
});

api.get('/quizzes/:id', async (req, res) => {
  const quiz = await readQuiz(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
  res.json({ quiz, problems: validateQuiz(quiz) });
});

api.put('/quizzes/:id', async (req, res) => {
  const existing = await readQuiz(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Quiz not found.' });

  const quiz = normaliseQuiz(req.body?.quiz, existing);
  await writeQuiz(quiz);
  res.json({ quiz, problems: validateQuiz(quiz) });
});

api.delete('/quizzes/:id', async (req, res) => {
  const quiz = await readQuiz(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });

  // Clean up the media this quiz owned so uploads/ does not grow forever.
  for (const q of quiz.questions ?? []) {
    if (q.media?.url) await deleteUpload(q.media.url);
  }
  await deleteQuiz(req.params.id);
  res.json({ ok: true });
});

/** A fresh question object, so the client and server agree on defaults. */
api.get('/blank-question', (req, res) => {
  res.json({ question: blankQuestion() });
});

/** Copy an existing quiz — handy for reusing a format with new questions. */
api.post('/quizzes/:id/duplicate', async (req, res) => {
  const source = await readQuiz(req.params.id);
  if (!source) return res.status(404).json({ error: 'Quiz not found.' });

  const copy = normaliseQuiz(
    { ...source, title: `${source.title} (copy)`.slice(0, 80) },
    { ...blankQuiz(), createdAt: Date.now() },
  );
  // Give the copy its own media files so deleting either quiz is safe.
  for (const q of copy.questions) {
    if (q.media?.url) q.media = { ...q.media, url: await copyUpload(q.media.url) };
  }
  await writeQuiz(copy);
  res.status(201).json({ quiz: copy });
});

// --- uploads ----------------------------------------------------------------

api.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        error: tooBig
          ? `That file is over the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`
          : err.message,
      });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    res.status(201).json({
      media: {
        kind: kindForFilename(req.file.originalname),
        url: `/uploads/${req.file.filename}`,
        name: req.file.originalname.slice(0, 120),
      },
      size: req.file.size,
    });
  });
});

api.post('/upload/delete', async (req, res) => {
  res.json({ ok: await deleteUpload(req.body?.url) });
});

// --- movie assistant --------------------------------------------------------

api.get('/chat/status', (req, res) => {
  res.json(chatStatus());
});

api.post('/chat', async (req, res) => {
  const status = chatStatus();
  if (!status.ready) {
    return res.status(503).json({
      error: 'The movie assistant is not set up yet.',
      status,
    });
  }
  try {
    const { reply, history, toolCalls } = await ask(req.body?.history, req.body?.message);
    res.json({ reply, history, toolCalls });
  } catch (err) {
    // These are upstream failures (rate limits, bad keys, timeouts) rather than
    // bugs, so pass the message through — the panel shows it to the user.
    res.status(502).json({ error: err.message ?? 'The assistant failed to answer.' });
  }
});

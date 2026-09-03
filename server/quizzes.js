import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');
export const QUIZ_DIR = path.join(DATA_DIR, 'quizzes');

// --- shape limits -----------------------------------------------------------

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 8;
export const MAX_QUESTIONS = 100;
export const TIME_LIMITS = [5, 10, 20, 30, 45, 60, 90, 120];
export const POINT_VALUES = [0, 500, 1000, 2000];
export const MEDIA_KINDS = ['image', 'audio', 'video'];

const MAX_TITLE = 80;
const MAX_PROMPT = 300;
const MAX_OPTION = 120;

const id = () => randomBytes(8).toString('hex');

// --- helpers ----------------------------------------------------------------

const clampText = (raw, max) =>
  String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const num = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const nearest = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

export function blankOption() {
  return { id: id(), text: '' };
}

export function blankQuestion() {
  return {
    id: id(),
    prompt: '',
    media: null,
    clipStart: 0,
    clipEnd: null,
    hideVideo: false,
    timeLimit: 20,
    points: 1000,
    options: [blankOption(), blankOption(), blankOption(), blankOption()],
    // "Select all that apply" when true; exactly one right answer when false.
    multiSelect: false,
    correctIndexes: [0],
  };
}

export function blankQuiz(title = 'Untitled quiz') {
  const now = Date.now();
  return {
    id: id(),
    title: clampText(title, MAX_TITLE) || 'Untitled quiz',
    createdAt: now,
    updatedAt: now,
    questions: [blankQuestion()],
  };
}

// --- normalisation ----------------------------------------------------------

/** Media the client claims to have uploaded. We only keep fields we understand. */
function normaliseMedia(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!MEDIA_KINDS.includes(raw.kind)) return null;
  const url = String(raw.url ?? '');
  // Only ever reference files inside our own uploads folder.
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  return {
    kind: raw.kind,
    url,
    name: clampText(raw.name, 120),
  };
}

function normaliseQuestion(raw) {
  const base = blankQuestion();
  if (!raw || typeof raw !== 'object') return base;

  let options = Array.isArray(raw.options) ? raw.options : [];
  options = options
    .slice(0, MAX_OPTIONS)
    .map((o) => ({ id: typeof o?.id === 'string' ? o.id : id(), text: clampText(o?.text, MAX_OPTION) }));
  while (options.length < MIN_OPTIONS) options.push(blankOption());

  const media = normaliseMedia(raw.media);
  const clipStart = Math.max(0, num(raw.clipStart, 0));
  let clipEnd = raw.clipEnd == null ? null : Math.max(0, num(raw.clipEnd, 0));
  if (clipEnd !== null && clipEnd <= clipStart) clipEnd = null;

  const multiSelect = Boolean(raw.multiSelect);

  // Accepts the current shape (correctIndexes) and the original single-answer
  // shape (correctIndex), so quizzes saved before multi-select still load.
  const rawCorrect = Array.isArray(raw.correctIndexes)
    ? raw.correctIndexes
    : raw.correctIndex != null
      ? [raw.correctIndex]
      : [];

  let correctIndexes = [...new Set(rawCorrect.map((n) => Math.trunc(num(n, -1))))]
    .filter((i) => i >= 0 && i < options.length)
    .sort((a, b) => a - b);

  if (!correctIndexes.length) correctIndexes = [0];
  // A single-answer question can only ever have one right answer.
  if (!multiSelect) correctIndexes = [correctIndexes[0]];

  return {
    id: typeof raw.id === 'string' ? raw.id : base.id,
    prompt: clampText(raw.prompt, MAX_PROMPT),
    media,
    clipStart,
    clipEnd,
    // "Audio only" mode: play a video's sound with the picture hidden.
    hideVideo: media?.kind === 'video' && Boolean(raw.hideVideo),
    timeLimit: nearest(num(raw.timeLimit, 20), TIME_LIMITS, 20),
    points: nearest(num(raw.points, 1000), POINT_VALUES, 1000),
    options,
    multiSelect,
    correctIndexes,
  };
}

/**
 * Accepts anything from the client and returns a well-formed quiz.
 * Pass `touch: false` when reading from disk, so migrating an old file in
 * memory does not make it look freshly edited.
 */
export function normaliseQuiz(raw, existing = null, { touch = true } = {}) {
  const questions = (Array.isArray(raw?.questions) ? raw.questions : [])
    .slice(0, MAX_QUESTIONS)
    .map(normaliseQuestion);

  return {
    id: existing?.id ?? (typeof raw?.id === 'string' ? raw.id : id()),
    title: clampText(raw?.title, MAX_TITLE) || 'Untitled quiz',
    createdAt: existing?.createdAt ?? num(raw?.createdAt, Date.now()),
    updatedAt: touch ? Date.now() : num(raw?.updatedAt, Date.now()),
    questions: questions.length ? questions : [blankQuestion()],
  };
}

// --- validation (what makes a quiz playable) --------------------------------

/**
 * Returns a list of human-readable problems. An empty list means the quiz can
 * be played. Used by the builder to show warnings and by the host to gate start.
 */
export function validateQuiz(quiz) {
  const problems = [];
  if (!quiz.questions.length) problems.push('The quiz has no questions.');

  quiz.questions.forEach((q, i) => {
    const where = `Question ${i + 1}`;
    if (!q.prompt) problems.push(`${where}: needs a question to ask.`);

    const filled = q.options.filter((o) => o.text.length > 0);
    if (filled.length < MIN_OPTIONS) {
      problems.push(`${where}: needs at least ${MIN_OPTIONS} answer options.`);
    }

    if (!q.correctIndexes.length) {
      problems.push(`${where}: mark at least one correct answer.`);
    } else if (q.correctIndexes.some((i) => !q.options[i]?.text)) {
      problems.push(
        q.correctIndexes.length > 1
          ? `${where}: one of the correct answers is blank.`
          : `${where}: the correct answer is blank.`,
      );
    } else if (q.multiSelect && q.correctIndexes.length === filled.length) {
      // Nothing to get wrong makes the question free points.
      problems.push(`${where}: every option is marked correct — add a wrong answer.`);
    }
    const seen = new Set();
    for (const o of filled) {
      const key = o.text.toLowerCase();
      if (seen.has(key)) {
        problems.push(`${where}: "${o.text}" is listed twice.`);
        break;
      }
      seen.add(key);
    }
  });

  return problems;
}

/** Strips blank options so the played quiz matches what admins see. */
export function compactQuestion(q) {
  const options = q.options.filter((o) => o.text.length > 0);

  // Follow the correct answers by id, since dropping blanks shifts the indexes.
  const correctIds = new Set(q.correctIndexes.map((i) => q.options[i]?.id).filter(Boolean));
  let correctIndexes = options.reduce(
    (acc, option, i) => (correctIds.has(option.id) ? [...acc, i] : acc),
    [],
  );
  if (!correctIndexes.length) correctIndexes = [0];

  return { ...q, options, correctIndexes };
}

// --- persistence ------------------------------------------------------------

const quizPath = (quizId) => path.join(QUIZ_DIR, `${quizId}.json`);

const isSafeId = (value) => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);

export async function ensureDirs() {
  await fs.mkdir(QUIZ_DIR, { recursive: true });
}

export async function listQuizzes() {
  await ensureDirs();
  const files = await fs.readdir(QUIZ_DIR);
  const summaries = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(QUIZ_DIR, file), 'utf8'));
      const quiz = normaliseQuiz(parsed, parsed, { touch: false });
      summaries.push({
        id: quiz.id,
        title: quiz.title,
        questionCount: quiz.questions?.length ?? 0,
        updatedAt: quiz.updatedAt,
        problems: validateQuiz(quiz).length,
      });
    } catch {
      // Skip anything unreadable rather than failing the whole listing.
    }
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readQuiz(quizId) {
  if (!isSafeId(quizId)) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(quizPath(quizId), 'utf8'));
    // Normalising on read migrates quizzes saved by older versions (single
    // correctIndex) without rewriting the file or bumping its edited time.
    return normaliseQuiz(parsed, parsed, { touch: false });
  } catch {
    return null;
  }
}

export async function writeQuiz(quiz) {
  await ensureDirs();
  if (!isSafeId(quiz.id)) throw new Error('Bad quiz id.');
  // Write to a temp file first so a crash mid-write cannot corrupt a saved quiz.
  const tmp = `${quizPath(quiz.id)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(quiz, null, 2), 'utf8');
  await fs.rename(tmp, quizPath(quiz.id));
  return quiz;
}

export async function deleteQuiz(quizId) {
  if (!isSafeId(quizId)) return false;
  try {
    await fs.unlink(quizPath(quizId));
    return true;
  } catch {
    return false;
  }
}

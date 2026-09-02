import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024; // 250 MB — enough for a clip

/**
 * Extensions we accept, and the kind of question media each becomes.
 * Kept to formats browsers can play without extra codecs.
 */
const EXTENSIONS = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.mp3': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.ogg': 'audio',
  '.oga': 'audio',
  '.wav': 'audio',
  '.flac': 'audio',
  '.mp4': 'video',
  '.m4v': 'video',
  '.webm': 'video',
  '.ogv': 'video',
  '.mov': 'video',
};

export function kindForFilename(name) {
  return EXTENSIONS[path.extname(name).toLowerCase()] ?? null;
}

export async function ensureUploadDir() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Never trust the client's filename on disk — keep only the extension.
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const kind = kindForFilename(file.originalname);
    if (!kind) {
      cb(new Error('Unsupported file type. Use an image, audio or video file.'));
      return;
    }
    cb(null, true);
  },
});

/**
 * Copies an uploaded file and returns the new /uploads/... url, so a duplicated
 * quiz owns its own media and deleting the original cannot orphan the copy.
 * Returns the original url if the file cannot be copied.
 */
export async function copyUpload(url) {
  const match = /^\/uploads\/([A-Za-z0-9._-]+)$/.exec(String(url ?? ''));
  if (!match) return url;
  const ext = path.extname(match[1]).toLowerCase();
  const name = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}${ext}`;
  try {
    await fs.copyFile(path.join(UPLOAD_DIR, match[1]), path.join(UPLOAD_DIR, name));
    return `/uploads/${name}`;
  } catch {
    return url;
  }
}

/** Deletes an uploaded file given its public /uploads/... url. */
export async function deleteUpload(url) {
  const match = /^\/uploads\/([A-Za-z0-9._-]+)$/.exec(String(url ?? ''));
  if (!match) return false;
  try {
    await fs.unlink(path.join(UPLOAD_DIR, match[1]));
    return true;
  } catch {
    return false;
  }
}

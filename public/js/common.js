/* Shared helpers for the host and player pages. */

const $ = (id) => document.getElementById(id);

/** Show exactly one of the given screen ids. */
function showScreen(id, allIds) {
  for (const other of allIds) $(other).classList.toggle('hidden', other !== id);
}

/** Top-of-page status strip, used for connection state. */
function banner(text) {
  const el = $('banner');
  if (!el) return;
  if (!text) {
    el.classList.add('hidden');
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden');
}

/** localStorage that never throws (private mode, blocked storage). */
const store = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
  clear(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/** 16 hex chars, matching the ids the server hands out.
 *  crypto.randomUUID is unavailable over plain http on a LAN address, so this
 *  falls back to getRandomValues, which is not restricted to secure contexts. */
function randomId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** socket.emit with an ack, as a promise. */
function ask(socket, event, payload = {}) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (reply) => resolve(reply ?? { ok: false, error: 'No response.' }));
  });
}

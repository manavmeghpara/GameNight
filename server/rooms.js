import { randomBytes } from 'node:crypto';

// Ambiguous characters (0/O, 1/I/L) are left out so codes are easy to read off a TV.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

const MAX_PLAYERS = 60;
const MAX_NAME_LENGTH = 16;

/** @type {Map<string, Room>} */
const rooms = new Map();

function randomCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function uniqueCode() {
  let code = randomCode();
  while (rooms.has(code)) code = randomCode();
  return code;
}

function token() {
  return randomBytes(16).toString('hex');
}

/**
 * A room is one hosted game session. It owns the players and, from step 3
 * onwards, the running game state.
 */
class Room {
  constructor(code) {
    this.code = code;
    this.hostToken = token();
    this.hostSocketId = null;
    /** @type {Map<string, Player>} */
    this.players = new Map();
    /** @type {import('./game.js').Game | null} set once the host starts */
    this.game = null;
    this.createdAt = Date.now();
  }

  /** The room's phase is whatever the running game says, or 'lobby'. */
  get phase() {
    return this.game?.phase ?? 'lobby';
  }

  /** Tear down a running game and put everyone back in the lobby. */
  reset() {
    this.game?.destroy();
    this.game = null;
    for (const player of this.players.values()) {
      player.score = 0;
      player.streak = 0;
    }
  }

  get playerList() {
    return [...this.players.values()].map((p) => p.toPublic());
  }

  get connectedCount() {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  nameTaken(name, exceptId = null) {
    const wanted = name.trim().toLowerCase();
    for (const p of this.players.values()) {
      if (p.id !== exceptId && p.name.toLowerCase() === wanted) return true;
    }
    return false;
  }

  addPlayer(name, socketId) {
    const player = new Player(token(), name, socketId);
    this.players.set(player.id, player);
    return player;
  }

  removePlayer(playerId) {
    return this.players.delete(playerId);
  }

  playerBySocket(socketId) {
    for (const p of this.players.values()) {
      if (p.socketId === socketId) return p;
    }
    return null;
  }
}

class Player {
  constructor(id, name, socketId) {
    this.id = id;
    this.name = name;
    this.socketId = socketId;
    this.connected = true;
    this.score = 0;
    this.streak = 0;
    this.joinedAt = Date.now();
  }

  toPublic() {
    return {
      id: this.id,
      name: this.name,
      connected: this.connected,
      score: this.score,
    };
  }
}

export function createRoom() {
  const room = new Room(uniqueCode());
  rooms.set(room.code, room);
  return room;
}

export function getRoom(code) {
  if (typeof code !== 'string') return null;
  return rooms.get(code.trim().toUpperCase()) ?? null;
}

export function deleteRoom(code) {
  rooms.delete(code);
}

export function listRooms() {
  return [...rooms.values()];
}

/**
 * Validates a requested nickname. Returns { ok, name } or { ok:false, error }.
 */
export function validateName(raw) {
  const name = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  if (name.length < 1) return { ok: false, error: 'Enter a nickname.' };
  return { ok: true, name };
}

export { MAX_PLAYERS, MAX_NAME_LENGTH };

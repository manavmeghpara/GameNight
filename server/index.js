import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { Server } from 'socket.io';

import {
  createRoom,
  getRoom,
  deleteRoom,
  listRooms,
  validateName,
  MAX_PLAYERS,
} from './rooms.js';
import { api } from './api.js';
import { ensureUploadDir, UPLOAD_DIR } from './media.js';
import { ensureDirs, readQuiz, validateQuiz } from './quizzes.js';
import { Game } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;

// A room with no connected host for this long is abandoned and swept away.
const ROOM_TTL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(PUBLIC_DIR));

// Uploaded media. Immutable filenames, so cache them hard.
app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    maxAge: '365d',
    immutable: true,
    setHeaders: (res) => res.setHeader('Accept-Ranges', 'bytes'),
  }),
);

/** LAN addresses so the host screen can tell players where to point their phones. */
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

app.get('/api/info', (req, res) => {
  res.json({ port: PORT, addresses: lanAddresses() });
});

app.use('/api', api);

// ---------------------------------------------------------------------------
// Socket wiring
// ---------------------------------------------------------------------------

const hostRoomKey = (code) => `host:${code}`;
const playersRoomKey = (code) => `players:${code}`;

function broadcastPlayers(room) {
  io.to(hostRoomKey(room.code)).emit('room:players', {
    players: room.playerList,
    connected: room.connectedCount,
  });
}

/** Everything a player needs to render their screen right now. */
function playerStateFor(room, player) {
  return {
    code: room.code,
    phase: room.phase,
    player: player.toPublic(),
    playerCount: room.players.size,
    // Present only mid-game, so a refreshed phone lands back where it was.
    game: room.game ? room.game.stateForPlayer(player) : null,
  };
}

/** How a Game talks to the three audiences in its room. */
function hooksFor(room) {
  return {
    toHost: (event, payload) => io.to(hostRoomKey(room.code)).emit(event, payload),
    toPlayers: (event, payload) => io.to(playersRoomKey(room.code)).emit(event, payload),
    toPlayer: (player, event, payload) => io.to(player.socketId).emit(event, payload),
  };
}

io.on('connection', (socket) => {
  // What this socket currently is. Set on create/join, read on disconnect.
  socket.data.role = null; // 'host' | 'player'
  socket.data.code = null;
  socket.data.playerId = null;

  function attachHost(room) {
    room.hostSocketId = socket.id;
    socket.data.role = 'host';
    socket.data.code = room.code;
    socket.join(hostRoomKey(room.code));
  }

  socket.on('host:create', (_payload, ack) => {
    const room = createRoom();
    attachHost(room);
    console.log(`[room ${room.code}] created`);
    ack?.({
      ok: true,
      code: room.code,
      hostToken: room.hostToken,
      players: room.playerList,
    });
  });

  socket.on('host:resume', ({ code, hostToken } = {}, ack) => {
    const room = getRoom(code);
    if (!room) return ack?.({ ok: false, error: 'That game no longer exists.' });
    if (room.hostToken !== hostToken) {
      return ack?.({ ok: false, error: 'Not the host of this game.' });
    }
    attachHost(room);
    io.to(playersRoomKey(room.code)).emit('host:reconnected');
    console.log(`[room ${room.code}] host resumed`);
    ack?.({
      ok: true,
      code: room.code,
      hostToken: room.hostToken,
      players: room.playerList,
      phase: room.phase,
    });
  });

  socket.on('player:join', ({ code, name } = {}, ack) => {
    const room = getRoom(code);
    if (!room) return ack?.({ ok: false, error: 'No game with that code.' });
    if (room.phase !== 'lobby') {
      return ack?.({ ok: false, error: 'That game has already started.' });
    }
    if (room.players.size >= MAX_PLAYERS) {
      return ack?.({ ok: false, error: 'This game is full.' });
    }

    const check = validateName(name);
    if (!check.ok) return ack?.({ ok: false, error: check.error });
    if (room.nameTaken(check.name)) {
      return ack?.({ ok: false, error: 'Someone already took that name.' });
    }

    const player = room.addPlayer(check.name, socket.id);
    socket.data.role = 'player';
    socket.data.code = room.code;
    socket.data.playerId = player.id;
    socket.join(playersRoomKey(room.code));

    console.log(`[room ${room.code}] + ${player.name}`);
    ack?.({ ok: true, playerId: player.id, state: playerStateFor(room, player) });
    broadcastPlayers(room);
  });

  socket.on('player:resume', ({ code, playerId } = {}, ack) => {
    const room = getRoom(code);
    if (!room) return ack?.({ ok: false, error: 'No game with that code.' });
    const player = room.players.get(playerId);
    if (!player) return ack?.({ ok: false, error: 'You are not in this game.' });

    player.socketId = socket.id;
    player.connected = true;
    socket.data.role = 'player';
    socket.data.code = room.code;
    socket.data.playerId = player.id;
    socket.join(playersRoomKey(room.code));

    console.log(`[room ${room.code}] ~ ${player.name} reconnected`);
    ack?.({ ok: true, playerId: player.id, state: playerStateFor(room, player) });
    broadcastPlayers(room);
  });

  socket.on('host:kick', ({ playerId } = {}, ack) => {
    const room = getRoom(socket.data.code);
    if (!room || room.hostSocketId !== socket.id) {
      return ack?.({ ok: false, error: 'Not the host.' });
    }
    const player = room.players.get(playerId);
    if (!player) return ack?.({ ok: false, error: 'No such player.' });

    room.removePlayer(playerId);
    io.to(player.socketId).emit('player:kicked');
    io.sockets.sockets.get(player.socketId)?.leave(playersRoomKey(room.code));
    console.log(`[room ${room.code}] - ${player.name} (kicked)`);
    ack?.({ ok: true });
    broadcastPlayers(room);
  });

  // -------------------------------------------------------------------------
  // Running a game
  // -------------------------------------------------------------------------

  /** Resolves the room only if this socket is genuinely its host. */
  function asHost() {
    const room = getRoom(socket.data.code);
    if (!room || room.hostSocketId !== socket.id) return null;
    return room;
  }

  socket.on('host:start', async ({ quizId } = {}, ack) => {
    const room = asHost();
    if (!room) return ack?.({ ok: false, error: 'Not the host.' });
    if (room.game) return ack?.({ ok: false, error: 'A game is already running.' });
    if (room.players.size === 0) {
      return ack?.({ ok: false, error: 'Nobody has joined yet.' });
    }

    const quiz = await readQuiz(quizId);
    if (!quiz) return ack?.({ ok: false, error: 'That quiz no longer exists.' });

    const problems = validateQuiz(quiz);
    if (problems.length) {
      return ack?.({ ok: false, error: 'That quiz is not ready to play.', problems });
    }

    room.game = new Game(room, quiz, hooksFor(room));
    console.log(`[room ${room.code}] started "${quiz.title}" (${room.game.total} questions)`);
    ack?.({ ok: true, title: quiz.title, total: room.game.total });
    room.game.start();
  });

  socket.on('host:advance', (_payload, ack) => {
    const room = asHost();
    if (!room) return ack?.({ ok: false, error: 'Not the host.' });
    if (!room.game) return ack?.({ ok: false, error: 'No game is running.' });
    const moved = room.game.advance();
    ack?.({ ok: moved, phase: room.game.phase });
  });

  socket.on('host:reset', (_payload, ack) => {
    const room = asHost();
    if (!room) return ack?.({ ok: false, error: 'Not the host.' });
    room.reset();
    io.to(playersRoomKey(room.code)).emit('game:reset');
    console.log(`[room ${room.code}] back to the lobby`);
    ack?.({ ok: true });
    broadcastPlayers(room);
  });

  socket.on('player:answer', ({ optionIndex, indexes } = {}, ack) => {
    const room = getRoom(socket.data.code);
    if (!room?.game) return ack?.({ ok: false, error: 'No game is running.' });
    const player = room.players.get(socket.data.playerId);
    if (!player || player.socketId !== socket.id) {
      return ack?.({ ok: false, error: 'You are not in this game.' });
    }
    // `indexes` for a multi-answer question, `optionIndex` for a single one.
    ack?.(room.game.submitAnswer(player, indexes ?? optionIndex));
  });

  socket.on('host:close', (_payload, ack) => {
    const room = getRoom(socket.data.code);
    if (!room || room.hostSocketId !== socket.id) {
      return ack?.({ ok: false, error: 'Not the host.' });
    }
    io.to(playersRoomKey(room.code)).emit('room:closed');
    room.game?.destroy();
    deleteRoom(room.code);
    console.log(`[room ${room.code}] closed by host`);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket.data.code);
    if (!room) return;

    if (socket.data.role === 'host' && room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      io.to(playersRoomKey(room.code)).emit('host:disconnected');
      console.log(`[room ${room.code}] host disconnected`);
      return;
    }

    if (socket.data.role === 'player') {
      const player = room.players.get(socket.data.playerId);
      if (!player || player.socketId !== socket.id) return;
      player.connected = false;
      console.log(`[room ${room.code}] ~ ${player.name} dropped`);
      broadcastPlayers(room);
    }
  });
});

// Sweep rooms whose host walked away and never came back.
setInterval(() => {
  const now = Date.now();
  for (const room of listRooms()) {
    if (room.hostSocketId === null && now - room.createdAt > ROOM_TTL_MS) {
      io.to(playersRoomKey(room.code)).emit('room:closed');
      room.game?.destroy();
      deleteRoom(room.code);
      console.log(`[room ${room.code}] swept (abandoned)`);
    }
  }
}, SWEEP_INTERVAL_MS).unref();

await ensureDirs();
await ensureUploadDir();

httpServer.listen(PORT, () => {
  console.log(`\n  GameNight is up.\n`);
  console.log(`  Quiz builder: http://localhost:${PORT}/admin.html`);
  console.log(`  Host screen : http://localhost:${PORT}/host.html`);
  for (const ip of lanAddresses()) {
    console.log(`  Players     : http://${ip}:${PORT}`);
  }
  console.log('');
});

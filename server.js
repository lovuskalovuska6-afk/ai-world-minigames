
'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 12;

const VALID_GAMES = new Set([
  'parkour',
  'redlight',
  'tiles',
  'lava',
  'obstacles'
]);

const rooms = new Map();

const COLORS = [
  '#ffbb55',
  '#70d6a0',
  '#d18cff',
  '#ff718b',
  '#62c9ff',
  '#f6d365',
  '#ff8c69'
];

const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

app.use(express.static(PUBLIC_DIR));

app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get('/', (req, res) => {
  res.sendFile(INDEX_FILE);
});

app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/socket.io/') ||
    path.extname(req.path) !== ''
  ) {
    return next();
  }

  res.sendFile(INDEX_FILE, err => {
    if (err && !res.headersSent) next(err);
  });
});

function cleanName(value) {
  return String(value || 'Игрок')
    .replace(/[<>\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 18) || 'Игрок';
}

function cleanCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

function cleanMessage(value) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, 160);
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;

  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

function playerList(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    alive: p.alive,
    finished: p.finished,
    color: p.color
  }));
}

function publicRoom(room, viewerId) {
  return {
    code: room.code,
    game: room.game,
    hostId: room.hostId,
    hostName: room.players.get(room.hostId)?.name || 'Игрок',
    status: room.status,
    isPublic: room.isPublic,
    maxPlayers: room.maxPlayers,
    players: playerList(room),
    playerCount: room.players.size,
    isHost: room.hostId === viewerId
  };
}

function roomSummary(room) {
  return {
    code: room.code,
    game: room.game,
    hostId: room.hostId,
    hostName: room.players.get(room.hostId)?.name || 'Игрок',
    status: room.status,
    isPublic: room.isPublic,
    maxPlayers: room.maxPlayers,
    playerCount: room.players.size
  };
}

function publicRooms() {
  return [...rooms.values()]
    .filter(room => room.isPublic)
    .map(roomSummary);
}

function emitRoom(room) {
  io.to(room.code).emit('room:update', publicRoom(room, null));
  io.emit('rooms:list:update', publicRooms());
}

function error(cb, message) {
  if (typeof cb === 'function') cb({ ok: false, error: message });
}

function success(cb, payload) {
  if (typeof cb === 'function') cb({ ok: true, ...payload });
}

function findRoomFor(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function isHost(socket, room) {
  return !!room && room.hostId === socket.id;
}

function addPlayer(room, socket, name) {
  const player = {
    id: socket.id,
    name: cleanName(name),
    x: 0,
    y: 0.02,
    z: 3,
    yaw: 0,
    alive: true,
    finished: false,
    color: COLORS[room.players.size % COLORS.length]
  };

  room.players.set(socket.id, player);
  socket.join(room.code);
  socket.data.roomCode = room.code;

  return player;
}

function removePlayer(socket) {
  const room = findRoomFor(socket);
  if (!room) return;

  room.players.delete(socket.id);
  socket.leave(room.code);
  delete socket.data.roomCode;

  if (room.players.size === 0) {
    rooms.delete(room.code);
    io.emit('rooms:list:update', publicRooms());
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }

  emitRoom(room);
}

function playerUpdatePayload(p) {
  return {
    id: p.id,
    playerId: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    alive: p.alive,
    finished: p.finished,
    color: p.color
  };
}

io.on('connection', socket => {
  socket.on('rooms:list', cb => {
    success(cb, { rooms: publicRooms() });
  });

  socket.on('room:create', (data = {}, cb) => {
    if (findRoomFor(socket)) removePlayer(socket);

    const game = VALID_GAMES.has(data.game) ? data.game : 'parkour';
    const code = makeCode();

    const room = {
      code,
      game,
      hostId: socket.id,
      status: 'lobby',
      isPublic: !!data.isPublic,
      maxPlayers: MAX_PLAYERS,
      players: new Map()
    };

    rooms.set(code, room);
    addPlayer(room, socket, data.name);
    emitRoom(room);

    success(cb, {
      code,
      room: publicRoom(room, socket.id),
      isHost: true
    });
  });

  function joinRoom(socket, data, cb, requirePublic) {
    const code = cleanCode(data.code);
    const room = rooms.get(code);

    if (!room) return error(cb, 'Комната с таким кодом не найдена.');
    if (requirePublic && !room.isPublic) {
      return error(cb, 'Эта комната приватная.');
    }
    if (room.status !== 'lobby') {
      return error(cb, 'Раунд уже идёт. Попробуй позже.');
    }
    if (room.players.size >= room.maxPlayers) {
      return error(cb, 'Комната заполнена.');
    }

    if (findRoomFor(socket)) removePlayer(socket);

    addPlayer(room, socket, data.name);
    emitRoom(room);

    success(cb, {
      code: room.code,
      room: publicRoom(room, socket.id),
      isHost: room.hostId === socket.id
    });
  }

  socket.on('room:join', (data = {}, cb) => {
    joinRoom(socket, data, cb, false);
  });

  socket.on('room:join-public', (data = {}, cb) => {
    joinRoom(socket, data, cb, true);
  });

  socket.on('room:settings', (data = {}, cb) => {
    const room = findRoomFor(socket);

    if (!room) return error(cb, 'Ты не находишься в комнате.');
    if (!isHost(socket, room)) {
      return error(cb, 'Только создатель может менять доступ.');
    }

    room.isPublic = !!data.isPublic;
    emitRoom(room);

    success(cb, {
      room: publicRoom(room, socket.id),
      isPublic: room.isPublic
    });
  });

  socket.on('game:select', (data = {}, cb) => {
    const room = findRoomFor(socket);

    if (!room) return error(cb, 'Сначала войди в комнату.');
    if (!isHost(socket, room)) {
      return error(cb, 'Выбирать мини-игру может только создатель.');
    }
    if (room.status !== 'lobby') {
      return error(cb, 'Нельзя менять игру во время раунда.');
    }
    if (!VALID_GAMES.has(data.game)) {
      return error(cb, 'Неизвестная мини-игра.');
    }

    room.game = data.game;
    emitRoom(room);
    success(cb, { game: room.game });
  });

  socket.on('game:start', (_data = {}, cb) => {
    const room = findRoomFor(socket);

    if (!room) return error(cb, 'Сначала войди в комнату.');
    if (!isHost(socket, room)) {
      return error(cb, 'Начать общий раунд может только создатель.');
    }
    if (room.status === 'playing') {
      return error(cb, 'Раунд уже идёт.');
    }
    if (room.players.size < 2) {
      return error(cb, 'Для мультиплеера нужны минимум 2 игрока.');
    }

    room.status = 'playing';

    for (const p of room.players.values()) {
      p.x = 0;
      p.y = 0.02;
      p.z = 3;
      p.yaw = 0;
      p.alive = true;
      p.finished = false;
    }

    emitRoom(room);

    io.to(room.code).emit('game:started', {
      game: room.game,
      code: room.code
    });

    success(cb, { game: room.game });
  });

  // Движение и синхронизация состояния игрока.
  socket.on('player:move', data => {
    const room = findRoomFor(socket);

    if (!room || room.status !== 'playing' || !data) return;

    const p = room.players.get(socket.id);
    if (!p) return;

    const num = (value, fallback = 0) => (
      Number.isFinite(Number(value))
        ? Math.max(-100, Math.min(100, Number(value)))
        : fallback
    );

    p.x = num(data.x, p.x);
    p.y = num(data.y, p.y);
    p.z = num(data.z, p.z);
    p.yaw = num(data.yaw, p.yaw);

    // FIX: клиент отправляет alive:true и finished:false
    // при нажатии «Заново». Сервер должен принять оба значения.
    if (typeof data.alive === 'boolean') {
      p.alive = data.alive;
    }

    if (typeof data.finished === 'boolean') {
      p.finished = data.finished;
    }

    socket.to(room.code).volatile.emit(
      'player:moved',
      playerUpdatePayload(p)
    );
  });

  // Явное возрождение игрока — независимо от других игроков.
  socket.on('player:respawn', (_data = {}, cb) => {
    const room = findRoomFor(socket);

    if (!room || room.status !== 'playing') {
      return error(cb, 'Сейчас нельзя возродиться.');
    }

    const p = room.players.get(socket.id);
    if (!p) return error(cb, 'Игрок не найден.');

    p.x = 0;
    p.y = 0.02;
    p.z = 3;
    p.yaw = 0;
    p.alive = true;
    p.finished = false;

    io.to(room.code).emit(
      'player:respawned',
      playerUpdatePayload(p)
    );

    emitRoom(room);

    success(cb, { player: p });
  });

  socket.on('game:event', event => {
    const room = findRoomFor(socket);

    if (!room || room.status !== 'playing' || !event) return;

    const p = room.players.get(socket.id);
    if (!p) return;

    if (event.type === 'finished') {
      p.finished = true;
    } else if (event.type === 'eliminated') {
      p.alive = false;
    } else {
      return;
    }

    io.to(room.code).emit('game:event', {
      type: event.type,
      detail: cleanMessage(event.detail),
      playerId: socket.id
    });

    emitRoom(room);
  });

  socket.on('chat:send', data => {
    const room = findRoomFor(socket);
    if (!room) return;

    const message = cleanMessage(data?.message);
    if (!message) return;

    const now = Date.now();

    if (socket.data.lastChat && now - socket.data.lastChat < 450) {
      return;
    }

    socket.data.lastChat = now;

    const p = room.players.get(socket.id);

    io.to(room.code).emit('chat:message', {
      message,
      name: p?.name || cleanName(data?.name),
      playerId: socket.id
    });
  });

  socket.on('disconnect', () => {
    removePlayer(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AI WORLD server listening on ${PORT}`);
  console.log(`Static files directory: ${PUBLIC_DIR}`);
});

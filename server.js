
"use strict";

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 12;
const rooms = new Map();
const socketRooms = new Map();

const GAME_NAMES = {
  parkour: "3D Паркур",
  redlight: "Красный свет",
  tiles: "Исчезающие плитки",
  lava: "Поднимающаяся лава",
  obstacles: "Полоса препятствий"
};

function cleanName(value) {
  return String(value || "Игрок").trim().slice(0, 18) || "Игрок";
}

function validGame(game) {
  return Object.prototype.hasOwnProperty.call(GAME_NAMES, game);
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = "";
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));

  return code;
}

function getRoom(socket) {
  const code = socketRooms.get(socket.id);
  return code ? rooms.get(code) : null;
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    alive: player.alive,
    finished: player.finished
  };
}

function publicRoom(room, viewerId = null) {
  return {
    code: room.code,
    game: room.game,
    isPublic: room.isPublic,
    status: room.status,
    hostId: room.hostId,
    isHost: viewerId === room.hostId,
    maxPlayers: MAX_PLAYERS,
    playerCount: room.players.size,
    hostName: room.players.get(room.hostId)?.name || "Игрок",
    players: [...room.players.values()].map(publicPlayer)
  };
}

function respond(callback, data) {
  if (typeof callback === "function") callback(data);
}

function fail(callback, error) {
  respond(callback, { ok: false, error });
}

function ok(callback, data = {}) {
  respond(callback, { ok: true, ...data });
}

function publishRoom(room) {
  if (!room) return;

  io.to(room.code).emit("room:update", publicRoom(room));
  publishRoomList();
}

function publishRoomList() {
  const list = [...rooms.values()]
    .filter(room => room.isPublic)
    .map(room => ({
      code: room.code,
      game: room.game,
      status: room.status,
      hostName: room.players.get(room.hostId)?.name || "Игрок",
      playerCount: room.players.size,
      maxPlayers: MAX_PLAYERS
    }));

  io.emit("rooms:list:update", list);
}

function leaveRoom(socket) {
  const room = getRoom(socket);
  if (!room) {
    socketRooms.delete(socket.id);
    return;
  }

  room.players.delete(socket.id);
  socketRooms.delete(socket.id);
  socket.leave(room.code);

  if (room.players.size === 0) {
    rooms.delete(room.code);
    publishRoomList();
    return;
  }

  if (!room.players.has(room.hostId)) {
    room.hostId = room.players.keys().next().value;
  }

  if (room.status === "playing") {
    room.status = "lobby";
    for (const player of room.players.values()) {
      player.alive = true;
      player.finished = false;
    }
  }

  publishRoom(room);
}

function createRoom(socket, data, callback) {
  if (getRoom(socket)) leaveRoom(socket);

  const game = validGame(data?.game) ? data.game : "parkour";
  const code = makeCode();

  const room = {
    code,
    game,
    isPublic: Boolean(data?.isPublic),
    status: "lobby",
    hostId: socket.id,
    players: new Map()
  };

  room.players.set(socket.id, {
    id: socket.id,
    name: cleanName(data?.name),
    color: "#58a6ff",
    x: 0,
    y: 0,
    z: 3,
    yaw: 0,
    alive: true,
    finished: false
  });

  rooms.set(code, room);
  socketRooms.set(socket.id, code);
  socket.join(code);

  publishRoom(room);
  ok(callback, {
    code,
    isHost: true,
    room: publicRoom(room, socket.id)
  });
}

function joinRoom(socket, code, callback, publicOnly = false) {
  code = String(code || "").trim().toUpperCase();
  const room = rooms.get(code);

  if (!room) return fail(callback, "Комната не найдена.");
  if (publicOnly && !room.isPublic) {
    return fail(callback, "Эта комната не публичная.");
  }
  if (room.status === "playing") {
    return fail(callback, "Игра уже началась. Выбери другую комнату.");
  }
  if (room.players.size >= MAX_PLAYERS) {
    return fail(callback, "Комната заполнена.");
  }

  if (getRoom(socket)) leaveRoom(socket);

  room.players.set(socket.id, {
    id: socket.id,
    name: cleanName(arguments[1]?.name),
    color: "#ffbb55",
    x: Math.random() * 2 - 1,
    y: 0,
    z: 3,
    yaw: 0,
    alive: true,
    finished: false
  });

  socketRooms.set(socket.id, code);
  socket.join(code);

  publishRoom(room);

  ok(callback, {
    code,
    isHost: room.hostId === socket.id,
    room: publicRoom(room, socket.id)
  });
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/socket.io/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.on("connection", socket => {
  socket.on("rooms:list", callback => {
    const list = [...rooms.values()]
      .filter(room => room.isPublic)
      .map(room => ({
        code: room.code,
        game: room.game,
        status: room.status,
        hostName: room.players.get(room.hostId)?.name || "Игрок",
        playerCount: room.players.size,
        maxPlayers: MAX_PLAYERS
      }));

    ok(callback, { rooms: list });
  });

  socket.on("room:create", (data, callback) => {
    createRoom(socket, data || {}, callback);
  });

  socket.on("room:join", (data, callback) => {
    joinRoom(socket, data?.code, callback, false);
  });

  socket.on("room:join-public", (data, callback) => {
    joinRoom(socket, data?.code, callback, true);
  });

  socket.on("game:select", (data, callback) => {
    const room = getRoom(socket);

    if (!room) return fail(callback, "Ты не в комнате.");
    if (room.hostId !== socket.id) {
      return fail(callback, "Выбирать игру может только создатель.");
    }
    if (room.status === "playing") {
      return fail(callback, "Сначала заверши текущий раунд.");
    }
    if (!validGame(data?.game)) {
      return fail(callback, "Неизвестная мини-игра.");
    }

    room.game = data.game;
    publishRoom(room);
    ok(callback, { game: room.game });
  });

  socket.on("room:settings", (data, callback) => {
    const room = getRoom(socket);

    if (!room) return fail(callback, "Ты не в комнате.");
    if (room.hostId !== socket.id) {
      return fail(callback, "Изменять настройки может только создатель.");
    }

    room.isPublic = Boolean(data?.isPublic);
    publishRoom(room);

    ok(callback, {
      isPublic: room.isPublic,
      room: publicRoom(room, socket.id)
    });
  });

  socket.on("game:start", (_data, callback) => {
    const room = getRoom(socket);

    if (!room) return fail(callback, "Сначала войди в комнату.");
    if (room.hostId !== socket.id) {
      return fail(callback, "Начать игру может только создатель комнаты.");
    }
    if (!validGame(room.game)) {
      return fail(callback, "Не выбрана мини-игра.");
    }

    room.status = "playing";

    for (const player of room.players.values()) {
      player.x = 0;
      player.y = 0;
      player.z = 3;
      player.yaw = 0;
      player.alive = true;
      player.finished = false;
    }

    publishRoom(room);

    io.to(room.code).emit("game:started", {
      game: room.game,
      room: publicRoom(room)
    });

    ok(callback, { game: room.game });
  });

  socket.on("player:move", data => {
    const room = getRoom(socket);
    if (!room || !data || room.status !== "playing") return;

    const player = room.players.get(socket.id);
    if (!player) return;

    const number = (value, fallback = 0) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback;

    player.x = Math.max(-100, Math.min(100, number(data.x)));
    player.y = Math.max(-20, Math.min(100, number(data.y)));
    player.z = Math.max(-200, Math.min(100, number(data.z)));
    player.yaw = number(data.yaw);
    player.alive = data.alive !== false;
    player.finished = Boolean(data.finished);

    socket.to(room.code).volatile.emit("player:moved", publicPlayer(player));
  });

  socket.on("chat:send", data => {
    const message = String(data?.message || "").trim().slice(0, 160);
    if (!message) return;

    const room = getRoom(socket);
    const player = room?.players.get(socket.id);
    const name = player?.name || cleanName(data?.name);

    const payload = {
      playerId: socket.id,
      name,
      message
    };

    if (room) {
      io.to(room.code).emit("chat:message", payload);
    } else {
      socket.emit("chat:message", payload);
    }
  });

  socket.on("game:event", event => {
    const room = getRoom(socket);
    if (!room || !event) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    const type = String(event.type || "");

    if (type === "finished") {
      player.finished = true;
    } else if (type === "eliminated") {
      player.alive = false;
    } else if (type !== "jump") {
      return;
    }

    io.to(room.code).emit("game:event", {
      type,
      playerId: socket.id,
      detail: String(event.detail || "").slice(0, 100)
    });

    publishRoom(room);
  });

  socket.on("disconnect", () => {
    leaveRoom(socket);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AI WORLD server listening on port ${PORT}`);
});

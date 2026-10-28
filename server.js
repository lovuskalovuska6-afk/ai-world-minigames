
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 12;

const rooms = new Map();

const ALLOWED_GAMES = [
  "parkour",
  "redlight",
  "tiles",
  "lava",
  "obstacles"
];

app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    publicRooms: getPublicRooms().length
  });
});

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = Array.from(
      { length: 5 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));

  return code;
}

function cleanName(name) {
  return String(name || "Игрок")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 18) || "Игрок";
}

function makePlayer(socket, name) {
  return {
    id: socket.id,
    name: cleanName(name),
    x: 0,
    y: 1,
    z: 4,
    yaw: 0,
    color: "#" + crypto.randomBytes(3).toString("hex"),
    alive: true,
    finished: false
  };
}

function roomData(room) {
  return {
    code: room.code,
    game: room.game,
    status: room.status,
    isPublic: room.isPublic,
    hostId: room.hostId,
    hostName:
      room.players.get(room.hostId)?.name || "Игрок",
    maxPlayers: MAX_PLAYERS,
    players: [...room.players.values()]
  };
}

function getPublicRooms() {
  return [...rooms.values()]
    .filter(room => room.isPublic)
    .map(room => ({
      code: room.code,
      game: room.game,
      status: room.status,
      hostName:
        room.players.get(room.hostId)?.name || "Игрок",
      playerCount: room.players.size,
      maxPlayers: MAX_PLAYERS
    }))
    .sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === "lobby" ? -1 : 1;
      }

      return b.playerCount - a.playerCount;
    });
}

function broadcastPublicRooms() {
  io.emit("rooms:list:update", getPublicRooms());
}

function updateRoom(room) {
  io.to(room.code).emit("room:update", roomData(room));
  broadcastPublicRooms();
}

function getSocketRoom(socket) {
  const code = socket.data.roomCode;

  if (!code) return null;

  return rooms.get(code) || null;
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;

  if (!code) return;

  const room = rooms.get(code);

  socket.leave(code);
  socket.data.roomCode = null;

  if (!room) return;

  room.players.delete(socket.id);

  if (room.players.size === 0) {
    rooms.delete(code);
    broadcastPublicRooms();
    return;
  }

  // Если создатель вышел, передаём права следующему игроку.
  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }

  updateRoom(room);
}

function joinRoom(socket, room, name, reply) {
  if (room.players.size >= MAX_PLAYERS) {
    return reply({
      ok: false,
      error: "В комнате максимум 12 игроков."
    });
  }

  room.players.set(
    socket.id,
    makePlayer(socket, name)
  );

  socket.join(room.code);
  socket.data.roomCode = room.code;

  reply({
    ok: true,
    code: room.code,
    isHost: room.hostId === socket.id,
    room: roomData(room)
  });

  updateRoom(room);

  // Если комната уже запущена, новый игрок получает событие старта.
  if (room.status === "playing") {
    socket.emit("game:started", {
      game: room.game,
      at: Date.now()
    });
  }
}

io.on("connection", socket => {
  // Получение списка публичных комнат.
  socket.on("rooms:list", (reply = () => {}) => {
    reply({
      ok: true,
      rooms: getPublicRooms()
    });
  });

  // Создание комнаты.
  socket.on("room:create", (data = {}, reply = () => {}) => {
    leaveRoom(socket);

    const game = ALLOWED_GAMES.includes(data.game)
      ? data.game
      : "parkour";

    const isPublic = data.isPublic === true;
    const code = makeCode();

    const room = {
      code,
      game,
      status: "lobby",
      isPublic,
      hostId: socket.id,
      players: new Map()
    };

    room.players.set(
      socket.id,
      makePlayer(socket, data.name)
    );

    rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;

    reply({
      ok: true,
      code,
      isHost: true,
      isPublic,
      room: roomData(room)
    });

    updateRoom(room);
  });

  // Вход в комнату по коду.
  socket.on("room:join", (data = {}, reply = () => {}) => {
    const code = String(data.code || "")
      .trim()
      .toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      return reply({
        ok: false,
        error: "Комната не найдена."
      });
    }

    // Повторный вход в ту же комнату не создаёт дубликат игрока.
    if (
      socket.data.roomCode === code &&
      room.players.has(socket.id)
    ) {
      return reply({
        ok: true,
        code,
        isHost: room.hostId === socket.id,
        room: roomData(room)
      });
    }

    // Не выгоняем игрока из старой комнаты, если новая заполнена.
    if (room.players.size >= MAX_PLAYERS) {
      return reply({
        ok: false,
        error: "В комнате максимум 12 игроков."
      });
    }

    leaveRoom(socket);

    const currentRoom = rooms.get(code);

    if (!currentRoom) {
      return reply({
        ok: false,
        error: "Комната больше не существует."
      });
    }

    joinRoom(socket, currentRoom, data.name, reply);
  });

  // Вход в комнату через список публичных комнат.
  socket.on(
    "room:join-public",
    (data = {}, reply = () => {}) => {
      const code = String(data.code || "")
        .trim()
        .toUpperCase();

      const room = rooms.get(code);

      if (!room || !room.isPublic) {
        return reply({
          ok: false,
          error: "Публичная комната больше недоступна."
        });
      }

      if (
        socket.data.roomCode === code &&
        room.players.has(socket.id)
      ) {
        return reply({
          ok: true,
          code,
          isHost: room.hostId === socket.id,
          room: roomData(room)
        });
      }

      if (room.players.size >= MAX_PLAYERS) {
        return reply({
          ok: false,
          error: "В комнате максимум 12 игроков."
        });
      }

      leaveRoom(socket);

      const currentRoom = rooms.get(code);

      if (!currentRoom || !currentRoom.isPublic) {
        return reply({
          ok: false,
          error: "Публичная комната больше недоступна."
        });
      }

      joinRoom(socket, currentRoom, data.name, reply);
    }
  );

  // Изменение публичности комнаты.
  // Клиент должен отправить:
  // socket.emit("room:settings", { isPublic: false }, callback)
  socket.on(
    "room:settings",
    (data = {}, reply = () => {}) => {
      const room = getSocketRoom(socket);

      if (!room) {
        return reply({
          ok: false,
          error: "Нет комнаты."
        });
      }

      // Только текущий создатель может менять доступ.
      if (room.hostId !== socket.id) {
        return reply({
          ok: false,
          error: "Менять доступ может только создатель комнаты."
        });
      }

      if (typeof data.isPublic !== "boolean") {
        return reply({
          ok: false,
          error: "Неверная настройка доступа."
        });
      }

      room.isPublic = data.isPublic;

      updateRoom(room);

      reply({
        ok: true,
        isPublic: room.isPublic,
        room: roomData(room)
      });
    }
  );

  // Синхронизация положения игроков.
  socket.on("player:move", data => {
    const room = getSocketRoom(socket);
    const player = room?.players.get(socket.id);

    if (!room || !player || !data) return;

    for (const key of ["x", "y", "z", "yaw"]) {
      if (Number.isFinite(data[key])) {
        player[key] = Math.max(
          -100,
          Math.min(100, data[key])
        );
      }
    }

    if (typeof data.alive === "boolean") {
      player.alive = data.alive;
    }

    if (typeof data.finished === "boolean") {
      player.finished = data.finished;
    }

    socket.to(room.code).volatile.emit("player:moved", {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      alive: player.alive,
      finished: player.finished
    });
  });

  // Выбор мини-игры.
  socket.on("game:select", (data = {}, reply = () => {}) => {
    const room = getSocketRoom(socket);

    if (!room) {
      return reply({
        ok: false,
        error: "Нет комнаты."
      });
    }

    if (room.hostId !== socket.id) {
      return reply({
        ok: false,
        error: "Выбирать игру может создатель комнаты."
      });
    }

    if (!ALLOWED_GAMES.includes(data.game)) {
      return reply({
        ok: false,
        error: "Неизвестная игра."
      });
    }

    room.game = data.game;
    room.status = "lobby";

    for (const player of room.players.values()) {
      player.x = 0;
      player.y = 1;
      player.z = 4;
      player.alive = true;
      player.finished = false;
    }

    updateRoom(room);
    reply({ ok: true });
  });

  // Запуск игры.
  socket.on("game:start", (_data, reply = () => {}) => {
    const room = getSocketRoom(socket);

    if (!room) {
      return reply({
        ok: false,
        error: "Нет комнаты."
      });
    }

    if (room.hostId !== socket.id) {
      return reply({
        ok: false,
        error: "Запустить игру может создатель комнаты."
      });
    }

    room.status = "playing";

    for (const player of room.players.values()) {
      player.x = 0;
      player.y = 1;
      player.z = 4;
      player.alive = true;
      player.finished = false;
    }

    io.to(room.code).emit("game:started", {
      game: room.game,
      at: Date.now()
    });

    updateRoom(room);
    reply({ ok: true });
  });

  // События мини-игр.
  socket.on("game:event", data => {
    const room = getSocketRoom(socket);

    if (!room || !data) return;

    const allowed = [
      "eliminated",
      "finished",
      "jump",
      "redlight"
    ];

    if (!allowed.includes(data.type)) return;

    io.to(room.code).emit("game:event", {
      type: data.type,
      playerId: socket.id,
      detail: String(data.detail || "").slice(0, 80)
    });
  });

  // Удаление игрока при отключении.
  socket.on("disconnect", () => {
    leaveRoom(socket);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    "AI WORLD multiplayer server started on " + PORT
  );
});

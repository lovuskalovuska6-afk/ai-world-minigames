
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static("public"));
app.get("/health", (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
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
    hostId: room.hostId,
    players: [...room.players.values()]
  };
}

function updateRoom(room) {
  io.to(room.code).emit("room:update", roomData(room));
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
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }

  updateRoom(room);
}

io.on("connection", socket => {
  socket.on("room:create", (data = {}, reply = () => {}) => {
    leaveRoom(socket);

    const code = makeCode();
    const allowedGames = [
      "parkour",
      "redlight",
      "tiles",
      "lava",
      "obstacles"
    ];

    const game = allowedGames.includes(data.game)
      ? data.game
      : "parkour";

    const room = {
      code,
      game,
      status: "lobby",
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

    reply({ ok: true, code, isHost: true });
    updateRoom(room);
  });

  socket.on("room:join", (data = {}, reply = () => {}) => {
    leaveRoom(socket);

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

    if (room.players.size >= 12) {
      return reply({
        ok: false,
        error: "В комнате максимум 12 игроков."
      });
    }

    room.players.set(
      socket.id,
      makePlayer(socket, data.name)
    );

    socket.join(code);
    socket.data.roomCode = code;

    reply({
      ok: true,
      code,
      isHost: room.hostId === socket.id
    });

    updateRoom(room);
  });

  socket.on("player:move", data => {
    const room = rooms.get(socket.data.roomCode);
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

  socket.on("game:select", (data = {}, reply = () => {}) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room) {
      return reply({ ok: false, error: "Нет комнаты." });
    }

    if (room.hostId !== socket.id) {
      return reply({
        ok: false,
        error: "Выбирать игру может создатель комнаты."
      });
    }

    const allowed = [
      "parkour",
      "redlight",
      "tiles",
      "lava",
      "obstacles"
    ];

    if (!allowed.includes(data.game)) {
      return reply({ ok: false, error: "Неизвестная игра." });
    }

    room.game = data.game;
    room.status = "lobby";

    for (const p of room.players.values()) {
      p.x = 0;
      p.y = 1;
      p.z = 4;
      p.alive = true;
      p.finished = false;
    }

    updateRoom(room);
    reply({ ok: true });
  });

  socket.on("game:start", (_data, reply = () => {}) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room) {
      return reply({ ok: false, error: "Нет комнаты." });
    }

    if (room.hostId !== socket.id) {
      return reply({
        ok: false,
        error: "Запустить игру может создатель комнаты."
      });
    }

    room.status = "playing";

    for (const p of room.players.values()) {
      p.x = 0;
      p.y = 1;
      p.z = 4;
      p.alive = true;
      p.finished = false;
    }

    io.to(room.code).emit("game:started", {
      game: room.game,
      at: Date.now()
    });

    updateRoom(room);
    reply({ ok: true });
  });

  socket.on("game:event", data => {
    const room = rooms.get(socket.data.roomCode);
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

  socket.on("disconnect", () => {
    leaveRoom(socket);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("AI WORLD multiplayer server started on " + PORT);
});

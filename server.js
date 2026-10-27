
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.json({ ok: true }));

const clients = new Map();
let round = null;
let nextId = 1;

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data, recipients = [...clients.keys()]) {
  for (const ws of recipients) send(ws, data);
}

function lobbyPlayers() {
  return [...clients.entries()]
    .filter(([, p]) => p.queued && !p.playing)
    .map(([ws, p]) => ({ ws, id: p.id, name: p.name }));
}

function gamePlayers() {
  return [...clients.entries()]
    .filter(([, p]) => p.playing)
    .map(([ws, p]) => ({
      ws,
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      alive: p.alive,
      won: p.won
    }));
}

function updateLobby() {
  const players = lobbyPlayers().map(({ ws, ...p }) => p);
  broadcast({
    type: "lobby",
    count: players.length,
    minimum: 2,
    players
  });
}

function updateGame() {
  const players = gamePlayers();
  if (!players.length) return;

  broadcast({
    type: "gameState",
    game: round?.game,
    light: round?.light,
    players: players.map(({ ws, ...p }) => p)
  }, players.map(p => p.ws));
}

function endRound() {
  if (!round) return;

  for (const [ws, p] of clients) {
    if (p.playing) {
      p.playing = false;
      p.queued = false;
      send(ws, { type: "roundEnded" });
    }
  }

  round = null;
  updateLobby();
}

wss.on("connection", ws => {
  const id = String(nextId++);

  clients.set(ws, {
    id,
    name: "Игрок " + id,
    queued: false,
    playing: false,
    x: 0.5,
    y: 0.92,
    alive: true,
    won: false,
    lastMove: 0
  });

  send(ws, { type: "welcome", id });
  updateLobby();

  ws.on("message", raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const p = clients.get(ws);
    if (!p) return;

    if (msg.type === "name") {
      p.name = String(msg.name || "Игрок")
        .replace(/[<>]/g, "")
        .slice(0, 18);

      updateLobby();
      updateGame();
    }

    if (msg.type === "joinQueue") {
      if (round) {
        send(ws, {
          type: "notice",
          text: "Раунд уже идёт. Попробуй позже."
        });
        return;
      }

      p.queued = true;
      p.playing = false;
      p.alive = true;
      p.won = false;
      updateLobby();
    }

    if (msg.type === "leaveQueue") {
      p.queued = false;
      updateLobby();
    }

    if (msg.type === "start") {
      const players = lobbyPlayers();

      if (round) {
        send(ws, {
          type: "notice",
          text: "Раунд уже начался."
        });
        return;
      }

      if (players.length < 2 || !p.queued) {
        send(ws, {
          type: "notice",
          text: "Нужно минимум 2 игрока!"
        });
        return;
      }

      const game = msg.game === "tiles" ? "tiles" : "redgreen";

      round = {
        game,
        light: "green",
        nextLight: Date.now() + 4000,
        finishTimer: null
      };

      for (const player of players) {
        const q = clients.get(player.ws);
        q.queued = false;
        q.playing = true;
        q.x = 0.5;
        q.y = 0.92;
        q.alive = true;
        q.won = false;
        q.lastMove = 0;

        send(player.ws, {
          type: "gameStart",
          game,
          id: q.id,
          light: round.light
        });
      }

      updateLobby();
      updateGame();
    }

    if (msg.type === "move" && p.playing && round) {
      const now = Date.now();

      // Ограничение частоты обновлений.
      if (now - p.lastMove < 45) return;
      p.lastMove = now;

      const x = Number(msg.x);
      const y = Number(msg.y);

      if (!Number.isFinite(x) || !Number.isFinite(y)) return;

      const nx = Math.max(0, Math.min(1, x));
      const ny = Math.max(0, Math.min(1, y));
      const moving = Boolean(msg.moving);

      if (
        round.game === "redgreen" &&
        round.light === "red" &&
        moving &&
        p.alive &&
        (Math.abs(nx - p.x) > 0.002 ||
         Math.abs(ny - p.y) > 0.002)
      ) {
        p.alive = false;
        send(ws, {
          type: "lost",
          reason: "Ты двигался на красный свет!"
        });
        updateGame();
        return;
      }

      p.x = nx;
      p.y = ny;

      // Проверка финиша на сервере.
      if (p.alive && !p.won && p.y < 0.08) {
        p.won = true;
        send(ws, {
          type: "won",
          text: "Ты добрался до финиша!"
        });
      }

      updateGame();
      checkRoundEnd();
    }

    if (msg.type === "chat") {
      const text = String(msg.text || "")
        .replace(/[<>]/g, "")
        .trim()
        .slice(0, 180);

      if (!text) return;

      const recipients = p.playing
        ? gamePlayers().map(q => q.ws)
        : lobbyPlayers().map(q => q.ws);

      broadcast({
        type: "chat",
        name: p.name,
        text
      }, recipients);
    }

    if (msg.type === "backToLobby") {
      p.playing = false;
      p.queued = false;
      updateLobby();
      checkRoundEnd();
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    updateLobby();
    updateGame();
    checkRoundEnd();
  });
});

function checkRoundEnd() {
  if (!round || round.finishTimer) return;

  const players = gamePlayers();

  if (
    players.length > 0 &&
    players.every(p => p.won || !p.alive)
  ) {
    round.finishTimer = setTimeout(endRound, 2500);
  }

  if (players.length === 0) {
    if (round.finishTimer) clearTimeout(round.finishTimer);
    round = null;
    updateLobby();
  }
}

setInterval(() => {
  if (!round || round.game !== "redgreen") return;

  if (Date.now() >= round.nextLight) {
    round.light = round.light === "green" ? "red" : "green";
    round.nextLight = Date.now() +
      (round.light === "green" ? 4000 : 2500);

    broadcast({
      type: "light",
      light: round.light
    }, gamePlayers().map(p => p.ws));

    updateGame();
  }
}, 250);

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Mini-games server running on port " + PORT);
});

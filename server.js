// server.js — Stick War Legacy Online (Mobile PvP)
// FIXES:
// 1) Шахтёры всегда выбирают ближайшую руду на своей половине и ходят: база -> руда -> база.
// 2) Хост (A) гарантированно получает сигнал "ready", когда игрок B зашёл, и сразу переходит в игру.
// 3) Убрана ошибка с двойным полем mines (перезапись объекта).

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;

// Если есть папка public — берём её, иначе раздаём из корня (чтобы работало и так и так)
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ok");
  }

  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(PUBLIC_DIR, urlPath);

  // защита от выхода из папки
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js"   ? "application/javascript; charset=utf-8" :
      ext === ".css"  ? "text/css; charset=utf-8" :
      "application/octet-stream";

    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

// ───────────────────────── Game constants ─────────────────────────
const LANE_W = 1000;
const LANE_H = 380;

const BASE_HP = 900;
const GOLD_TICK_MS = 1000; // пассивный доход

const UNIT_DEF = {
  miner:  { cost: 50,  pop: 1, hp: 55,  dmg: 0,  range: 0,   speed: 70,  attackRate: 999999 },
  sword:  { cost: 120, pop: 1, hp: 110, dmg: 14, range: 24,  speed: 85,  attackRate: 700 },
  archer: { cost: 170, pop: 1, hp: 75,  dmg: 9,  range: 165, speed: 75,  attackRate: 950, projSpeed: 240 },
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function now() { return Date.now(); }
function mkId() { return Math.random().toString(36).slice(2); }
function dist1d(a, b) { return Math.abs(a - b); }

function nearestEnemy(unit, enemies) {
  let best = null, bestD = Infinity;
  for (const e of enemies) {
    const d = dist1d(unit.x, e.x);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function makeState() {
  return {
    lane: { w: LANE_W, h: LANE_H },
    gold: { A: 100, B: 100 },
    pop:  { A: 0,   B: 0 },
    popCap: { A: 10, B: 10 },
    mode: { A: "defend", B: "defend" },

    bases: {
      A: { x: 60,  hp: BASE_HP, maxHp: BASE_HP },
      B: { x: 940, hp: BASE_HP, maxHp: BASE_HP },
    },

    // 4 точки руды (как на фоне). Шахтёры выбирают ближайшую на своей половине.
    mines: [
      { id: "L1", x: 190 },
      { id: "L2", x: 320 },
      { id: "R1", x: 680 },
      { id: "R2", x: 810 },
    ],

    units: [],
    projectiles: [],
    goldTick: { A: 0, B: 0 },
    winner: null,
    tick: 0,
    ready: false, // оба игрока в комнате?
  };
}

function pickMineFor(st, side, x) {
  const mid = LANE_W / 2;
  const candidates = st.mines.filter(m => (side === "A" ? m.x < mid : m.x > mid));
  const list = candidates.length ? candidates : st.mines;
  let best = null, bestD = Infinity;
  for (const m of list) {
    const d = Math.abs(m.x - x);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best;
}

function spawnUnit(st, side, type) {
  const def = UNIT_DEF[type];
  if (!def) return false;
  if (st.gold[side] < def.cost) return "nogold";
  if (st.pop[side] + def.pop > st.popCap[side]) return "nopop";
  if (st.winner) return "ended";

  st.gold[side] -= def.cost;
  st.pop[side]  += def.pop;

  const base = st.bases[side];
  const startX = side === "A" ? base.x + 40 : base.x - 40;

  const unit = {
    id: mkId(),
    side,
    type,
    x: startX,
    y: 0,
    hp: def.hp,
    maxHp: def.hp,
    speed: def.speed,
    dmg: def.dmg,
    range: def.range,
    attackRate: def.attackRate,
    attackTimer: 0,

    // miner-only
    carry: 0,
    mineTimer: 0,
    mineId: null,
    ai: (type === "miner") ? "toMine" : "walk", // toMine|mining|toBase  /  walk
  };

  // сразу назначим руду, чтобы не было "зависаний"
  if (type === "miner") {
    const m = pickMineFor(st, side, startX);
    unit.mineId = m ? m.id : null;
  }

  st.units.push(unit);
  return true;
}

function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (const ws of room.clients) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}

function sendTo(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ───────────────────────── Core simulation ─────────────────────────
function stepGame(st, dtMs) {
  if (st.winner) return;
  st.tick++;

  const dt = dtMs / 1000;
  const alive = (u) => u.hp > 0;

  const unitsA = st.units.filter(u => u.side === "A" && alive(u));
  const unitsB = st.units.filter(u => u.side === "B" && alive(u));

  // пассивный доход
  for (const side of ["A", "B"]) {
    st.goldTick[side] += dtMs;
    while (st.goldTick[side] >= GOLD_TICK_MS) {
      st.goldTick[side] -= GOLD_TICK_MS;
      st.gold[side] += 3;
    }
  }

  for (const unit of st.units) {
    if (!alive(unit)) continue;

    const enemySide = unit.side === "A" ? "B" : "A";
    const enemies = (unit.side === "A" ? unitsB : unitsA);

    const myBase = st.bases[unit.side];
    const enemyBase = st.bases[enemySide];
    const dir = unit.side === "A" ? 1 : -1;

    unit.attackTimer = Math.max(0, unit.attackTimer - dtMs);

    // ── MINER LOOP ────────────────────────────────────────────────
    if (unit.type === "miner") {
      // если нет mineId или точки нет, подберём заново
      let mine = unit.mineId ? st.mines.find(m => m.id === unit.mineId) : null;
      if (!mine) {
        mine = pickMineFor(st, unit.side, unit.x);
        unit.mineId = mine ? mine.id : null;
      }

      // если рядом враг, отступить
      const closestEnemy = nearestEnemy(unit, enemies);
      if (closestEnemy && dist1d(unit.x, closestEnemy.x) < 140) {
        unit.ai = "toBase";
      }

      if (unit.ai === "toMine") {
        if (!mine) {
          unit.ai = "toBase";
        } else {
          const to = mine.x - unit.x;
          if (Math.abs(to) <= 18) {
            unit.ai = "mining";
            unit.mineTimer = 0;
          } else {
            unit.x += Math.sign(to) * unit.speed * dt;
          }
        }
      } else if (unit.ai === "mining") {
        unit.mineTimer += dtMs;
        if (unit.mineTimer >= 1200) {
          unit.mineTimer = 0;
          unit.carry = 20;
          unit.ai = "toBase";
        }
      } else { // toBase
        const to = myBase.x - unit.x;
        if (Math.abs(to) <= 22) {
          if (unit.carry > 0) st.gold[unit.side] += unit.carry;
          unit.carry = 0;
          // заново выбираем ближайшую руду ОТ БАЗЫ
          const m = pickMineFor(st, unit.side, myBase.x);
          unit.mineId = m ? m.id : unit.mineId;
          unit.ai = "toMine";
        } else {
          unit.x += Math.sign(to) * unit.speed * dt;
        }
      }

      unit.x = clamp(unit.x, 30, LANE_W - 30);
      continue;
    }

    // ── Fighters (sword/archer) ────────────────────────────────────
    let target = null;
    let bestD = Infinity;

    for (const e of enemies) {
      const dx = e.x - unit.x;
      if (unit.side === "A" && dx < 0) continue;
      if (unit.side === "B" && dx > 0) continue;
      const d = Math.abs(dx);
      if (d < bestD) { bestD = d; target = e; }
    }

    const baseDist = Math.abs(enemyBase.x - unit.x);
    const inRangeEnemy = target && bestD <= unit.range;
    const inRangeBase = baseDist <= unit.range;

    if (inRangeEnemy || (!target && inRangeBase)) {
      if (unit.attackTimer === 0) {
        unit.attackTimer = unit.attackRate;

        if (unit.type === "archer") {
          const speed = UNIT_DEF.archer.projSpeed;
          const vx = (unit.side === "A" ? 1 : -1) * speed;
          st.projectiles.push({
            x: unit.x + (unit.side === "A" ? 10 : -10),
            side: unit.side,
            vx,
            dmg: unit.dmg
          });
        } else {
          if (inRangeEnemy) target.hp -= unit.dmg;
          else enemyBase.hp -= unit.dmg;
        }
      }
    } else {
      unit.x += dir * unit.speed * dt;
      unit.x = clamp(unit.x, 30, LANE_W - 30);
    }
  }

  // ── Projectiles ──────────────────────────────────────────────────
  for (let i = st.projectiles.length - 1; i >= 0; i--) {
    const p = st.projectiles[i];
    p.x += p.vx * dt;

    const es = p.side === "A" ? "B" : "A";
    const enemies = st.units.filter(u => u.side === es && u.hp > 0);

    let hit = null;
    let best = Infinity;
    for (const e of enemies) {
      const d = Math.abs(e.x - p.x);
      if (d < 14 && d < best) { best = d; hit = e; }
    }

    if (hit) {
      hit.hp -= p.dmg;
      st.projectiles.splice(i, 1);
      continue;
    }

    const base = st.bases[es];
    if (Math.abs(base.x - p.x) < 18) {
      base.hp -= p.dmg;
      st.projectiles.splice(i, 1);
      continue;
    }

    if (p.x < -80 || p.x > LANE_W + 80) st.projectiles.splice(i, 1);
  }

  // ── Cleanup dead ─────────────────────────────────────────────────
  for (let i = st.units.length - 1; i >= 0; i--) {
    const u = st.units[i];
    if (u.hp <= 0) {
      st.pop[u.side] = Math.max(0, st.pop[u.side] - (UNIT_DEF[u.type]?.pop || 0));
      st.units.splice(i, 1);
    }
  }

  if (st.bases.A.hp <= 0) st.winner = "B";
  if (st.bases.B.hp <= 0) st.winner = "A";
}

// ───────────────────────── Rooms + WS ─────────────────────────────
const rooms = new Map();
function makeRoomId() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

setInterval(() => {
  const t = now();
  for (const [roomId, room] of rooms) {
    if (room.clients.length === 0) {
      rooms.delete(roomId);
      continue;
    }

    const dt = Math.min(120, t - room.lastTick);
    room.lastTick = t;

    stepGame(room.state, dt);
    broadcast(room, { type: "state", roomId, state: room.state });
  }
}, 50);

wss.on("connection", (ws) => {
  ws.roomId = null;
  ws.role = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "create") {
      const roomId = makeRoomId();
      const state = makeState();
      rooms.set(roomId, { clients: [ws], state, lastTick: now(), host: ws });

      ws.roomId = roomId;
      ws.role = "A";

      // joined + сразу ready=false
      sendTo(ws, { type: "joined", roomId, role: "A", ready: false });
      // стартовый state (UI оживает сразу)
      sendTo(ws, { type: "state", roomId, state });
      return;
    }

    if (msg.type === "join") {
      const roomId = String(msg.roomId || "").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) return sendTo(ws, { type: "error", msg: "Room not found" });
      if (room.clients.length >= 2) return sendTo(ws, { type: "error", msg: "Room full" });

      room.clients.push(ws);
      ws.roomId = roomId;
      ws.role = "B";

      room.state.ready = true;

      // joiner
      sendTo(ws, { type: "joined", roomId, role: "B", ready: true });
      sendTo(ws, { type: "state", roomId, state: room.state });

      // host: гарантированный сигнал
      sendTo(room.host, { type: "ready" });
      sendTo(room.host, { type: "opponent_joined" });

      broadcast(room, { type: "info", msg: "Player B joined" });
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room || !ws.role) return;

    if (msg.type === "spawn") {
      const r = spawnUnit(room.state, ws.role, msg.unitType);
      if (r !== true) {
        const text =
          r === "nogold" ? "Не хватает золота" :
          r === "nopop"  ? "Лимит армии" :
          r === "ended"  ? "Игра завершена" : "Ошибка";
        sendTo(ws, { type: "error", msg: text });
      }
      return;
    }

    if (msg.type === "mode") {
      room.state.mode[ws.role] = (msg.value === "attack") ? "attack" : "defend";
      return;
    }

    if (msg.type === "reset") {
      room.state = makeState();
      room.state.ready = (room.clients.length === 2);
      broadcast(room, { type: "reset_ok" });
      return;
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;

    room.clients = room.clients.filter(c => c !== ws);

    // если вышел хост, назначим нового
    if (room.host === ws) {
      room.host = room.clients[0] || null;
    }

    // уведомим оставшегося
    for (const c of room.clients) {
      sendTo(c, { type: "opponent_left" });
    }

    if (room.state) room.state.ready = (room.clients.length === 2);
  });
});

server.listen(PORT, () => console.log("Listening on", PORT));

// server.js — Stick War Lite Online PvP (Mobile)
// Run: npm i ws && npm start
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ok");
  }

  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(PUBLIC_DIR, urlPath);

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
      ext === ".js" ? "application/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
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
const GOLD_TICK_MS = 1000; // небольшой пассивный доход (чтобы игра не стояла)

const UNIT_DEF = {
  miner:  { cost: 50,  pop: 1, hp: 55, dmg: 0,  range: 0,   speed: 70,  attackRate: 999999 },
  sword:  { cost: 120, pop: 1, hp: 110,dmg: 14, range: 24,  speed: 85,  attackRate: 700 },
  archer: { cost: 170, pop: 1, hp: 75, dmg: 9,  range: 165, speed: 75,  attackRate: 950, projSpeed: 240 },
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
    pop: { A: 0, B: 0 },
    popCap: { A: 10, B: 10 },
    mode: { A: "defend", B: "defend" },

    bases: {
      A: { x: 60,  hp: BASE_HP, maxHp: BASE_HP },
      B: { x: 940, hp: BASE_HP, maxHp: BASE_HP },
    },

    // 4 кучи золота по линии (как на картинке)
    // A использует m1/m2, B использует m3/m4
    mines: [
      { id: "m1", x: 230 },
      { id: "m2", x: 350 },
      { id: "m3", x: 650 },
      { id: "m4", x: 770 }
    ],

    units: [],
    projectiles: [],

    goldTick: { A: 0, B: 0 },
    winner: null,
    tick: 0,
  };
}

function spawnUnit(st, side, type) {
  const def = UNIT_DEF[type];
  if (!def) return false;
  if (st.winner) return "ended";
  if (st.gold[side] < def.cost) return "nogold";
  if (st.pop[side] + def.pop > st.popCap[side]) return "nopop";

  st.gold[side] -= def.cost;
  st.pop[side] += def.pop;

  const base = st.bases[side];
  const startX = side === "A" ? base.x + 40 : base.x - 40;

  const unit = {
    id: mkId(), side, type,
    x: startX,
    hp: def.hp, maxHp: def.hp,
    speed: def.speed,
    dmg: def.dmg, range: def.range,
    attackRate: def.attackRate,
    attackTimer: 0,

    // miner
    carry: 0,
    mineTimer: 0,
    mineId: null,
    ai: type === "miner" ? "toMine" : "walk"
  };

  st.units.push(unit);
  return true;
}

function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (const ws of room.clients) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}

// ───────────────────────── Core simulation ─────────────────────────
function stepGame(st, dtMs) {
  if (st.winner) return;
  st.tick++;

  const dt = dtMs / 1000;
  const alive = (u) => u.hp > 0;

  const unitsA = st.units.filter(u => u.side === "A" && alive(u));
  const unitsB = st.units.filter(u => u.side === "B" && alive(u));

  // Пассивный доход (минимальный). Основной доход — от miner.
  for (const side of ["A", "B"]) {
    st.goldTick[side] += dtMs;
    if (st.goldTick[side] >= GOLD_TICK_MS) {
      st.goldTick[side] -= GOLD_TICK_MS;
      st.gold[side] += 3;
    }
  }

  for (const unit of st.units) {
    if (!alive(unit)) continue;

    const enemySide = unit.side === "A" ? "B" : "A";
    const enemies = (unit.side === "A" ? unitsB : unitsA).filter(alive);

    const myBase = st.bases[unit.side];
    const enemyBase = st.bases[enemySide];
    const dir = unit.side === "A" ? 1 : -1;

    unit.attackTimer = Math.max(0, unit.attackTimer - dtMs);

    // ── MINER: go nearest mine on own side -> mine -> return -> repeat
    if (unit.type === "miner") {
      const mid = LANE_W / 2;

      // Только “своя половина”
      const myMines = st.mines.filter(m =>
        unit.side === "A" ? m.x < mid : m.x > mid
      );

      function pickMine() {
        let best = null, bestD = Infinity;
        for (const m of myMines) {
          const d = Math.abs(m.x - unit.x);
          if (d < bestD) { bestD = d; best = m; }
        }
        return best;
      }

      const closestEnemy = nearestEnemy(unit, enemies);

      // Если враг слишком близко — бежать домой
      if (closestEnemy && dist1d(unit.x, closestEnemy.x) < 140) {
        unit.ai = "toBase";
      }

      if (!unit.mineId) {
        const m = pickMine();
        unit.mineId = m ? m.id : null;
      }

      const mine = st.mines.find(m => m.id === unit.mineId) || pickMine();
      if (!mine) unit.ai = "toBase";

      if (unit.ai === "toMine") {
        const to = mine.x - unit.x;
        if (Math.abs(to) <= 18) {
          unit.ai = "mining";
          unit.mineTimer = 0;
        } else {
          unit.x += Math.sign(to) * unit.speed * dt;
        }
      } else if (unit.ai === "mining") {
        unit.mineTimer += dtMs;
        if (unit.mineTimer >= 1200) {
          unit.mineTimer = 0;
          unit.carry = 20;      // добыча за цикл
          unit.ai = "toBase";
        }
      } else { // toBase
        const to = myBase.x - unit.x;
        if (Math.abs(to) <= 22) {
          st.gold[unit.side] += unit.carry;
          unit.carry = 0;
          unit.ai = "toMine";
          const m = pickMine();
          unit.mineId = m ? m.id : unit.mineId;
        } else {
          unit.x += Math.sign(to) * unit.speed * dt;
        }
      }

      // ✅ фикс “залипания” для обеих сторон
      unit.x = clamp(unit.x, 30, LANE_W - 30);
      continue;
    }

    // ── Fighters
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

  // ── Projectiles
  for (let i = st.projectiles.length - 1; i >= 0; i--) {
    const p = st.projectiles[i];
    p.x += p.vx * dt;

    const es = p.side === "A" ? "B" : "A";
    const enemies = st.units.filter(u => u.side === es && u.hp > 0);

    let hit = null;
    let best = 999999;
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

  // ── Cleanup dead
  for (let i = st.units.length - 1; i >= 0; i--) {
    if (st.units[i].hp <= 0) {
      st.pop[st.units[i].side] = Math.max(0, st.pop[st.units[i].side] - UNIT_DEF[st.units[i].type].pop);
      st.units.splice(i, 1);
    }
  }

  // ── Win
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
      rooms.set(roomId, { clients: [ws], state: makeState(), lastTick: now() });
      ws.roomId = roomId;
      ws.role = "A";
      ws.send(JSON.stringify({ type: "joined", roomId, role: "A" }));
      return;
    }

    if (msg.type === "join") {
      const roomId = String(msg.roomId || "").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) return ws.send(JSON.stringify({ type: "error", msg: "Room not found" }));
      if (room.clients.length >= 2) return ws.send(JSON.stringify({ type: "error", msg: "Room full" }));
      room.clients.push(ws);
      ws.roomId = roomId;
      ws.role = "B";
      ws.send(JSON.stringify({ type: "joined", roomId, role: "B" }));
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
        ws.send(JSON.stringify({ type: "error", msg: text }));
      }
      return;
    }

    if (msg.type === "mode") {
      room.state.mode[ws.role] = (msg.value === "attack") ? "attack" : "defend";
      return;
    }

    if (msg.type === "reset") {
      room.state = makeState();
      broadcast(room, { type: "info", msg: "Reset" });
      return;
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.clients = room.clients.filter(c => c !== ws);
  });
});

server.listen(PORT, () => console.log("Listening on", PORT));

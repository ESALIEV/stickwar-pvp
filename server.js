// server.js — Stick War Legacy Online (Mobile PvP)
const http = require("http");
const fs   = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT       = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  const urlPath  = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = { ".html":"text/html;charset=utf-8", ".js":"application/javascript;charset=utf-8", ".css":"text/css;charset=utf-8" };
    res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

// ─── Constants ────────────────────────────────────────────────────────────────
const LANE_W = 1000, LANE_H = 380;
const BASE_HP = 800;
const GOLD_TICK_MS = 1500; // base gold every 1.5s

const UNIT_DEF = {
  miner:  { hp:45, speed:55, dmg:0,  range:0,   attackRate:0,    cost:50,  pop:1, reward:12 },
  sword:  { hp:120, speed:65, dmg:22, range:55,  attackRate:1800, cost:120, pop:2, reward:25 },
  archer: { hp:65,  speed:60, dmg:14, range:290, attackRate:2200, cost:170, pop:2, reward:20 },
  giant:  { hp:380, speed:38, dmg:45, range:70,  attackRate:2500, cost:350, pop:4, reward:80 },
  spear:  { hp:90,  speed:58, dmg:18, range:130, attackRate:1600, cost:150, pop:2, reward:28 },
};

let uid = 0;
function mkId() { return ++uid; }
function now() { return Date.now(); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist1d(a, b) { return Math.abs(a - b); }

function makeRoom(idA) {
  return {
    clients: { A: idA, B: null },
    state: makeState(),
    lastTick: now(),
  };
}

function makeState() {
  return {
    lane: { w: LANE_W, h: LANE_H },
    gold: { A: 100, B: 100 },
    pop:  { A: 0,   B: 0   },
    popCap: { A: 10, B: 10 },
    mode: { A: "defend", B: "defend" },
    bases: {
      A: { x: 60,  hp: BASE_HP, maxHp: BASE_HP },
      B: { x: 940, hp: BASE_HP, maxHp: BASE_HP },
    },
    units: [],
    projectiles: [],
    goldTick: { A: 0, B: 0 }, // ms accumulator for base gold
    winner: null,
    tick: 0,
  };
}

// ─── Game Logic ───────────────────────────────────────────────────────────────
function spawnUnit(st, side, type) {
  const def = UNIT_DEF[type];
  if (!def) return false;
  if (st.gold[side] < def.cost) return "nogold";
  if (st.pop[side] + def.pop > st.popCap[side]) return "nopop";

  st.gold[side] -= def.cost;
  st.pop[side]  += def.pop;

  const base = st.bases[side];
  const dir  = side === "A" ? 1 : -1;
  const startX = side === "A" ? base.x + 40 : base.x - 40;

  const unit = {
    id: mkId(), side, type,
    x: startX, y: 0,
    hp: def.hp, maxHp: def.hp,
    speed: def.speed,
    dmg: def.dmg, range: def.range,
    attackRate: def.attackRate,
    attackTimer: 0,
    state: "walk", // walk | fight | mine | dead
    targetId: null,
  };

  st.units.push(unit);
  return true;
}

function stepGame(st, dtMs) {
  if (st.winner) return;
  st.tick++;

  const dt = dtMs / 1000;
  const alive = (u) => u.hp > 0;
  const unitsA = st.units.filter(u => u.side === "A" && alive(u));
  const unitsB = st.units.filter(u => u.side === "B" && alive(u));

  // ── Base gold income ──────────────────────────────────────────────────────
  for (const side of ["A", "B"]) {
    st.goldTick[side] += dtMs;
    if (st.goldTick[side] >= GOLD_TICK_MS) {
      st.goldTick[side] -= GOLD_TICK_MS;
      // count miners for bonus
      const minerCount = st.units.filter(u => u.side === side && u.type === "miner" && alive(u)).length;
      st.gold[side] += 5 + minerCount * 8;
    }
  }

  // ── Unit AI ───────────────────────────────────────────────────────────────
  for (const unit of st.units) {
    if (!alive(unit)) continue;

    const enemySide    = unit.side === "A" ? "B" : "A";
    const enemies      = (unit.side === "A" ? unitsB : unitsA).filter(alive);
    const myBase       = st.bases[unit.side];
    const enemyBase    = st.bases[enemySide];
    const mode         = st.mode[unit.side];
    const dir          = unit.side === "A" ? 1 : -1;
    const homeLine     = unit.side === "A" ? myBase.x + 80 : myBase.x - 80;
    const frontLine    = unit.side === "A" ? homeLine + 30 : homeLine - 30;

    unit.attackTimer   = Math.max(0, unit.attackTimer - dtMs);

    if (unit.type === "miner") {
      // miners just walk forward slowly, generate gold (already counted above)
      // they don't fight — retreat if enemy is close
      const closestEnemy = nearestEnemy(unit, enemies);
      if (closestEnemy && dist1d(unit.x, closestEnemy.x) < 120) {
        // retreat to base
        unit.x -= dir * unit.speed * dt * 0.8;
        unit.state = "walk";
      } else {
        // walk to roughly 200 from enemy base
        const target = unit.side === "A" ? enemyBase.x - 200 : enemyBase.x + 200;
        if (Math.abs(unit.x - target) > 10) {
          unit.x += dir * unit.speed * dt * 0.7;
          unit.state = "walk";
        } else {
          unit.state = "mine";
        }
      }
      unit.x = clamp(unit.x, myBase.x - 10, enemyBase.x + 10);
      continue;
    }

    // Combat units (sword/archer/spear/giant)
    const closestEnemy = nearestEnemy(unit, enemies);

    if (mode === "defend" && unit.type !== "giant") {
      // hold the line near home base
      const holdX = unit.side === "A" ? homeLine + 60 : homeLine - 60;
      if (!closestEnemy || dist1d(unit.x, closestEnemy.x) > unit.range + 40) {
        // move to hold position
        if (Math.abs(unit.x - holdX) > 15) {
          const sign = unit.x < holdX ? 1 : -1;
          unit.x += sign * unit.speed * dt;
        }
        unit.state = "walk";
        continue;
      }
    }

    // ATTACK logic
    if (closestEnemy) {
      const d = dist1d(unit.x, closestEnemy.x);

      if (d <= unit.range) {
        // in range — attack
        unit.state = "fight";
        if (unit.attackTimer === 0) {
          unit.attackTimer = unit.attackRate;

          if (unit.type === "archer" || unit.type === "spear") {
            // fire projectile
            st.projectiles.push({
              id: mkId(),
              owner: unit.side,
              x: unit.x,
              vx: dir * (unit.type === "archer" ? 480 : 340),
              dmg: unit.dmg,
              pierce: unit.type === "spear",
              ttl: 2000,
              hit: [],
            });
          } else {
            // melee
            closestEnemy.hp -= unit.dmg;
            if (closestEnemy.hp <= 0) {
              closestEnemy.hp = 0;
              st.gold[unit.side] += UNIT_DEF[closestEnemy.type]?.reward || 15;
            }
          }
        }
      } else {
        // move toward enemy
        unit.x += dir * unit.speed * dt;
        unit.state = "walk";
      }
    } else {
      // no enemies — march to enemy base
      if (dist1d(unit.x, enemyBase.x) > 72) {
        unit.x += dir * unit.speed * dt;
        unit.state = "walk";
      } else {
        // attack base
        unit.state = "fight";
        if (unit.attackTimer === 0) {
          unit.attackTimer = unit.attackRate;
          enemyBase.hp -= unit.dmg;
          if (enemyBase.hp <= 0) {
            enemyBase.hp = 0;
            st.winner = unit.side;
          }
        }
      }
    }

    unit.x = clamp(unit.x, 30, LANE_W - 30);
  }

  // ── Projectiles ───────────────────────────────────────────────────────────
  for (let i = st.projectiles.length - 1; i >= 0; i--) {
    const p = st.projectiles[i];
    p.ttl -= dtMs;
    p.x   += p.vx * dt;

    if (p.ttl <= 0 || p.x < 0 || p.x > LANE_W) {
      st.projectiles.splice(i, 1);
      continue;
    }

    const enemySide = p.owner === "A" ? "B" : "A";
    const enemyBase = st.bases[enemySide];

    let hit = false;
    for (const u of st.units) {
      if (u.side !== enemySide || u.hp <= 0) continue;
      if (p.hit.includes(u.id)) continue;
      if (Math.abs(u.x - p.x) < 22) {
        u.hp -= p.dmg;
        p.hit.push(u.id);
        if (u.hp <= 0) {
          u.hp = 0;
          st.gold[p.owner] += UNIT_DEF[u.type]?.reward || 15;
        }
        if (!p.pierce) { hit = true; break; }
      }
    }

    // hit base
    if (Math.abs(p.x - enemyBase.x) < 50) {
      enemyBase.hp -= p.dmg;
      if (enemyBase.hp <= 0) { enemyBase.hp = 0; st.winner = p.owner; }
      hit = true;
    }

    if (hit && !p.pierce) {
      st.projectiles.splice(i, 1);
      continue;
    }
  }

  // ── Clean dead units ──────────────────────────────────────────────────────
  for (const u of st.units) {
    if (u.hp <= 0 && u.hp !== -999) {
      st.pop[u.side] -= UNIT_DEF[u.type]?.pop || 1;
      if (st.pop[u.side] < 0) st.pop[u.side] = 0;
      u.hp = -999; // mark for removal
    }
  }
  st.units = st.units.filter(u => u.hp !== -999);

  // ── Gold cap ──────────────────────────────────────────────────────────────
  st.gold.A = Math.min(st.gold.A, 9999);
  st.gold.B = Math.min(st.gold.B, 9999);
}

function nearestEnemy(unit, enemies) {
  let best = null, bestD = Infinity;
  for (const e of enemies) {
    const d = dist1d(unit.x, e.x);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// ─── Tick loop ────────────────────────────────────────────────────────────────
setInterval(() => {
  const t = now();
  for (const [roomId, room] of rooms) {
    if (!room.clients.A && !room.clients.B) { rooms.delete(roomId); continue; }
    const dt = clamp(t - room.lastTick, 0, 100);
    room.lastTick = t;
    stepGame(room.state, dt);

    const msg = JSON.stringify({ type: "state", state: room.state });
    for (const side of ["A", "B"]) {
      const ws = room.clients[side];
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}, 50);

// ─── WebSocket ────────────────────────────────────────────────────────────────
const clients = new Map(); // ws -> { roomId, role }

wss.on("connection", (ws) => {
  clients.set(ws, { roomId: null, role: null });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const meta = clients.get(ws);

    if (msg.type === "create") {
      const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
      rooms.set(roomId, makeRoom(ws));
      meta.roomId = roomId; meta.role = "A";
      ws.send(JSON.stringify({ type: "joined", roomId, role: "A" }));
      return;
    }

    if (msg.type === "join") {
      const roomId = String(msg.roomId || "").trim().toUpperCase();
      const room   = rooms.get(roomId);
      if (!room) return ws.send(JSON.stringify({ type: "error", msg: "Комната не найдена" }));
      if (room.clients.B) return ws.send(JSON.stringify({ type: "error", msg: "Комната заполнена" }));
      room.clients.B = ws;
      meta.roomId = roomId; meta.role = "B";
      ws.send(JSON.stringify({ type: "joined", roomId, role: "B" }));
      // notify A
      if (room.clients.A?.readyState === WebSocket.OPEN)
        room.clients.A.send(JSON.stringify({ type: "opponent_joined" }));
      return;
    }

    if (msg.type === "reset") {
      const room = rooms.get(meta.roomId);
      if (!room) return;
      room.state = makeState();
      for (const side of ["A","B"]) {
        const ws2 = room.clients[side];
        if (ws2?.readyState === WebSocket.OPEN) ws2.send(JSON.stringify({ type: "reset_ok" }));
      }
      return;
    }

    if (msg.type === "spawn") {
      const room = rooms.get(meta.roomId);
      if (!room || !meta.role || room.state.winner) return;
      const result = spawnUnit(room.state, meta.role, msg.unitType);
      if (result === "nogold") ws.send(JSON.stringify({ type: "error", msg: "Недостаточно золота" }));
      if (result === "nopop")  ws.send(JSON.stringify({ type: "error", msg: "Лимит юнитов" }));
      return;
    }

    if (msg.type === "mode") {
      const room = rooms.get(meta.roomId);
      if (!room || !meta.role) return;
      room.state.mode[meta.role] = msg.value; // attack | defend
      return;
    }
  });

  ws.on("close", () => {
    const meta = clients.get(ws);
    if (meta?.roomId) {
      const room = rooms.get(meta.roomId);
      if (room) {
        if (meta.role === "A") room.clients.A = null;
        if (meta.role === "B") room.clients.B = null;
      }
    }
    clients.delete(ws);
  });
});

server.listen(PORT, () => console.log("🗡  Stick War server on port", PORT));

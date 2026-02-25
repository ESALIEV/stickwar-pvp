// server.js (Stick War Lite PvP)
// npm i ws
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");

const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
      res.writeHead(404); return res.end("Not found");
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

// ---------------- Game ----------------
const rooms = new Map();

function rid() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function now() { return Date.now(); }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

const LANE_W = 1000;
const LANE_H = 380;

const UNIT = {
  miner:  { hp: 45, dmg: 4,  range: 18, speed: 55,  cd: 800,  cost: 50,  goldPerSec: 6 },
  sword:  { hp: 95, dmg: 12, range: 22, speed: 75,  cd: 650,  cost: 120 },
  archer: { hp: 65, dmg: 8,  range: 140,speed: 65,  cd: 900,  cost: 170, projSpeed: 220 },
};

function makeState(){
  return {
    lane: { w: LANE_W, h: LANE_H },
    bases: {
      A: { x: 80,  hp: 650 },
      B: { x: 920, hp: 650 },
    },
    gold: { A: 250, B: 250 },
    pop:  { A: 0,   B: 0 },
    popCap:{ A: 30, B: 30 },
    mode: { A: "defend", B: "defend" }, // defend/attack (в MVP влияет на точку сбора)
    units: [],        // {id, side, type, x, hp, atkCd, targetMode}
    projectiles: [],  // {x, side, dmg, vx}
    winner: null,
    t: now(),
  };
}

function broadcast(room, obj){
  const s = JSON.stringify(obj);
  for (const ws of room.clients){
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(s);
  }
}

function spawnUnit(st, side, type){
  const cfg = UNIT[type];
  if (!cfg) return { ok:false, msg:"unknown unit" };
  if (st.winner) return { ok:false, msg:"game ended" };
  if (st.gold[side] < cfg.cost) return { ok:false, msg:"no gold" };
  if (st.pop[side] >= st.popCap[side]) return { ok:false, msg:"pop cap" };

  st.gold[side] -= cfg.cost;
  st.pop[side] += 1;

  const id = Math.random().toString(36).slice(2);
  const baseX = st.bases[side].x;
  const x = side === "A" ? baseX + 35 : baseX - 35;

  st.units.push({
    id, side, type,
    x,
    hp: cfg.hp,
    atkCd: 0,
  });
  return { ok:true };
}

function enemySide(side){ return side === "A" ? "B" : "A"; }

function step(st, dtMs){
  if (st.winner) return;
  const dt = dtMs / 1000;

  // золото от miner
  let minersA = 0, minersB = 0;
  for (const u of st.units){
    if (u.type === "miner"){
      if (u.side === "A") minersA++;
      else minersB++;
    }
  }
  st.gold.A += minersA * UNIT.miner.goldPerSec * dt;
  st.gold.B += minersB * UNIT.miner.goldPerSec * dt;
  st.gold.A = Math.floor(st.gold.A);
  st.gold.B = Math.floor(st.gold.B);

  // таймеры
  for (const u of st.units){
    u.atkCd = Math.max(0, u.atkCd - dtMs);
  }

  // движение + атака (упрощённый “лейн батлер”)
  // Правило: юнит видит ближайшего врага по оси X в радиусе range (или базу).
  const proj = st.projectiles;

  function findTarget(unit){
    const cfg = UNIT[unit.type];
    const es = enemySide(unit.side);

    // найти ближайшего врага по направлению движения
    let best = null;
    let bestDist = Infinity;

    for (const other of st.units){
      if (other.side !== es) continue;
      const dx = other.x - unit.x;
      const dist = Math.abs(dx);

      // чтобы лучник/мечник не бил назад, но сильно не усложняем:
      // A атакует вправо, B атакует влево
      if (unit.side === "A" && dx < 0) continue;
      if (unit.side === "B" && dx > 0) continue;

      if (dist < bestDist) { bestDist = dist; best = other; }
    }

    if (best && bestDist <= cfg.range) return { kind:"unit", ref: best };

    // если никого рядом, можно бить базу если дошёл
    const base = st.bases[es];
    const distBase = Math.abs(base.x - unit.x);
    if (distBase <= cfg.range) return { kind:"base", side: es };

    return null;
  }

  // перемещение
  for (const u of st.units){
    const cfg = UNIT[u.type];
    const target = findTarget(u);

    if (!target){
      // идём вперёд
      const dir = u.side === "A" ? 1 : -1;
      u.x += dir * cfg.speed * dt;

      // ограничим границы лейна
      u.x = clamp(u.x, 20, LANE_W - 20);
    } else {
      // атакуем
      if (u.atkCd === 0){
        u.atkCd = cfg.cd;

        if (u.type === "archer"){
          // стреляет снарядом
          const dir = u.side === "A" ? 1 : -1;
          proj.push({ x: u.x, side: u.side, dmg: cfg.dmg, vx: dir * cfg.projSpeed });
        } else {
          // мили урон сразу
          if (target.kind === "unit"){
            target.ref.hp -= cfg.dmg;
          } else {
            st.bases[target.side].hp -= cfg.dmg;
          }
        }
      }
    }
  }

  // снаряды (стрелы)
  for (let i = proj.length - 1; i >= 0; i--){
    const p = proj[i];
    p.x += p.vx * dt;

    // попадание в ближайшего врага
    const es = enemySide(p.side);
    let hit = null;
    let bestDist = 999999;

    for (const u of st.units){
      if (u.side !== es) continue;
      const dist = Math.abs(u.x - p.x);
      if (dist < 14 && dist < bestDist){
        bestDist = dist;
        hit = u;
      }
    }

    if (hit){
      hit.hp -= p.dmg;
      proj.splice(i, 1);
      continue;
    }

    // попадание в базу
    const base = st.bases[es];
    if (Math.abs(base.x - p.x) < 18){
      base.hp -= p.dmg;
      proj.splice(i, 1);
      continue;
    }

    // улетело
    if (p.x < -50 || p.x > LANE_W + 50) proj.splice(i, 1);
  }

  // смерть юнитов
  for (let i = st.units.length - 1; i >= 0; i--){
    if (st.units[i].hp <= 0){
      st.pop[st.units[i].side] = Math.max(0, st.pop[st.units[i].side] - 1);
      st.units.splice(i, 1);
    }
  }

  // победа
  if (st.bases.A.hp <= 0) st.winner = "B";
  if (st.bases.B.hp <= 0) st.winner = "A";
}

setInterval(() => {
  const t = now();
  for (const [roomId, room] of rooms){
    if (room.clients.length === 0){
      rooms.delete(roomId);
      continue;
    }
    const dt = Math.min(120, t - room.lastTick);
    room.lastTick = t;

    step(room.state, dt);
    broadcast(room, { type:"state", roomId, state: room.state });
  }
}, 50); // 20 FPS

wss.on("connection", (ws) => {
  ws.roomId = null;
  ws.role = null;

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "create"){
      const roomId = rid();
      rooms.set(roomId, { clients: [ws], state: makeState(), lastTick: now() });
      ws.roomId = roomId;
      ws.role = "A";
      ws.send(JSON.stringify({ type:"joined", roomId, role:"A" }));
      return;
    }

    if (msg.type === "join"){
      const roomId = String(msg.roomId||"").trim().toUpperCase();
      const room = rooms.get(roomId);
      if (!room) return ws.send(JSON.stringify({ type:"error", msg:"Room not found" }));
      if (room.clients.length >= 2) return ws.send(JSON.stringify({ type:"error", msg:"Room full" }));
      room.clients.push(ws);
      ws.roomId = roomId;
      ws.role = "B";
      ws.send(JSON.stringify({ type:"joined", roomId, role:"B" }));
      broadcast(room, { type:"info", msg:"Player B joined" });
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room || !ws.role) return;

    if (msg.type === "spawn"){
      const st = room.state;
      const r = spawnUnit(st, ws.role, msg.unitType);
      if (!r.ok) ws.send(JSON.stringify({ type:"error", msg: r.msg }));
      return;
    }

    if (msg.type === "mode"){
      room.state.mode[ws.role] = (msg.value === "attack") ? "attack" : "defend";
      return;
    }

    if (msg.type === "reset"){
      room.state = makeState();
      broadcast(room, { type:"info", msg:"Reset" });
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

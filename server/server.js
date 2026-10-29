/**
 * 炸弹猫联机服务器。
 *
 * 架构（调研结论落地）：
 *   - 权威服务器：完整游戏状态只在服务端，所有动作在此校验后由引擎结算。
 *     手牌是隐藏信息，P2P 互传状态等于把底牌摊开。
 *   - 引擎复用：src/core/engine.js 是纯逻辑，Node 直接 require——
 *     联机与单机跑的是同一套规则，不维护第二份实现。
 *   - 按座位分发：每个玩家收到「自己的手牌 + 自己的合法动作」的私有快照；
 *     事件流按座位脱敏（对手抽到的牌、炸弹插回位置、预测未来的牌面都只发给本人）。
 *   - 断线重连：开局时每人发一个 seat token，断线后 90s 内凭 token 重连并补发当前快照。
 *
 * 运行：node server/server.js [端口]     （默认 8080；页面与 WebSocket 同源）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const Engine = require('../src/core/engine.js');
const RNG = require('../src/core/rng.js');
const { accept, WsSocket } = require('./ws.js');
const { eventsForSeat } = require('./redact.js');

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // 路径安全：拼出来不在项目根内的一律 404，防 ../ 穿越
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ---------------- 房间与对局 ---------------- */

const rooms = new Map();                    // code -> room
const GRACE_MS = 90 * 1000;                 // 断线宽限：超时未归，房间解散（Wesnoth 先例 90s）
// 否决窗口的思考时间：太短来不及读牌，太长会把牌桌拖住。
// 测试可用 NOPE_TIMEOUT_MS 环境变量缩短。
const NOPE_TIMEOUT_MS = Math.max(500, parseInt(process.env.NOPE_TIMEOUT_MS || '8000', 10) || 8000);
// 测试固定种子：设置后每局都用同一副牌，方便端到端断言否决窗口
const FIXED_SEED = process.env.BOMBCATS_SEED ? (parseInt(process.env.BOMBCATS_SEED, 10) >>> 0) : null;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // 去掉易混的 0/1/I/L/O

const rnd4 = () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
const newCode = () => {
  for (let guard = 0; guard < 50; guard++) {
    const code = rnd4() + rnd4() + rnd4() + rnd4();
    if (!rooms.has(code)) return code;
  }
  return null;
};
const newToken = () => crypto.randomBytes(16).toString('hex');

function roomByCode(code) {
  return rooms.get(String(code || '').toUpperCase()) || null;
}

function createRoom(conn, name) {
  const code = newCode();
  if (!code) return null;
  const room = {
    code,
    host: 0,
    started: false,
    ended: false,
    G: null,
    lastPeekSeat: -1,
    nopeTimer: null,         // 当前否决窗口的超时计时器
    respondDeadline: 0,      // 发给客户端的截止时间戳
    players: [{ seat: 0, name: name || '玩家 1', token: newToken(), conn: null, since: Date.now() }],
    graceTimer: null
  };
  bindSeat(room, 0, conn);
  rooms.set(code, room);
  return room;
}

function joinRoom(room, conn, name) {
  if (room.started || room.ended) return { error: '对局已经开始' };
  if (room.players.length >= 5) return { error: '房间已满（最多 5 人）' };
  const seat = room.players.length;
  room.players.push({ seat, name: (name || '').slice(0, 10) || ('玩家 ' + (seat + 1)), token: newToken(), conn: null, since: Date.now() });
  bindSeat(room, seat, conn);
  return { seat };
}

/** 把连接绑到座位；同一座位旧连接先踢掉（重复打开页面/重连） */
function bindSeat(room, seat, conn) {
  const p = room.players[seat];
  if (p.conn && p.conn !== conn) p.conn.close();
  p.conn = conn;
  conn._room = room;
  conn._seat = seat;
  stopGraceTimer(room);
}

function stopGraceTimer(room) {
  if (room.graceTimer) { clearTimeout(room.graceTimer); room.graceTimer = null; }
}

/** 断线处理：未开局且所有人都掉了 → 直接解散；开局了 → 起宽限计时 */
function onSeatDisconnect(room, seat) {
  const p = room.players[seat];
  if (p) p.conn = null;
  broadcast(room, { t: 'seat-gone', seat });

  const anyone = room.players.some(x => x.conn);
  if (!anyone) { destroyRoom(room); return; }
  // 掉线的人不能卡住否决窗口：重排一次，由 promptResponder 转入自动放过
  if (room.G && room.G.pendingAction && Engine.pendingResponder(room.G) === seat) {
    promptResponder(room);
  }
  if (room.started && !room.ended && !room.graceTimer) {
    room.graceTimer = setTimeout(() => {
      room.graceTimer = null;
      if (!room.players.some(x => x.conn)) { destroyRoom(room); return; }
      if (room.players.some(x => !x.conn)) {
        broadcast(room, { t: 'closed', reason: '有玩家长时间掉线，房间已解散' });
        destroyRoom(room);
      }
    }, GRACE_MS);
  }
}

function destroyRoom(room) {
  stopGraceTimer(room);
  clearNopeTimer(room);
  room.players.forEach(p => { if (p.conn) { p.conn._room = null; p.conn.close(); p.conn = null; } });
  rooms.delete(room.code);
}

/* ---------------- 快照与事件脱敏 ---------------- */

/**
 * 座位私有快照：完整状态拷贝后，把「非本人」的手牌藏起来再走 getState。
 * 顺带算好本人此刻的合法动作，客户端渲染直接用，不再自己碰引擎。
 */
function snapshotFor(room, seat) {
  const view = JSON.parse(JSON.stringify(room.G));
  view.players.forEach(p => { p.isAI = (p.id !== seat); });   // getState 只对 isAI===false 亮手牌
  const s = Engine.getState(view);
  // 徽标按真人显示（isAI 在视图里统一翻回 false），手牌只保留本人的
  s.players.forEach(p => {
    p.isAI = false;
    if (p.id !== seat) p.hand = null;
  });
  s.moves = Engine.legalMoves(view, seat);
  s.you = seat;
  // 预测未来看到的牌面只有看的人自己能知道
  s.seenTop = (room.lastPeekSeat === seat) ? s.seenTop : [];
  return s;
}

function snapshots(room) {
  return room.players.map(p => snapshotFor(room, p.seat));
}

/**
 * 广播一条 update：先换快照再播事件（与离线 runAction 的顺序一致）
 */
function broadcastUpdate(room, events) {
  const snaps = snapshots(room);
  room.players.forEach(p => {
    if (!p.conn) return;
    p.conn.send(JSON.stringify({
      t: 'update',
      events: eventsForSeat(events, p.seat),
      state: snaps[p.seat],
      moves: snaps[p.seat].moves
    }));
  });
}

function broadcastLobby(room) {
  broadcast(room, {
    t: 'lobby',
    code: room.code,
    host: room.host,
    players: room.players.map(p => ({ seat: p.seat, name: p.name, connected: !!p.conn }))
  });
}

function broadcast(room, msg) {
  const text = JSON.stringify(msg);
  room.players.forEach(p => { if (p.conn) p.conn.send(text); });
}

/* ---------------- 否决窗口 ----------------
   窗口状态由引擎维护（pendingAction），服务器负责：
   - 只把「现在轮到你回应」的邀请发给对应座位（谁手里有否决是隐藏信息）；
   - 超时自动放过，避免一个人离开就卡住牌桌；
   - 回应成功后广播新快照，再邀请下一位候选。 */

function clearNopeTimer(room) {
  if (room.nopeTimer) { clearTimeout(room.nopeTimer); room.nopeTimer = null; }
  room.respondDeadline = 0;
}

/** 给当前回应者发私有邀请；掉线的人短延时后自动放过 */
function promptResponder(room) {
  clearNopeTimer(room);
  const G = room.G;
  if (!G || !G.pendingAction || room.ended) return;
  const seat = Engine.pendingResponder(G);
  if (seat == null) return;
  const p = room.players[seat];

  if (!p || !p.conn) {
      room.nopeTimer = setTimeout(() => {
      room.nopeTimer = null;
      const back = room.players[seat];
      if (back && back.conn) { promptResponder(room); return; }   // 人回来了，重新邀请
          autoPass(room, seat);
    }, 350);
    return;
  }

  room.respondDeadline = Date.now() + NOPE_TIMEOUT_MS;
  p.conn.send(JSON.stringify({ t: 'respond', deadline: room.respondDeadline }));
  room.nopeTimer = setTimeout(() => {
    room.nopeTimer = null;
    autoPass(room, seat);
  }, NOPE_TIMEOUT_MS);
}

/** 超时 / 掉线：视为放过，继续窗口或结算原牌 */
function autoPass(room, seat) {
  const G = room.G;
  if (!G || !G.pendingAction || Engine.pendingResponder(G) !== seat) return;
  const r = Engine.passResponse(G, seat);
  if (!r.ok) return;
  afterResponse(room, r);
}

/** 回应结算后的广播与窗口推进 */
function afterResponse(room, r) {
  const G = room.G;
  if (!G) return;
  const peek = (r.events || []).find(e => e.type === 'peek');
  if (peek) room.lastPeekSeat = peek.player;
  if (G.phase === 'over') { room.ended = true; clearNopeTimer(room); }
  broadcastUpdate(room, r.events || []);
  if (!room.ended && G.pendingAction) promptResponder(room);
}

/** 收到某座的回应：nope=true 打出否决，否则放过 */
function applyResponse(room, seat, useNope) {
  const G = room.G;
  if (!G || room.ended) return sendErr(room, seat, '对局不在进行中');
  if (!G.pendingAction || Engine.pendingResponder(G) !== seat) {
    return sendErr(room, seat, '现在轮不到你回应');
  }

  let r = null;
  if (useNope) {
    const me = G.players[seat];
    const nope = me && me.hand ? me.hand.find(c => c.type === 'nope') : null;
    if (!nope) return sendErr(room, seat, '你手里没有否决');
    r = Engine.respondNope(G, seat, nope.uid);
  } else {
    r = Engine.passResponse(G, seat);
  }
  if (!r.ok) return sendErr(room, seat, r.error || '回应无效');

  clearNopeTimer(room);
  afterResponse(room, r);
}

/* ---------------- 对局驱动 ---------------- */

function startGame(room) {
  const seed = FIXED_SEED != null
    ? FIXED_SEED
    : ((Date.now() ^ (crypto.randomInt(0xffffffff))) >>> 0);
  const rng = RNG.seeded(seed);
  room.G = Engine.createGame({
    playerCount: room.players.length,
    names: room.players.map(p => p.name),
    rng,
    humanIndex: 0
  });
  // 引擎按 humanIndex 分真人/AI，联机全员真人：badge 显示与状态可见性都按真人走
  room.G.players.forEach(p => { p.isAI = false; });
  room.started = true;
  room.lastPeekSeat = -1;
  clearNopeTimer(room);

  room.players.forEach(p => {
    if (!p.conn) return;
    const snap = snapshotFor(room, p.seat);
    p.conn.send(JSON.stringify({ t: 'started', state: snap, moves: snap.moves }));
  });
  broadcastUpdate(room, []);
}

/** 动作统一入口：校验「本人回合」后交给引擎，成功就广播 update */
function applyAction(room, seat, action) {
  const G = room.G;
  if (!G || room.ended) return sendErr(room, seat, '对局不在进行中');
  if (G.current !== seat) return sendErr(room, seat, '还没轮到你');
  if (G.pendingBomb && (action.act !== 'place' || G.pendingBomb.player !== seat)) {
    return sendErr(room, seat, '等待炸弹放回');
  }

  let r = null;
  if (action.act === 'play') {
    r = Engine.playCard(G, seat, action.uid | 0, action.target == null ? undefined : (action.target | 0));
  } else if (action.act === 'end') {
    r = Engine.endTurn(G, seat);
  } else if (action.act === 'place') {
    r = Engine.placeBomb(G, seat, action.pos | 0);
    if (r.ok) {
      // 与离线 main.js 的 afterPlacement 一致：若回合正卡在「等放回」，接着推进
      if (G.turnEndPending) {
        const r2 = Engine.resumeAfterPlacement(G, G.current);
        if (r2.ok) r.events = r.events.concat(r2.events);
      }
    }
  } else {
    return sendErr(room, seat, '未知动作');
  }

  if (!r.ok) return sendErr(room, seat, r.error || '动作无效');
  const peek = (r.events || []).find(e => e.type === 'peek');
  if (peek) room.lastPeekSeat = peek.player != null ? peek.player : seat;
  if (G.phase === 'over') { room.ended = true; clearNopeTimer(room); }
  broadcastUpdate(room, r.events);
  // 有牌进了否决窗口：先让所有人拿到快照，再私下邀请第一位候选
  if (!room.ended && G.pendingAction) promptResponder(room);
}

function sendErr(room, seat, msg) {
  const p = room.players[seat];
  if (p && p.conn) p.conn.send(JSON.stringify({ t: 'err', msg }));
}

/* ---------------- 连接层 ---------------- */

const server = http.createServer(serveStatic);
server.on('upgrade', (req, socket) => {
  if (!accept(req, socket)) { socket.destroy(); return; }
  const conn = new WsSocket(socket);

  conn.onText(text => {
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const room = conn._room;

    // 房间内消息：动作 / 离开
    if (room) {
      const seat = conn._seat;
      if (msg.t === 'act') { applyAction(room, seat, msg); return; }
      if (msg.t === 'respond') { applyResponse(room, seat, !!msg.nope); return; }
      if (msg.t === 'leave') {
        const p = room.players[seat];
        if (p) p.conn = null;
        conn._room = null;
        broadcast(room, { t: 'closed', reason: (p ? p.name : '有人') + ' 离开了房间' });
        destroyRoom(room);
        return;
      }
      if (msg.t === 'start' && !room.started && seat === room.host) {
        if (room.players.length >= 2) startGame(room);
        else sendErr(room, seat, '至少要 2 个人才能开局');
        return;
      }
      if (msg.t === 'ping') { conn.send('{"t":"pong"}'); return; }
      return;   // 房间内不收其他消息
    }

    // 大厅消息：创建 / 加入 / 重连
    if (msg.t === 'create') {
      const r = createRoom(conn, String(msg.name || '').slice(0, 10));
      if (!r) return conn.send(JSON.stringify({ t: 'err', msg: '创建失败' }));
      conn.send(JSON.stringify({ t: 'created', code: r.code, seat: 0, token: r.players[0].token }));
      broadcastLobby(r);
    } else if (msg.t === 'join') {
      const r = roomByCode(msg.code);
      if (!r) return conn.send(JSON.stringify({ t: 'err', msg: '房间不存在' }));
      const res = joinRoom(r, conn, String(msg.name || '').slice(0, 10));
      if (res.error) return conn.send(JSON.stringify({ t: 'err', msg: res.error }));
      conn.send(JSON.stringify({ t: 'joined', code: r.code, seat: res.seat, token: r.players[res.seat].token }));
      broadcastLobby(r);
    } else if (msg.t === 'rejoin') {
      const r = roomByCode(msg.code);
      const p = r && r.players[msg.seat | 0];
      if (!p || p.token !== msg.token) {
        return conn.send(JSON.stringify({ t: 'err', msg: '无法重连：房间不存在或已重开', fatal: true }));
      }
      bindSeat(r, p.seat, conn);
      conn.send(JSON.stringify({ t: 'rejoined', code: r.code, seat: p.seat, token: p.token }));
      if (r.started) {
        const snap = snapshotFor(r, p.seat);
        conn.send(JSON.stringify({ t: 'started', state: snap, moves: snap.moves }));
        broadcastUpdate(r, []);      // 其他人收到 seat-back + 新快照
        broadcast(r, { t: 'seat-back', seat: p.seat });
        // 重连回来的人可能正轮到回应否决：补发邀请
        if (r.G && r.G.pendingAction && Engine.pendingResponder(r.G) === p.seat) {
          promptResponder(r);
        }
      } else {
        broadcastLobby(r);
      }
    } else if (msg.t === 'ping') {
      conn.send('{"t":"pong"}');
    }
  });

  conn.onClose(() => {
    const room = conn._room;
      if (room && conn._seat != null && room.players[conn._seat] && room.players[conn._seat].conn === conn) {
      onSeatDisconnect(room, conn._seat);
    }
  });
});

/* 空房清扫：没人且闲置超 10 分钟的房间删掉，防 Map 无限膨胀 */
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    const idle = now - Math.max(...room.players.map(p => p.since));
    if (!room.players.some(p => p.conn) && idle > 10 * 60 * 1000) rooms.delete(code);
  });
}, 60 * 1000);

/* ---------------- 启动 ---------------- */

const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
server.listen(PORT, () => {
  // PORT=0 时由系统分配端口，测试就是靠这行 stdout 拿到真实端口的
  console.log('[炸弹猫] 联机服务器已启动: http://localhost:' + server.address().port);
});

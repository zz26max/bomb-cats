/**
 * 联机服务器端到端测试（真实 WebSocket，裸 net socket 实现）。
 *
 * 覆盖：
 *   1. 创建 / 加入 / 开局的消息流
 *   2. 快照隐私：自己的手牌可见，对手手牌必须是 null
 *   3. 事件脱敏：对手抽到的牌 card 必须为 null，自己的必须是完整牌
 *   4. 完整对局：两个自驱动客户端从开局打到分出胜负
 *   5. 断线重连：凭 seat token 找回座位并拿到当前快照
 *
 * 用法：node tests/server.test.js
 */
'use strict';
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const { eventsForSeat } = require('../server/redact.js');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '（' + extra + '）' : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- 裸 WebSocket 测试客户端 ---------------- */

class TestClient {
  constructor(port) {
    const self = this;
    this.msgs = [];
    this.waiters = [];
    this.lastState = null;
    this.lastMoves = null;
    this.allEvents = [];        // 收到的全部事件（脱敏断言用）
    this.autoPlay = false;      // 轮到自己就自动出牌/结束回合
    this.autoNope = false;      // 收到否决邀请时自动打出否决（否则放过）
    this.msgSeq = 0;
    this.closed = false;

    const key = crypto.randomBytes(16).toString('base64');
    this.socket = net.connect(port, '127.0.0.1', () => {
      self.socket.write(
        'GET / HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n');
    });

    this.buf = Buffer.alloc(0);
    this.handshaken = false;
    this.socket.on('data', chunk => self._feed(chunk));
    this.socket.on('close', () => { self.closed = true; });
    this.socket.on('error', () => { self.closed = true; });
  }

  /** 客户端帧必须带 mask（RFC6455） */
  _frame(payload, opcode) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    const len = masked.length;
    let head;
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode; head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    }
    return Buffer.concat([head, mask, masked]);
  }

  _feed(chunk) {
    const self = this;
    if (!this.handshaken) {
      this.buf = Buffer.concat([this.buf, chunk]);
      const idx = this.buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = this.buf.slice(0, idx).toString();
      if (!/101/.test(head)) { this.closed = true; return; }
      this.handshaken = true;
      this.buf = this.buf.slice(idx + 4);
    } else {
      this.buf = Buffer.concat([this.buf, chunk]);
    }
    while (true) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len);
      this.buf = buf.slice(off + len);
      if (opcode === 0x1) {
        const msg = JSON.parse(payload.toString('utf8'));
        self._dispatch(msg);
      } /* ping/close 在测试里不会遇到 */
    }
  }

  _dispatch(msg) {
    msg._seq = ++this.msgSeq;
    if (msg.t === 'update' || msg.t === 'started') {
      this.lastState = msg.state;
      this.lastMoves = msg.moves;
      if (msg.t === 'update') this.allEvents.push(...(msg.events || []));
      if (this.autoPlay) this.maybeAct();
    }
    if (msg.t === 'respond' && this.autoPlay) {
      this.send({ t: 'respond', nope: !!this.autoNope });
    }
    this.msgs.push(msg);
    this.waiters = this.waiters.filter(w => {
      if (w.pred(msg)) { w.resolve(msg); return false; }
      return true;
    });
  }

  /** 自驱动：待放炸弹就放回最底部；轮到自己就先出牌、没牌就结束回合 */
  maybeAct() {
    const st = this.lastState;
    if (!st || st.phase !== 'playing') return;
    if (st.pendingBomb && st.pendingBomb.player === st.you) {
      this.send({ t: 'act', act: 'place', pos: st.deckSize });
      return;
    }
    if (st.pendingAction) return;        // 等否决窗口，别往服务器发无效动作
    if (st.current === st.you) {
      const mv = this.lastMoves || { playable: [] };
      // 优先打「摸两张」：让 draw2.cards 的脱敏断言有稳定的数据来源
      const d2 = (mv.playable || []).find(m => m.type === 'draw2');
      const pick = d2 || (mv.playable || [])[0];
      if (pick) {
        this.send({ t: 'act', act: 'play', uid: pick.cardUid });
      } else {
        this.send({ t: 'act', act: 'end' });
      }
    }
  }

  send(obj) {
    if (this.closed) return;
    this.socket.write(this._frame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1));
  }

  wait(pred, timeout, label) {
    const queued = this.msgs.find(pred);
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待超时: ' + (label || ''))), timeout || 5000);
      this.waiters.push({
        pred,
        resolve: msg => { clearTimeout(timer); resolve(msg); }
      });
    });
  }

  /** 只认基线之后的新消息（同一客户端会多次收到 respond，不能命中上一条） */
  waitAfter(pred, sinceSeq, timeout, label) {
    const queued = this.msgs.find(m => m._seq > sinceSeq && pred(m));
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待超时: ' + (label || ''))), timeout || 5000);
      this.waiters.push({
        pred: m => m._seq > sinceSeq && pred(m),
        resolve: msg => { clearTimeout(timer); resolve(msg); }
      });
    });
  }

  close() {
    try { this.socket.destroy(); } catch (e) { /* 忽略 */ }
    this.closed = true;
  }
}

/* ---------------- 测试主体 ---------------- */

async function main() {
  console.log('\n=== 联机服务器端到端测试 ===\n');

  // 0. 事件脱敏纯函数：直接喂事件，不依赖随机牌局里是否真的摸到「摸两张」
  //    （自驱动对局约 13% 的情况压根没出现 draw2，用它做唯一数据源会偶发翻车）
  const seed = [
    { type: 'draw', player: 0, card: { uid: 11 } },
    { type: 'draw', player: 1, card: { uid: 12 } },
    { type: 'draw2', player: 0, cards: [{ uid: 21 }, { uid: 22 }] },
    { type: 'draw2', player: 1, cards: [{ uid: 23 }, { uid: 24 }] },
    { type: 'peek', player: 0, cards: [{ uid: 31 }] },
    { type: 'peek', player: 1, cards: [{ uid: 32 }] },
    { type: 'place-bomb', player: 0, position: 3, deckSize: 12 },
    { type: 'place-bomb', player: 1, position: 7, deckSize: 12 },
    { type: 'play', player: 1, card: { uid: 41 }, target: null }
  ];
  const seenBy0 = eventsForSeat(seed, 0);
  ok('脱敏：自己的抽牌保留牌面，对手的置 null',
    seenBy0[0].card != null && seenBy0[1].card === null);
  ok('脱敏：自己的「摸两张」保留牌面，对手的置 null',
    seenBy0[2].cards != null && seenBy0[3].cards === null);
  ok('脱敏：预测未来看到的牌只给本人',
    seenBy0[4].cards != null && seenBy0[5].cards === null);
  ok('脱敏：炸弹放回位置只给本人，公开事件原样保留',
    seenBy0[6].position === 3 && seenBy0[7].position === null && seenBy0[8].card != null);

  // 起服务器（随机端口，从 stdout 拿真实端口）
  // 固定种子 10：两家起手各有一张否决，2 人局由 0 号位先手，可稳定复现否决窗口。
  // 否决思考时间缩到 1.2s，超时用例不用等 8 秒。
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js'), '0'], {
    stdio: 'pipe',
    env: Object.assign({}, process.env, { NOPE_TIMEOUT_MS: '1200', BOMBCATS_SEED: '10' })
  });
  let port = null;
  child.stdout.on('data', d => {
    const m = String(d).match(/localhost:(\d+)/);
    if (m) port = parseInt(m[1], 10);
  });
  child.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 50 && !port; i++) await sleep(100);
  if (!port) { console.log('  ✗ 服务器未能启动'); child.kill(); process.exit(1); return; }

  try {
    // 1. 创建 / 加入
    const A = new TestClient(port);
    await sleep(200);
    A.send({ t: 'create', name: '甲' });
    const created = await A.wait(m => m.t === 'created', 4000, 'created');
    ok('创建房间返回 4 位房间码', /^[2-9A-HJKMNP-Z]{4}$/.test(created.code), created.code);

    const B = new TestClient(port);
    await sleep(200);
    B.send({ t: 'join', code: created.code, name: '乙' });
    const joined = await B.wait(m => m.t === 'joined', 4000, 'joined');
    ok('加入房间分配座位 1', joined.seat === 1);

    await A.wait(m => m.t === 'lobby' && m.players.length === 2, 4000, 'lobby');
    ok('等待室广播了 2 名玩家', true);

    // 2. 开局 + 快照隐私
    A.send({ t: 'start' });
    const aStart = await A.wait(m => m.t === 'started', 4000, 'started A');
    const bStart = await B.wait(m => m.t === 'started', 4000, 'started B');
    ok('开局快照 phase=playing', aStart.state.phase === 'playing');
    ok('座位号正确', aStart.state.you === 0 && bStart.state.you === 1);
    ok('自己的手牌可见（5 张起手）', Array.isArray(aStart.state.players[0].hand) && aStart.state.players[0].hand.length > 0,
      'A 手牌 ' + (aStart.state.players[0].hand || []).length);
    ok('对手手牌必须为 null（隐藏信息不出服务器）',
      aStart.state.players[1].hand === null && bStart.state.players[0].hand === null);
    ok('快照自带合法动作', Array.isArray(aStart.state.moves.playable));

    // 2b. 否决窗口：固定种子让两家起手各有一张否决，逐步验证邀请隐私、
    //     否决链、取消、超时自动放过与断线不阻塞。
    console.log('\n[否决窗口]');

    async function openSeedRoom(tag) {
      const A = new TestClient(port);
      await sleep(150);
      A.send({ t: 'create', name: tag + '甲' });
      const created = await A.wait(m => m.t === 'created', 4000, 'create ' + tag);
      const B = new TestClient(port);
      await sleep(150);
      B.send({ t: 'join', code: created.code, name: tag + '乙' });
      await B.wait(m => m.t === 'joined', 4000, 'join ' + tag);
      await A.wait(m => m.t === 'lobby' && m.players.length === 2, 4000, 'lobby ' + tag);
      A.send({ t: 'start' });
      const aStart2 = await A.wait(m => m.t === 'started', 4000, 'A started ' + tag);
      const bStart2 = await B.wait(m => m.t === 'started', 4000, 'B started ' + tag);
      return { A, B, aStart: aStart2, bStart: bStart2 };
    }

    // 2b-1. 否决链：甲出牌 → 乙否决 → 甲再否决，偶数张原牌生效
    {
      const { A: NA, B: NB, aStart: s } = await openSeedRoom('链');
      const play = s.state.moves.playable.find(m => m.type === 'shuffle');
      ok('固定种子下起手有可出的洗牌', !!play);
      const aSeq = NA.msgSeq, bSeq = NB.msgSeq, evStart = NA.allEvents.length;
      NA.send({ t: 'act', act: 'play', uid: play.cardUid });
      const bInvite = await NB.waitAfter(m => m.t === 'respond', bSeq, 4000, '乙的否决邀请');
      ok('回应邀请带截止时间', bInvite.t === 'respond' && bInvite.deadline > Date.now());
      await sleep(150);
      ok('未轮到回应的人收不到邀请',
        !NA.msgs.some(m => m._seq > aSeq && m.t === 'respond'));
      const pa = NB.lastState.pendingAction;
      ok('窗口快照公开原牌与已出的否决',
        !!pa && pa.card.type === 'shuffle' && Array.isArray(pa.nopes));
      ok('快照不泄露回应顺序（awaiting/queue）',
        !!pa && pa.awaiting === undefined && pa.queue === undefined);
      ok('否决窗口内合法动作为空',
        (NB.lastMoves.playable || []).length === 0 && (NB.lastMoves.needTarget || []).length === 0);

      const aInviteSeq = NA.msgSeq;
      const bNoAskSeq = NB.msgSeq;
      NB.send({ t: 'respond', nope: true });
      const aInvite = await NA.waitAfter(m => m.t === 'respond', aInviteSeq, 4000, '甲的否决邀请');
      ok('被否决后，窗口交回出牌人继续表态', aInvite.t === 'respond');
      await sleep(150);
      ok('刚否决过的人不会被立刻重复询问',
        !NB.msgs.some(m => m._seq > bNoAskSeq && m.t === 'respond'));

      const closeSeq = NA.msgSeq;
      NA.send({ t: 'respond', nope: true });
      const closed = await NA.waitAfter(
        m => m.t === 'update' && m.state.pendingAction === null, closeSeq, 4000, '否决链结算');
      const evs = NA.allEvents.slice(evStart);
      ok('两张否决都广播到了事件流',
        evs.filter(e => e.type === 'nope').length === 2,
        evs.map(e => e.type).join(','));
      ok('偶数张否决：原牌生效，没有取消事件', !evs.some(e => e.type === 'cancel'));
      ok('否决链结束后回到正常回合', closed.state.pendingAction === null);
      NA.close(); NB.close();
    }

    // 2b-2. 单张否决：出牌人放过 → 原牌被取消
    {
      const { A: NA, B: NB, aStart: s } = await openSeedRoom('取消');
      const play = s.state.moves.playable.find(m => m.type === 'shuffle');
      const evStart = NA.allEvents.length;
      const bSeq = NB.msgSeq;
      NA.send({ t: 'act', act: 'play', uid: play.cardUid });
      await NB.waitAfter(m => m.t === 'respond', bSeq, 4000, '乙的否决邀请');
      const aSeq = NA.msgSeq;
      NB.send({ t: 'respond', nope: true });
      await NA.waitAfter(m => m.t === 'respond', aSeq, 4000, '甲的否决邀请');
      const closeSeq = NA.msgSeq;
      NA.send({ t: 'respond', nope: false });
      await NA.waitAfter(
        m => m.t === 'update' && m.state.pendingAction === null, closeSeq, 4000, '取消结算');
      const evs = NA.allEvents.slice(evStart);
      const cancel = evs.find(e => e.type === 'cancel');
      ok('单张否决取消原牌', !!cancel && cancel.target === 'shuffle',
        evs.map(e => e.type).join(','));
      ok('取消事件记录了否决者', !!cancel && cancel.by === 1);
      ok('被取消的牌没有产生效果', !evs.some(e => e.type === 'shuffle'));
      NA.close(); NB.close();
    }

    // 2b-3. 超时自动放过：回应者不操作，也要让牌桌继续
    {
      const { A: NA, B: NB, aStart: s } = await openSeedRoom('超时');
      const play = s.state.moves.playable.find(m => m.type === 'shuffle');
      const evStart = NA.allEvents.length;
      const bSeq = NB.msgSeq;
      NA.send({ t: 'act', act: 'play', uid: play.cardUid });
      await NB.waitAfter(m => m.t === 'respond', bSeq, 4000, '超时用例的邀请');
      const t0 = Date.now();
      // 基线取在邀请之后：startGame 在 started 之后还会补发一条空 update，
      // 它可能晚于 start 返回才到达，会把「窗口关闭」误判成已经发生。
      const closeSeq = NA.msgSeq;
      const closed = await NA.waitAfter(
        m => m.t === 'update' && m.state.pendingAction === null && (m.events || []).length > 0,
        closeSeq, 4000, '超时自动放过');
      const waited = Date.now() - t0;
      ok('回应超时后窗口自动关闭', closed.state.pendingAction === null, '等待 ' + waited + 'ms');
      ok('超时确实等满了思考时间', waited >= 700, waited + 'ms');
      const evs = NA.allEvents.slice(evStart);
      ok('超时视为放过，原牌正常生效', evs.some(e => e.type === 'shuffle'),
        evs.map(e => e.type).join(','));
      NA.close(); NB.close();
    }

    // 2b-4. 回应者掉线：短延时自动放过，不能把牌桌卡死
    {
      const { A: NA, B: NB, aStart: s } = await openSeedRoom('掉线');
      const play = s.state.moves.playable.find(m => m.type === 'shuffle');
      const bSeq = NB.msgSeq;
      NA.send({ t: 'act', act: 'play', uid: play.cardUid });
      await NB.waitAfter(m => m.t === 'respond', bSeq, 4000, '掉线用例的邀请');
      const t0 = Date.now();
      const closeSeq = NA.msgSeq;
      NB.close();
      const closed = await NA.waitAfter(
        m => m.t === 'update' && m.state.pendingAction === null && (m.events || []).length > 0,
        closeSeq, 4000, '掉线自动放过');
      const waited = Date.now() - t0;
      ok('回应者掉线后窗口自动关闭', closed.state.pendingAction === null, '等待 ' + waited + 'ms');
      ok('掉线自动放过不用等满思考时间', waited < 1100, waited + 'ms');
      NA.close();
    }
    await sleep(200);

    // 3. 完整对局：双方自驱动，打到分出胜负
    A.autoPlay = true;
    B.autoPlay = true;
    // 开局后的第一条 update 在上面的断言期间已被消费，autoPlay 是从现在开始挂的——
    // 当前行动者需要被主动踢一脚，否则两边都在等 update，对局永远停在第一回合
    [A, B].forEach(c => c.maybeAct());
    const startTurn = aStart.state.turn;
    const deadline = Date.now() + 60 * 1000;
    while (Date.now() < deadline) {
      const st = A.lastState;
      if (st && st.phase === 'over') break;
      await sleep(60);
    }
    const finalState = A.lastState;
    ok('完整对局打到分出胜负', !!finalState && finalState.phase === 'over',
      finalState ? 'phase=' + finalState.phase + ' turn=' + finalState.turn : '未结束');
    if (finalState && finalState.phase === 'over') {
      ok('胜者是存活玩家', finalState.players[finalState.winner] != null);
      ok('对局有实际回合数（> ' + startTurn + '）', finalState.turn > startTurn, 'turn=' + finalState.turn);
    }

    // 4. 事件脱敏：A 视角里，乙抽牌的事件 card 必须是 null，甲抽牌必须是完整牌
    const draws = A.allEvents.filter(e => e.type === 'draw');
    const myDraws = draws.filter(e => e.player === 0);
    const oppDraws = draws.filter(e => e.player !== 0);
    ok('甲的抽牌事件带完整牌面', myDraws.every(e => e.card && e.card.uid != null));
    ok('对手的抽牌事件已脱敏（card=null）', oppDraws.length > 0 && oppDraws.every(e => e.card === null),
      '对手抽牌 ' + oppDraws.length + ' 次');

    // 「摸两张」聚合事件里也带着两张牌：只给本人，不能绕开 draw 的脱敏。
    // 自驱动对局不保证出现这张牌（约 13% 没有），确定性覆盖见开头的纯函数用例；
    // 这里出现一次就顺带验证一次真实链路。
    const draw2s = A.allEvents.filter(e => e.type === 'draw2');
    const oppDraw2 = draw2s.filter(e => e.player !== 0);
    ok('「摸两张」事件也按座位脱敏',
      oppDraw2.every(e => e.cards === null),
      '触发 ' + draw2s.length + ' 次（对手 ' + oppDraw2.length + ' 次）');

    // 5. 断线重连：B 断开后凭 token 找回座位
    B.close();
    await sleep(300);
    const B2 = new TestClient(port);
    await sleep(200);
    B2.send({ t: 'rejoin', code: created.code, seat: joined.seat, token: joined.token });
    const rejoined = await B2.wait(m => m.t === 'rejoined', 4000, 'rejoined');
    ok('凭 token 重连成功', rejoined.seat === joined.seat);
    const reStart = await B2.wait(m => m.t === 'started', 4000, 'rejoin started');
    // 快照一致性：B 重连后自己看到的手牌张数，必须和 A 眼里座位 1 的手牌数一致
    // （不能断言「>0」：重连可能发生在对局结束后，败者手牌本来就空了）
    const aView = A.lastState && A.lastState.players[1] ? A.lastState.players[1].handSize : -1;
    const bView = reStart.state.players[1].hand ? reStart.state.players[1].hand.length : 0;
    ok('重连快照与房内视角一致（座位 1 手牌 ' + bView + ' 张）', aView === bView,
      'A 见 ' + aView + ' / B 自见 ' + bView);

    // 错误 token 拒绝
    const C = new TestClient(port);
    await sleep(200);
    C.send({ t: 'rejoin', code: created.code, seat: 1, token: 'bad' });
    const err = await C.wait(m => m.t === 'err', 4000, 'err');
    ok('错误 token 被拒绝', err.fatal === true, err.msg);
    C.close();

    A.close();
    B2.close();
  } finally {
    child.kill();
  }

  console.log('\n结果：' + passed + ' 通过, ' + failed + ' 失败\n');
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

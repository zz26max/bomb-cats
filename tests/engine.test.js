/**
 * 引擎冒烟测试：跑大量随机对局，验证不卡死、不崩溃、状态自洽。
 * 运行： node tests/engine.test.js
 */
'use strict';
const path = require('path');
const Engine = require(path.join(__dirname, '..', 'src', 'core', 'engine.js'));
const RNG = require(path.join(__dirname, '..', 'src', 'core', 'rng.js'));
const CARDS = require(path.join(__dirname, '..', 'src', 'core', 'cards.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

/** 把当前否决窗口里的候选逐一放过（无人愿意否决） */
function passWindow(g) {
  let guard = 0;
  while (g.pendingAction && guard++ < 100) {
    const pid = Engine.pendingResponder(g);
    if (pid == null) break;
    const r = Engine.passResponse(g, pid);
    if (!r.ok) throw new Error('passResponse: ' + r.error);
  }
}

/* ---------- 1. 牌堆构成 ---------- */
console.log('\n[1] 牌堆与初始化');
{
  const g = Engine.createGame({ playerCount: 4, rng: RNG.seeded(1) });
  const total = g.deck.length + g.players.reduce((s, p) => s + p.hand.length, 0) + g.discard.length;
  // 6 拆除 + 3 炸弹 + 5预测 + 4攻击 + 4跳过 + 4洗牌 + 4求饶 + 4帮忙 + 4否决 + 1摸两张 + 5无效果 = 44
  check('4 人局总牌数为 44', total === 44, '实际 ' + total);
  check('每位玩家手牌 5 张', g.players.every(p => p.hand.length === 5));
  check('每位玩家至少 1 张拆除', g.players.every(p => p.hand.some(c => c.type === 'defuse')));
  check('牌堆顶不是炸弹', g.deck[0].type !== 'bomb', '顶部是 ' + g.deck[0].type);
  // 炸弹总数 = 人数 - 1
  const bombTotal = g.deck.concat(...g.players.map(p => p.hand), g.discard)
    .filter(c => c.type === 'bomb').length;
  check('全场炸弹数 = 人数-1', bombTotal === 3, '实际 ' + bombTotal);
  // 官方规则：炸弹在发牌后才洗入牌堆，开局任何人手上都不该有炸弹
  const bombsInHand = g.players.reduce((s, p) => s + p.hand.filter(c => c.type === 'bomb').length, 0);
  check('开局没有任何人手上拿着炸弹', bombsInHand === 0, '手牌里 ' + bombsInHand + ' 张');
  check('快照里的炸弹总数正确', g.bombTotal === 3, '实际 ' + g.bombTotal);
  check('快照不再暴露「明牌炸弹」字段', Engine.getState(g).revealedBomb === undefined);
  check('当前玩家合法', g.current >= 0 && g.current < 4);
}

/* ---------- 1b. 炸弹不可打出 ---------- */
console.log('\n[1b] 炸弹不能被主动打出');
{
  const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(9), humanIndex: 0 });
  g.current = 0;
  const fakeBomb = Engine._internal.makeCard('bomb');
  g.players[0].hand.push(fakeBomb);
  const r = Engine.playCard(g, 0, fakeBomb.uid);
  check('playCard 拒绝打出炸弹', !r.ok && /炸弹/.test(r.error || ''), r.error || '居然成功了');
  const lm = Engine.legalMoves(g, 0);
  const offered = lm.playable.concat(lm.needTarget).some(m => m.type === 'bomb');
  check('legalMoves 不把炸弹列为可出', !offered);
}

/* ---------- 1c. 普通抽牌绝不能触发拆除 ---------- */
// 这里曾经有一个严重 bug：抽到任何非炸弹的牌也会走一遍「拆除」流程，
// 结果玩家每抽一次牌就白丢一张拆除，随后被真炸弹炸死，表现为「每局开局必炸」。
console.log('\n[1c] 抽到普通牌不应消耗拆除');
{
  let lostDefuse = 0, falseBomb = 0, noCardAdded = 0, sampled = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const g = Engine.createGame({ playerCount: 4, rng: RNG.seeded(seed), humanIndex: 0 });
    g.current = 0;
    const top = g.deck[0].type;
    if (top === 'bomb') continue;              // 只考察非炸弹
    sampled++;

    const defuseBefore = g.players[0].hand.filter(c => c.type === 'defuse').length;
    const handBefore = g.players[0].hand.length;
    const r = Engine.endTurn(g, 0);

    const defuseAfter = g.players[0].hand.filter(c => c.type === 'defuse').length;
    if (defuseAfter < defuseBefore) lostDefuse++;          // 不该少
    if (g.pendingBomb) falseBomb++;                        // 不该进入放回流程
    if (!r.events.some(e => e.type === 'draw')) noCardAdded++;
    // 抽牌 +1，若手上原本没拆除又抽到拆除也只会更多，因此至少 +1
    if (g.players[0].hand.length < handBefore + 1 && g.players[0].alive) noCardAdded++;
  }

  check(`抽到普通牌不消耗拆除（${sampled} 局）`, lostDefuse === 0, lostDefuse + ' 局被误扣');
  check('抽到普通牌不触发炸弹放回流程', falseBomb === 0, falseBomb + ' 局误触发');
  check('抽到普通牌后手牌确实 +1', noCardAdded === 0, noCardAdded + ' 局异常');
}

/* ---------- 1d. 跳过牌 ---------- */
// 「跳过」的规则价值就是本回合不抽牌。曾经界面仍提示「点击抽牌」，
// 玩家打完牌看不出任何变化，误以为跳过期失效；这里锁死引擎侧的效果。
console.log('\n[1d] 跳过牌取消本回合抽牌');
{
  const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(21), humanIndex: 0 });
  g.current = 0;
  g.pendingBomb = null;
  g.pendingDraws = 1;
  g.mustDraw = true;
  const skip = Engine._internal.makeCard('skip');
  g.players[0].hand.push(skip);
  const deckBefore = g.deck.length;
  const r = Engine.playCard(g, 0, skip.uid);
  passWindow(g);                       // 其他座位可能握着否决，测试里一律放过
  check('跳过可以打出', r.ok, r.error);
  check('跳过把本回合抽牌数清零',
    g.pendingDraws === 0 && g.mustDraw === false,
    'pendingDraws=' + g.pendingDraws + ' mustDraw=' + g.mustDraw);
  check('打出跳过本身不推进回合（由玩家点结束回合）', g.current === 0);
  const r2 = Engine.endTurn(g, 0);
  check('跳过后的结束回合不抽牌',
    r2.ok && g.deck.length === deckBefore && !r2.events.some(e => e.type === 'draw'),
    deckBefore + '->' + g.deck.length + ' events=' + r2.events.map(e => e.type).join(','));
  check('跳过结算后轮到下一位玩家',
    g.current === 1 && g.pendingDraws === 1,
    'current=' + g.current + ' pending=' + g.pendingDraws);

  // 被攻击（要抽 2 次）时打出跳过，两张都免掉
  const g2 = Engine.createGame({ playerCount: 3, rng: RNG.seeded(22), humanIndex: 0 });
  g2.current = 0;
  g2.pendingBomb = null;
  g2.pendingDraws = 2;
  g2.mustDraw = true;
  const skip2 = Engine._internal.makeCard('skip');
  g2.players[0].hand.push(skip2);
  const deck2 = g2.deck.length;
  Engine.playCard(g2, 0, skip2.uid);
  passWindow(g2);
  const r3 = Engine.endTurn(g2, 0);
  check('被攻击时打出跳过可免掉全部抽牌',
    r3.ok && g2.deck.length === deck2,
    deck2 + '->' + g2.deck.length);
}

/* ---------- 2. 随机对局压力测试 ---------- */
console.log('\n[2] 400 局随机对战（随机策略）');
{
  let games = 0, wins = 0, errors = [];
  const turnsPerGame = [];

  for (let seed = 1; seed <= 400; seed++) {
    const rng = RNG.seeded(seed);
    const n = 2 + (seed % 4);            // 2~5 人
    const g = Engine.createGame({ playerCount: n, rng, humanIndex: null });
    let steps = 0;
    let ended = false;

    while (steps++ < 3000) {
      if (g.phase === 'over') { ended = true; break; }
      const pid = g.current;
      const me = g.players[pid];

      // 否决窗口：随机决定是否反制，覆盖连锁与奇偶结算
      if (g.pendingAction) {
        const rid = Engine.pendingResponder(g);
        if (rid == null) { errors.push('否决窗口没有回应者'); break; }
        const nope = g.players[rid].hand.find(c => c.type === 'nope');
        const r = (nope && rng() < 0.4)
          ? Engine.respondNope(g, rid, nope.uid)
          : Engine.passResponse(g, rid);
        if (!r.ok) { errors.push('response: ' + r.error); break; }
        continue;
      }

      // 处理待放回炸弹
      if (g.pendingBomb) {
        const r = Engine.placeBomb(g, pid, Math.floor(rng() * (g.deck.length + 1)));
        if (!r.ok) { errors.push('placeBomb: ' + r.error); break; }
        if (g.turnEndPending) {
          const rr = Engine.resumeAfterPlacement(g, pid);
          if (!rr.ok) { errors.push('resume: ' + rr.error); break; }
        }
        continue;
      }

      // 随机出牌（40% 概率），否则结束回合
      const lm = Engine.legalMoves(g, pid);
      const all = lm.playable.concat(lm.needTarget);
      if (all.length && rng() < 0.45) {
        const mv = RNG.pick(all, rng);
        const target = mv.targets ? RNG.pick(mv.targets, rng) : undefined;
        const r = Engine.playCard(g, pid, mv.cardUid, target);
        if (!r.ok) { errors.push('playCard(' + mv.type + '): ' + r.error); break; }
        continue;
      }

      const r = Engine.endTurn(g, pid);
      if (!r.ok) { errors.push('endTurn: ' + r.error); break; }
    }

    if (!ended && g.phase !== 'over') {
      errors.push(`种子 ${seed}（${n}人）在 ${steps} 步内未结束`);
      continue;
    }
    games++; turnsPerGame.push(g.turn);
    if (g.winner != null && g.players[g.winner].alive) wins++;

    // 状态自洽检查
    const alive = g.players.filter(p => p.alive);
    if (alive.length !== 1) errors.push(`种子 ${seed}: 结束时存活 ${alive.length} 人`);
    if (alive.length === 1 && g.winner !== alive[0].id) errors.push(`种子 ${seed}: 赢家不是唯一存活者`);
    if (g.winner != null && !g.players[g.winner].alive) errors.push(`种子 ${seed}: 赢家已出局`);
    // 存活玩家手牌可以为 0（打出最后一张牌后、抽牌前是正常状态），
    // 但此时轮到他必须还能正常抽牌，不能被卡住。
    if (g.phase === 'playing') {
      const cur = g.players[g.current];
      if (!cur.alive) errors.push(`种子 ${seed}: 当前回合指向已出局的玩家 ${cur.id}`);
    }
  }

  check('400 局全部正常结束', games === 400, '完成 ' + games + ' 局');
  check('每局都有合法赢家', wins === 400, '合法赢家 ' + wins + ' 局');
  check('无引擎错误', errors.length === 0, errors.slice(0, 5).join(' | '));
  const avg = turnsPerGame.reduce((a, b) => a + b, 0) / (turnsPerGame.length || 1);
  console.log(`     平均每局 ${avg.toFixed(1)} 个回合`);
}

/* ---------- 3. 规则细节 ---------- */
console.log('\n[3] 规则细节');
{
  // 3.1 攻击叠加：被攻击者需要抽 2 张
  const rng = RNG.seeded(7);
  const g = Engine.createGame({ playerCount: 3, rng, humanIndex: 0 });
  g.current = 0;
  const atk = g.players[0].hand.find(c => c.type === 'attack');
  if (atk) {
    const r = Engine.playCard(g, 0, atk.uid);
    passWindow(g);
    check('攻击打出成功', r.ok, r.error);
    const e = Engine.endTurn(g, 0);
    check('攻击后回合正常推进', e.ok, e.error);
    check('下家需要抽 2 张', g.pendingDraws === 2, '实际 ' + g.pendingDraws);
  } else {
    check('攻击牌测试（本局未发到攻击，跳过）', true);
  }

  // 3.2 抽到炸弹且有拆除 → 进入放回流程
  const g2 = Engine.createGame({ playerCount: 2, rng: RNG.seeded(99), humanIndex: 0 });
  g2.current = 0;
  g2.players[0].hand.push(Engine._internal.makeCard('defuse'));
  g2.deck.unshift(Engine._internal.makeCard('bomb'));
  const r2 = Engine.endTurn(g2, 0);
  check('抽到炸弹触发拆除流程', r2.ok && (r2.needsPlacement || g2.pendingBomb), r2.error);
  check('玩家未出局', g2.players[0].alive);
  const placed = Engine.placeBomb(g2, 0, 0);
  check('炸弹可放回牌堆顶', placed.ok && g2.deck[0].type === 'bomb', placed.error);

  // 3.3 抽到炸弹且无拆除 → 出局
  const g3 = Engine.createGame({ playerCount: 2, rng: RNG.seeded(5), humanIndex: 0 });
  g3.current = 0;
  g3.players[0].hand = g3.players[0].hand.filter(c => c.type !== 'defuse');
  const before = g3.players[0].hand.length;
  g3.deck.unshift(Engine._internal.makeCard('bomb'));
  const r3 = Engine.endTurn(g3, 0);
  check('无拆除时抽到炸弹出局', r3.ok && !g3.players[0].alive);
  check('出局后手牌清空', g3.players[0].hand.length === 0, '原 ' + before + ' 张');

  // 3.4 活着的人数降到 1 → 游戏结束
  check('对局进入结束状态', g3.phase === 'over' && g3.winner === 1,
    'phase=' + g3.phase + ' winner=' + g3.winner);

  // 3.5 手牌不够抽时自动重洗弃牌堆
  const g4 = Engine.createGame({ playerCount: 2, rng: RNG.seeded(11), humanIndex: 0 });
  g4.current = 0;
  g4.discard = g4.deck.slice(0, 5);
  g4.deck = [];
  const r4 = Engine.endTurn(g4, 0);
  check('牌堆空时重洗弃牌堆且不崩溃', r4.ok, r4.error);
}

/* ---------- 4. 快照安全性 ---------- */
console.log('\n[4] 状态快照');
{
  const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(3), humanIndex: 0 });
  const s = Engine.getState(g);
  check('快照含 3 名玩家', s.players.length === 3);
  check('真人手牌可见', Array.isArray(s.players[0].hand) && s.players[0].hand.length === 5);
  check('AI 手牌不可见', s.players[1].hand === null);
  check('快照不含牌堆内容', s.deck === undefined);
  check('快照可 JSON 序列化', (() => { try { JSON.stringify(s); return true; } catch (e) { return false; } })());
}

/* ---------- 5. 否决卡 ---------- */
console.log('\n[5] 否决窗口');
{
  const mk = t => Engine._internal.makeCard(t);
  const rig = (g, hands) => {
    g.players.forEach((p, i) => { p.hand = (hands[i] || []).map(mk); });
  };

  // 5.1 无人持否决 → 不出窗口，直接结算
  {
    const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(31), humanIndex: 0 });
    g.current = 0;
    rig(g, [['attack', 'nothing'], ['nothing'], ['nothing']]);
    const atk = g.players[0].hand[0];
    const r = Engine.playCard(g, 0, atk.uid);
    check('无人持否决时立即结算', r.ok && !r.pending && !g.pendingAction);
    check('攻击立即生效', g.attackQueue === 2, 'attackQueue=' + g.attackQueue);
  }

  // 5.2 否决取消攻击
  {
    const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(32), humanIndex: 0 });
    g.current = 0;
    rig(g, [['attack', 'nothing'], ['nope', 'nothing'], ['nothing']]);
    const atk = g.players[0].hand[0];
    const nope = g.players[1].hand[0];

    const r = Engine.playCard(g, 0, atk.uid);
    check('有人持否决时产生回应窗口', r.ok && r.pending === true && !!g.pendingAction);
    check('窗口从下家开始询问', Engine.pendingResponder(g) === 1);
    check('窗口期不能结束回合', !Engine.endTurn(g, 0).ok);
    check('窗口期没有普通可出牌', Engine.legalMoves(g, 0).playable.length === 0);
    check('非回应者不能操作窗口', !Engine.passResponse(g, 2).ok);
    check('快照公开待结算牌、但不暴露回应者', (() => {
      const s = Engine.getState(g);
      return !!s.pendingAction &&
        s.pendingAction.card.type === 'attack' &&
        s.pendingAction.awaiting === undefined;
    })());

    const rn = Engine.respondNope(g, 1, nope.uid);
    check('否决可打出并关闭窗口', rn.ok && !g.pendingAction, rn.error);
    check('否决与取消事件都发出',
      rn.events.some(e => e.type === 'nope') &&
      rn.events.some(e => e.type === 'cancel' && e.target === 'attack'));
    check('被否决的攻击没有生效', g.attackQueue !== 2, 'attackQueue=' + g.attackQueue);
    check('原牌与否决都进弃牌堆',
      g.discard.some(c => c.uid === atk.uid) && g.discard.some(c => c.uid === nope.uid));
    check('被否决的牌也不会回到手里',
      !g.players[0].hand.some(c => c.uid === atk.uid) &&
      !g.players[1].hand.some(c => c.uid === nope.uid));

    const e = Engine.endTurn(g, 0);
    check('否决后回合照常推进（只抽 1 张）',
      e.ok && g.current === 1 && g.pendingDraws === 1,
      'current=' + g.current + ' pending=' + g.pendingDraws);
  }

  // 5.3 连锁否决：偶数张 → 原牌恢复生效
  {
    const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(33), humanIndex: 0 });
    g.current = 0;
    rig(g, [['attack', 'nothing'], ['nope', 'nothing'], ['nope', 'nothing']]);
    const atk = g.players[0].hand[0];
    const n1 = g.players[1].hand[0];
    const n2 = g.players[2].hand[0];

    Engine.playCard(g, 0, atk.uid);
    Engine.respondNope(g, 1, n1.uid);
    check('一张否决后轮到其他持否决者', Engine.pendingResponder(g) === 2);
    const r = Engine.respondNope(g, 2, n2.uid);
    check('连锁否决后窗口关闭', r.ok && !g.pendingAction);
    check('偶数张否决 → 原牌生效', g.attackQueue === 2, 'attackQueue=' + g.attackQueue);
    check('偶数张否决不产生取消事件', !r.events.some(e => e.type === 'cancel'));
  }

  // 5.4 自己打出的牌被否决后，可以再否决回来
  {
    const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(34), humanIndex: 0 });
    g.current = 0;
    rig(g, [['attack', 'nope'], ['nope', 'nothing'], ['nothing']]);
    const atk = g.players[0].hand[0];
    const n0 = g.players[0].hand[1];
    const n1 = g.players[1].hand[0];

    Engine.playCard(g, 0, atk.uid);
    Engine.respondNope(g, 1, n1.uid);
    check('自己打出的牌被否决后可再次回应', Engine.pendingResponder(g) === 0);
    const r = Engine.respondNope(g, 0, n0.uid);
    check('再否决后攻击恢复生效', r.ok && !g.pendingAction && g.attackQueue === 2,
      'attackQueue=' + g.attackQueue);
  }

  // 5.5 否决不能作为普通手牌打出
  {
    const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(35), humanIndex: 0 });
    g.current = 0;
    rig(g, [['nope', 'nothing'], ['nothing'], ['nothing']]);
    const nope = g.players[0].hand[0];
    const lm = Engine.legalMoves(g, 0);
    check('legalMoves 不把否决列为可出',
      !lm.playable.concat(lm.needTarget).some(m => m.type === 'nope'));
    const r = Engine.playCard(g, 0, nope.uid);
    check('playCard 拒绝普通打出否决', !r.ok && /否决/.test(r.error || ''), r.error || '居然成功了');
  }

  // 5.6 被否决的预测未来不留下任何牌面信息
  {
    const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(36), humanIndex: 0 });
    g.current = 0;
    rig(g, [['see'], ['nope', 'nothing'], ['nothing']]);
    const see = g.players[0].hand[0];
    const nope = g.players[1].hand[0];

    const r = Engine.playCard(g, 0, see.uid);
    check('预测未来在窗口期不提前亮牌', r.pending && g.seenTop.length === 0 && g.players[0].seen.length === 0);
    const rn = Engine.respondNope(g, 1, nope.uid);
    check('被否决的预测未来不留下信息',
      rn.ok && g.seenTop.length === 0 && g.players[0].seen.length === 0 &&
      !rn.events.some(e => e.type === 'peek'));
  }

  // 5.7 被否决的求饶不发生转移
  {
    const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(37), humanIndex: 0 });
    g.current = 0;
    rig(g, [['favor'], ['nope', 'nothing'], ['nothing', 'nothing']]);
    const favor = g.players[0].hand[0];
    const nope = g.players[1].hand[0];

    Engine.playCard(g, 0, favor.uid, 2);
    const rn = Engine.respondNope(g, 1, nope.uid);
    check('被否决的求饶没有转移任何牌',
      rn.ok && g.players[0].hand.length === 0 && g.players[2].hand.length === 2,
      'p0=' + g.players[0].hand.length + ' p2=' + g.players[2].hand.length);
  }

  // 5.8 全部放过 → 原牌生效
  {
    const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(38), humanIndex: 0 });
    g.current = 0;
    rig(g, [['skip'], ['nope', 'nothing'], []]);
    const skip = g.players[0].hand[0];
    Engine.playCard(g, 0, skip.uid);
    const r = Engine.passResponse(g, 1);
    check('对全部放过后原牌生效', r.ok && !g.pendingAction && g.pendingDraws === 0);
  }
}

console.log(`\n结果：${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);

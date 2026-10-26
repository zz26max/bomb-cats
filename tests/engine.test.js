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

console.log(`\n结果：${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);

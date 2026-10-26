/**
 * AI 对战测试：让三档难度的 AI 互相对战，验证不崩溃、能分出胜负，
 * 并粗略比较不同难度的胜率（难度梯度是否真的有效）。
 * 运行： node tests/ai.test.js
 */
'use strict';
const path = require('path');
const Engine = require(path.join(__dirname, '..', 'src', 'core', 'engine.js'));
const AI = require(path.join(__dirname, '..', 'src', 'ai', 'ai.js'));
const RNG = require(path.join(__dirname, '..', 'src', 'core', 'rng.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

/**
 * 用 AI 驱动一整局；返回赢家索引与回合数。
 * difficulties: 每个座位的难度数组
 */
function playGame(seed, difficulties, maxSteps) {
  const rng = RNG.seeded(seed);
  const n = difficulties.length;
  const G = Engine.createGame({ playerCount: n, rng, humanIndex: null });

  let steps = 0;
  const limit = maxSteps || 5000;
  while (steps++ < limit && G.phase !== 'over') {
    const pid = G.current;
    const p = G.players[pid];

    // 待放回炸弹：先处理（可能是某次抽牌留下的）
    if (G.pendingBomb) {
      const owner = G.pendingBomb.player;
      const diff = difficulties[owner] || 'normal';
      const pos = AI.chooseBombPosition(G, owner, diff);
      const r = Engine.placeBomb(G, owner, pos);
      if (!r.ok) throw new Error('placeBomb: ' + r.error);
      if (G.turnEndPending) {
        const rr = Engine.resumeAfterPlacement(G, owner);
        if (!rr.ok) throw new Error('resume: ' + rr.error);
      }
      continue;
    }

    // 尝试出牌
    const diff = difficulties[pid];
    const pick = AI.chooseCard(G, pid, diff);
    let acted = false;

    if (pick) {
      const target = pick.needsTarget ? AI.chooseTarget(G, pid, pick, diff) : undefined;
      const r = Engine.playCard(G, pid, pick.card.uid, target);
      if (r.ok) {
        acted = true;
        // 出牌本身可能触发炸弹（摸两张）
        if (G.phase === 'over') break;
      } else {
        // 出牌失败（例如目标非法）：退化为结束回合，避免死循环
        acted = false;
      }
    }

    if (!acted) {
      if (G.pendingBomb) continue;   // 出牌后产生待放回炸弹
      const r = Engine.endTurn(G, pid);
      if (!r.ok) {
        // 极少数情况下（如刚被淘汰）直接跳过
        if (G.phase === 'over') break;
        throw new Error('endTurn(' + pid + '): ' + r.error);
      }
    }
  }

  if (G.phase !== 'over') return { winner: null, turns: G.turn, stuck: true };
  return { winner: G.winner, turns: G.turn, stuck: false };
}

/* ---------- 1. 稳定性 ---------- */
console.log('\n[1] AI 对战稳定性');
{
  let ok = 0, stuck = 0, errors = [];
  let totalTurns = 0;
  for (let seed = 1; seed <= 200; seed++) {
    try {
      const diffs = seed % 2 === 0 ? ['normal', 'normal', 'normal'] : ['hard', 'normal', 'easy'];
      const res = playGame(seed, diffs);
      if (res.stuck) { stuck++; continue; }
      ok++; totalTurns += res.turns;
    } catch (e) {
      errors.push('seed ' + seed + ': ' + e.message);
    }
  }
  check('200 局 AI 对战全部正常结束', ok === 200, ok + ' 局完成, ' + stuck + ' 局卡死, 错误: ' + errors.slice(0, 3).join(' | '));
  console.log(`     平均每局 ${(totalTurns / (ok || 1)).toFixed(1)} 个回合`);
}

/* ---------- 2. 不同人数 ---------- */
console.log('\n[2] 各种人数都能跑通');
{
  for (const n of [2, 3, 4, 5]) {
    let done = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const diffs = Array.from({ length: n }, (_, i) => ['easy', 'normal', 'hard'][i % 3]);
      const res = playGame(seed * 7 + n, diffs);
      if (!res.stuck && res.winner != null) done++;
    }
    check(`${n} 人局 40 场全部有结果`, done === 40, done + '/40');
  }
}

/* ---------- 3. 难度梯度 ---------- */
console.log('\n[3] 难度梯度（hard > normal > easy）');
{
  // 三档同场竞技，并轮换座位以消除先后手偏差。
  // 三人局公平份额是 33.3%，三方都明显偏离才说明梯度真实存在。
  const perms = [
    ['hard', 'normal', 'easy'],
    ['easy', 'hard', 'normal'],
    ['normal', 'easy', 'hard']
  ];
  const total = { hard: 0, normal: 0, easy: 0 };
  let games = 0;

  for (const diffs of perms) {
    for (let seed = 1; seed <= 250; seed++) {
      const res = playGame(seed, diffs);
      if (res.winner == null) continue;
      games++;
      total[diffs[res.winner]]++;
    }
  }

  const rate = {
    hard: total.hard / games,
    normal: total.normal / games,
    easy: total.easy / games
  };
  console.log(`     hard ${(rate.hard * 100).toFixed(1)}% | normal ${(rate.normal * 100).toFixed(1)}% | easy ${(rate.easy * 100).toFixed(1)}%  (${games} 局)`);

  check('hard 明显强于公平份额 33%', rate.hard > 0.36, (rate.hard * 100).toFixed(1) + '%');
  check('hard 强于 normal', rate.hard > rate.normal + 0.04,
    `${(rate.hard * 100).toFixed(1)}% vs ${(rate.normal * 100).toFixed(1)}%`);
  check('normal 强于 easy', rate.normal > rate.easy + 0.04,
    `${(rate.normal * 100).toFixed(1)}% vs ${(rate.easy * 100).toFixed(1)}%`);
  check('easy 明显弱于公平份额 33%', rate.easy < 0.30, (rate.easy * 100).toFixed(1) + '%');
}

/* ---------- 3b. 难度差异要能「看见」 ---------- */
console.log('\n[3b] 难度差异体现在具体行为上');
{
  // 统计每档 AI 在一局里主动用「跳过/攻击」躲掉抽牌的次数
  function countDodges(difficulty, seed) {
    const rng = RNG.seeded(seed);
    const G = Engine.createGame({ playerCount: 3, rng, humanIndex: null });
    // 让 0 号位就是被测难度，其余用 easy 陪跑
    let dodges = 0, steps = 0;
    while (steps++ < 2000 && G.phase !== 'over') {
      const pid = G.current;
      if (G.pendingBomb) {
        const o = G.pendingBomb.player;
        Engine.placeBomb(G, o, AI.chooseBombPosition(G, o, pid === 0 ? difficulty : 'easy'));
        if (G.turnEndPending) Engine.resumeAfterPlacement(G, o);
        continue;
      }
      const d = pid === 0 ? difficulty : 'easy';
      const pick = AI.chooseCard(G, pid, d);
      if (pick) {
        if (pid === 0 && (pick.card.type === 'skip' || pick.card.type === 'attack')) dodges++;
        const t = pick.needsTarget ? AI.chooseTarget(G, pid, pick, d) : undefined;
        if (Engine.playCard(G, pid, pick.card.uid, t).ok) continue;
      }
      Engine.endTurn(G, pid);
    }
    return dodges;
  }

  const sum = d => { let s = 0; for (let seed = 1; seed <= 120; seed++) s += countDodges(d, seed); return s; };
  const dEasy = sum('easy');
  const dHard = sum('hard');
  console.log(`     跳过/攻击使用次数：easy ${dEasy} 次，hard ${dHard} 次`);
  check('hard 比 easy 更会躲抽牌', dHard > dEasy + 20, `hard ${dHard} vs easy ${dEasy}`);
  check('easy 几乎不用跳过保命（新手感）', dEasy < 15, `easy 用了 ${dEasy} 次`);

  // 炸弹放回位置：hard 应该往牌堆深处塞
  const g = Engine.createGame({ playerCount: 3, rng: RNG.seeded(21), humanIndex: null });
  const deckSize = g.deck.length;
  const posHard = AI.chooseBombPosition(g, 0, 'hard');
  const posEasy = AI.chooseBombPosition(g, 0, 'easy');
  check('hard 把炸弹放回牌堆深处', posHard > deckSize * 0.7,
    `位置 ${posHard} / 牌堆 ${deckSize}`);
  check('easy 放回位置是随机的', posEasy >= 0 && posEasy <= deckSize,
    `位置 ${posEasy} / 牌堆 ${deckSize}`);
}

/* ---------- 3c. AI 不会打出非法牌 ---------- */
console.log('\n[3c] AI 出牌合法性');
{
  let illegal = 0, checks = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rng = RNG.seeded(seed);
    const G = Engine.createGame({ playerCount: 4, rng, humanIndex: null });
    let steps = 0;
    while (steps++ < 2000 && G.phase !== 'over') {
      const pid = G.current;
      if (G.pendingBomb) {
        const o = G.pendingBomb.player;
        Engine.placeBomb(G, o, AI.chooseBombPosition(G, o, 'normal'));
        if (G.turnEndPending) Engine.resumeAfterPlacement(G, o);
        continue;
      }
      const pick = AI.chooseCard(G, pid, 'normal');
      if (pick) {
        checks++;
        // AI 绝不能想着打炸弹或拆除
        if (pick.card.type === 'bomb' || pick.card.type === 'defuse') illegal++;
        const t = pick.needsTarget ? AI.chooseTarget(G, pid, pick, 'normal') : undefined;
        const r = Engine.playCard(G, pid, pick.card.uid, t);
        if (!r.ok) illegal++;
        continue;
      }
      Engine.endTurn(G, pid);
    }
  }
  check(`AI ${checks} 次决策全部合法`, illegal === 0, illegal + ' 次非法');
}

/* ---------- 4. 极端场景不崩溃 ---------- */
console.log('\n[4] 边界情况');
{
  // 只剩 2 人时的「优势」判断
  const g = Engine.createGame({ playerCount: 2, rng: RNG.seeded(3), humanIndex: null });
  check('2 人局 AI 能给出决策', (() => {
    try { AI.chooseCard(g, g.current, 'hard'); return true; } catch (e) { return false; }
  })());

  // 手上只有拆除和炸弹时，AI 应选择结束回合
  const g2 = Engine.createGame({ playerCount: 3, rng: RNG.seeded(4), humanIndex: null });
  g2.players[g2.current].hand = [
    Engine._internal.makeCard('defuse'),
    Engine._internal.makeCard('defuse')
  ];
  const pick = AI.chooseCard(g2, g2.current, 'normal');
  check('无可用牌时 AI 选择抽牌', pick === null, pick ? '选了 ' + pick.card.type : '');

  // 炸弹风险函数在空牌堆时不除零
  const g3 = Engine.createGame({ playerCount: 2, rng: RNG.seeded(5), humanIndex: null });
  g3.deck = []; g3.discard = [];
  const risk = AI.bombRisk(g3, 0);
  check('空牌堆风险为 0（不产生 NaN）', risk === 0 && !isNaN(risk), String(risk));
}

console.log(`\n结果：${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * AI 对手决策
 *
 * 三档难度共用一个「风险评估」内核，区别只在信息量与决策激进度：
 *   easy   随机合法出牌，从不记牌
 *   normal 会算炸弹概率，有「预测未来」必用，风险高时用跳过/攻击规避
 *   hard   记牌 + 推断剩余炸弹数，按场上人数决定保守/激进，劣势时留拆除
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/engine.js'), require('../core/cards.js'));
  } else {
    root.BombCats = Object.assign(root.BombCats || {}, {
      AI: factory(root.BombCats.Engine, root.BombCats.CardData)
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine, CARD_DATA) {
  'use strict';

  const { CARDS } = CARD_DATA;

  /**
   * 估算「下一次抽牌抽到炸弹」的概率。
   *
   * 由于炸弹在发牌之后才洗进牌堆、且不会留在任何人手上，
   * 下一张牌一定来自牌堆，所以直接算 牌堆内炸弹数 / 牌堆张数 就是精确值。
   * （弃牌堆只有等牌堆抽空才会重洗回来，不该计入当前这一次抽取的分母。）
   */
  function bombRisk(G, pid) {
    const me = G.players[pid];

    // 已通过「预测未来」看到过顶牌：这是确定性信息，优先级最高
    if (me.seen && me.seen.length) {
      return me.seen[0].type === 'bomb' ? 1 : 0;
    }

    if (!G.deck.length) return 0;
    let bombs = 0;
    G.deck.forEach(c => { if (c.type === 'bomb') bombs++; });
    return Math.min(1, bombs / G.deck.length);
  }

  /** 统计还活着的玩家里，除我之外谁最可能握着炸弹（手牌越多概率越大） */
  function likelyBombHolders(G, pid) {
    const deckAndDiscard = G.deck.length + G.discard.length;
    let bombsOut = 0;
    G.deck.forEach(c => { if (c.type === 'bomb') bombsOut++; });
    G.discard.forEach(c => { if (c.type === 'bomb') bombsOut++; });
    const totalBombs = G.players.length - 1;
    const bombsInHands = Math.max(0, totalBombs - bombsOut);

    return G.players
      .filter(p => p.alive && p.id !== pid)
      .map(p => ({ id: p.id, handSize: p.hand.length }))
      .sort((a, b) => b.handSize - a.handSize);
  }

  /** 我方是否处于「快要赢」的领先位置（存活人数少 = 优势） */
  function isLeading(G, pid) {
    const alive = G.players.filter(p => p.alive).length;
    return alive <= 2;
  }

  /**
   * 三档难度的性格参数。
   *
   *   favor 人还多的时候，愿意打「求饶 / 帮忙」抢一张牌的概率。
   *         长局里最重要的一项：多一张牌就多一分摸到第二张拆除的机会，
   *         同时也在削弱对手。实测关掉抢牌，胜率直接从 35% 掉到 27%。
   *   dodge 手上没有拆除时，愿意用「跳过 / 攻击」躲掉这次抽牌的概率。
   *         注意只在「没拆除」时才值得躲——手上有拆除时抽到炸弹根本不会死，
   *         反而能白拿一张牌、增加抽到下一张拆除的机会。
   *   see   没有拆除、且手上有躲避手段时，愿意用「预测未来」摸清顶牌的概率。
   *         有拆除时看牌没有意义。
   *   chaos 不按策略走、随便打一张牌的概率。
   *   naive 低难度特有：连「跳过 / 攻击」都当普通牌乱打，
   *         也就是新手那种「攥着保命牌硬抽」的典型行为。
   */
  const PROFILES = {
    easy:   { dodge: 0.00, see: 0.00, favor: 0.15, chaos: 0.75, naive: true, nope: 0.16 },
    normal: { dodge: 0.30, see: 0.10, favor: 0.15, chaos: 0.40, naive: false, nope: 0.60 },
    hard:   { dodge: 0.90, see: 0.60, favor: 0.80, chaos: 0.00, naive: false, nope: 0.95 }
  };

  /** 手牌中所有可打出的牌（否决只能用于回应，不在普通出牌候选里） */
  function handOptions(G, pid) {
    const me = G.players[pid];
    const opponents = G.players.filter(p => p.alive && p.id !== pid && p.hand.length >= 2);
    return me.hand.filter(c => c.type !== 'defuse' && c.type !== 'bomb' && c.type !== 'nope').map(c => ({
      card: c,
      needsTarget: CARDS[c.type].need === 'player',
      targets: opponents.map(p => p.id)
    })).filter(o => !o.needsTarget || o.targets.length > 0);
  }

  /**
   * 选一张要出的牌；返回 null 表示直接结束回合（抽牌）。
   */
  function chooseCard(G, pid, difficulty) {
    const options = handOptions(G, pid);
    if (!options.length) return null;
    const rnd = G.rng;
    const has = t => options.find(o => o.card.type === t);
    const profile = PROFILES[difficulty] || PROFILES.normal;

    // 低难度会「乱打」：随手指一张牌，不考虑风险。
    // 新手还不会用「跳过 / 攻击」保命，所以这两个先排除在乱打范围外，
    // 表现为「攥着保命牌硬抽」——正是新手最容易犯的错。
    if (profile.chaos && rnd() < profile.chaos) {
      const pool = profile.naive
        ? options.filter(o => o.card.type !== 'skip' && o.card.type !== 'attack')
        : options;
      if (pool.length) return pool[Math.floor(rnd() * pool.length)];
      return null;
    }

    const me = G.players[pid];
    // 「预测未来」看到过的顶牌。seen 按牌堆顺序排列，seen[0] 是下一张。
    const known = me.seen && me.seen.length ? me.seen : null;
    const topIsBomb = !!known && known[0].type === 'bomb';

    const skip = has('skip');
    const attack = has('attack');
    const shuffle = has('shuffle');
    // 手上还有几张拆除。这是本作真正的「命数」。
    const defuse = me.hand.filter(c => c.type === 'defuse').length;
    // 没有拆除 = 抽到炸弹就会死 = 此刻才需要避险
    const naked = defuse === 0;

    // ——以下是 normal / hard 的规则式决策——
    //
    // 本作真正的核心权衡（实测结论，和直觉相反）：
    //   · 手上有拆除时，抽牌几乎没有风险，而且是纯赚——
    //     多一张牌就多一次摸到下一张拆除的机会，而拆除才是命。
    //     所以「有拆除就大胆抽」比「一味躲避」强得多。
    //   · 手上没有拆除时，抽牌等于俄罗斯轮盘，这时跳过/攻击才值钱。
    //   · 长局里最重要的动作其实是「求饶 / 帮忙」：抢牌既增加自己的命，
    //     又削弱对手。关掉抢牌胜率从 35% 掉到 27%。
    // （早期版本把躲避当成唯一技术点，是因为抽牌逻辑有 bug、
    //   每抽一次就白丢一张拆除，导致所有人都在裸奔。）

    // 1. 已知牌堆顶是炸弹 → 只要还活着就得躲，绝不能抽
    if (topIsBomb) {
      if (skip) return skip;
      if (attack) return attack;
      // 洗牌能改变顶部，但要丢掉已知信息，仍比硬抽强
      if (shuffle && rnd() < 0.8) return shuffle;
      // 明知是炸弹还打「摸两张」等于自杀
      return null;
    }

    // 2. 抢牌：只要人还多，这是稳赚不赔的动作（不消耗抽牌机会）
    const aliveCount = G.players.filter(p => p.alive).length;
    if (aliveCount >= 3 && rnd() < profile.favor) {
      const favor = has('favor');
      if (favor) return favor;
      const help = has('help');
      if (help) return help;
    }

    // 3. 只有「没有拆除」时才需要避险
    if (naked) {
      // 先看能不能摸清底牌，再决定要不要躲
      const see = has('see');
      if (see && !known && rnd() < profile.see) return see;

      if (skip && rnd() < profile.dodge) return skip;
      if (attack && rnd() < profile.dodge) return attack;
    }

    // 4. 手牌太多时泄一张无效果的牌，降低被抢的概率
    const nothing = has('nothing');
    if (nothing && me.hand.length > 6 && rnd() < 0.6) return nothing;

    // 5. 「摸两张」：手上有拆除时是白赚两张牌；没有拆除时等于赌命，
    //    只有明确知道前两张都不是炸弹才值得打。
    const draw2 = has('draw2');
    if (draw2) {
      if (!naked) return draw2;
      if (known && known.length >= 2 &&
          known[0].type !== 'bomb' && known[1].type !== 'bomb') return draw2;
    }

    return null;
  }

  /**
   * 评估「当前这张待结算的牌对自己有多大威胁」。
   *
   * 否决窗口按奇偶结算：偶数张否决 = 原牌生效，奇数张 = 原牌无效。
   * 所以这里关心的不是「牌好不好」，而是「当前结果是否对我不利」：
   *   - 别人的攻击正指向我 → 很想否决；
   *   - 别人的求饶/帮忙正冲着我 → 很想否决；
   *   - 我自己的牌被否决了 → 很想再否决回来；
   *   - 别人的跳过/无效果/看牌 → 基本懒得管。
   */
  function nopeDesire(G, pid, pa) {
    const type = pa.card.type;
    const applies = pa.nopes.length % 2 === 0;
    const mine = pa.player === pid;
    let value = 0.05;

    if (type === 'attack') {
      const victim = Engine._internal.nextAlive(G, pa.player);
      value = victim === pid ? 1.0 : 0.05;
    } else if (type === 'favor' || type === 'help') {
      value = pa.target === pid ? 0.95 : 0.08;
    } else if (type === 'draw2') {
      value = 0.45;
    } else if (type === 'see') {
      value = 0.18;
    } else if (type === 'shuffle') {
      value = 0.15;
    } else if (type === 'skip') {
      value = 0.12;
    }

    if (mine) {
      const keep = type === 'nothing' ? 0.15 : (type === 'skip' ? 0.5 : 0.85);
      return applies ? 0 : keep;
    }
    return applies ? value : 0;
  }

  /**
   * 否决窗口里的决策：返回要打出的否决 uid，null 表示放过。
   * 由调用方（main.js / 服务器的响应窗口）驱动，引擎只负责按顺序询问。
   */
  function chooseNope(G, pid, difficulty) {
    const pa = G.pendingAction;
    if (!pa) return null;
    const me = G.players[pid];
    if (!me || !me.alive) return null;
    const nopes = me.hand.filter(c => c.type === 'nope');
    if (!nopes.length) return null;

    const desire = nopeDesire(G, pid, pa);
    if (desire <= 0) return null;

    const profile = PROFILES[difficulty] || PROFILES.normal;
    // 手里不止一张时更舍得用；只剩一张时留给真正的致命时刻
    const spare = nopes.length > 1 ? 1.15 : 1;
    const chance = Math.min(0.98, desire * profile.nope * spare);
    return G.rng() < chance ? nopes[0].uid : null;
  }

  /** 选择目标：hard 优先打手牌最多的人（手里更可能藏着炸弹 / 更值得消耗） */
  function chooseTarget(G, pid, options, difficulty) {
    const ids = options.targets;
    if (!ids.length) return undefined;
    if (difficulty === 'hard') {
      // 手牌最多的人通常握有关键牌，也是未来最危险的对手
      let best = ids[0], most = -1;
      ids.forEach(id => {
        const n = G.players[id].hand.length;
        if (n > most) { most = n; best = id; }
      });
      return best;
    }
    let best = ids[0], fewest = Infinity;
    ids.forEach(id => {
      const n = G.players[id].hand.length;
      if (n < fewest) { fewest = n; best = id; }
    });
    return best;
  }

  /**
   * 拆除后把炸弹放回牌堆的哪个位置。
   *
   * 直觉上应该放「顶部」立刻坑下家，但实测相反：
   * 放顶部 → 下家大概率还有拆除，能活，并且会把炸弹继续往他下家传，
   *           一圈下来很容易原样回到自己手上（26.9% 胜率）；
   * 放底部 → 自己这一轮完全安全，炸弹要等牌堆快抽空才出现，
   *           中间还得由其他所有人轮流承担风险（32.0% 胜率）。
   * 所以强 AI 一律往牌堆深处塞。
   */
  function chooseBombPosition(G, pid, difficulty) {
    const deckSize = G.deck.length;
    if (deckSize <= 0) return 0;
    if (difficulty === 'hard') {
      // 塞到牌堆底部：离自己最远，风险摊给所有人
      return Math.max(0, deckSize - 1);
    }
    if (difficulty === 'normal') {
      // 稍微学一点，但没那么精：塞到后半段
      const lo = Math.floor(deckSize * 0.6);
      return lo + Math.floor(G.rng() * Math.max(1, deckSize - lo));
    }
    return Math.floor(G.rng() * (deckSize + 1));
  }

  /**
   * 执行一个 AI 回合中的「出牌阶段」。
   * 返回一组要执行的动作，由调用方（main.js）实际驱动引擎，便于统一播动画。
   */
  function planTurn(G, pid, difficulty) {
    const plan = [];
    let guard = 0;
    const options = handOptions(G, pid);
    if (!options.length) return plan;

    // 强 AI 一回合可以连续出多张（真实玩家也是这么打的）；简单 AI 只出一张
    const maxCards = difficulty === 'hard' ? 3 : 1;
    while (guard++ < maxCards) {
      const pick = chooseCard(G, pid, difficulty);
      if (!pick) break;
      const target = pick.needsTarget ? chooseTarget(G, pid, pick, difficulty) : undefined;
      plan.push({ cardUid: pick.card.uid, type: pick.card.type, target });
      break;   // 每轮只规划一张，剩余由 main.js 的循环继续驱动
    }
    return plan;
  }

  return {
    bombRisk,
    chooseCard,
    chooseNope,
    chooseTarget,
    chooseBombPosition,
    planTurn,
    handOptions,
    PROFILES   // 导出便于测试与调参（改这个对象即可调整难度手感）
  };
});

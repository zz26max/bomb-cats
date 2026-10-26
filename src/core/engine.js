/**
 * 炸弹猫 · 规则引擎
 *
 * 设计原则：
 *  1. 纯逻辑，绝不触碰 DOM，可在 Node 里跑几万局压力测试。
 *  2. 状态变更全部通过 API，对外只暴露只读快照（getState）。
 *  3. 每个动作返回统一结构 { ok, error?, events[] }，
 *     events 供 UI 播动画 / AI 读日志，引擎自身不关心谁在消费。
 *  4. 一切随机来自注入的 rng，种子固定即可复现整局。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./cards.js'), require('./rng.js'));
  } else {
    root.BombCats = Object.assign(root.BombCats || {}, {
      Engine: factory(root.BombCats.CardData, root.BombCats.RNG)
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CARD_DATA, RNG) {
  'use strict';

  const { CARDS, BASE_COUNTS, PLAYER_LIMITS, startHandSize, bombCount } = CARD_DATA;

  let uid = 0;
  /** 每张实体牌都有唯一实例 id，用于动画追踪与「秘密放回」定位 */
  function makeCard(typeId) {
    const def = CARDS[typeId];
    if (!def) throw new Error('未知卡牌: ' + typeId);
    return { uid: ++uid, type: typeId, name: def.name, glyph: def.glyph, kind: def.kind };
  }

  function buildDeck(playerCount, rng) {
    const list = [];
    const push = (typeId, n) => { for (let i = 0; i < n; i++) list.push(makeCard(typeId)); };

    push('defuse', BASE_COUNTS.defuse);
    push('bomb', bombCount(playerCount));
    Object.keys(BASE_COUNTS).forEach(k => { if (k !== 'defuse') push(k, BASE_COUNTS[k]); });

    RNG.shuffle(list, rng);
    return list;
  }

  const clone = o => JSON.parse(JSON.stringify(o));

  function createGame(options) {
    const opt = options || {};
    const playerCount = Math.min(PLAYER_LIMITS.max, Math.max(PLAYER_LIMITS.min, opt.playerCount || 4));
    const rng = opt.rng || Math.random;

    const G = {
      rng,
      turn: 0,              // 回合计数
      players: [],
      deck: [],             // 牌堆，index 0 为顶
      discard: [],
      current: 0,           // 当前玩家索引
      pendingDraws: 1,      // 本回合还需抽几张
      mustDraw: false,      // 本回合是否必须抽牌（打出跳过/攻击后为 false）
      phase: 'playing',     // playing | over
      winner: null,
      log: [],
      seenTop: [],          // 「预测未来」看到的牌（仅本人可见）
      lastAutoEnd: false,
      turnEnded: false      // 本次「结束回合」是否已经结算过抽牌
    };

    // 玩家
    for (let i = 0; i < playerCount; i++) {
      G.players.push({
        id: i,
        name: (opt.names && opt.names[i]) || ('玩家 ' + (i + 1)),
        isAI: !(opt.humanIndex === i) && opt.humanIndex != null,
        hand: [],
        alive: true,
        seen: [],           // 该玩家通过「预测未来」记住的牌（AI 用）
        revealed: false
      });
    }
    // 若未指定真人座位，默认 0 号为真人（纯 AI 观战场景由视图自行处理）
    if (opt.humanIndex == null) G.players.forEach(p => { p.isAI = true; });

    G.deck = buildDeck(playerCount, rng);

    // 先发普通牌，炸弹一律不入手。
    // 官方规则：炸弹是在发完手牌之后才洗进牌堆的，因此任何人开局手上都不会有炸弹，
    // 也就不存在「手里攥着一张炸弹猫怎么打」的规则空洞。
    const bombs = G.deck.filter(c => c.type === 'bomb');
    G.deck = G.deck.filter(c => c.type !== 'bomb');
    RNG.shuffle(G.deck, rng);

    // 发牌
    const handSize = startHandSize(playerCount);
    G.players.forEach(p => {
      for (let i = 0; i < handSize; i++) p.hand.push(G.deck.pop());
    });

    // 每位玩家必得 1 张拆除（原版规则）：从牌堆取，并换出一张普通牌回牌堆
    G.players.forEach(p => {
      if (p.hand.some(c => c.type === 'defuse')) return;   // 已经抽到拆除，无需补
      const idx = G.deck.findIndex(c => c.type === 'defuse');
      if (idx < 0) return;
      const defuse = G.deck.splice(idx, 1)[0];

      const rank = c => (c.type === 'nope' ? 60 : 20);
      let swap = 0, worst = -1;
      p.hand.forEach((c, i) => {
        const r = rank(c);
        if (r > worst) { worst = r; swap = i; }
      });
      G.deck.push(p.hand[swap]);
      p.hand[swap] = defuse;
    });

    // 发牌完成后再把炸弹洗进牌堆
    G.deck = G.deck.concat(bombs);
    RNG.shuffle(G.deck, rng);

    // 本局炸弹总数：只作为界面上的信息展示，不再单独放一张「明牌」在桌上，
    // 那样容易被误解成场上真的躺着一张炸弹。
    G.bombTotal = bombs.length;

    // 保证开局第一张不是炸弹：不让任何人在还没出过牌时就炸掉。
    //
    // 注意这里必须把炸弹放回一个「均匀随机」的第 2 张之后的位置。
    // 早期实现是「与第一张非炸弹交换」，而第一张非炸弹几乎总是 index 1，
    // 结果是把所有本该落在顶部的炸弹（概率 12.5%）全都堆到了 index 1，
    // 使第二张是炸弹的概率翻倍到 24%——第二个行动的人几乎必中。
    if (G.deck[0] && G.deck[0].type === 'bomb') {
      // 可能连续多张炸弹叠在顶部，逐张挪走
      for (let guard = 0; guard <= bombs.length; guard++) {
        if (!G.deck.length || G.deck[0].type !== 'bomb') break;
        if (G.deck.length < 2) break;                 // 只剩一张时无处可挪
        const topBomb = G.deck.shift();
        // shift 之后长度变成 n-1，合法插入区间是 [1, n-1]，即「第 2 张之后」
        const pos = 1 + RNG.int(rng, G.deck.length);
        G.deck.splice(pos, 0, topBomb);
      }
    }

    G.current = RNG.int(rng, playerCount);
    pushLog(G, 'system', `${G.players[G.current].name} 先手。牌堆剩余 ${G.deck.length} 张。`);
    return G;
  }

  function pushLog(G, kind, text, extra) {
    const entry = Object.assign({ turn: G.turn, kind, text }, extra || {});
    G.log.push(entry);
    if (G.log.length > 200) G.log.shift();
    return entry;
  }

  function alivePlayers(G) { return G.players.filter(p => p.alive); }
  function player(G, id) { return G.players[id]; }
  function cardById(cardUid) {
    return c => c.uid === cardUid;
  }
  function findInHand(G, pid, cardUid) {
    const p = player(G, pid);
    if (!p || !p.alive) return null;
    const idx = p.hand.findIndex(cardById(cardUid));
    return idx >= 0 ? { player: p, index: idx, card: p.hand[idx] } : null;
  }

  /** 结算抽牌：抽到炸弹则触发拆除/爆炸 */
  function resolveDraw(G, pid, events) {
    const p = player(G, pid);
    if (!G.deck.length) reshuffleDiscard(G, events);
    if (!G.deck.length) {
      // 牌堆与弃牌堆都空了：洗回所有出局玩家的牌（极端情况兜底），仍空则跳过本次抽牌
      events.push({ type: 'deck-empty', player: pid });
      pushLog(G, 'system', '牌堆与弃牌堆都已耗尽，本回合跳过抽牌。');
      return { exploded: false, empty: true };
    }

    const card = G.deck.shift();
    p.hand.push(card);
    events.push({ type: 'draw', player: pid, card: clone(card), fromTop: true });
    // 玩家一旦抽到牌，之前看到的顶牌信息全部失效
    p.seen = [];

    // 只有炸弹才进入拆除/爆炸结算。这张提前返回曾经被误删，
    // 导致抽到任何牌都会被当成炸弹、白白消耗掉一张拆除，玩家随后必被真炸弹炸死。
    if (card.type !== 'bomb') return { exploded: false, card };

    // 炸弹处理：先看手上有没有拆除
    const defuseIdx = p.hand.findIndex(c => c.type === 'defuse');
    if (defuseIdx < 0) {
      // 抽到的炸弹本身进弃牌堆，手牌全部弃掉，玩家出局
      p.hand.pop();                       // 移除刚抽进来的这张炸弹
      p.hand.forEach(c => G.discard.push(c));
      p.hand = [];
      G.discard.push(card);
      p.alive = false;
      p.seen = [];
      events.push({ type: 'explode', player: pid, card: clone(card) });
      pushLog(G, 'boom', `💥 ${p.name} 抽到了炸弹猫，出局！`);
      checkVictory(G, events);
      return { exploded: true, card };
    }

    const defuse = p.hand.splice(defuseIdx, 1)[0];
    G.discard.push(defuse);
    // 炸弹先移出手牌，等待玩家通过 placeBomb 决定放回牌堆的哪个位置
    const bi = p.hand.findIndex(c => c.uid === card.uid);
    if (bi >= 0) p.hand.splice(bi, 1);
    G.pendingBomb = { player: pid, card };
    events.push({ type: 'defuse', player: pid, card: clone(defuse), bomb: clone(card) });
    return { exploded: false, defused: true, needsPlacement: true, card };
  }

  /** 存活人数降到 1 时结束对局 */
  function checkVictory(G, events) {
    if (G.phase === 'over') return true;
    const alive = alivePlayers(G);
    if (alive.length <= 1) {
      finish(G, alive.length ? alive[0].id : G.players[0].id, events);
      return true;
    }
    return false;
  }

  function reshuffleDiscard(G, events) {
    if (!G.discard.length) {
      // 弃牌堆也空：把已出局玩家留下的牌重新投入牌堆（正常流程不会走到，作为兜底）
      return;
    }
    G.deck = RNG.shuffle(G.discard.slice(), G.rng);
    G.discard = [];
    events.push({ type: 'reshuffle', count: G.deck.length });
    pushLog(G, 'system', `牌堆用尽，弃牌堆 ${G.deck.length} 张重新洗入牌堆。`);
  }

  /* ------------------------------------------------------------------ */
  /* 公开 API                                                            */
  /* ------------------------------------------------------------------ */

  /** 打出卡牌 */
  function playCard(G, pid, cardUid, target) {
    const events = [];
    if (G.phase !== 'playing') return { ok: false, error: '对局已结束', events };
    if (pid !== G.current) return { ok: false, error: '还没轮到你', events };

    const found = findInHand(G, pid, cardUid);
    if (!found) return { ok: false, error: '手上没有这张牌', events };
    const { card } = found;
    const def = CARDS[card.type];

    // 能不能在「必须抽牌」的节点出牌？除拆除外都可以
    if (card.type === 'defuse') return { ok: false, error: '拆除只能在抽到炸弹时使用', events };
    // 炸弹猫不可主动打出（正常情况下它也不会出现在手牌里，这里兜底防止规则被绕过）
    if (card.type === 'bomb') return { ok: false, error: '炸弹猫不能主动打出', events };

    // 需要目标的牌
    let targetPlayer = null;
    if (def.need === 'player') {
      targetPlayer = player(G, target);
      if (!targetPlayer || !targetPlayer.alive || targetPlayer.id === pid) {
        return { ok: false, error: '必须选择一名还活着的对手', events };
      }
      if (!targetPlayer.hand.length) return { ok: false, error: `${targetPlayer.name} 手上没有牌`, events };
      if (targetPlayer.hand.length < 2) {
        return { ok: false, error: `${targetPlayer.name} 只剩最后一张牌，不能成为目标`, events };
      }
    }

    // 从手牌移除并进弃牌堆
    found.player.hand.splice(found.index, 1);
    G.discard.push(card);
    // 打出牌后，本人之前看到的顶牌信息仍有效（自己没抽牌），但顺序可能因洗牌变化

    const base = { type: 'play', player: pid, card: clone(card), target: target != null ? target : null };
    events.push(base);

    switch (card.type) {
      case 'see': {
        const top = G.deck.slice(0, 3).map(clone);
        player(G, pid).seen = top;
        G.seenTop = top;
        events.push({ type: 'peek', player: pid, cards: top });
        pushLog(G, 'action', `${player(G, pid).name} 使用了「预测未来」。`, { private: pid });
        break;
      }
      case 'attack': {
        G.mustDraw = false;
        G.pendingDraws = 0;
        // 下家要抽 2 次：延迟到下一位玩家开始时生效
        G.attackQueue = 2;
        events.push({ type: 'attack', player: pid, victim: nextAlive(G, pid) });
        pushLog(G, 'action', `${player(G, pid).name} 使用了「攻击」。`);
        break;
      }
      case 'skip': {
        G.mustDraw = false;
        G.pendingDraws = 0;
        pushLog(G, 'action', `${player(G, pid).name} 使用了「跳过」。`);
        break;
      }
      case 'shuffle': {
        RNG.shuffle(G.deck, G.rng);
        G.players.forEach(p => { p.seen = []; });
        events.push({ type: 'shuffle', player: pid, deckSize: G.deck.length });
        pushLog(G, 'action', `${player(G, pid).name} 使用了「洗牌」。`);
        break;
      }
      case 'favor':
      case 'help': {
        const t = targetPlayer;
        // 规则约束：不能让一名存活玩家被掏空手牌。
        // 空手玩家在抽到炸弹时毫无还手之力，等同直接判死，因此最后一张牌不可被要走。
        const giveIdx = chooseGive(t, card.type, G);
        if (giveIdx < 0) {
          events.push({ type: 'noop', player: pid, reason: '对方没有可给的牌' });
          break;
        }
        if (t.hand.length <= 1) {
          events.push({ type: 'noop', player: pid, reason: '对方只剩最后一张牌，不能交出' });
          pushLog(G, 'action', `「${def.name}」未生效：${t.name} 只剩最后一张牌。`);
          break;
        }
        const given = t.hand.splice(giveIdx, 1)[0];
        player(G, pid).hand.push(given);
        events.push({
          type: 'transfer', from: t.id, to: pid, card: clone(given),
          secret: t.isAI === false ? false : true
        });
        pushLog(G, 'action', `${player(G, pid).name} 对 ${t.name} 使用了「${def.name}」，获得 1 张牌。`);
        break;
      }
      case 'nope': {
        // 基础版把否决实现为「反制窗口」：记录本次动作可被否决，
        // 由 UI/AI 在窗口期内选择是否打出否决，见 resolveResponse 流程。
        events.push({ type: 'nope', player: pid, cancelable: !!G.lastAction });
        if (G.lastAction && !G.lastAction.canceled) {
          G.lastAction.canceled = true;
          G.lastAction.canceledBy = pid;
          events.push({ type: 'cancel', target: G.lastAction.type, by: pid });
          pushLog(G, 'action', `${player(G, pid).name} 用「否决」取消了上一张牌。`);
        } else {
          pushLog(G, 'action', `${player(G, pid).name} 使用了「否决」。`);
        }
        break;
      }
      case 'draw2': {
        const drawn = [];
        for (let i = 0; i < 2; i++) {
          const r = resolveDraw(G, pid, events);
          if (r.exploded) {
            // 摸两张途中炸了：如果还有其他人活着，回合要交给下家
            if (G.phase !== 'over') advanceTurn(G, events, true);
            return { ok: true, events, exploded: true };
          }
          if (r.empty) break;
          if (r.needsPlacement) {
            // 抽到炸弹但用拆除化解了：本回合暂停，等放回炸弹后由 resumeAfterPlacement 继续
            G.turnEndPending = true;
            return { ok: true, events, needsPlacement: true, turnPaused: true };
          }
          if (r.card) drawn.push(clone(r.card));
        }
        if (G.phase === 'over') return { ok: true, events };
        events.push({ type: 'draw2', player: pid, cards: drawn });
        pushLog(G, 'action', `${player(G, pid).name} 使用了「摸两张」。`);
        break;
      }
      case 'nothing': {
        pushLog(G, 'action', `${player(G, pid).name} 打出了一张「无效果」。`);
        break;
      }
      default:
        break;
    }

    return { ok: true, events };
  }

  /**
   * 帮忙/求饶时，被点名的一方选择交出哪张牌。
   * 基础版由引擎代为实现（真人玩家则由 UI 弹出选择）。
   */
  function chooseGive(target, cardType, G) {
    if (!target.hand.length) return -1;
    // 优先交出最不关键的牌；若只剩炸弹则必须交出
    const score = c => {
      if (c.type === 'bomb') return 100;   // 最不想给
      if (c.type === 'defuse') return 90;
      if (c.type === 'nope') return 60;
      return 20;
    };
    let best = -1, bestScore = Infinity;
    target.hand.forEach((c, i) => {
      const s = score(c) + (G.rng() * 8);
      if (s < bestScore) { bestScore = s; best = i; }
    });
    return best;
  }

  /** 拆除后把炸弹秘密放回牌堆：position 0 = 顶 */
  function placeBomb(G, pid, position) {
    const events = [];
    if (!G.pendingBomb) {
      return { ok: false, error: '当前没有待放回的炸弹', events };
    }
    if (G.pendingBomb.player !== pid) {
      return { ok: false, error: '只能由放回炸弹的玩家本人操作', events };
    }
    const pos = Math.max(0, Math.min(G.deck.length, position | 0));
    G.deck.splice(pos, 0, G.pendingBomb.card);
    events.push({ type: 'place-bomb', player: pid, position: pos, deckSize: G.deck.length });
    pushLog(G, 'system', `${player(G, pid).name} 把炸弹猫秘密放回了牌堆。`);
    G.pendingBomb = null;
    // 玩家自己抽牌时看到的顶牌信息，因这次插入而改变
    player(G, pid).seen = [];
    return { ok: true, events };
  }

  /** 结束回合：结算必须抽的牌，并推进到下一位玩家 */
  function endTurn(G, pid) {
    const events = [];
    if (G.phase !== 'playing') return { ok: false, error: '对局已结束', events };
    if (G.pendingBomb) {
      return G.pendingBomb.player === pid
        ? { ok: false, error: '请先把炸弹放回牌堆', events }
        : { ok: false, error: '等待对方把炸弹放回牌堆', events };
    }
    if (pid !== G.current) return { ok: false, error: '还没轮到你', events };

    const me = player(G, pid);
    let exploded = false;

    // 逐张结算本回合必须抽的牌
    for (let i = 0; i < G.pendingDraws; i++) {
      const r = resolveDraw(G, pid, events);
      if (r.exploded) { exploded = true; break; }
      if (r.needsPlacement) {
        // 抽到炸弹但用拆除化解了：暂停结束流程，等 placeBomb 后由 resumeAfterPlacement 接着走
        G.turnEndPending = true;
        return { ok: true, events, needsPlacement: true, turnPaused: true };
      }
      // 牌堆被抽空时提前收尾，避免空转
      if (r.empty) break;
    }

    // 已经分出胜负（有人在这次抽牌中出局）就不要再推进回合
    if (G.phase === 'over') return { ok: true, events, exploded };
    if (checkVictory(G, events)) return { ok: true, events, exploded };

    // 抽牌者自己可能已经出局（抽到炸弹且无拆除，且场上仍有其他人存活），
    // 此时必须从「出局者」往后找下一个还活着的人，且不能再执行攻击队列。
    if (!me.alive) {
      advanceTurn(G, events, true);
      return { ok: true, events, exploded };
    }

    advanceTurn(G, events);
    return { ok: true, events, exploded };
  }

  /** 拆除结算完毕（从 endTurn 的暂停中恢复） */
  function resumeAfterPlacement(G, pid) {
    const events = [];
    if (!G.turnEndPending) return { ok: false, error: '无需恢复', events };
    G.turnEndPending = false;
    if (G.phase === 'over') return { ok: true, events };
    if (checkVictory(G, events)) return { ok: true, events };
    advanceTurn(G, events);
    return { ok: true, events };
  }

  function advanceTurn(G, events, fromDead) {
    if (G.pendingBomb) return;   // 有炸弹待放回时禁止推进回合
    G.turn++;
    const next = nextAlive(G, G.current);
    if (next == null) return;
    G.current = next;
    const victim = player(G, next);
    if (G.attackQueue && !fromDead) {
      // 攻击只对「正常结束回合」后的下家生效；出局者造成的推进不继承攻击
      G.pendingDraws = G.attackQueue;
      G.attackQueue = 0;
      pushLog(G, 'system', `⚔️ ${victim.name} 被攻击，本回合要抽 ${G.pendingDraws} 次。`);
    } else {
      G.attackQueue = 0;
      G.pendingDraws = 1;
    }
    G.mustDraw = true;
    G.turnEnded = false;
    events.push({ type: 'turn', player: next, pendingDraws: G.pendingDraws });
    pushLog(G, 'turn', `—— 轮到 ${victim.name}（需抽 ${G.pendingDraws} 张）——`);
  }

  function nextAlive(G, fromId) {
    for (let step = 1; step <= G.players.length; step++) {
      const idx = (fromId + step) % G.players.length;
      if (G.players[idx].alive) return idx;
    }
    return null;
  }

  function finish(G, winnerId, events) {
    G.phase = 'over';
    G.winner = winnerId;
    events.push({ type: 'gameover', winner: winnerId });
    pushLog(G, 'system', `🏆 ${player(G, winnerId).name} 成为最后的赢家！`);
  }

  /** 合法动作枚举，AI 与 UI 提示共用 */
  function legalMoves(G, pid) {
    const moves = { playable: [], needTarget: [], canEnd: false };
    if (G.phase !== 'playing' || pid !== G.current) return moves;
    if (G.pendingBomb) return moves;

    const me = player(G, pid);
    // 目标必须至少有 2 张手牌：只剩 1 张时不能交出，否则会让对手空手等死
    const opponents = G.players.filter(p => p.alive && p.id !== pid && p.hand.length >= 2);
    const seen = new Set();
    me.hand.forEach(c => {
      // 拆除与炸弹都不能主动打出：拆除只在抽到炸弹时用，炸弹根本不入牌局
      if (c.type === 'defuse' || c.type === 'bomb') return;
      if (seen.has(c.type)) return;
      seen.add(c.type);
      const def = CARDS[c.type];
      if (def.need === 'player') {
        if (opponents.length) moves.needTarget.push({ type: c.type, cardUid: c.uid, targets: opponents.map(p => p.id) });
      } else {
        moves.playable.push({ type: c.type, cardUid: c.uid });
      }
    });
    moves.canEnd = !G.pendingBomb;
    return moves;
  }

  /** 只读快照，供 UI 渲染；隐藏他人手牌细节 */
  function getState(G) {
    return {
      turn: G.turn,
      phase: G.phase,
      winner: G.winner,
      current: G.current,
      pendingDraws: G.pendingDraws,
      deckSize: G.deck.length,
      discardSize: G.discard.length,
      discardTop: G.discard.length ? clone(G.discard[G.discard.length - 1]) : null,
      bombTotal: G.bombTotal || 0,
      pendingBomb: G.pendingBomb ? { player: G.pendingBomb.player } : null,
      seenTop: G.seenTop.slice(),
      log: G.log.slice(-40),
      players: G.players.map(p => ({
        id: p.id, name: p.name, isAI: p.isAI, alive: p.alive,
        handSize: p.hand.length,
        hand: p.isAI === false || p.revealHand ? p.hand.map(clone) : null
      }))
    };
  }

  /** 完整状态（含所有手牌），仅供测试与存档 */
  function dump(G) {
    return {
      turn: G.turn, phase: G.phase, winner: G.winner, current: G.current,
      pendingDraws: G.pendingDraws, deckSize: G.deck.length, discardSize: G.discard.length,
      players: G.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, hand: p.hand.map(c => c.type) })),
      deck: G.deck.map(c => c.type)
    };
  }

  return {
    createGame, playCard, endTurn, placeBomb, resumeAfterPlacement,
    legalMoves, getState, dump,
    _internal: { buildDeck, nextAlive, resolveDraw, makeCard }
  };
});

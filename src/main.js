/**
 * 主控：把引擎、AI、视图、音效串起来，处理交互与回合流程。
 *
 * 回合流程（真人玩家）：
 *   出牌阶段（可出 0~N 张）→ 结束回合 → 抽牌结算 → 下一位
 * AI 玩家则由 driveAI() 自动走完同样的流程。
 */
(function (root) {
  'use strict';

  const { Engine, AI, View, SFX, CARDS, RNG } = root.BombCats;

  const $ = id => document.getElementById(id);

  /* ---------------- 对局状态 ---------------- */

  const App = {
    G: null,
    humanId: 0,          // 真人座位；-1 表示纯观战
    difficulty: 'normal',
    selectedUid: null,   // 当前选中的手牌
    newUid: null,        // 刚抽到的那张牌，用于在手牌里高亮
    incomingUid: null,   // 正从牌堆飞向手牌、还没落地的那张（先隐形占位）
    lastDrawn: null,     // 最近一次抽到的牌（供界面/调试回溯）
    awaitingTarget: false,
    busy: false,         // 动画播放中，锁定输入
    soundOn: true,
    stats: { turns: 0, drawn: 0, played: 0, startAt: 0 }
  };

  const delay = ms => new Promise(r => setTimeout(r, ms));

  /**
   * 真人现在能不能「直接抽牌」。
   * 点牌堆、按空格、点结束回合按钮共用这一套前提：
   *   轮到我 + 出牌阶段 + 没有待放回的炸弹 + 不在动画中 + 没在选目标。
   * 不满足时调用方一律静默返回（不报错、不弹提示）。
   */
  function canHumanDraw() {
    const G = App.G;
    if (!G || App.busy) return false;
    if (G.phase !== 'playing') return false;
    if (G.current !== App.humanId) return false;
    // 放炸弹模式：牌堆的点击归 enableBombPlacement() 的临时监听器，这里必须让开
    if (G.pendingBomb) return false;
    if (App.awaitingTarget) return false;
    return true;
  }

  /* ---------------- 渲染总入口 ---------------- */

  function render() {
    if (!App.G) return;
    const state = Engine.getState(App.G);
    const myId = App.humanId;

    // 放炸弹预览的退出兜底：状态里已经没有待放回的炸弹就收掉监听器与横线
    // （对局结束 / 状态被外部推进 / 读档等都不经过点击路径）
    if (bombPlaceCleanup && !state.pendingBomb) clearBombPlacement();

    // 计算哪些牌现在可以出
    const lm = Engine.legalMoves(App.G, state.current);
    const playable = new Set();
    let targetableIds = null;

    if (state.current === myId && state.phase === 'playing' && !App.busy) {
      lm.playable.forEach(m => playable.add(m.cardUid));
      lm.needTarget.forEach(m => playable.add(m.cardUid));
      // 选中了需要目标的牌 → 高亮可选对手
      if (App.awaitingTarget && App.selectedUid != null) {
        const hit = lm.needTarget.find(m => m.cardUid === App.selectedUid);
        targetableIds = hit ? hit.targets : null;
      }
    }

    View.renderOpponents(state, myId, targetableIds);
    View.renderStage(state);
    View.renderHand(state, myId, playable, App.selectedUid, App.awaitingTarget, App.newUid, App.incomingUid);
    View.renderLog(state.log);

    // 结束回合按钮：轮到自己且不在动画中才能点
    const isMyTurn = state.current === myId && state.phase === 'playing';
    $('btnEnd').disabled = !isMyTurn || App.busy || !!state.pendingBomb;
    $('btnHint').disabled = App.busy;

    // 牌堆的可点状态（金色呼吸光晕 / cursor / title），判定与点牌堆、空格完全一致
    View.setPileDrawable(canHumanDraw());

    // 提示条
    if (state.phase === 'over') {
      const win = state.winner === myId;
      View.setPrompt(win ? '<b>🎉 你赢了！</b>' : '<b>' + state.players[state.winner].name + '</b> 获胜', false);
    } else if (state.pendingBomb) {
      if (state.pendingBomb.player === myId) {
        View.setPrompt(PLACE_PROMPT, true);
      } else {
        View.setPrompt('<b>' + state.players[state.pendingBomb.player].name + '</b> 正在放置炸弹…', false);
      }
    } else if (state.current === myId) {
      const n = state.pendingDraws;
      View.setPrompt(n > 1
        ? '轮到你 · 被攻击，本回合要抽 <b>' + n + '</b> 张（点击牌堆）'
        : '轮到你 · 出牌后点击牌堆（或按空格）抽牌', false);
    } else {
      View.setPrompt('<b>' + state.players[state.current].name + '</b> 的回合…', false);
    }
  }

  /* ---------------- 飞牌辅助 ---------------- */

  function rectOf(node) {
    return node && typeof node.getBoundingClientRect === 'function'
      ? node.getBoundingClientRect()
      : null;
  }

  function pileRect() { return rectOf(View.el.pileStack); }
  function discardRect() { return rectOf(View.el.discardTop); }

  /** 对手头像矩形（对手抽牌 / AI 出牌的起飞点） */
  function opponentRect(pid) {
    const node = document.querySelector('.opponent[data-pid="' + pid + '"]');
    if (!node) return null;
    return rectOf(node.querySelector('.opp-avatar')) || rectOf(node);
  }

  /** 手牌里某张牌当前的矩形、旋转角与宽度（飞牌落点用） */
  function handTarget(uid) {
    const d = View.handCardEl(uid);
    if (!d) return null;
    return {
      rect: rectOf(d),
      rot: parseFloat(d.style.getPropertyValue('--rot')) || 0,
      cw: d.offsetWidth || 96
    };
  }

  /* ---------------- 抽牌 / 出牌飞行动效 ---------------- */

  const DRAW_HOLD = 600;          // 揭晓停留基准（H）
  const DRAW_HOLD_MULTI = 450;    // 第 2 张起：H × 0.75
  const DRAW_WAIT_LAST = 260;     // 最后一张：卡面起飞后再等 260ms（合计 460+H）
  const DRAW_WAIT_MORE = 80;      // 还有下一张：卡面起飞后 80ms 就放行
  const PLAY_WAIT_HUMAN = 300;    // 真人出牌事件等待
  const PLAY_WAIT_AI = 320;       // AI 出牌事件等待

  /**
   * 真人抽一张：卡背飞入 → 揭晓 → 卡面飞进手牌。
   * 时间轴（t=0 进入 draw 分支）：
   *   0     卡背起飞 + render（新牌 .incoming 隐形占位，跳过 cardIn）
   *   200   揭晓 showDrawnCard(card, H+140)，与卡背飞行重叠 80ms
   *   200+H 卡面起飞（340ms，50% 处上抬 -24px）
   *   460+H 本次事件放行；最后 80ms 的落地收尾（去 .incoming + render）不阻塞回合
   */
  async function playHumanDraw(card, opts) {
    const o = opts || {};
    const hold = o.hold == null ? DRAW_HOLD : o.hold;
    const isBomb = !!(card && CARDS[card.type] && CARDS[card.type].kind === 'bomb');

    App.lastDrawn = card || null;
    App.newUid = card ? card.uid : null;

    if (isBomb) {
      // 炸弹不入手：只播卡背和揭晓
      View.flyCard(pileRect(), View.drawFlashCardRect(), {
        face: 'back', scaleFrom: .64, scaleTo: 1, rotateFrom: -8, rotateTo: 0,
        ms: 280, fadeTail: 80, easing: 'cubic-bezier(.2,.7,.3,1)'
      });
      View.showDrawnCard(card, 1100);
      render();
      await delay(900);
      return;
    }

    // 新牌先隐形占位，等飞牌落地再显形；不能飞（无 WAAPI / 减少动态效果）时保持普通进场
    if (View.canFly()) App.incomingUid = card.uid;
    render();

    View.flyCard(pileRect(), View.drawFlashCardRect(), {
      face: 'back', scaleFrom: .64, scaleTo: 1, rotateFrom: -8, rotateTo: 0,
      ms: 280, fadeTail: 80, easing: 'cubic-bezier(.2,.7,.3,1)'
    });

    await delay(200);
    View.showDrawnCard(card, hold + 140);

    await delay(hold);
    const target = handTarget(card.uid);
    const flight = View.flyCard(View.drawFlashCardRect(), target && target.rect, {
      face: 'front', card: card, size: 'face',
      scaleFrom: 1, scaleTo: target ? target.cw / 116 : 1,
      rotateFrom: 0, rotateTo: target ? target.rot : 0,
      ms: 340, lift: -24, easing: 'cubic-bezier(.25,.8,.3,1)'
    });
    flight.then(() => {
      View.clearIncoming(card.uid);
      if (App.incomingUid === card.uid) App.incomingUid = null;
      render();                        // 让 handGeom 缓存与 DOM 重新对齐
    });

    await delay(o.more ? DRAW_WAIT_MORE : DRAW_WAIT_LAST);
  }

  /** 对手抽牌：卡背从牌堆飞向对手头像，落地后再抖一下 */
  async function playOpponentDraw(pid) {
    View.flyCard(pileRect(), opponentRect(pid), {
      face: 'back', scaleFrom: 1, scaleTo: .32, rotateFrom: 0, rotateTo: 12,
      ms: 420, fadeTail: 120, easing: 'cubic-bezier(.3,.6,.3,1)'
    });
    await delay(300);
    View.showOpponentDraw(pid);
    await delay(60);
  }

  /** 真人出牌：从手牌位置飞向弃牌堆，元素立刻摘掉（不走 .leaving，避免和克隆重影） */
  async function playHumanPlay(e) {
    const taken = View.takeHandCard(e.card.uid);
    const rot = (Math.random() * 8) - 4;
    const cw = taken && taken.el.offsetWidth ? taken.el.offsetWidth : 96;
    View.flyCard(taken && taken.rect, discardRect(), {
      face: 'front', card: e.card,
      scaleFrom: 1, scaleTo: 74 / cw,
      rotateFrom: taken ? taken.rot : 0, rotateTo: rot,
      ms: 380, arcAt: .4, lift: -18, easing: 'cubic-bezier(.3,.7,.2,1)'
    }).then(() => {
      View.setDiscardTop(e.card, rot);
      View.discardLand();
    });
    await delay(PLAY_WAIT_HUMAN);
  }

  /** AI 出牌：从对手头像位置起飞（与真人出牌同一条弧线） */
  async function playAIPlay(e) {
    const rot = (Math.random() * 8) - 4;
    View.flyCard(opponentRect(e.player), discardRect(), {
      face: 'front', card: e.card,
      scaleFrom: .40, scaleTo: .77,
      rotateFrom: 0, rotateTo: rot,
      ms: 420, arcAt: .4, lift: -18, easing: 'cubic-bezier(.3,.7,.2,1)'
    }).then(() => {
      View.setDiscardTop(e.card, rot);
      View.discardLand();
    });
    await delay(PLAY_WAIT_AI);
  }

  /* ---------------- 事件处理：播放引擎返回的事件 ---------------- */

  async function playEvents(events) {
    let humanDrawIndex = 0;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case 'play':
          SFX.play();
          if (e.player === App.humanId) await playHumanPlay(e);
          else await playAIPlay(e);
          break;
        case 'draw': {
          SFX.draw();
          View.bumpDeck();
          if (e.player === App.humanId) {
            // 连续抽多张（被攻击）时：上一张的卡面起飞后 80ms 才放行下一张
            const more = events.slice(i + 1).some(x => x.type === 'draw' && x.player === App.humanId);
            const hold = humanDrawIndex === 0 ? DRAW_HOLD : DRAW_HOLD_MULTI;
            humanDrawIndex++;
            await playHumanDraw(e.card, { hold: hold, more: more });
          } else {
            await playOpponentDraw(e.player);
          }
          break;
        }
        case 'peek':
          SFX.peek();
          if (e.player === App.humanId) View.showPeek(e.cards);
          else View.floater('🔮 预测未来', 'var(--blue)');
          await delay(e.player === App.humanId ? 300 : 420);
          break;
        case 'shuffle':
          SFX.shuffle();
          View.floater('🌀 洗牌', 'var(--purple)');
          await delay(360);
          break;
        case 'attack':
          SFX.attack();
          View.floater('⚔️ 攻击！', 'var(--red-2)');
          if (e.victim != null) View.pulsePlayer(e.victim, 'hit');
          await delay(420);
          break;
        case 'transfer':
          SFX.transfer();
          View.pulsePlayer(e.from, 'hit');
          View.floater('🔄 转移一张牌', 'var(--gold)');
          await delay(360);
          break;
        case 'nope':
        case 'cancel':
          SFX.nope();
          View.floater('🚫 否决！', 'var(--red-2)');
          await delay(360);
          break;
        case 'defuse':
          SFX.defuse();
          View.floater('✂️ 拆除成功', 'var(--green)');
          await delay(400);
          break;
        case 'place-bomb':
          SFX.click();
          break;
        case 'explode':
          SFX.explode();
          View.flash();
          View.shake();
          View.boomAtPlayer(e.player);        // 12 帧手绘爆炸精灵
          View.burstAtPlayer(e.player);       // 叠加粒子碎屑
          View.pulsePlayer(e.player, 'blasted');
          View.floater('BOOM！', 'var(--red-2)');
          await delay(820);
          break;
        case 'reshuffle':
          SFX.shuffle();
          break;
        case 'gameover':
          await delay(240);
          break;
        case 'turn':
          SFX.turn();
          // 轮到真人：牌堆与「结束回合」按钮各脉冲一次，提示「该你了」
          if (e.player === App.humanId) View.pulseTurnCue();
          // 注意：这里不要清 newUid。抽牌后紧接着就会推进回合，
          // 若在此清空，「新抽到的牌」高亮会一闪即逝，等于没有提示。
          // newUid 由下一次抽牌覆盖，开局时重置。
          break;
        default:
          break;
      }
    }
  }

  /* ---------------- 回合推进 ---------------- */

  /** 统一执行一个动作并播动画 */
  async function runAction(fn) {
    App.busy = true;
    let result;
    try {
      result = fn();
    } catch (err) {
      App.busy = false;
      console.error(err);
      View.floater('出错了：' + err.message, 'var(--red-2)');
      return { ok: false };
    }

    if (!result.ok) {
      App.busy = false;
      if (result.error) View.floater(result.error, 'var(--red-2)');
      return result;
    }

    App.selectedUid = null;
    App.awaitingTarget = false;

    // 统计真人打出了多少张牌（AI 出牌不走 runAction，所以这里只会计到玩家头上）
    (result.events || []).forEach(e => {
      if (e.type === 'play' && e.player === App.humanId) App.stats.played++;
    });

    await playEvents(result.events || []);
    App.busy = false;
    render();
    return result;
  }

  /** 真人的一次出牌 */
  async function humanPlayCard(uid) {
    const G = App.G;
    const card = G.players[App.humanId].hand.find(c => c.uid === uid);
    if (!card) return;
    const def = CARDS[card.type];

    if (def.need === 'player') {
      // 需要目标：先选中，等待点击对手
      App.selectedUid = uid;
      App.awaitingTarget = true;
      render();
      const lm = Engine.legalMoves(G, App.humanId);
      const hit = lm.needTarget.find(m => m.cardUid === uid);
      View.floater('选择一名对手', 'var(--gold)');
      if (!hit || !hit.targets.length) {
        App.awaitingTarget = false;
        App.selectedUid = null;
        render();
      }
      return;
    }

    // 无需目标：直接结算
    const r = await runAction(() => Engine.playCard(G, App.humanId, uid));
    if (r && r.needsPlacement) await handlePlacementIfNeeded();
  }

  /** 点选对手作为目标 */
  async function humanPickTarget(targetId) {
    if (!App.awaitingTarget || App.selectedUid == null) return;
    const uid = App.selectedUid;
    App.awaitingTarget = false;
    const r = await runAction(() => Engine.playCard(App.G, App.humanId, uid, targetId));
    if (r && r.needsPlacement) await handlePlacementIfNeeded();
  }

  /** 真人结束回合（抽牌） */
  async function humanEndTurn() {
    const G = App.G;
    const r = await runAction(() => Engine.endTurn(G, App.humanId));
    if (!r.ok) return;
    if (r.needsPlacement) { await handlePlacementIfNeeded(); return; }
    await checkGameOver();
    if (!App.busy) scheduleAIIfNeeded();
  }

  /* ---------------- 炸弹放回 ---------------- */

  const PLACE_PROMPT = '<b>💣 炸弹放回哪里？</b>点击牌堆任意高度决定位置';

  /** 当前挂着的放炸弹监听器清理函数（防重入 + 所有退出路径共用） */
  let bombPlaceCleanup = null;

  /** 收掉放炸弹监听器与预览（点击完成 / 对局结束 / 重开 / 状态被外部推进） */
  function clearBombPlacement() {
    if (!bombPlaceCleanup) return;
    const fn = bombPlaceCleanup;
    bombPlaceCleanup = null;
    fn();
  }

  /** 指针高度占牌堆高度的比例（不做上下夹取，越界由 posFromEvent 的 clamp 兜住） */
  function ratioFromEvent(ev) {
    const stack = document.querySelector('.pile-stack');
    if (!stack || typeof stack.getBoundingClientRect !== 'function') return 0;
    const rect = stack.getBoundingClientRect();
    if (!rect.height) return 0;
    return (ev.clientY - rect.top) / rect.height;
  }

  /**
   * 指针高度 → 炸弹插回位置。预览（marker / 文案）与最终放置共用这一个函数，
   * 保证「看到的位置」就是「放回的位置」。
   * 12 槽是刻意的：牌堆 100px 高，按张数分格点不准；真正有意义的也是接下来要抽的十几张。
   */
  function posFromEvent(ev) {
    const G = App.G;
    const deckSize = G && G.deck ? G.deck.length : 0;
    const ratio = ratioFromEvent(ev);
    return Math.max(0, Math.min(deckSize, Math.round(ratio * Math.min(deckSize, 12))));
  }

  /** 若当前有待放回的炸弹且属于真人，等玩家点击牌堆；否则由 AI 处理 */
  async function handlePlacementIfNeeded() {
    const G = App.G;
    if (!G.pendingBomb) return;

    if (G.pendingBomb.player === App.humanId) {
      View.setPrompt(PLACE_PROMPT, true);
      enableBombPlacement();
      return;
    }

    // AI 自动放置
    const owner = G.pendingBomb.player;
    const pos = AI.chooseBombPosition(G, owner, App.difficulty);
    await delay(420);
    const r = Engine.placeBomb(G, owner, pos);
    if (r.ok) await playEvents(r.events);
    await afterPlacement();
  }

  /** 让牌堆可点击，玩家选择炸弹放回的位置（带插入位置预览） */
  function enableBombPlacement() {
    const stack = document.querySelector('.pile-stack');
    if (!stack) return;
    // 防重入：任何时刻牌堆上最多只挂一套放炸弹监听器
    clearBombPlacement();

    // 双保险：放炸弹期间牌堆不能同时是「可抽牌」状态（常驻点击也会因 pendingBomb 让开）
    View.setPileDrawable(false);
    stack.style.cursor = 'pointer';
    stack.style.outline = '2px dashed var(--red)';
    stack.style.outlineOffset = '4px';

    /** 悬停 / 触摸预览：横线画在指针高度，文案给出会插到第几张 */
    const onMove = (ev) => {
      const G = App.G;
      if (!G || !G.pendingBomb) return;
      const ratio = ratioFromEvent(ev);
      const pos = posFromEvent(ev);
      const deckSize = G.deck.length;
      View.showPlaceMarker(ratio, pos, deckSize);
      View.setPrompt(PLACE_PROMPT + '（当前：' + View.placeMarkerText(pos, deckSize) + '）', true);
    };

    const onLeave = () => {
      View.hidePlaceMarker();
      View.setPrompt(PLACE_PROMPT, true);
    };

    const onClick = async (ev) => {
      const pos = posFromEvent(ev);
      cleanup();
      const r = Engine.placeBomb(App.G, App.humanId, pos);
      if (r.ok) {
        View.floater('🗨️ 炸弹已放回', 'var(--red-2)');
        await playEvents(r.events);
      }
      await afterPlacement();
    };

    const cleanup = () => {
      stack.style.cursor = '';
      stack.style.outline = '';
      stack.style.outlineOffset = '';
      stack.removeEventListener('click', onClick);
      stack.removeEventListener('pointermove', onMove);
      stack.removeEventListener('pointerdown', onMove);
      stack.removeEventListener('pointerleave', onLeave);
      View.hidePlaceMarker();
      if (bombPlaceCleanup === cleanup) bombPlaceCleanup = null;
      // 不在这里恢复 .can-draw：交给下一次 render() 按真实状态重新算
    };

    // 同步挂载：120ms 延迟会让玩家看到红框后的第一击被吞掉（探针已证实）
    stack.addEventListener('click', onClick);
    stack.addEventListener('pointermove', onMove);
    stack.addEventListener('pointerdown', onMove);   // 触摸没有 hover，按下就先显示
    stack.addEventListener('pointerleave', onLeave);
    bombPlaceCleanup = cleanup;
  }

  /** 炸弹放回之后的收尾：判断是否需要恢复暂停的回合 */
  async function afterPlacement() {
    const G = App.G;
    render();
    if (G.turnEndPending) {
      const owner = App.G.current;
      const r = Engine.resumeAfterPlacement(G, owner);
      if (r.ok) await playEvents(r.events);
    }
    render();
    await checkGameOver();
    scheduleAIIfNeeded();
  }

  /* ---------------- AI 驱动 ---------------- */

  let aiTimer = null;

  function scheduleAIIfNeeded() {
    const G = App.G;
    if (!G || G.phase !== 'playing') return;
    if (G.pendingBomb) return;
    const cur = G.players[G.current];
    if (!cur || !cur.isAI) return;
    clearTimeout(aiTimer);
    aiTimer = setTimeout(driveAI, 620);
  }

  async function driveAI() {
    const G = App.G;
    if (!G || G.phase !== 'playing' || App.busy) return;

    const pid = G.current;
    const p = G.players[pid];
    if (!p || !p.isAI) return;

    // 1) 待放回的炸弹
    if (G.pendingBomb) {
      if (G.pendingBomb.player === pid || true) {
        const owner = G.pendingBomb.player;
        const pos = AI.chooseBombPosition(G, owner, App.difficulty);
        const r = Engine.placeBomb(G, owner, pos);
        if (r.ok) await playEvents(r.events);
        await afterPlacement();
      }
      return;
    }

    App.busy = true;
    View.setPrompt('<b>' + p.name + '</b> 思考中…', false);

    try {
      // 2) 出牌决策（最多连续出 2 张，保持节奏）
      let played = 0;
      const maxPlay = App.difficulty === 'hard' ? 2 : 1;

      while (played < maxPlay && G.phase === 'playing' && G.current === pid && !G.pendingBomb) {
        await delay(340);
        const pick = AI.chooseCard(G, pid, App.difficulty);
        if (!pick) break;

        const target = pick.needsTarget ? AI.chooseTarget(G, pid, pick, App.difficulty) : undefined;
        const r = Engine.playCard(G, pid, pick.card.uid, target);
        if (!r.ok) break;

        await playEvents(r.events || []);
        played++;
        render();

        if (r.needsPlacement) {
          App.busy = false;
          await handlePlacementIfNeeded();
          return;
        }
        if (G.phase === 'over') break;
      }

      if (G.phase === 'over') { App.busy = false; render(); await checkGameOver(); return; }

      // 3) 结束回合（抽牌）
      await delay(300);
      const r = Engine.endTurn(G, pid);
      if (!r.ok) {
        App.busy = false;
        render();
        return;
      }
      await playEvents(r.events || []);
      App.busy = false;
      render();

      if (r.needsPlacement) { await handlePlacementIfNeeded(); return; }
      await checkGameOver();
      scheduleAIIfNeeded();
    } catch (err) {
      console.error('[AI]', err);
      App.busy = false;
      render();
    }
  }

  /* ---------------- 结算 ---------------- */

  let overShown = false;

  async function checkGameOver() {
    const G = App.G;
    if (!G || G.phase !== 'over' || overShown) return;
    overShown = true;

    await delay(500);
    const win = G.winner === App.humanId;
    if (win) { SFX.win(); View.burst(window.innerWidth / 2, window.innerHeight / 2, 70, ['#f3d79a', '#d9b061', '#fff0d0', '#ffd39b']); }
    else SFX.lose();

    const winnerName = G.players[G.winner] ? G.players[G.winner].name : '？';
    // 胜利用庆祝插画，失败用出局插画（单文件版会走内联数据）
    const art = $('resultArt');
    if (art) {
      const map = root.__ASSETS;
      const path = win ? 'assets/art/win.webp' : 'assets/art/lose.webp';
      art.src = (map && map[path]) || path;
      art.alt = win ? '胜利' : '失败';
    }
    const title = $('resultTitle');
    title.textContent = win ? '你是最后的赢家！' : winnerName + ' 获胜';
    title.className = 'result-title ' + (win ? 'win' : 'lose');
    $('resultSub').textContent = win
      ? '你把所有对手都送进了猫窝。'
      : '再来一局，这次记得盯着牌堆。';

    const elapsed = Math.max(1, Math.round((Date.now() - App.stats.startAt) / 1000));
    // 回合数直接从引擎取，避免依赖定时器轮询带来的滞后
    $('statTurns').textContent = G.turn;
    $('statPlayed').textContent = App.stats.played;
    $('statTime').textContent = elapsed + 's';

    View.showModal('modalResult');
  }

  /* ---------------- 开局 ---------------- */

  function readNames(count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const inp = $('name' + i);
      const v = inp ? inp.value.trim() : '';
      out.push(v || (i === App.humanId ? '你' : 'AI ' + i));
    }
    return out;
  }

  function buildNameInputs(count) {
    const wrap = $('names');
    wrap.innerHTML = '';
    const defaults = ['你', 'AI 阿猫', 'AI 二狗', 'AI 三花', 'AI 四喜'];
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'name-row';

      const seat = document.createElement('span');
      seat.className = 'seat';
      seat.textContent = i + 1;

      const inp = document.createElement('input');
      inp.id = 'name' + i;
      inp.type = 'text';
      inp.maxLength = 10;
      inp.value = i === 0 ? defaults[0] : defaults[i];
      inp.placeholder = '玩家 ' + (i + 1);
      inp.readOnly = i === 0;         // 0 号位固定是真人「你」

      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = i === 0 ? '你' : 'AI';

      row.append(seat, inp, tag);
      wrap.appendChild(row);
    }
  }

  function startGame() {
    const count = parseInt($('setupPlayers').dataset.value || '4', 10);
    const names = readNames(count);

    App.humanId = 0;
    App.selectedUid = null;
    App.newUid = null;
    App.incomingUid = null;
    App.lastDrawn = null;
    App.awaitingTarget = false;
    App.busy = false;
    App.stats = { turns: 0, drawn: 0, played: 0, startAt: Date.now() };
    overShown = false;
    // 重开时收掉可能还挂着的放炸弹监听器与预览
    clearBombPlacement();

    // 用时间戳作种子，方便复盘时在控制台复现
    const seed = Date.now() >>> 0;
    const rng = RNG.seeded(seed);
    console.log('[炸弹猫] 本局随机种子：', seed, '（引擎需要时可用 RNG.seeded(seed) 复现）');

    App.G = Engine.createGame({
      playerCount: count,
      names,
      rng,
      humanIndex: App.humanId
    });

    View.hideModal('modalSetup');
    View.hideModal('modalResult');
    // 新一局：清掉上一局的手牌复用表，免得旧牌还在播离场动画
    View.resetHand();
    render();
    scheduleAIIfNeeded();
  }

  /* ---------------- 交互绑定 ---------------- */

  function bindUI() {
    // 手牌点击：出牌 或 选中需要目标的牌
    $('hand').addEventListener('click', ev => {
      // 扇形手牌会互相压住：真实指针点击（detail > 0）用几何命中判定定位最上面那张；
      // 测试里的 el.click() 没有坐标且 detail 为 0，退回 closest('.card')
      let cardEl = null;
      if (ev.detail > 0) {
        cardEl = View.handCardAt(ev.clientX, ev.clientY);
      } else if (ev.target && ev.target.closest) {
        cardEl = ev.target.closest('.card');
      }
      if (!cardEl) return;
      if (App.busy) return;
      const G = App.G;
      if (!G || G.phase !== 'playing') return;
      if (G.current !== App.humanId) return;
      const uid = parseInt(cardEl.dataset.uid, 10);

      if (!cardEl.classList.contains('playable')) {
        View.floater('这张牌现在不能出', 'var(--faint)');
        return;
      }
      // 再次点击已选中的牌 → 取消选择
      if (App.selectedUid === uid && App.awaitingTarget) {
        App.selectedUid = null;
        App.awaitingTarget = false;
        render();
        return;
      }
      humanPlayCard(uid);
    });

    // 扇形手牌 hover：由几何命中判定切 .is-hover（牌互相压住时 CSS :hover 命中不准）
    let hoveredCard = null;
    const setHoveredCard = card => {
      if (card === hoveredCard) return;
      if (hoveredCard) hoveredCard.classList.remove('is-hover');
      hoveredCard = card;
      if (hoveredCard) hoveredCard.classList.add('is-hover');
    };
    $('hand').addEventListener('pointermove', ev => {
      setHoveredCard(View.handCardAt(ev.clientX, ev.clientY));
    });
    $('hand').addEventListener('pointerleave', () => setHoveredCard(null));

    // 窗口尺寸变化：手牌宽度变了，扇形步距与命中缓存都要重算
    if (root.addEventListener) {
      root.addEventListener('resize', () => View.refreshHandLayout());
    }

    // 对手点击：作为目标
    $('opponents').addEventListener('click', ev => {
      const node = ev.target.closest('.opponent');
      if (!node) return;
      if (!App.awaitingTarget) return;
      humanPickTarget(parseInt(node.dataset.pid, 10));
    });

    // 结束回合
    $('btnEnd').addEventListener('click', () => {
      if (App.busy) return;
      humanEndTurn();
    });

    // 牌堆：常驻点击 = 直接抽牌。
    // 不满足条件时静默返回；炸弹放回模式下 G.pendingBomb 为真，这里必然让开，
    // 点击交给 enableBombPlacement() 的临时监听器处理——两套逻辑不会同时触发。
    const pileStack = document.querySelector('.pile-stack');
    if (pileStack) {
      pileStack.addEventListener('click', () => {
        if (!canHumanDraw()) return;
        humanEndTurn();
      });
    }

    // 提示按钮：显示当前建议
    $('btnHint').addEventListener('click', () => {
      const G = App.G;
      if (!G) return;
      if (G.current !== App.humanId) { View.floater('还没轮到你', 'var(--faint)'); return; }
      const risk = AI.bombRisk(G, App.humanId);
      const lm = Engine.legalMoves(G, App.humanId);
      const n = lm.playable.length + lm.needTarget.length;
      View.floater(
        '抽到炸弹概率约 ' + Math.round(risk * 100) + '% · 可出 ' + n + ' 张牌',
        risk > 0.35 ? 'var(--red-2)' : 'var(--gold)'
      );
    });

    // 重开
    $('btnRestart').addEventListener('click', () => {
      View.hideModal('modalResult');
      View.showModal('modalSetup');
    });
    $('btnAgain').addEventListener('click', () => {
      View.hideModal('modalResult');
      View.showModal('modalSetup');
    });

    // 开局设置：人数
    $('setupPlayers').addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      $('setupPlayers').querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      $('setupPlayers').dataset.value = b.dataset.v;
      buildNameInputs(parseInt(b.dataset.v, 10));
    });

    // 开局设置：难度
    const DIFF_HINTS = {
      easy: 'AI 比较莽，攥着「跳过」也照抽不误，适合放松玩。',
      normal: '偶尔看牌、偶尔躲避，但经常判断失误，大致势均力敌。',
      hard: '会抢你的牌，没拆除时才躲，还会把拆掉的炸弹塞进牌堆最深处。'
    };
    $('setupDiff').addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      $('setupDiff').querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      App.difficulty = b.dataset.v;
      const hint = $('diffHint');
      if (hint) hint.textContent = DIFF_HINTS[App.difficulty] || '';
    });

    // 开始
    $('btnStart').addEventListener('click', startGame);

    // 音效开关
    $('btnSound').addEventListener('click', () => {
      App.soundOn = !App.soundOn;
      root.BombCats.setSoundEnabled(App.soundOn);
      // 图标现在是 sprite 引用，切换的是 <use> 的 href
      const use = $('btnSound').querySelector('use');
      if (use) use.setAttribute('href', App.soundOn ? '#ic-sound-on' : '#ic-sound-off');
      $('btnSound').title = App.soundOn ? '关闭音效' : '开启音效';
      if (App.soundOn) SFX.click();
    });

    // 日志面板开关
    $('btnLog').addEventListener('click', () => {
      View.el.logPanel.classList.add('hidden');
      $('btnLogToggle').style.display = 'block';
    });
    $('btnLogToggle').addEventListener('click', () => {
      View.el.logPanel.classList.remove('hidden');
      $('btnLogToggle').style.display = 'none';
    });

    // 键盘快捷键
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        App.selectedUid = null;
        App.awaitingTarget = false;
        render();
      }
      if (ev.key === ' ' || ev.key === 'Enter') {
        const btn = $('btnEnd');
        if (!btn.disabled && document.activeElement.tagName !== 'INPUT') {
          ev.preventDefault();
          humanEndTurn();
        }
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  /**
   * 素材自检。
   * 素材是外部文件，一旦 assets/ 不可达（换了打开方式、只拷了 HTML、用不支持
   * 本地文件的预览器打开……），页面不会报错，只会静默变成一片裂图。
   * 这里主动探一张必用素材，失败就给出可执行的提示，而不是让玩家对着碎图标猜。
   */
  function checkAssets() {
    // 单文件版把素材内联成 data URI，不存在「找不到文件」的问题
    if (root.__ASSETS) { App.assetsOk = true; return; }

    const probe = new Image();
    probe.onload = () => { App.assetsOk = true; };
    probe.onerror = () => {
      App.assetsOk = false;
      const resolved = probe.src;
      console.error('[炸弹猫] 素材加载失败：' + resolved);

      const bar = document.createElement('div');
      bar.className = 'asset-warn';
      bar.innerHTML =
        '<b>素材没加载出来</b>' +
        '<span>页面找不到 <code>assets/</code> 里的图片，现在显示的只是纯色占位。</span>' +
        '<span class="path">' + resolved.replace(/[<>&]/g, '') + '</span>' +
        '<span>请确认 <code>index.html</code> 和 <code>assets</code> 文件夹在同一个目录下，' +
        '并且是直接用浏览器打开（或通过本地服务器访问），而不是在预览器里查看单个文件。</span>' +
        '<button type="button">知道了</button>';
      bar.querySelector('button').addEventListener('click', () => bar.remove());
      document.body.appendChild(bar);
    };
    probe.src = 'assets/cards/frame.webp';
  }

  function boot() {
    bindUI();
    buildNameInputs(4);
    View.showModal('modalSetup');
    checkAssets();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 暴露少量内部方法，供自动化验收脚本（tests/screenshot.js、tests/browser.test.js）驱动真实界面
  App.render = render;
  App.startGame = startGame;
  App.checkGameOver = checkGameOver;
  // 放炸弹相关：探针 / 桩脚本要直接验证「看到的位置 == 放回的位置」
  App.posFromEvent = posFromEvent;
  App.enableBombPlacement = enableBombPlacement;

  root.BombCats = Object.assign(root.BombCats || {}, { App });
})(typeof window !== 'undefined' ? window : globalThis);

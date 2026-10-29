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

  /**
   * 玩家名是用户输入（联机时还可能是对手填的），拼进提示条的 HTML 前必须转义。
   * 其他位置的名字都走 textContent / title / alt，不受影响。
   */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ---------------- 对局状态 ---------------- */

  const App = {
    G: null,
    humanId: 0,          // 真人座位；-1 表示纯观战
    difficulty: 'normal',
    selectedUid: null,   // 当前选中的手牌
    selectedAt: 0,       // 最近一次触摸选中的时间戳（≥200ms 后再点同一张才算确认出牌）
    input: 'mouse',      // 输入类型：只认 pointerdown 记下的 pointerType（mouse / touch）
    newUid: null,        // 刚抽到的那张牌，用于在手牌里高亮
    incomingUid: null,   // 正从牌堆飞向手牌、还没落地的那张（先隐形占位）
    lastDrawn: null,     // 最近一次抽到的牌（供界面/调试回溯）
    awaitingTarget: false,
    busy: false,         // 动画播放中，锁定输入
    soundOn: true,
    mode: 'local',       // 开局面板的选择：local | online
    online: null,        // 联机会话：{ conn, code, seat, token, state, moves, host }
    stats: { turns: 0, drawn: 0, played: 0, startAt: 0 }
  };

  const delay = ms => new Promise(r => setTimeout(r, ms));

  /* ---------------- 状态源：单机读本地引擎，联机读服务器快照 ---------------- */

  function curState() {
    if (App.online) return App.online.state;
    return App.G ? Engine.getState(App.G) : null;
  }

  function curMoves() {
    if (App.online) {
      return App.online.moves || { playable: [], needTarget: [], canEnd: false };
    }
    return Engine.legalMoves(App.G, curState().current);
  }

  /**
   * 触觉反馈：只在支持的设备生效（Android 手机的浏览器；iOS 会忽略，无副作用）。
   * 只用在分量最重的时刻——爆炸、拆弹、被攻击、胜负——抽牌这类高频动作不震，
   * 否则很快就烦了。
   */
  function buzz(pattern) {
    if (root.navigator && typeof root.navigator.vibrate === 'function') {
      try { root.navigator.vibrate(pattern); } catch (e) { /* 忽略 */ }
    }
  }

  /**
   * 真人现在能不能「直接抽牌」。
   * 点牌堆、按空格、点结束回合按钮共用这一套前提：
   *   轮到我 + 出牌阶段 + 没有待放回的炸弹 + 不在动画中 + 没在选目标。
   * 不满足时调用方一律静默返回（不报错、不弹提示）。
   */
  function canHumanDraw() {
    if (App.busy) return false;
    if (App.online) {
      const s = App.online.state;
      const responding = !!(App.online.respond && App.online.respond.pending);
      return !!s && s.phase === 'playing' && s.current === App.humanId &&
             !s.pendingBomb && !s.pendingAction && !App.awaitingTarget && !responding;
    }
    const G = App.G;
    if (!G) return false;
    if (G.phase !== 'playing') return false;
    if (G.current !== App.humanId) return false;
    // 放炸弹模式：牌堆的点击归 enableBombPlacement() 的临时监听器，这里必须让开
    if (G.pendingBomb) return false;
    if (G.pendingAction) return false;      // 上一张牌还在等否决窗口
    if (App.awaitingTarget) return false;
    return true;
  }

  /* ---------------- 渲染总入口 ---------------- */

  function render() {
    const state = curState();
    if (!state) return;                  // 单机未开局 / 联机还在等待室
    const myId = App.humanId;

    // 选中失效：牌已不在手牌里（被抢 / 被弃 / 换局），清掉免得下次误判
    if (App.selectedUid != null) {
      const me = state.players[myId];
      if (!me || !me.hand || !me.hand.some(c => c.uid === App.selectedUid)) {
        App.selectedUid = null;
        App.awaitingTarget = false;
      }
    }

    // 放炸弹预览的退出兜底：状态里已经没有待放回的炸弹就收掉监听器与横线
    // （对局结束 / 状态被外部推进 / 读档等都不经过点击路径）
    if (bombPlaceCleanup && !state.pendingBomb) clearBombPlacement();

    // 计算哪些牌现在可以出（联机时服务器已经算好，快照自带）
    const lm = curMoves();
    const playable = new Set();
    let targetableIds = null;

    if (state.current === myId && state.phase === 'playing' && !App.busy) {
      // 合法动作按牌型去重（同一牌型只给一个 uid，给 AI 用），
      // 但玩家手里可能有两张同名卡：UI 按牌型映射回所有同名卡，
      // 否则第二张点下去会提示「现在不能出」，看起来像坏牌。
      const types = new Set();
      lm.playable.forEach(m => types.add(m.type));
      lm.needTarget.forEach(m => types.add(m.type));
      const me = state.players[myId];
      if (me && me.hand) {
        me.hand.forEach(c => { if (types.has(c.type)) playable.add(c.uid); });
      }
      // 选中了需要目标的牌 → 高亮可选对手（同样按牌型匹配，不看具体哪一张）
      if (App.awaitingTarget && App.selectedUid != null && me && me.hand) {
        const sel = me.hand.find(c => c.uid === App.selectedUid);
        const hit = sel ? lm.needTarget.find(m => m.type === sel.type) : null;
        targetableIds = hit ? hit.targets : null;
      }
    }

    View.renderOpponents(state, myId, targetableIds);
    View.renderStage(state);
    View.renderHand(state, myId, playable, App.selectedUid, App.awaitingTarget, App.newUid, App.incomingUid);
    View.renderLog(state.log);

    // 结束回合按钮：轮到自己、不在动画中、没在瞄准目标时才能点
    const isMyTurn = state.current === myId && state.phase === 'playing';
    const onlineResponding = !!(App.online && App.online.respond && App.online.respond.pending);
    $('btnEnd').disabled = !isMyTurn || App.busy || !!state.pendingBomb || App.awaitingTarget ||
      !!state.pendingAction || onlineResponding;
    $('btnHint').disabled = App.busy;

    // 打出跳过/攻击后本回合抽牌数为 0：结束动作不再抽牌，
    // 按钮与牌堆提示都必须改口，否则玩家会以为跳过没生效。
    const noDrawTurn = isMyTurn && state.pendingDraws === 0;
    const endLabel = $('btnEnd').querySelector('span');
    if (endLabel) endLabel.textContent = noDrawTurn ? '结束回合' : '结束回合 · 抽牌';
    $('btnEnd').title = noDrawTurn ? '本回合不抽牌，点击结束回合' : '结束回合并抽一张牌';

    // 牌堆的可点状态（金色呼吸光晕 / cursor / title），判定与点牌堆、空格完全一致
    View.setPileDrawable(canHumanDraw(), noDrawTurn ? '结束回合' : '点击抽牌');

    // 提示条
    if (state.phase === 'over') {
      const win = state.winner === myId;
      View.setPrompt(win ? '<b>🎉 你赢了！</b>' : '<b>' + esc(state.players[state.winner].name) + '</b> 获胜', false);
    } else if (state.pendingBomb) {
      if (state.pendingBomb.player === myId) {
        View.setPrompt(placePrompt(), true);
      } else {
        View.setPrompt('<b>' + esc(state.players[state.pendingBomb.player].name) + '</b> 正在放置炸弹…', false);
      }
    } else if (App.awaitingTarget && App.selectedUid != null) {
      // 目标牌选中后，桌面端也要常驻一句「下一步点哪」，不能只靠一次飘字
      View.setPrompt('<b>选择一名对手</b> 作为目标', false);
    } else if (state.pendingAction) {
      const pa = state.pendingAction;
      const actor = state.players[pa.player];
      const cardName = (CARDS[pa.card.type] && CARDS[pa.card.type].name) || pa.card.name || '一张牌';
      const myWindow = App.online
        ? onlineResponding
        : !!(App.G && Engine.pendingResponder(App.G) === myId);
      if (myWindow) {
        View.setPrompt('<b>轮到你回应</b> · 是否否决「' + esc(cardName) + '」？', true);
      } else if (pa.nopes.length) {
        View.setPrompt('「' + esc(cardName) + '」已被否决 ' + pa.nopes.length + ' 次，等待回应…', false);
      } else {
        View.setPrompt('<b>' + esc(actor ? actor.name : '有人') + '</b> 的「' +
          esc(cardName) + '」等待回应…', false);
      }
    } else if (state.current === myId) {
      const n = state.pendingDraws;
      // 触摸端没有键盘，「按空格」的提示只留给鼠标
      const kb = (App.input === 'mouse' && (root.innerWidth || 0) > 620) ? '（或按空格）' : '';
      View.setPrompt(n === 0
        ? '轮到你 · 本回合不抽牌（点牌堆结束回合）'
        : n > 1
          ? '轮到你 · 被攻击，本回合要抽 <b>' + n + '</b> 张（点击牌堆）'
          : '轮到你 · 出牌后点击牌堆' + kb + '抽牌', false);
    } else {
      View.setPrompt('<b>' + esc(state.players[state.current].name) + '</b> 的回合…', false);
    }

    // 联机的「待放回炸弹」是服务器直接推快照过来的，本地不会经过
    // handlePlacementIfNeeded；这里兜底挂上牌堆的放置监听器（内部会先清理，重复调用安全）。
    // 否则 1280px 桌面（放置条只在触摸 / 窄屏出现）点牌堆毫无反应，玩家会卡住。
    if (state.pendingBomb && state.pendingBomb.player === myId) enableBombPlacement();

    // 触摸端：说明条 / 目标栏 / 放置条跟着状态走（桌面端两者都不显示）
    refreshNopeBar();
    refreshPlaceBar();
    renderInspect();
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
      scaleFrom: 1, scaleTo: target ? target.cw / 132 : 1,
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
          // 跳过没有抽牌事件，不补一句反馈的话，桌面上就像什么都没发生
          if (e.card && e.card.type === 'skip') {
            View.floater('跳过', 'var(--gold)', { sub: '本回合不抽牌' });
            await delay(160);
          }
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
          else View.floater('预测未来', 'var(--blue)');
          await delay(e.player === App.humanId ? 300 : 420);
          break;
        case 'shuffle':
          SFX.shuffle();
          View.shufflePile();
          View.floater('洗牌', 'var(--gold)', { sub: '牌堆已重洗' });
          await delay(680);
          break;
        case 'attack': {
          SFX.attack();
          const cs = curState();
          const victimName = (e.victim != null && cs && cs.players[e.victim]) ? cs.players[e.victim].name : null;
          View.floater('攻击', 'var(--red-2)', { sub: victimName ? '「' + victimName + '」要连抽 2 张' : undefined });
          if (e.victim != null) {
            View.pulsePlayer(e.victim, 'hit');
            View.impactAtPlayer(e.victim);      // 冲击环：攻击要有视觉落点，不能只有飘字
            if (e.victim === App.humanId) buzz([40, 60, 40]);
          }
          await delay(420);
          break;
        }
        case 'transfer': {
          SFX.transfer();
          View.pulsePlayer(e.from, 'hit');
          View.floater('转移', 'var(--gold-2)', { sub: '一张牌换了主人' });
          // 求饶/帮忙：牌从被点名的人手里真的飞向得牌者——不能只有飘字瞬间结算
          if (e.card && View.canFly()) {
            const toRect = e.to === App.humanId
              ? rectOf(document.querySelector('.hand'))
              : opponentRect(e.to);
            View.flyCard(opponentRect(e.from), toRect, {
              face: 'front', card: e.card,
              scaleFrom: .42, scaleTo: .52, rotateFrom: -6, rotateTo: 16,
              ms: 560, arcAt: .5, lift: -34, fadeTail: 80,
              easing: 'cubic-bezier(.3,.7,.2,1)'
            });
          }
          await delay(460);
          break;
        }
        case 'nope': {
          SFX.nope();
          const chain = e.chain || 1;
          // 奇数张否决让原牌失效，偶数张把它「翻」回生效——提示必须跟着奇偶走
          View.floater('否决', 'var(--red-2)', {
            sub: chain % 2 === 1 ? '这张牌不会生效' : '第 ' + chain + ' 张 · 效果恢复'
          });
          await delay(380);
          break;
        }
        case 'cancel': {
          SFX.nope();
          const def = CARDS[e.target];
          View.floater('否决生效', 'var(--red-2)', {
            sub: (def && def.name ? '「' + def.name + '」' : '上一张牌') + '没有生效'
          });
          await delay(440);
          break;
        }
        case 'defuse':
          SFX.defuse();
          View.floater('拆除成功', 'var(--green)', { sub: '危机解除' });
          View.defuseAtPlayer(e.player);
          if (e.player === App.humanId) buzz(30);
          await delay(460);
          break;
        case 'place-bomb':
          SFX.click();
          break;
        case 'explode': {
          SFX.explode();
          // 联机局没有本地 App.G（全新联机会话时它是 null），必须从当前状态源取名
          const cs = curState();
          const boomName = cs && cs.players[e.player] ? cs.players[e.player].name : '';
          View.floater('BOOM', 'var(--red-2)', { sub: boomName ? boomName + ' 炸出局' : undefined });
          if (e.player === App.humanId) buzz([60, 40, 90]);
          View.flash();
          View.shake();
          View.boomAtPlayer(e.player);        // 12 帧手绘爆炸精灵
          View.burstAtPlayer(e.player);       // 叠加粒子碎屑
          View.pulsePlayer(e.player, 'blasted');
          await delay(820);
          break;
        }
        case 'reshuffle':
          SFX.shuffle();
          View.shufflePile();
          View.floater('洗牌', 'var(--gold)', { sub: '弃牌堆重新洗入' });
          await delay(680);
          break;
        case 'gameover':
          await delay(240);
          break;
        case 'turn':
          SFX.turn();
          View.turnSpotlight(e.player);
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

  /* ---------------- 否决回应 ---------------- */

  /** 真人回应 Promise 的 resolve；同一时刻只会有一个窗口 */
  let nopeAnswer = null;
  let nopeTick = null;

  function hideNopeBar() {
    const bar = $('nopeBar');
    if (bar) bar.classList.remove('show');
    stopNopeTick();
  }

  function stopNopeTick() {
    if (nopeTick) { clearInterval(nopeTick); nopeTick = null; }
    const timer = $('nopeTimer');
    if (timer) timer.textContent = '';
  }

  /** 联机窗口有时限；把剩余秒数写在回应条里，别让条自己突然消失 */
  function refreshNopeTimer() {
    const timer = $('nopeTimer');
    if (!timer) return;
    const r = App.online && App.online.respond;
    if (!r || !r.pending || !r.deadline) { timer.textContent = ''; return; }
    const left = Math.max(0, Math.ceil((r.deadline - Date.now()) / 1000));
    timer.textContent = left > 0 ? left + ' 秒' : '自动放过';
  }

  /** 回应条显示条件：桌面与手机共用；单机按引擎的候选窗口，联机按服务器的邀请 */
  function refreshNopeBar() {
    const bar = $('nopeBar');
    if (!bar) return;
    const state = curState();
    const pa = state && state.pendingAction;
    let show = false;
    if (pa) {
      if (App.online) show = !!(App.online.respond && App.online.respond.pending) && !App.busy;
      else show = !!(App.G && Engine.pendingResponder(App.G) === App.humanId);
    }
    bar.classList.toggle('show', show);

    if (!show) { stopNopeTick(); return; }

    const actor = state.players[pa.player];
    const def = CARDS[pa.card.type] || {};
    const cardName = def.name || pa.card.name || '一张牌';
    const title = $('nopeTitle');
    if (title) title.textContent = (actor ? actor.name : '有人') + ' 打出了「' + cardName + '」';

    const sub = $('nopeSub');
    if (sub) {
      const n = pa.nopes.length;
      if (n === 0) {
        sub.textContent = '你可以用「否决」取消它';
      } else {
        const last = pa.nopes[n - 1];
        const who = state.players[last.player];
        sub.textContent = (who ? who.name : '有人') + ' 已否决' +
          (n % 2 === 1 ? '，这张牌不会生效' : '，效果恢复') + '。你可以再否决';
      }
    }

    if (App.online) {
      refreshNopeTimer();
      if (!nopeTick) nopeTick = setInterval(refreshNopeTimer, 500);
    } else {
      stopNopeTick();
    }
  }

  /** 等真人点「否决 / 放过」；true = 打出否决 */
  function askHumanNope() {
    return new Promise(resolve => {
      nopeAnswer = resolve;
      refreshNopeBar();
    });
  }

  function answerHumanNope(useNope) {
    const fn = nopeAnswer;
    nopeAnswer = null;
    hideNopeBar();
    if (fn) fn(!!useNope);
  }

  /** 重开 / 退出 / 对局作废时收掉回应条，别把旧 Promise 永远挂在空中 */
  function cancelNopePrompt() {
    const fn = nopeAnswer;
    nopeAnswer = null;
    hideNopeBar();
    if (fn) fn(false);
  }

  function humanNopeUid() {
    const G = App.G;
    if (!G) return null;
    const me = G.players[App.humanId];
    if (!me || !me.hand) return null;
    const card = me.hand.find(c => c.type === 'nope');
    return card ? card.uid : null;
  }

  /**
   * 单机的否决窗口驱动：按引擎给的候选顺序逐个询问（真人弹条，AI 自己决策），
   * 直到窗口关闭。返回效果结算后携带的 needsPlacement / exploded。
   */
  async function resolvePendingResponses() {
    const epoch = gameEpoch;
    const flags = {};
    let guard = 0;

    while (App.G && App.G.pendingAction && guard++ < 100) {
      if (epoch !== gameEpoch) return flags;
      const G = App.G;
      const pid = Engine.pendingResponder(G);
      if (pid == null) break;

      let r = null;
      if (pid === App.humanId) {
        // 先把 Promise 挂好再 render：回应条可见的那一帧按钮就该是有效的
        const waiting = askHumanNope();
        render();
        const use = await waiting;
        if (epoch !== gameEpoch) return flags;
        if (use) {
          const uid = humanNopeUid();
          if (uid != null) {
            r = Engine.respondNope(G, pid, uid);
            if (r.ok) App.stats.played++;
          }
        }
        if (!r || !r.ok) r = Engine.passResponse(G, pid);
      } else {
        render();
        const p = G.players[pid];
        View.setPrompt('<b>' + esc(p ? p.name : '对手') + '</b> 正在考虑要不要否决…', false);
        await delay(420);
        if (epoch !== gameEpoch) return flags;
        const uid = AI.chooseNope(G, pid, App.difficulty);
        if (uid != null) r = Engine.respondNope(G, pid, uid);
        if (!r || !r.ok) r = Engine.passResponse(G, pid);
      }

      if (!r || !r.ok) break;      // 理论上不会发生；真发生也不能把流程卡死
      if (r.needsPlacement) flags.needsPlacement = true;
      if (r.exploded) flags.exploded = true;
      await playEvents(r.events || []);
      if (epoch !== gameEpoch) return flags;
      render();
    }

    return flags;
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
      View.floater('出错了：' + err.message, 'var(--red-2)', { info: true });
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

    // 打出的牌进入否决窗口：所有人的回应处理完，效果才真正结算。
    // 单机由这里驱动；联机的窗口在服务器，等 update 快照即可。
    let extra = {};
    if (!App.online && App.G && App.G.pendingAction) {
      extra = await resolvePendingResponses();
    }

    App.busy = false;
    render();
    return Object.assign({}, result, extra);
  }

  /** 真人的一次出牌（联机：把动作发给服务器；单机：本地引擎结算） */
  async function humanPlayCard(uid) {
    if (App.online) {
      const moves = App.online.moves || { playable: [], needTarget: [] };
      const me = App.online.state && App.online.state.players[App.humanId];
      const card = me && me.hand ? me.hand.find(c => c.uid === uid) : null;
      const need = moves.needTarget.find(m => m.cardUid === uid || (card && m.type === card.type));
      if (need) {
        // 需要目标：先选中，等待点击对手（交互与单机一致，只是结算在服务器）
        App.selectedUid = uid;
        App.awaitingTarget = true;
        render();
        View.floater('选择一名对手', 'var(--gold)', { info: true });
        return;
      }
      App.selectedUid = null;
      App.awaitingTarget = false;
      App.busy = true;
      netSend({ t: 'act', act: 'play', uid: uid });
      return;
    }

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
      const hit = lm.needTarget.find(m => m.type === card.type);
      View.floater('选择一名对手', 'var(--gold)', { info: true });
      if (!hit || !hit.targets.length) {
        App.awaitingTarget = false;
        App.selectedUid = null;
        render();
      }
      return;
    }

    // 无需目标：直接结算
    const r = await runAction(() => Engine.playCard(G, App.humanId, uid));
    if (!r || !r.ok) return;
    if (r.needsPlacement) { await handlePlacementIfNeeded(); return; }
    await checkGameOver();
    // 「摸两张」可能把自己炸出局：若对局继续且回合已交给下家，AI 必须接上
    if (App.G && App.G.phase === 'playing' && App.G.current !== App.humanId) scheduleAIIfNeeded();
  }

  /** 点选对手作为目标 */
  async function humanPickTarget(targetId) {
    if (!App.awaitingTarget || App.selectedUid == null) return;
    const uid = App.selectedUid;
    App.awaitingTarget = false;
    if (App.online) {
      App.selectedUid = null;
      App.busy = true;
      netSend({ t: 'act', act: 'play', uid: uid, target: targetId });
      return;
    }
    const r = await runAction(() => Engine.playCard(App.G, App.humanId, uid, targetId));
    if (!r || !r.ok) return;
    if (r.needsPlacement) { await handlePlacementIfNeeded(); return; }
    await checkGameOver();
    if (App.G && App.G.phase === 'playing' && App.G.current !== App.humanId) scheduleAIIfNeeded();
  }

  /** 真人结束回合（抽牌） */
  async function humanEndTurn() {
    // 键盘快捷键也会走到这里：瞄准目标、动画中、非本人回合都不该结束回合。
    // 单机路径原先漏了这道闸，空格/回车能把正在瞄准的回合直接推走。
    if (!canHumanDraw()) return;
    if (App.online) {
      // 点击的一瞬先收掉牌堆的「可抽」光晕（与单机同理：下一次 render 要等动画播完）
      View.setPileDrawable(false);
      App.busy = true;
      netSend({ t: 'act', act: 'end' });
      return;
    }
    const G = App.G;
    // 点击的一瞬先收掉牌堆的「可抽」光晕：光晕由 render() 管理，
    // 而下一次 render 要等抽牌动画播完才跑，不收的话点击后它还会再闪一秒
    View.setPileDrawable(false);
    const r = await runAction(() => Engine.endTurn(G, App.humanId));
    if (!r.ok) return;
    if (r.needsPlacement) { await handlePlacementIfNeeded(); return; }
    await checkGameOver();
    if (!App.busy) scheduleAIIfNeeded();
  }

  /* ---------------- 炸弹放回 ---------------- */

  const PLACE_PROMPT = '<b>💣 炸弹放回哪里？</b>点击牌堆任意高度决定位置';
  // 触摸 / 窄屏：点牌堆只移动预览、不提交，文案必须改成「点放回这里」
  const PLACE_PROMPT_TOUCH = '<b>💣 炸弹放回哪里？</b>选好位置后点「放回这里」';

  /** 当前该用哪套放置提示（鼠标桌面保持原文案逐字不变） */
  function placePrompt() {
    return (App.input === 'touch' || (root.innerWidth || 0) <= 620) ? PLACE_PROMPT_TOUCH : PLACE_PROMPT;
  }

  /** 当前挂着的放炸弹监听器清理函数（防重入 + 所有退出路径共用） */
  let bombPlaceCleanup = null;

  /** 收掉放炸弹监听器与预览（点击完成 / 对局结束 / 重开 / 状态被外部推进） */
  function clearBombPlacement() {
    // 放置条与选中档位跟着一起收（任何退出路径都不残留）
    hidePlaceBar();
    if (!bombPlaceCleanup) return;
    const fn = bombPlaceCleanup;
    bombPlaceCleanup = null;
    fn();
  }

  /** 当前牌堆张数（联机读快照，单机读本地引擎） */
  function curDeckSize() {
    if (App.online) return App.online.state ? App.online.state.deckSize : 0;
    return App.G && App.G.deck ? App.G.deck.length : 0;
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
    const deckSize = curDeckSize();
    const ratio = ratioFromEvent(ev);
    return Math.max(0, Math.min(deckSize, Math.round(ratio * Math.min(deckSize, 12))));
  }

  /** 若当前有待放回的炸弹且属于真人，等玩家点击牌堆；否则由 AI 处理 */
  async function handlePlacementIfNeeded() {
    const G = App.G;
    if (!G.pendingBomb) return;

    if (G.pendingBomb.player === App.humanId) {
      View.setPrompt(placePrompt(), true);
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
      if (!curState() || !curState().pendingBomb) return;
      const ratio = ratioFromEvent(ev);
      const pos = posFromEvent(ev);
      const deckSize = curDeckSize();
      View.showPlaceMarker(ratio, pos, deckSize);
      View.setPrompt(placePrompt() + '（当前：' + View.placeMarkerText(pos, deckSize) + '）', true);
    };

    const onLeave = () => {
      View.hidePlaceMarker();
      View.setPrompt(placePrompt(), true);
    };

    const onClick = async (ev) => {
      const pos = posFromEvent(ev);
      if (App.input === 'touch') {
        // 触摸：点牌堆只把预览移到点击高度对应的档位，不提交（提交走放置条的确认按钮）
        if (!curState()) return;
        placePos = pos;
        const deck = curDeckSize();
        const ratio = Math.max(0, Math.min(1, placePos / Math.max(1, Math.min(deck, 12))));
        View.showPlaceMarker(ratio, placePos, deck);
        refreshPlaceBar();
        return;
      }
      await commitPlacement(pos);
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
      hidePlaceBar();
      if (bombPlaceCleanup === cleanup) bombPlaceCleanup = null;
      // 不在这里恢复 .can-draw：交给下一次 render() 按真实状态重新算
    };

    // 同步挂载：120ms 延迟会让玩家看到红框后的第一击被吞掉（探针已证实）
    stack.addEventListener('click', onClick);
    stack.addEventListener('pointermove', onMove);
    stack.addEventListener('pointerdown', onMove);   // 触摸没有 hover，按下就先显示
    stack.addEventListener('pointerleave', onLeave);
    bombPlaceCleanup = cleanup;
    refreshPlaceBar();                               // 放置条按当前状态立即出现（触摸 / 窄屏）
  }

  /** 炸弹放回之后的收尾：判断是否需要恢复暂停的回合 */
  async function afterPlacement() {
    const epoch = gameEpoch;
    const G = App.G;
    render();
    if (G.turnEndPending) {
      const owner = App.G.current;
      const r = Engine.resumeAfterPlacement(G, owner);
      if (r.ok) await playEvents(r.events);
      if (epoch !== gameEpoch) return;   // 期间重开/换局：旧流程到此为止
    }
    render();
    await checkGameOver();
    if (epoch !== gameEpoch) return;
    scheduleAIIfNeeded();
  }

  /* ---------------- 触摸说明条 #inspect / 炸弹放回位置条 #placeBar ---------------- */

  /** 弃牌堆顶的只读说明（触摸点弃牌堆时用；关闭 / 选中手牌时清掉） */
  let discardInspect = null;
  /** 说明条当前展示的数据（主按钮点击时复用） */
  let inspectInfo = null;
  /** 放置条当前选中的插入位置（null = 未选） */
  let placePos = null;

  /** 说明条要展示的牌信息：选中的手牌优先，其次弃牌堆顶 */
  function inspectCardInfo() {
    if (App.online) {
      const s = App.online.state;
      if (!s) return null;
      if (App.selectedUid != null) {
        const me = s.players[App.humanId];
        const card = me && me.hand ? me.hand.find(c => c.uid === App.selectedUid) : null;
        if (!card) return null;
        const moves = App.online.moves || { playable: [], needTarget: [] };
        const need = moves.needTarget.find(m => m.type === card.type);
        return {
          card,
          canPlay: moves.playable.some(m => m.type === card.type),
          needTarget: !!need,
          targets: need ? need.targets : null,
          readonly: false
        };
      }
      if (discardInspect) return { card: discardInspect, canPlay: false, needTarget: false, targets: null, readonly: true };
      return null;
    }

    const G = App.G;
    if (!G) return null;
    if (App.selectedUid != null) {
      const state = Engine.getState(G);
      const me = state.players[App.humanId];
      const card = me && me.hand ? me.hand.find(c => c.uid === App.selectedUid) : null;
      if (!card) return null;
      const lm = Engine.legalMoves(G, App.humanId);
      const canPlay = lm.playable.some(m => m.type === card.type);
      const need = lm.needTarget.find(m => m.type === card.type);
      return { card, canPlay, needTarget: !!need, targets: need ? need.targets : null, readonly: false };
    }
    if (discardInspect) return { card: discardInspect, canPlay: false, needTarget: false, targets: null, readonly: true };
    return null;
  }

  function removeTargetButtons(el) {
    Array.from(el.children || []).forEach(c => {
      if (!c.classList) return;
      // i-cancel 也要收：renderInspect 每次 render 都会重跑，
      // 只清 i-target 的话「取消」按钮会一个个累积（截图验收里抓到的）
      if (c.classList.contains('i-target') || c.classList.contains('i-cancel')) el.removeChild(c);
    });
  }

  /** 目标栏：取消 + 每个可选对手一个按钮（点击直接结算） */
  function renderTargetButtons(el, targets, state) {
    removeTargetButtons(el);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'i-cancel';
    cancel.textContent = '取消';
    cancel.addEventListener('click', ev => {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      closeInspect();
    });
    el.appendChild(cancel);
    (targets || []).forEach(pid => {
      const p = state.players[pid];
      if (!p) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'i-target';
      b.dataset.pid = String(pid);
      const img = document.createElement('img');
      img.className = 't-cat';
      img.alt = '';
      img.src = View.catArt(pid, p.alive);
      const col = document.createElement('span');
      col.className = 't-col';
      const nm = document.createElement('span');
      nm.className = 't-name';
      // 头像已经表明这是 AI，按钮里去掉重复的「AI 」前缀，窄屏才放得下名字
      nm.textContent = p.name.replace(/^AI\s+/i, '');
      b.title = p.name;
      b.setAttribute('aria-label', '选择 ' + p.name);
      const cnt = document.createElement('span');
      cnt.className = 't-count';
      cnt.textContent = p.handSize + ' 张';
      col.appendChild(nm);
      col.appendChild(cnt);
      b.appendChild(img);
      b.appendChild(col);
      b.addEventListener('click', ev => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        humanPickTarget(pid);
      });
      el.appendChild(b);
    });
  }

  /** 说明条 / 目标栏：触摸端选中牌、弃牌堆顶或等待目标时显示；桌面恒不显示 */
  function renderInspect() {
    const el = $('inspect');
    if (!el) return;
    const live = App.online ? !!App.online.state : !!App.G;
    const stage = document.querySelector('.stage');
    const touch = App.input === 'touch';
    let mode = null;
    inspectInfo = null;

    if (touch && live && App.selectedUid != null) {
      const info = inspectCardInfo();
      if (info) {
        inspectInfo = info;
        mode = (App.awaitingTarget && info.needTarget) ? 'target' : 'card';
      }
    } else if (touch && live && discardInspect) {
      inspectInfo = inspectCardInfo();
      mode = inspectInfo ? 'card' : null;
    }

    const show = !!mode;
    el.classList.toggle('show', show);
    el.classList.toggle('targeting', mode === 'target');
    if (stage) stage.classList.toggle('inspecting', show);

    // 触摸端没有 hover，选中之后「下一步点哪」全靠这一行字：
    // 说明条出现时把提示条挪到说明条上方（CSS 的 .stage.inspecting），这里写引导文案。
    // 只读说明（弃牌堆）不需要引导，保留 render() 写的回合提示。
    if (show) {
      if (mode === 'target') View.setPrompt('点选一个对手（或点下方按钮）', false);
      else if (!inspectInfo.readonly && inspectInfo.canPlay) View.setPrompt('再点一次这张牌，或点「出牌」', false);
    }

    if (!show) {
      removeTargetButtons(el);
      return;
    }

    if (mode === 'target') {
      renderTargetButtons(el, inspectInfo.targets, curState());
      return;
    }

    removeTargetButtons(el);
    const def = CARDS[inspectInfo.card.type] || {};
    const nameEl = el.querySelector('.i-name');
    const textEl = el.querySelector('.i-text');
    const goEl = el.querySelector('.i-go');
    if (nameEl) nameEl.textContent = def.name || inspectInfo.card.name || '';
    if (textEl) textEl.textContent = def.text || '';
    if (goEl) {
      const readonly = !!inspectInfo.readonly;
      const cs = curState();
      const myTurn = !!(cs && cs.current === App.humanId && cs.phase === 'playing');
      goEl.style.display = readonly ? 'none' : '';
      if (readonly) {
        goEl.disabled = true;
        goEl.textContent = '出牌';
      } else if (inspectInfo.needTarget) {
        goEl.disabled = false;
        goEl.textContent = '选目标';
      } else if (inspectInfo.canPlay) {
        goEl.disabled = false;
        goEl.textContent = '出牌';
      } else {
        goEl.disabled = true;
        goEl.textContent = myTurn ? '现在不能出' : '还没轮到你';
      }
    }
  }

  /** 关闭说明条：清掉选中与弃牌堆说明 */
  function closeInspect() {
    discardInspect = null;
    App.selectedUid = null;
    App.awaitingTarget = false;
    renderInspect();
    render();
  }

  /** 放置条的各部件（按 class 取，测试桩也能用） */
  function placeBarParts() {
    const bar = $('placeBar');
    if (!bar) return null;
    let title = null, ok = null;
    const slots = [];
    Array.from(bar.children || []).forEach(c => {
      if (!c.classList) return;
      if (c.classList.contains('pb-title')) title = c;
      else if (c.classList.contains('pb-ok')) ok = c;
      else if (c.classList.contains('pb-grid')) {
        Array.from(c.children || []).forEach(s => {
          if (s.classList && s.classList.contains('pb-slot')) slots.push(s);
        });
      }
    });
    slots.sort((a, b) => (parseInt(a.dataset.slot, 10) || 0) - (parseInt(b.dataset.slot, 10) || 0));
    return { bar, title, ok, slots };
  }

  /** 档位 → 插入位置：第 k 张 = k-1；最底部 = deck.length */
  function slotToPos(slot, deck) {
    return slot >= 6 ? deck : slot - 1;
  }

  /** 放置条显示条件：真人待放炸弹 + (触摸 或 窄屏) */
  function placeBarWanted() {
    const state = curState();
    if (!state || !state.pendingBomb || state.pendingBomb.player !== App.humanId) return false;
    return App.input === 'touch' || (root.innerWidth || 0) <= 620;
  }

  /** 隐藏放置条并清空选中档位（所有退出路径共用） */
  function hidePlaceBar() {
    placePos = null;
    const parts = placeBarParts();
    if (parts) parts.bar.classList.remove('show');
  }

  /** 刷新放置条：显示/隐藏、档位 disabled、标题、确认按钮文案 */
  function refreshPlaceBar() {
    const parts = placeBarParts();
    if (!parts) return;
    const on = placeBarWanted();
    parts.bar.classList.toggle('show', on);
    if (!on) { placePos = null; return; }
    const deck = curDeckSize();
    parts.slots.forEach(btn => {
      const slot = parseInt(btn.dataset.slot, 10);
      let enabled;
      if (deck === 0) enabled = slot === 1;
      else if (slot >= 6) enabled = true;
      else enabled = slot <= deck;
      btn.disabled = !enabled;
      btn.classList.toggle('on', placePos != null && slotToPos(slot, deck) === placePos);
    });
    if (parts.title) {
      let t = '炸弹放回哪里？';
      if (deck === 0) t += '牌堆已空，炸弹会放回原位';
      else if (placePos != null) t += '（当前：' + View.placeMarkerText(placePos, deck) + '）';
      parts.title.textContent = t;
    }
    if (parts.ok) {
      const sel = placePos != null;
      parts.ok.disabled = !sel;
      if (!sel) parts.ok.textContent = '请选择位置';
      else if (placePos === 0) parts.ok.textContent = '放回这里（第 1 张）';
      else if (placePos >= deck) parts.ok.textContent = '放回这里（最底部）';
      else parts.ok.textContent = '放回这里（第 ' + (placePos + 1) + ' 张）';
    }
  }

  /** 提交炸弹放置（鼠标点牌堆 / 放置条确认共用） */
  async function commitPlacement(pos) {
    clearBombPlacement();
    if (App.online) {
      App.busy = true;
      netSend({ t: 'act', act: 'place', pos: pos });
      return;
    }
    const r = Engine.placeBomb(App.G, App.humanId, pos);
    if (r.ok) {
      View.floater('炸弹已放回', 'var(--red-2)');
      await playEvents(r.events);
    }
    await afterPlacement();
  }

  /* ---------------- 手机端日志抽屉（桌面仍用右下角浮层面板） ---------------- */

  let logDrawerOpen = false;

  /** 打开日志抽屉：复用现有 .logpanel 的 DOM 与渲染（只是换个摆放方式） */
  function openLogDrawer() {
    const panel = $('logPanel');
    const mask = $('logMask');
    if (!panel || !mask) return;
    logDrawerOpen = true;
    panel.classList.remove('hidden');
    panel.classList.add('drawer', 'show');
    mask.classList.add('show');
    const btn = $('btnLogDrawer');
    if (btn) btn.classList.add('on');
  }

  /** 关闭日志抽屉：滑出动画结束后再摘掉 drawer 类（否则会瞬间跳回桌面浮层样式） */
  function closeLogDrawer() {
    const panel = $('logPanel');
    const mask = $('logMask');
    logDrawerOpen = false;
    if (mask) mask.classList.remove('show');
    const btn = $('btnLogDrawer');
    if (btn) btn.classList.remove('on');
    if (!panel) return;
    panel.classList.remove('show');
    setTimeout(() => {
      if (!logDrawerOpen) panel.classList.remove('drawer');
    }, 260);
  }

  /* ---------------- AI 驱动 ---------------- */

  let aiTimer = null;
  // 对局代次：重开 / 开新局时自增，用来作废旧对局还在 await 中的 AI 驱动。
  // 只清 setTimeout 拦不住已经跑到一半的 driveAI（它会在 await 之后继续出牌）。
  let gameEpoch = 0;

  /** 中止当前对局的 AI 计时器与在途驱动（打开重开面板 / 开新局时调用） */
  function stopGameLoop() {
    gameEpoch++;
    clearTimeout(aiTimer);
    aiTimer = null;
    cancelNopePrompt();
  }

  function scheduleAIIfNeeded() {
    if (App.online) return;              // 联机没有 AI，回合推进全在服务器
    const G = App.G;
    if (!G || G.phase !== 'playing') return;
    if (G.pendingBomb || G.pendingAction) return;
    const cur = G.players[G.current];
    if (!cur || !cur.isAI) return;
    clearTimeout(aiTimer);
    aiTimer = setTimeout(driveAI, 620);
  }

  async function driveAI() {
    const epoch = gameEpoch;
    const G = App.G;
    if (App.online) return;              // 联机没有 AI
    if (!G || G.phase !== 'playing' || App.busy) return;

    const pid = G.current;
    const p = G.players[pid];
    if (!p || !p.isAI) return;

    // 1) 待放回的炸弹（属于当前 AI；真人路径在 handlePlacementIfNeeded 里等点击）
    if (G.pendingBomb) {
      const owner = G.pendingBomb.player;
      if (owner === App.humanId) return;
      const pos = AI.chooseBombPosition(G, owner, App.difficulty);
      const r = Engine.placeBomb(G, owner, pos);
      if (r.ok) await playEvents(r.events);
      await afterPlacement();
      return;
    }

    App.busy = true;
    View.setPrompt('<b>' + esc(p.name) + '</b> 思考中…', false);

    try {
      // 2) 出牌决策（最多连续出 2 张，保持节奏）
      let played = 0;
      const maxPlay = App.difficulty === 'hard' ? 2 : 1;

      while (played < maxPlay && G.phase === 'playing' && G.current === pid &&
             !G.pendingBomb && !G.pendingAction) {
        await delay(340);
        if (epoch !== gameEpoch) return;
        const pick = AI.chooseCard(G, pid, App.difficulty);
        if (!pick) break;

        const target = pick.needsTarget ? AI.chooseTarget(G, pid, pick, App.difficulty) : undefined;
        const r = Engine.playCard(G, pid, pick.card.uid, target);
        if (!r.ok) break;

        await playEvents(r.events || []);
        if (epoch !== gameEpoch) return;
        played++;

        // 打出的牌进入否决窗口：按席位询问，窗口关掉才真正结算效果
        let extra = {};
        if (G.pendingAction) {
          extra = await resolvePendingResponses();
          if (epoch !== gameEpoch) return;
        }
        render();

        if ((extra && extra.needsPlacement) || G.pendingBomb) {
          App.busy = false;
          await handlePlacementIfNeeded();
          return;
        }
        if (G.phase === 'over') break;
        // 摸两张把自己炸出局、或效果把回合交了出去：别再按旧回合继续
        if (G.current !== pid) break;
      }

      if (G.phase === 'over') { App.busy = false; render(); await checkGameOver(); return; }

      // 出牌效果改变了回合（例如自己出局）：直接交给下一位，不能再用旧 pid 结束回合
      if (G.current !== pid) {
        App.busy = false;
        render();
        await checkGameOver();
        if (epoch !== gameEpoch) return;
        scheduleAIIfNeeded();
        return;
      }

      // 3) 结束回合（抽牌）
      await delay(300);
      if (epoch !== gameEpoch) return;
      const r = Engine.endTurn(G, pid);
      if (!r.ok) {
        App.busy = false;
        render();
        return;
      }
      await playEvents(r.events || []);
      if (epoch !== gameEpoch) return;
      App.busy = false;
      render();

      if (r.needsPlacement) { await handlePlacementIfNeeded(); return; }
      await checkGameOver();
      if (epoch !== gameEpoch) return;
      scheduleAIIfNeeded();
    } catch (err) {
      console.error('[AI]', err);
      if (epoch !== gameEpoch) return;
      App.busy = false;
      render();
    }
  }

  /* ---------------- 结算 ---------------- */

  let overShown = false;

  /** 结算面板（单机 / 联机共用）：胜负音效、插画、统计、弹层 */
  function showResultPanel(win, winnerName, turns) {
    if (win) {
      SFX.win(); buzz([40, 60, 40, 60, 100]);
      // 三连金屑：中央先炸，两翼随后补上（单发粒子偏单薄）
      const GOLD = ['#f3d79a', '#d9b061', '#fff0d0', '#ffd39b'];
      View.burst(window.innerWidth / 2, window.innerHeight / 2 - 60, 60, GOLD);
      setTimeout(() => View.burst(window.innerWidth * 0.24, window.innerHeight * 0.32, 34, GOLD), 200);
      setTimeout(() => View.burst(window.innerWidth * 0.76, window.innerHeight * 0.32, 34, GOLD), 380);
    } else { SFX.lose(); buzz(120); }

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
    $('statTurns').textContent = turns;
    $('statPlayed').textContent = App.stats.played;
    $('statTime').textContent = elapsed + 's';

    View.showModal('modalResult');
  }

  async function checkGameOver() {
    const G = App.G;
    if (!G || G.phase !== 'over' || overShown) return;
    overShown = true;

    await delay(500);
    const win = G.winner === App.humanId;
    const winnerName = G.players[G.winner] ? G.players[G.winner].name : '？';
    showResultPanel(win, winnerName, G.turn);
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

    stopGameLoop();             // 旧对局的 AI 计时器 / 在途驱动全部作废
    App.humanId = 0;
    App.selectedUid = null;
    App.selectedAt = 0;
    App.newUid = null;
    App.incomingUid = null;
    App.lastDrawn = null;
    App.awaitingTarget = false;
    App.busy = false;
    App.stats = { turns: 0, drawn: 0, played: 0, startAt: Date.now() };
    overShown = false;
    discardInspect = null;      // 弃牌堆说明是只读的临时状态，换局清掉
    hidePlaceBar();             // 放置条（clearBombPlacement 里也会收一次，这里兜底）
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
    /* 输入类型：只认 pointerdown 记下的 pointerType（iOS Safari 的 click 事件不一定带 pointerType）。
       捕获阶段：在按钮/牌堆/手牌自己的 pointerdown 之前先把 App.input 定下来。
       所有触摸新行为都挂在 App.input === 'touch' 上；鼠标路径与改动前逐行等价。 */
    document.addEventListener('pointerdown', ev => {
      const isTouch = ev.pointerType !== 'mouse';   // 触控笔也算 touch
      App.input = isTouch ? 'touch' : 'mouse';
      const appEl = document.querySelector('.app');
      if (appEl) appEl.classList.toggle('touch-input', isTouch);
      // 音频必须在手势调用栈里解锁（见 audio.js 的 unlock 注释）；
      // 重复调用是廉价的（ctx 已 running 时只是一次状态读取）
      SFX.unlockAudio();
    }, true);

    // 手牌点击：出牌 或 选中需要目标的牌
    $('hand').addEventListener('click', ev => {
      // 触摸时出牌只走 pointerup 路径，这里压掉松手后的那次 click
      if (App.input === 'touch') return;
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
      const state = curState();
      if (!state || state.phase !== 'playing') return;
      if (state.current !== App.humanId) return;
      const uid = parseInt(cardEl.dataset.uid, 10);

      if (!cardEl.classList.contains('playable')) {
        View.floater('这张牌现在不能出', 'var(--faint)', { info: true });
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

    /* ---------- 触摸：按住滑动挑牌 → 松手选中 → 再点一次出牌 ----------
       只在 App.input === 'touch' 时生效；鼠标路径完全不进这里（与改动前逐行等价）。 */
    let touchStart = null;   // 本次按下的候选牌（pointercancel 时清掉）
    $('hand').addEventListener('pointerdown', ev => {
      if (App.input !== 'touch') return;
      const cardEl = View.handCardAt(ev.clientX, ev.clientY);
      if (!cardEl) return;
      touchStart = { uid: parseInt(cardEl.dataset.uid, 10) };
      setHoveredCard(cardEl);                 // 按下就先抬起被盖住的那张
      const handEl = $('hand');
      if (typeof handEl.setPointerCapture === 'function' && ev.pointerId != null) {
        try { handEl.setPointerCapture(ev.pointerId); } catch (e) { /* 不支持就算了 */ }
      }
    });

    $('hand').addEventListener('pointerup', ev => {
      if (App.input !== 'touch') return;
      if (!touchStart) return;
      touchStart = null;

      const rect = $('hand').getBoundingClientRect();
      const inZone = ev.clientX >= rect.left && ev.clientX <= rect.right &&
                     ev.clientY >= rect.top - 60 && ev.clientY <= rect.bottom;
      if (!inZone) {                          // 滑走即取消
        setHoveredCard(null);
        return;
      }
      const cardEl = View.handCardAt(ev.clientX, ev.clientY);
      if (!cardEl) return;
      const uid = parseInt(cardEl.dataset.uid, 10);

      const state = curState();
      if (!state || state.phase !== 'playing' || state.current !== App.humanId || App.busy) return;

      if (App.selectedUid === uid) {
        // 再点一次 = 确认出牌；距上次选中不足 200ms 的连点不算（防误触双击）。
        // 曾经是 300ms：自然的两连击常落在 200~300ms 区间，第二击被吞掉，
        // 手感就是「点了没反应」，所以压到 200ms。
        if (Date.now() - App.selectedAt < 200) return;
        if (cardEl.classList.contains('playable')) humanPlayCard(uid);
        return;
      }
      // 换选另一张：只选中，不出牌
      App.selectedUid = uid;
      App.selectedAt = Date.now();
      // 需要目标的牌：选中即进入选目标（对手区高亮 + 说明条切目标栏），
      // 省掉「先选中 → 再点『选目标』」的中间一步；取消走目标栏的「取消」按钮
      let needTarget;
      if (App.online) {
        needTarget = (App.online.moves.needTarget || []).some(m => m.cardUid === uid) &&
                     cardEl.classList.contains('playable');
      } else {
        const picked = state.players[App.humanId].hand.find(c => c.uid === uid);
        needTarget = !!(picked &&
          CARDS[picked.type].need === 'player' &&
          cardEl.classList.contains('playable'));
      }
      App.awaitingTarget = needTarget;
      render();
    });

    $('hand').addEventListener('pointercancel', () => {
      if (App.input !== 'touch') return;
      touchStart = null;
      setHoveredCard(null);
    });

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

    // 否决回应条：单机走本地窗口，联机把回应发给服务器
    $('btnNope').addEventListener('click', () => {
      if (App.online) { netAnswerNope(true); return; }
      if (!nopeAnswer) return;
      answerHumanNope(true);
    });
    $('btnNopePass').addEventListener('click', () => {
      if (App.online) { netAnswerNope(false); return; }
      if (!nopeAnswer) return;
      answerHumanNope(false);
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
      if (App.online) {
        // 联机看不到牌堆内容（隐藏信息在服务器），只报可出牌数
        const moves = App.online.moves || { playable: [], needTarget: [] };
        const n = moves.playable.length + moves.needTarget.length;
        View.floater('可出 ' + n + ' 张牌', 'var(--gold)', { info: true });
        return;
      }
      const G = App.G;
      if (!G) return;
      if (G.current !== App.humanId) { View.floater('还没轮到你', 'var(--faint)', { info: true }); return; }
      const risk = AI.bombRisk(G, App.humanId);
      const lm = Engine.legalMoves(G, App.humanId);
      const n = lm.playable.length + lm.needTarget.length;
      View.floater(
        '抽到炸弹概率约 ' + Math.round(risk * 100) + '% · 可出 ' + n + ' 张牌',
        risk > 0.35 ? 'var(--red-2)' : 'var(--gold)',
        { info: true }
      );
    });

    // 重开：打开设置面板即视为放弃当前对局，先停掉后台 AI，别让它在面板后面继续打
    $('btnRestart').addEventListener('click', () => {
      stopGameLoop();
      if (App.online) { leaveOnline(); applySetupMode('local'); }
      View.hideModal('modalResult');
      View.showModal('modalSetup');
    });
    $('btnAgain').addEventListener('click', () => {
      stopGameLoop();
      if (App.online) { leaveOnline(); applySetupMode('local'); }
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

    // 对局模式：单机 / 联机
    $('setupMode').addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      const mode = b.dataset.v;
      if (mode === 'local' && App.online) leaveOnline();   // 从联机切回单机 = 退出房间
      applySetupMode(mode);
    });

    // 联机：创建房间 / 加入房间
    $('btnCreateRoom').addEventListener('click', () => {
      const name = ($('netName').value || '').trim().slice(0, 10) || '玩家';
      netEnsure(() => netSend({ t: 'create', name: name }));
    });
    $('btnJoinRoom').addEventListener('click', () => {
      const code = ($('netCode').value || '').trim().toUpperCase();
      if (code.length !== 4) { View.floater('先输入 4 位房间码', 'var(--red-2)', { info: true }); return; }
      const name = ($('netName').value || '').trim().slice(0, 10) || '玩家';
      netEnsure(() => netSend({ t: 'join', code: code, name: name }));
    });
    $('netCode').addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); $('btnJoinRoom').click(); }
    });

    // 开始（单机直接开；联机 = 房主发 start，其余人按钮本来就是禁用的）
    $('btnStart').addEventListener('click', () => {
      if (App.mode === 'online') {
        if (App.online && App.online.host) netSend({ t: 'start' });
        return;
      }
      startGame();
    });

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
      if (logDrawerOpen) { closeLogDrawer(); return; }
      View.el.logPanel.classList.add('hidden');
      $('btnLogDrawer').classList.remove('on');
    });
    $('btnLogToggle').addEventListener('click', () => {
      View.el.logPanel.classList.remove('hidden');
      $('btnLogToggle').style.display = 'none';
      $('btnLogDrawer').classList.add('on');
    });

    // 顶栏日志按钮：窄屏打开抽屉，桌面直接切换右下角浮层面板
    $('btnLogDrawer').addEventListener('click', () => {
      const narrow = root.matchMedia && root.matchMedia('(max-width: 620px)').matches;
      if (narrow) {
        if (logDrawerOpen) closeLogDrawer();
        else openLogDrawer();
        return;
      }
      const panel = View.el.logPanel;
      const nowHidden = panel.classList.toggle('hidden');
      $('btnLogDrawer').classList.toggle('on', !nowHidden);
    });
    $('logMask').addEventListener('click', () => {
      if (logDrawerOpen) closeLogDrawer();
    });

    /* ---------- 说明条（触摸端） ---------- */
    const inspect = $('inspect');
    if (inspect) {
      const goBtn = inspect.querySelector('.i-go');
      if (goBtn) {
        goBtn.addEventListener('click', ev => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          if (App.input !== 'touch') return;
          const info = inspectInfo;
          if (!info || info.readonly || App.awaitingTarget) return;
          if (info.needTarget) {
            App.awaitingTarget = true;
            render();
            return;
          }
          if (info.canPlay) humanPlayCard(info.card.uid);
        });
      }
      const closeBtn = inspect.querySelector('.i-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', ev => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          closeInspect();
        });
      }
    }

    // 点说明条外面：关闭并吃掉这一次点击（避免顺手点到牌堆抽了牌）
    document.addEventListener('click', ev => {
      if (App.input !== 'touch') return;
      const el = $('inspect');
      if (!el || !el.classList.contains('show')) return;
      const t = ev.target;
      if (t && el.contains && el.contains(t)) return;
      if (t && t.closest && t.closest('#btnEnd')) return;
      closeInspect();
      if (ev.stopPropagation) ev.stopPropagation();
      if (ev.preventDefault) ev.preventDefault();
    }, true);

    // 弃牌堆：触摸时用同一说明条只读展示堆顶那张牌
    const discardTop = $('discardTop');
    if (discardTop) {
      discardTop.addEventListener('click', () => {
        if (App.input !== 'touch') return;
        const state = curState();
        if (!state) return;
        if (!state.discardTop) return;
        discardInspect = state.discardTop;
        App.selectedUid = null;
        App.awaitingTarget = false;
        renderInspect();
      });
    }

    /* ---------- 炸弹放回位置条（触摸 / 窄屏） ---------- */
    const placeParts = placeBarParts();
    if (placeParts) {
      placeParts.slots.forEach(btn => {
        btn.addEventListener('click', () => {
          // 联机局没有本地 App.G，状态与牌堆张数都必须走 curState / curDeckSize，
          // 否则手机端在「炸弹放回哪里」阶段点任何档位都没有反应（软锁）。
          const st = curState();
          if (!st || !st.pendingBomb || st.pendingBomb.player !== App.humanId) return;
          if (btn.disabled) return;
          const slot = parseInt(btn.dataset.slot, 10);
          const deck = curDeckSize();
          placePos = slotToPos(slot, deck);
          const ratio = slot >= 6
            ? 1
            : Math.max(0, Math.min(1, placePos / Math.max(1, Math.min(deck, 12))));
          View.showPlaceMarker(ratio, placePos, deck);
          refreshPlaceBar();
        });
      });
      if (placeParts.ok) {
        placeParts.ok.addEventListener('click', () => {
          const st = curState();
          if (!st || !st.pendingBomb || st.pendingBomb.player !== App.humanId) return;
          if (placePos == null) return;
          commitPlacement(placePos);
        });
      }
    }

    // 键盘快捷键
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        if (logDrawerOpen) closeLogDrawer();
        discardInspect = null;
        App.selectedUid = null;
        App.awaitingTarget = false;
        render();
      }
      if (ev.key === ' ' || ev.key === 'Enter') {
        if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        // 焦点在按钮/输入控件上时交给控件自身的键盘行为：
        // 否则回车点「提示」的同时也会把回合结束掉，结束按钮还会被触发两次
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
        const btn = $('btnEnd');
        if (!btn.disabled) {
          ev.preventDefault();
          humanEndTurn();
        }
      }
    });
  }

  /* ---------------- 联机 ---------------- */

  const NET_STORE_KEY = 'bombcats.net';
  let netQueue = [];          // 排队待播的服务器 update（别人的动作可能在我动画期间到达）
  let netDraining = false;

  function netSend(msg) {
    return !!(App.online && App.online.conn && App.online.conn.send(msg));
  }

  /** 联机回应否决窗口：只发「否决 / 放过」，具体用哪张牌由服务器校验 */
  function netAnswerNope(useNope) {
    const r = App.online && App.online.respond;
    if (!r || !r.pending) return;
    App.online.respond = null;
    hideNopeBar();
    App.busy = true;
    if (!netSend({ t: 'respond', nope: !!useNope })) {
      App.busy = false;
      View.floater('连接已断开，正在重连…', 'var(--red-2)', { info: true });
    }
  }

  function netSaveSession() {
    try {
      sessionStorage.setItem(NET_STORE_KEY, JSON.stringify({
        code: App.online.code, seat: App.online.seat, token: App.online.token, name: App.online.name
      }));
    } catch (e) { /* 隐私模式存不了就算了 */ }
  }

  function netClearSession() {
    try { sessionStorage.removeItem(NET_STORE_KEY); } catch (e) { /* 忽略 */ }
  }

  /** 建立连接（已连上就复用），连接就绪后执行 action（发 create / join） */
  function netEnsure(action) {
    if (App.online) {
      const ready = App.online.conn && App.online.conn.ws && App.online.conn.ws.readyState === 1;
      if (ready) action();
      else App.online.pendingOpen.push(action);
      return;
    }
    const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    App.online = {
      conn: new root.BombCats.NetConnection(wsUrl, {
        onOpen: netOnOpen,
        onMsg: onNetMsg,
        onClose: (willRetry) => {
          // 对局中掉线才提示；等待室掉线静默重连
          if (willRetry && App.online && App.online.state) {
            View.floater('连接断开，正在重连…', 'var(--red-2)', { info: true });
          }
        },
        onDown: (reason) => netFail(reason || '连接已断开')
      }),
      code: null, seat: null, token: null, name: '',
      state: null, moves: null, host: false,
      respond: null,          // 服务器打开的否决回应窗口 { pending, deadline, seq }
      msgSeq: 0,              // 本次连接的收包序号，用来判断回应窗口是否已被新快照作废
      pendingOpen: [action]
    };
  }

  /** 连接建立：先执行排队动作（创建/加入）；没有排队动作且持有座位凭据 → 重连 */
  function netOnOpen() {
    if (!App.online) return;
    if (App.online.pendingOpen.length) {
      const act = App.online.pendingOpen.shift();
      act();
    } else if (App.online.code != null) {
      netSend({ t: 'rejoin', code: App.online.code, seat: App.online.seat, token: App.online.token });
    }
  }

  function onNetMsg(msg) {
    if (!msg || !msg.t) return;
    const seq = App.online ? (App.online.msgSeq = (App.online.msgSeq || 0) + 1) : 0;
    switch (msg.t) {
      case 'created':
      case 'joined':
      case 'rejoined':
        if (!App.online) return;
        App.online.code = msg.code;
        App.online.seat = msg.seat;
        App.online.token = msg.token;
        App.humanId = msg.seat;
        netSaveSession();
        applySetupMode('online');
        break;
      case 'lobby':
        if (!App.online) return;
        App.online.host = (msg.host === App.online.seat);
        renderLobby(msg);
        break;
      case 'started':
        if (!App.online) return;
        enterOnlineGame(msg.state, msg.moves);
        break;
      case 'update':
        onNetUpdate(msg, seq);
        break;
      case 'respond':
        if (!App.online) return;
        App.online.respond = { pending: true, deadline: Number(msg.deadline) || 0, seq: seq };
        // 动画还在播时先记下，等 update 队列排空后的 render 再亮出回应条
        if (!App.busy) render();
        break;
      case 'err':
        if (msg.fatal) { netFail(msg.msg); return; }
        App.busy = false;
        View.floater(msg.msg || '操作无效', 'var(--red-2)', { info: true });
        render();
        break;
      case 'seat-gone': {
        const s = App.online && App.online.state;
        const p = s && s.players[msg.seat];
        View.floater((p ? p.name : '有人') + ' 断线了，等待重连…', 'var(--faint)', { info: true });
        break;
      }
      case 'seat-back': {
        const s2 = App.online && App.online.state;
        const p2 = s2 && s2.players[msg.seat];
        View.floater((p2 ? p2.name : '有人') + ' 回来了', 'var(--green)', { info: true });
        break;
      }
      case 'closed':
        netFail(msg.reason || '房间已解散');
        break;
      default:
        break;
    }
  }

  /**
   * 服务器 update：先换快照再播事件（与离线 runAction 同序）。
   * 动画期间别人的动作可能继续到达 → 排队串行播，保证事件顺序不被打乱。
   */
  function onNetUpdate(msg, seq) {
    if (!App.online) return;
    msg._seq = seq;
    netQueue.push(msg);
    if (netDraining) return;
    netDraining = true;
    drainNetQueue();
  }

  async function drainNetQueue() {
    while (netQueue.length && App.online) {
      const m = netQueue.shift();
      // 新快照意味着上一轮回应已经结束；旧的回应条不能跨回合残留。
      // 但服务器是先广播 update 再私发 respond，update 可能在动画期间排队：
      // 等它出队时，更新的 respond 可能已经到了，不能把它一起清掉。
      const rsp = App.online.respond;
      if (!rsp || (rsp.seq || 0) < (m._seq || 0)) {
        App.online.respond = null;
        hideNopeBar();
      }
      App.online.state = m.state;
      App.online.moves = m.moves;
      // 统计本人出牌数（离线在 runAction 里数，联机从事件流里数；否决也算一张）
      (m.events || []).forEach(e => {
        if ((e.type === 'play' || e.type === 'nope') && e.player === App.humanId) App.stats.played++;
      });
      App.busy = true;
      await playEvents(m.events || []);
      App.busy = false;
      render();
    }
    netDraining = false;
    const s = App.online && App.online.state;
    if (s && s.phase === 'over' && !overShown) {
      overShown = true;
      await delay(400);
      showResultPanel(s.winner === App.humanId,
        s.players[s.winner] ? s.players[s.winner].name : '？', s.turn);
    }
  }

  /** 收到 started：用快照接管界面（座位号就是 humanId，全部现有交互直接复用） */
  function enterOnlineGame(state, moves) {
    App.humanId = state.you != null ? state.you : App.online.seat;
    App.online.state = state;
    App.online.moves = moves;
    App.online.respond = null;
    cancelNopePrompt();
    App.selectedUid = null;
    App.selectedAt = 0;
    App.newUid = null;
    App.incomingUid = null;
    App.lastDrawn = null;
    App.awaitingTarget = false;
    App.busy = false;
    App.stats = { turns: 0, drawn: 0, played: 0, startAt: Date.now() };
    overShown = false;
    discardInspect = null;
    hidePlaceBar();
    clearBombPlacement();

    View.hideModal('modalSetup');
    View.hideModal('modalResult');
    View.resetHand();
    render();
  }

  /** 彻底退出联机：断连接、清凭据、清本地状态 */
  function leaveOnline() {
    netClearSession();
    cancelNopePrompt();
    if (App.online && App.online.conn) App.online.conn.close();
    App.online = null;
    App.humanId = 0;
    App.busy = false;
    App.G = null;
    netQueue = [];
    netDraining = false;
    View.resetHand();
  }

  /** 联机失败 / 房间解散：回到开局面板并给出原因 */
  function netFail(reason) {
    leaveOnline();
    View.showModal('modalSetup');
    applySetupMode('local');
    View.floater(reason, 'var(--red-2)', { info: true });
  }

  /** 等待室渲染：房间码、玩家列表、开始按钮（只有房主能点） */
  function renderLobby(lobby) {
    $('lobbyCode').textContent = lobby.code;
    const wrap = $('lobbyPlayers');
    wrap.innerHTML = '';
    lobby.players.forEach(p => {
      const chip = document.createElement('span');
      chip.className = 'lobby-chip' + (p.connected ? '' : ' off');
      const nm = document.createElement('b');
      nm.textContent = p.name;
      chip.appendChild(nm);
      if (p.seat === lobby.host) {
        const tag = document.createElement('span');
        tag.className = 'host-tag';
        tag.textContent = '房主';
        chip.appendChild(tag);
      }
      if (!p.connected) {
        const tag = document.createElement('span');
        tag.className = 'off-tag';
        tag.textContent = '掉线';
        chip.appendChild(tag);
      }
      wrap.appendChild(chip);
    });
    const btn = $('btnStart');
    if (App.online.host) {
      btn.disabled = lobby.players.length < 2;
      btn.textContent = '开始对局（' + lobby.players.length + '/5）';
    } else {
      btn.disabled = true;
      btn.textContent = '等待房主开始…';
    }
  }

  /** 开局面板：单机 / 联机视图切换（inLobby 时联机面板换成等待室） */
  function applySetupMode(mode) {
    App.mode = mode;
    const seg = $('setupMode');
    if (seg) {
      seg.dataset.value = mode;
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === mode));
    }
    const inLobby = !!(App.online && App.online.code);
    const off = $('offlineFields');
    const net = $('netPanel');
    const lobby = $('lobbyPanel');
    if (off) off.style.display = mode === 'local' ? '' : 'none';
    if (net) net.style.display = (mode === 'online' && !inLobby) ? '' : 'none';
    if (lobby) lobby.style.display = (mode === 'online' && inLobby) ? '' : 'none';
    const btn = $('btnStart');
    if (btn && mode === 'local') { btn.disabled = false; btn.textContent = '开始对局'; }
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
    // 页面刷新后自动回到房间（对局中刷新 = 断线重连）。
    // 凭据留在 sessionStorage 里，netOnOpen 发现没有排队动作且有 code 就自动发 rejoin。
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(NET_STORE_KEY) || 'null'); } catch (e) { saved = null; }
    if (saved && saved.code && saved.token && location.host) {
      netEnsure(() => netSend({ t: 'rejoin', code: saved.code, seat: saved.seat, token: saved.token }));
    }
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
  App.playEvents = playEvents;
  App.resolvePendingResponses = resolvePendingResponses;
  App.netReceive = onNetMsg;

  root.BombCats = Object.assign(root.BombCats || {}, { App });
})(typeof window !== 'undefined' ? window : globalThis);

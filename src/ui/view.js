/**
 * 视图层：把引擎状态渲染成 DOM，并负责所有动画与特效。
 * 只读引擎状态（Engine.getState），绝不直接修改 G。
 */
(function (root) {
  'use strict';

  const { CARDS } = root.BombCats;

  const $ = id => document.getElementById(id);

  const el = {};
  ['opponents', 'prompt', 'hand', 'handCount', 'btnEnd', 'btnHint',
    'deckCount', 'bombCount', 'discardTop', 'logList', 'logPanel',
    'peekPanel', 'peekCards', 'floater', 'fx', 'flash', 'seedLabel',
    'drawFlash', 'drawFlashCard', 'pileStack'].forEach(id => {
    el[id] = $(id);
  });

  // 弃牌堆顶的「对账标记」哨兵：保证第一次 render 会把 HTML 里的占位符换成空堆素材
  if (el.discardTop) el.discardTop.dataset.discardUid = '__init';

  /* ---------------- 工具 ---------------- */

  /**
   * 系统「减少动态效果」偏好。
   * CSS 的 @media (prefers-reduced-motion) 管不到 element.animate()，
   * 所以 C/D 阶段的 JS 动画要用这个常量自己短路；测试桩里没有 matchMedia，必须判空。
   */
  const RM = (root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)')) || null;

  function cardAccent(type) {
    const def = CARDS[type];
    if (!def) return 'var(--line-2)';
    if (def.kind === 'bomb') return 'var(--red)';
    if (def.kind === 'defuse') return 'var(--green)';
    if (def.kind === 'passive') return 'var(--faint)';
    return 'var(--blue)';
  }

  /** 素材路径 */
  const ASSET = 'assets/';

  /**
   * 素材地址解析。
   * 常规版本直接返回相对路径；单文件版（tools/build-standalone.js 生成）
   * 会预先塞入 window.__ASSETS 的 data URI 映射，此时走内联数据。
   * 这样同一份 view.js 在两种构建下都能用。
   */
  function asset(path) {
    const map = root.__ASSETS;
    return (map && map[path]) || path;
  }

  const artOf = (type, size) =>
    asset(ASSET + 'cards/' + (size === 'face' ? 'face' : 'icon') + '/' + type + '.webp');

  /**
   * 创建一张卡牌 DOM。
   * 结构：白底金边卡框（frame.webp）+ 手绘插画 + 深墨色卡名 + 说明。
   * 小尺寸用 icon 版插画，大尺寸（抽牌浮层）用 face 版。
   */
  function createCard(card, opts) {
    const o = opts || {};
    const def = CARDS[card.type];
    const div = document.createElement('div');
    div.className = 'card kind-' + (def ? def.kind : 'action');
    div.dataset.uid = card.uid;
    div.dataset.type = card.type;
    if (o.size === 'face') div.classList.add('size-face');
    div.style.setProperty('--card-accent', cardAccent(card.type));

    const art = document.createElement('img');
    art.className = 'cart';
    art.src = artOf(card.type, o.size === 'face' ? 'face' : 'icon');
    art.alt = card.name || '';
    art.draggable = false;
    art.loading = 'lazy';

    const name = document.createElement('div');
    name.className = 'cname';
    name.textContent = card.name;

    const text = document.createElement('div');
    text.className = 'ctext';
    text.textContent = o.hideText ? '' : (def ? def.text : '');

    div.append(art, name, text);
    // 说明挂了提示，小卡放不下时也能看到
    if (def && def.text) div.title = card.name + '：' + def.text;
    return div;
  }

  /** 用于「预测未来」展示的牌 */
  function createPeekCard(card) {
    const div = createCard(card, { hideText: true });
    div.classList.add('peek-card');
    return div;
  }

  /* ---------------- 对手区 ---------------- */

  /** 5 只猫头像轮换使用；出局的换成 -dead 差分 */
  function catArt(pid, alive) {
    const n = String((pid % 5) + 1).padStart(2, '0');
    return asset(ASSET + 'cats/cat-' + n + (alive ? '' : '-dead') + '.webp');
  }

  function renderOpponents(state, myId, targetableIds) {
    const wrap = el.opponents;
    wrap.innerHTML = '';

    state.players.forEach(p => {
      if (p.id === myId) return;

      const d = document.createElement('div');
      d.className = 'opponent';
      d.dataset.pid = p.id;
      if (state.phase === 'playing' && p.id === state.current) d.classList.add('active');
      if (!p.alive) d.classList.add('dead');
      if (targetableIds && targetableIds.indexOf(p.id) >= 0) d.classList.add('targetable');

      // 猫头像 + 金色描边圈
      const avatar = document.createElement('div');
      avatar.className = 'opp-avatar';
      const cat = document.createElement('img');
      cat.className = 'cat';
      cat.src = catArt(p.id, p.alive);
      cat.alt = p.name;
      cat.draggable = false;
      avatar.appendChild(cat);
      if (!p.alive) {
        const out = document.createElement('img');
        out.className = 'out-sticker';
        out.src = asset(ASSET + 'cats/out-sticker.svg');
        out.alt = '出局';
        avatar.appendChild(out);
      }

      const head = document.createElement('div');
      head.className = 'opp-head';

      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.name;

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = p.isAI ? 'AI' : '玩家';

      head.append(nm, badge);

      const hand = document.createElement('div');
      hand.className = 'opp-hand';
      // 手牌用真实卡背；超过 6 张时折叠
      const show = Math.min(p.handSize, 6);
      for (let i = 0; i < show; i++) {
        const back = document.createElement('img');
        back.className = 'card-back mini';
        back.src = asset(ASSET + 'cards/back.webp');
        back.alt = '';
        back.draggable = false;
        hand.appendChild(back);
      }
      const cnt = document.createElement('span');
      cnt.className = 'count';
      cnt.textContent = p.handSize + ' 张';
      hand.appendChild(cnt);

      d.append(avatar, head, hand);

      // 被攻击标记
      if (state.phase === 'playing' && state.current === p.id && state.pendingDraws > 1) {
        const mark = document.createElement('span');
        mark.className = 'under-attack';
        mark.textContent = '×' + state.pendingDraws;
        mark.title = '本回合要抽 ' + state.pendingDraws + ' 张';
        d.appendChild(mark);
      }

      wrap.appendChild(d);
    });
  }

  /* ---------------- 中央舞台 ---------------- */

  function renderStage(state) {
    el.deckCount.textContent = state.deckSize;
    el.seedLabel.textContent = state.turn;

    // 本局炸弹总数（只更新数字，别覆盖掉图标 svg）
    if (el.bombCount) {
      const num = document.getElementById('bombTotal');
      if (num) num.textContent = state.bombTotal;
      el.bombCount.title = '本局牌堆里一共 ' + state.bombTotal + ' 张炸弹猫';
    }

    // 牌堆上显示剩余张数
    const badge = document.querySelector('.pile-stack .badge-num');
    if (badge) badge.textContent = state.deckSize;

    // 弃牌堆顶对账：动画路径（出牌落地）负责观感，这里只保证状态不脏——
    // 重开 / 读档 / 异常中断等不经过落地回调的弃牌变化，uid 对不上就静默更新
    // （不播落地动画、不加随机旋转）；对得上就什么都不做。
    const wantDiscardUid = state.discardTop ? String(state.discardTop.uid) : '';
    const haveDiscardUid = (el.discardTop && el.discardTop.dataset.discardUid) || '';
    if (haveDiscardUid !== wantDiscardUid) setDiscardTop(state.discardTop || null);
  }

  /**
   * 更新弃牌堆顶。
   * @param {object|null} card 牌对象；null 表示空堆
   * @param {number} [rotDeg] 落地随机角（±4°），加在 .discard-top 上（img 会被 overflow 裁边）
   */
  function setDiscardTop(card, rotDeg) {
    const box = el.discardTop;
    if (!box) return;
    box.innerHTML = '';
    if (card) {
      box.classList.add('has-card');
      const img = document.createElement('img');
      img.src = artOf(card.type, 'icon');
      img.alt = card.name;
      img.draggable = false;
      box.appendChild(img);
      box.title = '弃牌堆顶：' + card.name;
      box.style.setProperty('rotate', (typeof rotDeg === 'number' ? rotDeg : 0).toFixed(2) + 'deg');
      box.dataset.discardUid = String(card.uid);
    } else {
      box.classList.remove('has-card');
      const img = document.createElement('img');
      img.className = 'empty-mark';
      img.src = asset(ASSET + 'ui/discard-empty.svg');
      img.alt = '';
      box.appendChild(img);
      box.title = '还没有人出牌';
      box.style.setProperty('rotate', '0deg');
      box.dataset.discardUid = '';
    }
  }

  /** 弃牌堆落地：金边一闪 + 轻微回弹（CSS 里 200ms） */
  function discardLand() {
    const box = el.discardTop;
    if (!box) return;
    box.classList.remove('landing');
    void box.offsetWidth;
    box.classList.add('landing');
    setTimeout(() => box.classList.remove('landing'), 260);
  }

  /** 把卡面放进抽牌浮层的卡槽（不负责显示/隐藏） */
  function prepareDrawnCard(card) {
    if (!el.drawFlashCard || !card) return null;
    el.drawFlashCard.innerHTML = '';
    const face = createCard(card, { size: 'face' });
    face.classList.add('draw-face');
    el.drawFlashCard.appendChild(face);
    return face;
  }

  /**
   * 抽牌反馈：把刚抽到的牌摊在台面正中央，让人一眼看清抽了什么。
   * 这是之前最缺的一环——抽牌只有一声音效，玩家根本不知道自己摸到了什么。
   */
  function showDrawnCard(card, holdMs) {
    if (!el.drawFlash || !el.drawFlashCard || !card) return;
    prepareDrawnCard(card);

    el.drawFlash.classList.remove('show');
    void el.drawFlash.offsetWidth;          // 强制重排，重启动画
    el.drawFlash.classList.add('show');

    clearTimeout(el.drawFlash._timer);
    el.drawFlash._timer = setTimeout(() => {
      el.drawFlash.classList.remove('show');
    }, holdMs || 1100);
  }

  /**
   * 抽牌浮层里卡面「显示态」的矩形（视口坐标），给飞牌当落点/起点。
   * 浮层隐藏时带着 scale(.82) / translate(-42%)，直接量 DOM 会偏，所以按显示态几何推算：
   *   容器中心 = (舞台水平中心, 舞台顶 + 46% 舞台高)   ← .draw-flash { top:46%; left:50%; translate(-50%,-50%) }
   *   卡面中心比容器中心低 (label 高 + gap 9px)/2      ← .draw-flash { gap:9px }，label 在卡面上方
   */
  function drawFlashCardRect() {
    const stage = document.querySelector('.stage');
    const flash = el.drawFlash;
    if (!stage || !flash) return null;
    const sr = stage.getBoundingClientRect();
    const label = flash.querySelector('.label');
    const labelH = label && label.getBoundingClientRect ? label.getBoundingClientRect().height : 20;
    const w = 116;   // .draw-flash .card.draw-face 的尺寸
    const h = 162;
    const cx = sr.left + sr.width / 2;
    const cy = sr.top + sr.height * 0.46 + (labelH + 9) / 2;
    return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
  }

  /** 对手抽牌：只给一个背面滑入的提示，不暴露牌面 */
  function showOpponentDraw(pid) {
    const node = document.querySelector('.opponent[data-pid="' + pid + '"]');
    if (!node) return;
    node.classList.remove('drawing');
    void node.offsetWidth;
    node.classList.add('drawing');
    setTimeout(() => node.classList.remove('drawing'), 620);
  }

  /** 牌堆被抽走一张的视觉反馈 */
  function bumpDeck() {
    const stack = el.pileStack;
    if (!stack) return;
    stack.classList.remove('bump');
    void stack.offsetWidth;
    stack.classList.add('bump');
    setTimeout(() => stack.classList.remove('bump'), 420);
  }

  /**
   * 牌堆现在能不能「点一下就抽牌」。
   * 只负责视觉与提示（.can-draw 的呼吸光晕 / cursor / title），
   * 真正的判定在 main.js 的 canHumanDraw()，两边用同一套条件。
   * 炸弹放回模式下这个状态是关的——那时点击归 enableBombPlacement() 管。
   */
  function setPileDrawable(on) {
    const stack = el.pileStack;
    if (!stack) return;
    stack.classList.toggle('can-draw', !!on);
    stack.title = on ? '点击抽牌' : '';
  }

  /* ---------------- 放炸弹预览（插入位置横线 + 文案） ---------------- */

  /** 懒创建在牌堆里的预览节点（不改 index.html） */
  let placeMarker = null;
  let placeLabel = null;

  function ensurePlaceMarker() {
    const stack = el.pileStack;
    if (!stack) return null;
    if (!placeMarker || placeMarker.parentNode !== stack) {
      placeMarker = document.createElement('div');
      placeMarker.className = 'place-marker';
      stack.appendChild(placeMarker);
    }
    if (!placeLabel || placeLabel.parentNode !== stack) {
      placeLabel = document.createElement('div');
      placeLabel.className = 'place-label';
      stack.appendChild(placeLabel);
    }
    return { marker: placeMarker, label: placeLabel };
  }

  /** 预览文案：只描述「第几张」，绝不暗示牌堆里有什么牌 */
  function placeMarkerText(pos, deckSize) {
    if (pos <= 0) return '插入最上面';
    if (pos >= deckSize) return '插入最下面';
    return '插入第 ' + (pos + 1) + ' 张';
  }

  /**
   * 显示/更新插入位置预览。
   * @param {number} ratio 指针高度占牌堆高度的比例（0..1），横线画在这个高度
   * @param {number} pos   同一套公式算出的插回位置
   * @param {number} deckSize 当前牌堆张数
   */
  function showPlaceMarker(ratio, pos, deckSize) {
    const nodes = ensurePlaceMarker();
    if (!nodes) return;
    const top = Math.max(0, Math.min(1, ratio)) * 100;
    nodes.marker.style.top = top.toFixed(2) + '%';
    nodes.label.style.top = top.toFixed(2) + '%';
    nodes.label.textContent = placeMarkerText(pos, deckSize);
    nodes.marker.classList.add('show');
    nodes.label.classList.add('show');
  }

  /** 隐藏预览（pointerleave / 放置完成 / 任何退出路径） */
  function hidePlaceMarker() {
    if (placeMarker) placeMarker.classList.remove('show');
    if (placeLabel) placeLabel.classList.remove('show');
  }

  /* ---------------- 手牌 ---------------- */

  /**
   * 手牌 DOM 复用表：uid -> 元素。
   *
   * 以前每次 render 都 wrap.innerHTML = '' 重建整排手牌，牌一多就整排闪一下，
   * 出牌/摸牌也没有任何过渡。改成按 uid 复用后：
   *   已有 uid → 复用元素，只同步状态类与卡面内容；
   *   新 uid   → 创建一次，挂 .entering 播 cardIn 进场；
   *   消失 uid → 挂 .leaving 播 cardOut，播完再摘掉。
   * 元素身份稳定，扇形布局（layoutFan）与后续飞牌动效才有连续的 transform 起点。
   */
  const handEls = new Map();
  /** 正在离场、还没从 DOM 摘掉的牌：uid -> { el, timer, onEnd } */
  const handExiting = new Map();
  /** 正在从牌堆飞向手牌、还没落地的 uid（这些牌先隐形占位，落地后才显形） */
  const handIncoming = new Set();

  /** 上一次扇形布局用的元素顺序（resize 时按它重算） */
  let handOrdered = [];
  /** 命中判定用的基础布局缓存（不含 hover 抬升与放大），只在 render / resize 时更新 */
  let handGeom = null;

  const CARD_IN_MS = 440;    // 与 .card.entering 的 cardIn(.38s) 对齐，留一点余量
  const CARD_OUT_MS = 360;   // 与 .card.leaving 的 cardOut(.32s) 对齐，留一点余量

  /** 从父节点摘除；测试里的 DOM 桩没有实现 remove()，所以两条路都留着 */
  function detach(node) {
    if (!node) return;
    if (node.parentNode && typeof node.parentNode.removeChild === 'function') {
      node.parentNode.removeChild(node);
    } else if (typeof node.remove === 'function') {
      node.remove();
    }
  }

  /** 新牌进场：动画播完（或超时兜底）后摘掉 .entering，避免复用时残留 */
  function markEntering(d) {
    d.classList.add('entering');
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      d.removeEventListener('animationend', onEnd);
      d.classList.remove('entering');
    };
    // 正常态是 cardIn；减少动态效果时 CSS 换成 cardFadeIn，两个名字都要认
    const onEnd = ev => {
      if (!ev || ev.animationName === 'cardIn' || ev.animationName === 'cardFadeIn') done();
    };
    d.addEventListener('animationend', onEnd);
    timer = setTimeout(done, CARD_IN_MS);
  }

  /** 收尾一次离场：摘掉监听、定时器与元素 */
  function finishLeave(uid) {
    const rec = handExiting.get(uid);
    if (!rec) return;
    handExiting.delete(uid);
    clearTimeout(rec.timer);
    rec.el.removeEventListener('animationend', rec.onEnd);
    detach(rec.el);
  }

  /** 牌从手牌消失：先挂 .leaving 播 cardOut，动画结束（或超时）后再摘掉 */
  function startLeave(uid, d) {
    if (!d) return;
    finishLeave(uid);                 // 同一张牌重复触发时先收尾，别叠两份动画
    handEls.delete(uid);
    handIncoming.delete(uid);
    d.classList.remove('playable', 'locked', 'selected', 'newly-drawn', 'entering', 'is-hover', 'incoming');
    d.classList.add('leaving');

    const rec = { el: d, timer: 0, onEnd: null };
    rec.onEnd = ev => {
      if (!ev || ev.animationName === 'cardOut' || ev.animationName === 'cardFadeOut') finishLeave(uid);
    };
    d.addEventListener('animationend', rec.onEnd);
    rec.timer = setTimeout(() => finishLeave(uid), CARD_OUT_MS);
    handExiting.set(uid, rec);
  }

  /** 手牌里某个 uid 的当前元素（飞牌取起点/落点用） */
  function handCardEl(uid) {
    return handEls.get(uid) || null;
  }

  /** 飞牌落地：摘掉隐形占位，让这张牌显形 */
  function clearIncoming(uid) {
    handIncoming.delete(uid);
    const d = handEls.get(uid);
    if (d) d.classList.remove('incoming');
  }

  /**
   * 出牌飞行动效：把牌立刻从手牌里摘掉（不走 .leaving，否则会和飞行克隆重影）。
   * 返回 { el, rect, rot }，rect 在摘除前取好（摘除后就量不到了）。
   */
  function takeHandCard(uid) {
    const d = handEls.get(uid);
    if (!d) return null;
    const rect = typeof d.getBoundingClientRect === 'function' ? d.getBoundingClientRect() : null;
    const rot = parseFloat(d.style.getPropertyValue('--rot')) || 0;
    handEls.delete(uid);
    handIncoming.delete(uid);
    detach(d);
    return { el: d, rect: rect, rot: rot };
  }

  /**
   * 复用元素时同步卡面内容。
   * 现在引擎里一张牌 uid 固定后类型/名字都不会再变，这里仍做一次轻量同步，
   * 免得以后加「变牌 / 换牌」类规则时新旧内容对不上。
   */
  function syncCard(d, card) {
    const def = CARDS[card.type];
    if (d.dataset.type !== card.type) {
      const kind = 'kind-' + (def ? def.kind : 'action');
      Array.from(d.classList).forEach(c => {
        if (c.indexOf('kind-') === 0 && c !== kind) d.classList.remove(c);
      });
      d.classList.add(kind);
      d.dataset.type = card.type;
      const art = d.querySelector('.cart');
      if (art) art.src = artOf(card.type, 'icon');
    }
    d.dataset.uid = card.uid;
    d.style.setProperty('--card-accent', cardAccent(card.type));

    const name = d.querySelector('.cname');
    if (name && name.textContent !== card.name) name.textContent = card.name;
    const body = def ? def.text : '';
    const text = d.querySelector('.ctext');
    if (text && text.textContent !== body) text.textContent = body;
    d.title = (def && def.text) ? (card.name + '：' + def.text) : '';
  }

  /**
   * 让 DOM 顺序与手牌顺序一致。
   * 引擎对手牌只有 push / splice（新牌永远进队尾），正常情况下一张都不用搬；
   * 这里只在顺序真的错位时才动节点，避免无谓的 DOM 移动打断正在播的动画。
   * 测试里的 DOM 桩没实现 insertBefore / firstElementChild，此时直接跳过。
   */
  function syncHandOrder(wrap, ordered) {
    if (typeof wrap.insertBefore !== 'function') return;
    let ref = wrap.firstElementChild;
    ordered.forEach(node => {
      while (ref && ref.classList.contains('leaving')) ref = ref.nextElementSibling;
      if (ref === node) { ref = ref.nextElementSibling; return; }
      wrap.insertBefore(node, ref || null);
    });
  }

  /** 清空手牌复用表：开新局时调用，免得上一局的牌还在播离场动画 */
  function resetHand() {
    Array.from(handExiting.keys()).forEach(finishLeave);
    handEls.forEach(d => detach(d));
    handEls.clear();
    handIncoming.clear();
    handOrdered = [];
    handGeom = null;
    if (el.hand) {
      el.hand.classList.remove('aiming');
      el.hand.classList.remove('dense');
    }
  }

  function renderHand(state, myId, playableUids, selectedUid, aiming, newUid, incomingUid) {
    const wrap = el.hand;
    const me = state.players[myId];

    if (!me) {
      resetHand();
      el.handCount.textContent = '0 张';
      return;
    }

    // 正在飞向手牌的 uid：先隐形占位，飞牌落地后由 clearIncoming() 摘掉
    if (incomingUid != null) handIncoming.add(incomingUid);

    // 真人玩家的身份牌：显示猫头像、名字与当前状态
    const plate = document.getElementById('myPlate');
    if (plate) {
      const isTurn = state.phase === 'playing' && state.current === myId;
      plate.classList.toggle('active', isTurn);
      plate.classList.toggle('dead', !me.alive);
      const avatar = plate.querySelector('.plate-cat');
      if (avatar) avatar.src = catArt(myId, me.alive);
      const nm = plate.querySelector('.nm');
      if (nm) nm.textContent = me.name;
      const tag = plate.querySelector('.tag');
      if (tag) {
        if (!me.alive) tag.textContent = '出局';
        else if (isTurn) tag.textContent = '你的回合';
        else tag.textContent = '等待中';
      }
    }

    const seen = new Set();
    const ordered = [];

    me.hand.forEach(card => {
      const uid = card.uid;
      seen.add(uid);
      finishLeave(uid);               // 极端情况下同一 uid 正在离场，先收掉旧元素

      let d = handEls.get(uid);
      if (!d) {
        d = createCard(card);
        handEls.set(uid, d);
        wrap.appendChild(d);
        // 飞牌进来的牌先隐形占位（跳过 cardIn），其余新牌正常播进场动画
        if (handIncoming.has(uid)) d.classList.add('incoming');
        else markEntering(d);
      } else {
        syncCard(d, card);            // 老牌：复用元素，只同步内容
        d.classList.toggle('incoming', handIncoming.has(uid));
      }

      const canPlay = playableUids.has(uid);
      d.classList.toggle('playable', canPlay);
      d.classList.toggle('locked', !canPlay);
      d.classList.toggle('selected', uid === selectedUid);
      // 刚抽进来的那张牌高亮标出来，否则满手牌里根本看不出多了一张
      d.classList.toggle('newly-drawn', newUid != null && uid === newUid);
      ordered.push(d);
    });

    // 已经从手牌里消失的牌：播完 cardOut 再摘掉
    Array.from(handEls.keys()).forEach(uid => {
      if (!seen.has(uid)) startLeave(uid, handEls.get(uid));
    });

    syncHandOrder(wrap, ordered);
    layoutFan(wrap, ordered);       // 扇形几何 + 命中缓存

    wrap.classList.toggle('aiming', !!aiming);
    el.handCount.textContent = me.hand.length + ' 张';
  }

  /* ---------------- 扇形手牌布局 ---------------- */

  /**
   * 扇形参数（设计规范数值，集中在这里，别散落到 CSS 里）。
   * 与 CSS 的对应关系：
   *   bottomPad / pivotRatio 必须和 .hand > .card 的 bottom、transform-origin 一致；
   *   hover 的额外上抬 22px 只写在 CSS 里（.hand > .card.is-hover），JS 不参与。
   */
  const FAN = {
    pad: 12,            // 桌面端左右留白
    padNarrow: 6,       // ≤620px 左右留白
    rotStep: 26,        // 桌面旋转角分摊基数：26/(N-1)
    rotCap: 3.5,        // 桌面单张牌旋转增量上限（度）→ 总范围 ±13°
    rotStepNarrow: 18,  // 窄屏旋转角分摊基数：18/(N-1)
    rotCapNarrow: 3,    // 窄屏单张牌旋转增量上限（度）→ 总范围 ±9°
    stepMinNarrow: 16,  // 窄屏步距下限（px）
    stepMaxNarrow: 0.8, // 窄屏步距上限 = 0.8·cw
    arcMax: 18,         // 弧线下沉上限（px）
    arcStep: 2.4,       // 每多一张牌增加的弧线
    narrowArc: 0.75,    // ≤620px 弧线系数
    bottomPad: 20,      // 与 .hand > .card 的 bottom 一致
    pivotRatio: 1.3     // 与 transform-origin: 50% 130% 一致
  };

  /** 窄屏判定：与 CSS 的 @media (max-width: 620px) 对齐 */
  function isNarrow() {
    const w = root.innerWidth;
    return typeof w === 'number' && w > 0 && w <= 620;
  }

  /** 读 :root 上 --card-w / --card-h 的解析值；取不到（测试桩）就退回默认 */
  function cssPx(name, fallback) {
    if (typeof root.getComputedStyle !== 'function' || !el.hand) return fallback;
    const v = parseFloat(root.getComputedStyle(el.hand).getPropertyValue(name));
    return isNaN(v) ? fallback : v;
  }

  /**
   * 计算扇形几何，写进每张牌的 --x / --rot / --lift / --z，并缓存命中判定用的基础布局。
   *
   * N = 手牌张数，c = (N-1)/2，t = (i-c)/max(c,1)，cw = 牌宽：
   *   step  = clamp((Wa-cw)/(N-1), max(.30cw, 20), cw+10)   // 桌面；窄屏下界 16、上界 0.8·cw
   *   --x   = (i-c) * step
   *   --rot = (i-c) * min(3.5, 26/(N-1)) 度（桌面 ±13°；窄屏 min(3, 18/(N-1)) → ±9°）
   *   --lift= min(18, 2.4*(N-1)) * t²     （≤620px 再 ×0.75）
   *   --z   = i + 1
   *   step < 0.5·cw 时给 #hand 挂 .dense（竖排卡名）
   *
   * 测试桩里没有 clientWidth，直接 return（integration.test 靠这个不抛异常）。
   */
  function layoutFan(wrap, ordered) {
    handOrdered = ordered || [];
    handGeom = null;
    if (!wrap || typeof wrap.clientWidth !== 'number') return;

    const n = handOrdered.length;
    if (!n) return;

    const first = handOrdered[0];
    const cw = first.offsetWidth || cssPx('--card-w', 96);
    const ch = first.offsetHeight || cssPx('--card-h', 134);
    const narrow = isNarrow();
    const pad = narrow ? FAN.padNarrow : FAN.pad;
    // 容器宽度下限至少一张牌宽：clientWidth 异常小时也不让 Wa 变负
    const Wa = Math.max(cw, wrap.clientWidth - pad * 2);

    const c = (n - 1) / 2;
    // 桌面：上界 cw+10（牌少时几乎不重叠）；窄屏：上界 0.8·cw、下界 16
    const stepMax = narrow ? FAN.stepMaxNarrow * cw : cw + 10;
    const stepMin = narrow ? FAN.stepMinNarrow : Math.max(0.30 * cw, 20);
    let step = 0;
    if (n > 1) {
      const fit = (Wa - cw) / (n - 1);          // 容器能容纳的最大步距
      step = Math.max(stepMin, Math.min(stepMax, fit));
      // 护栏：容器极窄时下界会把牌挤出容器，这里以「(N-1)*step + cw <= Wa」优先
      step = Math.min(step, fit);
    }
    const rotUnit = n > 1
      ? Math.min(narrow ? FAN.rotCapNarrow : FAN.rotCap,
                 (narrow ? FAN.rotStepNarrow : FAN.rotStep) / (n - 1))
      : 0;
    let arc = Math.min(FAN.arcMax, FAN.arcStep * (n - 1));
    if (narrow) arc *= FAN.narrowArc;

    // 牌多到相邻牌压住大半时进入 dense（竖排卡名）；只在窄屏、且单张牌不算
    wrap.classList.toggle('dense', narrow && n > 1 && step < 0.5 * cw);

    const xs = [];
    const rots = [];
    handOrdered.forEach((d, i) => {
      const t = (i - c) / Math.max(c, 1);
      const x = (i - c) * step;
      const rot = (i - c) * rotUnit;
      const lift = arc * t * t;
      xs.push(x);
      rots.push(rot);
      d.style.setProperty('--x', x.toFixed(2) + 'px');
      d.style.setProperty('--rot', rot.toFixed(3));
      d.style.setProperty('--lift', lift.toFixed(2) + 'px');
      d.style.setProperty('--z', String(i + 1));
    });

    // 命中缓存：只在 render / resize 时读一次几何，pointermove 里不再碰布局
    if (typeof wrap.getBoundingClientRect !== 'function') return;
    const r = wrap.getBoundingClientRect();
    if (!r || !r.width) return;
    handGeom = {
      els: handOrdered.slice(),
      xs: xs,
      rots: rots,
      cw: cw,
      cx0: r.left + r.width / 2,
      pivotY: r.top + r.height - FAN.bottomPad + (FAN.pivotRatio - 1) * ch
    };
  }

  /**
   * 扇形手牌命中判定：返回指针 (x, y)（视口坐标）命中的那张 .card，没命中返回 null。
   * 只按缓存的基础布局算（不含 hover 抬升与放大），所以 pointermove 里没有布局读取。
   * 第 i 张牌在高度 y 处的中线：cx_i(y) = cx_i + (pivotY - y) * tan(rot_i)；
   * 取满足 x >= cx_i(y) - cw/2 的最大 i（即该 x 处最上面那张），
   * 超过最后一张右沿 8px 判为无。
   */
  function handCardAt(x, y) {
    const g = handGeom;
    if (!g || !g.els.length) return null;
    const half = g.cw / 2;
    const dy = g.pivotY - y;
    const tan = i => Math.tan(g.rots[i] * Math.PI / 180);

    let hit = -1;
    for (let i = 0; i < g.els.length; i++) {
      const cx = g.cx0 + g.xs[i] + dy * tan(i);
      if (x >= cx - half) hit = i;
    }
    if (hit < 0) return null;

    const last = g.els.length - 1;
    const lastCx = g.cx0 + g.xs[last] + dy * tan(last);
    if (x > lastCx + half + 8) return null;
    return g.els[hit];
  }

  /** 窗口尺寸变化后重算扇形与命中缓存 */
  function refreshHandLayout() {
    if (!el.hand) return;
    layoutFan(el.hand, handOrdered);
  }

  /* ---------------- 飞牌层（一次性克隆 + WAAPI 动画） ---------------- */

  let flyLayer = null;

  /**
   * 现在能不能用 WAAPI 飞牌：
   *   - 测试桩 / 老浏览器没有 Element.animate → 不飞；
   *   - 系统开了「减少动态效果」（RM.matches）→ 不飞（CSS 媒体查询管不到 element.animate）。
   * 不能飞时调用方应立即把结果画出来（比如手牌直接显形），不要留下隐形占位。
   */
  function canFly() {
    if (typeof Element === 'undefined' || !Element.prototype) return false;
    if (typeof Element.prototype.animate !== 'function') return false;
    if (RM && RM.matches) return false;
    if (typeof document === 'undefined' || !document.body) return false;
    return true;
  }

  /** 懒创建飞牌层（挂 body，不改 index.html） */
  function ensureFlyLayer() {
    if (flyLayer && flyLayer.parentNode) return flyLayer;
    flyLayer = document.createElement('div');
    flyLayer.className = 'fly-layer';
    document.body.appendChild(flyLayer);
    return flyLayer;
  }

  /** 飞行用的克隆：卡背用 size-face 的尺寸 + 卡背底图；卡面用 createCard */
  function makeFlyNode(o) {
    let node;
    if (o.face === 'front' && o.card) {
      node = createCard(o.card, { size: o.size === 'face' ? 'face' : undefined });
    } else {
      node = document.createElement('div');
      node.className = 'card size-face fly-back';
    }
    node.classList.add('fly-card');
    return node;
  }

  /**
   * 飞一张牌：从 fromRect 飞到 toRect（都是视口坐标矩形），返回 Promise。
   * 无法飞（没有 Element.animate / 减少动态效果 / 缺矩形）时立即 resolve(null)，不建任何克隆。
   *
   * opts: { face:'back'|'front', card, size:'face', scaleFrom, scaleTo,
   *         rotateFrom, rotateTo, ms, lift, arcAt, fadeTail, easing }
   * 只动画 transform / opacity；落点带弧线时用 0 / arcAt / 100% 三关键帧，arcAt 处额外上抬 lift。
   */
  function flyCard(fromRect, toRect, opts) {
    const o = opts || {};
    if (!canFly() || !fromRect || !toRect) return Promise.resolve(null);

    const layer = ensureFlyLayer();
    const node = makeFlyNode(o);
    layer.appendChild(node);

    const w = node.offsetWidth || 96;
    const h = node.offsetHeight || 134;
    const s0 = o.scaleFrom == null ? 1 : o.scaleFrom;
    const s1 = o.scaleTo == null ? 1 : o.scaleTo;
    const r0 = o.rotateFrom || 0;
    const r1 = o.rotateTo || 0;
    const ms = o.ms || 300;
    const fadeTail = o.fadeTail || 0;
    const lift = o.lift || 0;
    const arcAt = o.arcAt == null ? 0.5 : o.arcAt;

    // 中心对中心：transform-origin 是 50% 50%，克隆的视觉中心直接对准起落点中心
    const x0 = fromRect.left + fromRect.width / 2 - w / 2;
    const y0 = fromRect.top + fromRect.height / 2 - h / 2;
    const x1 = toRect.left + toRect.width / 2 - w / 2;
    const y1 = toRect.top + toRect.height / 2 - h / 2;

    const frame = (t, extraY, opacity) => {
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t + (extraY || 0);
      const s = s0 + (s1 - s0) * t;
      const r = r0 + (r1 - r0) * t;
      return {
        offset: t,
        transform: 'translate(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px) ' +
          'scale(' + s.toFixed(4) + ') rotate(' + r.toFixed(2) + 'deg)',
        opacity: opacity
      };
    };

    const frames = [frame(0, 0, 1)];
    if (lift) frames.push(frame(arcAt, lift, 1));
    if (fadeTail > 0) frames.push(frame(Math.max(0, 1 - fadeTail / ms), 0, 1));
    frames.push(frame(1, 0, fadeTail > 0 ? 0 : 1));
    frames.sort((a, b) => a.offset - b.offset);
    // 同 offset 去重（arcAt 恰好等于淡出起点时），后写的为准
    const uniq = [];
    frames.forEach(f => {
      const prev = uniq[uniq.length - 1];
      if (prev && Math.abs(prev.offset - f.offset) < 1e-4) uniq[uniq.length - 1] = f;
      else uniq.push(f);
    });

    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (node.parentNode) node.parentNode.removeChild(node);
        resolve(node);
      };
      let anim = null;
      try {
        anim = node.animate(uniq, {
          duration: ms,
          easing: o.easing || 'cubic-bezier(.3,.7,.2,1)',
          fill: 'forwards'
        });
      } catch (e) {
        anim = null;
      }
      if (!anim) { finish(); return; }
      anim.onfinish = finish;
      anim.oncancel = finish;
      // 兜底：动画事件丢失时也要收尾，避免克隆卡在屏幕上
      setTimeout(finish, ms + 260);
    });
  }

  /* ---------------- 提示条 ---------------- */

  function setPrompt(html, urgent) {
    el.prompt.innerHTML = html;
    el.prompt.classList.toggle('urgent', !!urgent);
  }

  /* ---------------- 日志 ---------------- */

  function renderLog(entries) {
    const list = el.logList;
    list.innerHTML = '';
    entries.forEach(e => {
      const d = document.createElement('div');
      d.className = 'entry ' + e.kind;
      d.textContent = e.text;
      list.appendChild(d);
    });
    list.scrollTop = list.scrollHeight;
  }

  /* ---------------- 特效 ---------------- */

  /** 中央飘字 */
  function floater(text, color) {
    const f = el.floater;
    f.textContent = text;
    f.style.color = color || 'var(--gold-2)';
    f.classList.remove('show');
    void f.offsetWidth;          // 强制重排以重启动画
    f.classList.add('show');
  }

  /** 屏幕震动 */
  function shake() {
    const app = document.querySelector('.app');
    if (!app) return;
    app.classList.remove('shake');
    void app.offsetWidth;
    app.classList.add('shake');
    setTimeout(() => app.classList.remove('shake'), 520);
  }

  /** 全屏爆炸闪光 */
  function flash() {
    const f = el.flash;
    f.classList.remove('fire');
    void f.offsetWidth;
    f.classList.add('fire');
  }

  /**
   * 爆炸精灵图：boom-sheet.webp 是 6 列 × 2 行、每帧 512×512、共 12 帧。
   * 用一个 div 逐帧切换 background-position 播完两行。
   */
  function boomAt(x, y, scale) {
    const s = scale || 1;
    const box = document.createElement('div');
    box.className = 'boom-sprite';
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    box.style.width = (150 * s) + 'px';
    box.style.height = (150 * s) + 'px';
    el.fx.appendChild(box);
    // 动画约 0.7s，播完移除
    setTimeout(() => box.remove(), 780);
  }

  /** 在某个玩家位置播放爆炸 */
  function boomAtPlayer(pid) {
    const node = document.querySelector('.opponent[data-pid="' + pid + '"]');
    const target = node || document.querySelector('#myPlate') || document.querySelector('.hand');
    if (!target) return;
    const r = target.getBoundingClientRect();
    boomAt(r.left + r.width / 2, r.top + r.height / 2, node ? 1.15 : 1);
  }

  /** 在某个元素位置炸出粒子 */
  function burst(x, y, count, colors) {
    const canvas = el.fx;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = w; canvas.height = h;

    const palette = colors || ['#f19135', '#e5484d', '#f5c45f', '#fff0d0'];
    const parts = [];
    for (let i = 0; i < (count || 42); i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 2.5 + Math.random() * 8.5;
      parts.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 1.6,
        life: 1,
        decay: 0.012 + Math.random() * 0.022,
        size: 2 + Math.random() * 4.5,
        color: palette[Math.floor(Math.random() * palette.length)]
      });
    }

    let raf = 0;
    function tick() {
      ctx.clearRect(0, 0, w, h);
      let alive = 0;
      parts.forEach(p => {
        if (p.life <= 0) return;
        alive++;
        p.x += p.vx; p.y += p.vy;
        p.vy += 0.24;            // 重力
        p.vx *= 0.985;
        p.life -= p.decay;
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
      if (alive > 0) raf = requestAnimationFrame(tick);
      else { ctx.clearRect(0, 0, w, h); cancelAnimationFrame(raf); }
    }
    tick();
  }

  /** 在指定玩家卡片上爆粒子 */
  function burstAtPlayer(pid) {
    const node = document.querySelector('.opponent[data-pid="' + pid + '"]');
    const target = node || document.querySelector('.hand');
    if (!target) return;
    const r = target.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, 46);
  }

  /** 给玩家卡片加一个短暂的动画 class */
  function pulsePlayer(pid, cls) {
    const node = document.querySelector('.opponent[data-pid="' + pid + '"]');
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
    setTimeout(() => node.classList.remove(cls), 800);
  }

  /**
   * 给节点挂一次性的脉冲 class：动画播完（或超时兜底）后自动摘掉。
   * 用 animationend 收尾而不是写死时长，改 CSS 里的 --turn-pulse-dur 时 JS 不用跟着改。
   */
  function pulseOnce(node, cls, animName, fallbackMs) {
    if (!node) return;
    if (node._pulseEnd) node.removeEventListener('animationend', node._pulseEnd);
    clearTimeout(node._pulseTimer);
    node.classList.remove(cls);
    void node.offsetWidth;            // 强制重排，重启动画
    node.classList.add(cls);
    const done = () => {
      clearTimeout(node._pulseTimer);
      if (node._pulseEnd) node.removeEventListener('animationend', node._pulseEnd);
      node._pulseEnd = null;
      node.classList.remove(cls);
    };
    node._pulseEnd = ev => { if (!ev || ev.animationName === animName) done(); };
    node.addEventListener('animationend', node._pulseEnd);
    node._pulseTimer = setTimeout(done, fallbackMs);
  }

  /** 回合切到真人：牌堆与「结束回合」按钮各脉冲一次，提示「该你了」 */
  function pulseTurnCue() {
    pulseOnce(el.pileStack, 'pulse', 'turnPulse', 900);
    pulseOnce(el.btnEnd, 'pulse', 'turnPulse', 900);
  }

  /* ---------------- 预测未来浮层 ---------------- */

  function showPeek(cards, onClose) {
    el.peekCards.innerHTML = '';
    cards.forEach(c => el.peekCards.appendChild(createPeekCard(c)));
    el.peekPanel.classList.add('show');
    const close = () => {
      el.peekPanel.classList.remove('show');
      el.peekPanel.removeEventListener('click', close);
      if (onClose) onClose();
    };
    // 点击任意处关闭
    setTimeout(() => el.peekPanel.addEventListener('click', close), 260);
    setTimeout(() => {
      if (el.peekPanel.classList.contains('show')) close();
    }, 4200);
  }

  /* ---------------- 弹层 ---------------- */

  function showModal(id) { $(id).classList.add('show'); }
  function hideModal(id) { $(id).classList.remove('show'); }

  /* ---------------- 导出 ---------------- */

  root.BombCats = Object.assign(root.BombCats || {}, {
    View: {
      el, createCard, createPeekCard,
      renderOpponents, renderStage, renderHand, setPrompt, renderLog,
      floater, shake, flash, burst, burstAtPlayer, pulsePlayer, showPeek,
      showDrawnCard, showOpponentDraw, bumpDeck, boomAt, boomAtPlayer, catArt, ASSET,
      setPileDrawable, pulseTurnCue, resetHand,
      showPlaceMarker, hidePlaceMarker, placeMarkerText,
      layoutFan, handCardAt, refreshHandLayout,
      handCardEl, clearIncoming, takeHandCard,
      canFly, ensureFlyLayer, flyCard,
      setDiscardTop, discardLand, prepareDrawnCard, drawFlashCardRect,
      showModal, hideModal
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * 集成自检：用最小 DOM 桩验证
 *   1. 所有 HTML 里引用的 id 都存在
 *   2. 视图层不会因为选择器写错而崩溃
 *   3. 引擎 → AI → 视图 的数据流能完整跑一轮
 * 运行： node tests/integration.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

/* ---------- 1. HTML 结构 ---------- */
console.log('\n[1] HTML 结构');

// 收集 HTML 中定义的所有 id
const definedIds = new Set([...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map(m => m[1]));

// 收集 main.js / view.js 里 $('...') 引用的 id
const scripts = ['src/main.js', 'src/ui/view.js'];
const referenced = new Map();
scripts.forEach(f => {
  const code = fs.readFileSync(path.join(rootDir, f), 'utf8');
  [...code.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].forEach(m => {
    if (!referenced.has(m[1])) referenced.set(m[1], f);
  });
});
// view.js 的 el 列表（数组里的字符串）
const viewCode = fs.readFileSync(path.join(rootDir, 'src/ui/view.js'), 'utf8');
const elList = viewCode.match(/\['((?:[^']*',\s*')*[^']*)'\]\.forEach/);
if (elList) {
  elList[1].split("',").map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean).forEach(id => {
    if (!referenced.has(id)) referenced.set(id, 'src/ui/view.js (el 列表)');
  });
}

const missing = [...referenced.entries()].filter(([id]) => !definedIds.has(id));
check(`引用的 ${referenced.size} 个 DOM id 全部存在于 HTML`, missing.length === 0,
  missing.map(([id, f]) => `${id} (${f})`).join(', '));

// 脚本加载顺序
const scriptOrder = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
check('脚本按依赖顺序加载', (() => {
  const need = ['src/core/cards.js', 'src/core/rng.js', 'src/core/engine.js', 'src/ai/ai.js', 'src/main.js'];
  let last = -1;
  return need.every(f => {
    const i = scriptOrder.indexOf(f);
    if (i < 0 || i < last) return false;
    last = i; return true;
  });
})(), scriptOrder.join(' → '));

// 每个脚本文件都真实存在
const missingFiles = scriptOrder.filter(f => !fs.existsSync(path.join(rootDir, f)));
check('所有脚本文件都存在', missingFiles.length === 0, missingFiles.join(', '));

// CSS 存在
check('样式文件存在', fs.existsSync(path.join(rootDir, 'styles/main.css')));

/* ---------- 1b. 素材引用必须真实存在 ---------- */
// 素材路径写错不会报错，只会静默变成裂图，所以单独守一道。
console.log('\n[1b] 素材引用');
{
  const sources = ['index.html', 'styles/main.css', 'src/ui/view.js', 'src/main.js', 'src/core/cards.js'];
  const refs = new Set();

  sources.forEach(f => {
    const full = path.join(rootDir, f);
    if (!fs.existsSync(full)) return;
    const text = fs.readFileSync(full, 'utf8');

    // CSS 里的 url("../assets/...")
    [...text.matchAll(/url\(\s*["']?\.\.\/(assets\/[^"')]+)["']?\s*\)/g)].forEach(m => refs.add(m[1]));
    // 直接的 assets/... 引用
    [...text.matchAll(/["'](assets\/[^"']+)["']/g)].forEach(m => refs.add(m[1]));
    // view.js 里拼出来的路径：ASSET + 'cards/' + (size) + '/' + type + '.webp'
    //  → 直接用卡牌定义表生成全部 22 个可能路径
    if (f === 'src/ui/view.js') {
      const CARDS = require(path.join(rootDir, 'src/core/cards.js')).CARDS;
      Object.keys(CARDS).forEach(t => {
        refs.add('assets/cards/icon/' + t + '.webp');
        refs.add('assets/cards/face/' + t + '.webp');
      });
      // 猫头像：cat-01..05 与出局差分
      for (let i = 1; i <= 5; i++) {
        refs.add('assets/cats/cat-0' + i + '.webp');
        refs.add('assets/cats/cat-0' + i + '-dead.webp');
      }
    }
  });

  const missing = [...refs].filter(r => !fs.existsSync(path.join(rootDir, r)));
  check(`引用的 ${refs.size} 个素材全部存在`, missing.length === 0, '缺失: ' + missing.slice(0, 8).join(', '));

  // 11 张卡牌的插画与图标必须一一对应
  const CARDS = require(path.join(rootDir, 'src/core/cards.js')).CARDS;
  const cardFilesMissing = Object.keys(CARDS).flatMap(t => [
    'assets/cards/icon/' + t + '.webp',
    'assets/cards/face/' + t + '.webp'
  ]).filter(r => !fs.existsSync(path.join(rootDir, r)));
  check('11 种卡牌的插画与图标齐全', cardFilesMissing.length === 0, cardFilesMissing.join(', '));

  // 5 只猫 + 出局差分
  let catMissing = 0;
  for (let i = 1; i <= 5; i++) {
    if (!fs.existsSync(path.join(rootDir, 'assets/cats/cat-0' + i + '.webp'))) catMissing++;
    if (!fs.existsSync(path.join(rootDir, 'assets/cats/cat-0' + i + '-dead.webp'))) catMissing++;
  }
  check('5 只猫头像与出局差分齐全', catMissing === 0, catMissing + ' 张缺失');

  // 内联图标 sprite 必须覆盖所有被引用的图标
  const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const usedIcons = [...html.matchAll(/<use href="#(ic-[a-z-]+)"/g)].map(m => m[1]);
  const definedIcons = [...html.matchAll(/<symbol id="(ic-[a-z-]+)"/g)].map(m => m[1]);
  const undef = [...new Set(usedIcons)].filter(id => definedIcons.indexOf(id) < 0);
  check(`内联图标 sprite 覆盖全部引用（${new Set(usedIcons).size} 个）`, undef.length === 0,
    '未定义: ' + undef.join(', '));
}

/* ---------- 2. 浏览器脚本语法 ---------- */
console.log('\n[2] 浏览器脚本语法');
{
  const files = scriptOrder.concat(['src/ui/audio.js']);
  const bad = [];
  [...new Set(files)].forEach(f => {
    const full = path.join(rootDir, f);
    if (!fs.existsSync(full)) return;
    const code = fs.readFileSync(full, 'utf8');
    try { new Function(code); }
    catch (e) { bad.push(f + ': ' + e.message); }
  });
  check('全部脚本语法正确', bad.length === 0, bad.join(' | '));
}

/* ---------- 3. 卡牌定义完整性 ---------- */
console.log('\n[3] 卡牌定义');
{
  const CARDS = require(path.join(rootDir, 'src/core/cards.js')).CARDS;
  const ids = Object.keys(CARDS);
  check('共定义 11 种卡牌', ids.length === 11, '实际 ' + ids.length);
  const badGlyph = ids.filter(id => !CARDS[id].glyph);
  check('每张牌都有图形字符', badGlyph.length === 0, badGlyph.join(', '));
  const badText = ids.filter(id => !CARDS[id].text);
  check('每张牌都有说明文字', badText.length === 0, badText.join(', '));
  const badName = ids.filter(id => !CARDS[id].name);
  check('每张牌都有中文名', badName.length === 0, badName.join(', '));
  const badNeed = ids.filter(id => !['none', 'player'].includes(CARDS[id].need));
  check('need 字段取值合法', badNeed.length === 0, badNeed.join(', '));
}

/* ---------- 4. 视图渲染（DOM 桩） ---------- */
console.log('\n[4] 视图渲染模拟');
{
  // 极简 DOM 桩：只实现视图层用到的方法
  // 注意 className 与 classList 必须互相同步，否则「用 className 设置、
  // 用 classList 查询」的代码在桩里会静默查不到，造成假阴性。
  function makeEl(tag) {
    let cls = '';
    const e = {
      tagName: (tag || 'div').toUpperCase(),
      children: [],
      get className() { return cls; },
      set className(v) {
        cls = String(v || '');
        e.classList._s = new Set(cls.split(/\s+/).filter(Boolean));
      },
      classList: {
        _s: new Set(),
        add(...c) { c.forEach(x => this._s.add(x)); e.className = [...this._s].join(' '); },
        remove(...c) { c.forEach(x => this._s.delete(x)); e.className = [...this._s].join(' '); },
        toggle(c, on) {
          const want = on === undefined ? !this._s.has(c) : !!on;
          if (want) this._s.add(c); else this._s.delete(c);
          e.className = [...this._s].join(' ');
        },
        contains(c) { return this._s.has(c); }
      },
      style: { setProperty() {} },
      dataset: {},
      _text: '',
      set textContent(v) { this._text = String(v); this.children = []; },
      get textContent() { return this._text; },
      set innerHTML(v) { this.children = []; this._text = ''; },
      get innerHTML() { return ''; },
      append(...cs) { cs.forEach(c => c && this.children.push(c)); },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 60 }; },
      getContext() { return { clearRect() {}, beginPath() {}, arc() {}, fill() {}, set fillStyle(v) {}, set globalAlpha(v) {} }; },
      scrollTop: 0, scrollHeight: 0, offsetWidth: 0
    };
    return e;
  }

  const registry = new Map();
  global.document = {
    readyState: 'complete',
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, makeEl('div'));
      return registry.get(id);
    },
    createElement(tag) { return makeEl(tag); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    activeElement: makeEl('body')
  };
  global.window = {
    innerWidth: 1200, innerHeight: 800,
    addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: cb => setTimeout(cb, 0),
    cancelAnimationFrame() {},
    AudioContext: null
  };
  global.requestAnimationFrame = global.window.requestAnimationFrame;

  // 加载浏览器脚本（用 vm 在共享 global 下执行）
  // 浏览器里 globalThis === window，所以让沙箱的 globalThis 指向同一个 window 对象，
  // 才能真实还原 UMD 脚本的挂载行为。
  const vm = require('vm');
  const sandbox = global.window;
  sandbox.window = sandbox;              // window.window === window
  sandbox.globalThis = sandbox;          // globalThis === window
  sandbox.console = console;
  sandbox.setTimeout = setTimeout; sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval; sandbox.clearInterval = clearInterval;
  sandbox.requestAnimationFrame = global.window.requestAnimationFrame;
  sandbox.cancelAnimationFrame = global.window.cancelAnimationFrame;
  sandbox.document = global.document;
  sandbox.Math = Math; sandbox.JSON = JSON; sandbox.Set = Set; sandbox.Map = Map;
  sandbox.Object = Object; sandbox.Array = Array; sandbox.Date = Date;
  sandbox.parseInt = parseInt; sandbox.isNaN = isNaN;

  const ctx = vm.createContext(sandbox);

  const order = ['src/core/cards.js', 'src/core/rng.js', 'src/core/engine.js', 'src/ai/ai.js', 'src/ui/audio.js', 'src/ui/view.js'];
  let loadErr = null;
  order.forEach(f => {
    const code = fs.readFileSync(path.join(rootDir, f), 'utf8');
    try { vm.runInContext(code, ctx, { filename: f }); }
    catch (e) { loadErr = f + ': ' + e.message; }
  });
  check('浏览器脚本可在 DOM 桩中加载', loadErr === null, loadErr || '');

  const BC = sandbox.BombCats;
  check('BombCats 命名空间已建立', !!BC);
  check('暴露了 View 模块', !!(BC && BC.View));
  check('暴露了 SFX 模块', !!(BC && BC.SFX));
  check('暴露了 AI 模块', !!(BC && BC.AI));
  check('暴露了 Engine 模块', !!(BC && BC.Engine));
  check('暴露了 CARDS 与 RNG', !!(BC && BC.CARDS && BC.RNG));

  // 关键回归点：BombCats.CARDS 必须就是「卡牌定义表」本身，
  // 而不是整个模块对象。视图与主控都写 CARDS[type].name/need，
  // 挂错一层会导致卡面文字全空、且出牌时抛 undefined。
  check('BombCats.CARDS 直接是卡牌表（按 type 可取到定义）',
    !!(BC && BC.CARDS && BC.CARDS.see && BC.CARDS.see.name === '预测未来'),
    BC && BC.CARDS ? Object.keys(BC.CARDS).slice(0, 4).join(',') : 'null');
  check('BombCats.CardData 保留辅助函数',
    !!(BC && BC.CardData && typeof BC.CardData.startHandSize === 'function'));

  if (BC && BC.View) {
    const G = BC.Engine.createGame({ playerCount: 4, rng: BC.RNG.seeded(1), humanIndex: 0 });
    const state = BC.Engine.getState(G);
    let renderErr = null;
    try {
      BC.View.renderOpponents(state, 0, [1, 2]);
      BC.View.renderStage(state);
      BC.View.renderHand(state, 0, new Set(), null, false);
      BC.View.renderLog(state.log);
      BC.View.setPrompt('测试', true);
    } catch (e) { renderErr = e.message; }
    check('视图渲染不抛异常', renderErr === null, renderErr || '');

    // 对手渲染出 3 个节点（4 人局 – 自己）
    const oppWrap = registry.get('opponents');
    check('对手区渲染出 3 名对手', oppWrap && oppWrap.children.length === 3,
      oppWrap ? String(oppWrap.children.length) : 'null');

    // 卡面必须真的渲染出名字与说明，而不是空白壳子
    const handWrap = registry.get('hand');
    const cards = handWrap ? handWrap.children : [];
    check('手牌区渲染出 5 张牌', cards.length === 5, String(cards.length));

    const blankName = [], blankText = [];
    cards.forEach(c => {
      const kids = c.children || [];
      const nm = kids.find(k => k.classList && k.classList.contains('cname'));
      const tx = kids.find(k => k.classList && k.classList.contains('ctext'));
      if (!nm || !nm.textContent) blankName.push(c.dataset ? c.dataset.type : '?');
      if (!tx || !tx.textContent) blankText.push(c.dataset ? c.dataset.type : '?');
    });
    check('每张手牌都有中文名', blankName.length === 0, '空白: ' + blankName.join(','));
    check('每张手牌都有说明文字', blankText.length === 0, '空白: ' + blankText.join(','));

    // 卡牌类型 class 必须落到 kind-bomb / kind-action 之类，不能被兜底成 action
    const kindCls = cards.map(c => c.className || '');
    check('卡牌带上了正确的类型样式', kindCls.every(s => /kind-(bomb|defuse|action|passive)/.test(s)),
      kindCls.join(' | '));
  }
}

/* ---------- 5. 端到端：AI 驱动完整对局（纯逻辑） ---------- */
console.log('\n[5] 端到端对局');
{
  const Engine = require(path.join(rootDir, 'src/core/engine.js'));
  const AI = require(path.join(rootDir, 'src/ai/ai.js'));
  const RNG = require(path.join(rootDir, 'src/core/rng.js'));

  // 否决窗口：AI 自己决定是否打断，真人座位（0）在模拟里一律放弃
  function settle(G) {
    let guard = 0;
    while (G.pendingAction && guard++ < 50) {
      const pid = Engine.pendingResponder(G);
      if (pid == null) break;
      const uid = pid === 0 ? null : AI.chooseNope(G, pid, 'normal');
      const r = uid != null ? Engine.respondNope(G, pid, uid) : Engine.passResponse(G, pid);
      if (!r.ok) throw new Error('settle(' + pid + '): ' + r.error);
    }
    if (G.pendingAction) throw new Error('否决窗口未能结算');
  }

  let ok = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const rng = RNG.seeded(seed);
    const G = Engine.createGame({ playerCount: 4, rng, humanIndex: 0 });
    let steps = 0;
    while (steps++ < 2000 && G.phase !== 'over') {
      const pid = G.current;
      if (G.pendingBomb) {
        const o = G.pendingBomb.player;
        Engine.placeBomb(G, o, AI.chooseBombPosition(G, o, 'normal'));
        if (G.turnEndPending) Engine.resumeAfterPlacement(G, o);
        continue;
      }
      if (G.pendingAction) { settle(G); continue; }
      const isHuman = pid === 0;
      const pick = isHuman ? null : AI.chooseCard(G, pid, 'normal');
      if (pick) {
        const t = pick.needsTarget ? AI.chooseTarget(G, pid, pick, 'normal') : undefined;
        const r = Engine.playCard(G, pid, pick.card.uid, t);
        if (r.ok) {
          if (G.pendingAction) settle(G);
          continue;
        }
      }
      Engine.endTurn(G, pid);
    }
    if (G.phase === 'over' && G.winner != null) ok++;
  }
  check('50 局完整对局全部正常结束', ok === 50, ok + '/50');
}

console.log(`\n结果：${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);

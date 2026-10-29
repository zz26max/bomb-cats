/**
 * 生成验收截图，并在浏览器里真实走一遍真人交互路径：
 *   01-setup    开局设置
 *   02-battle   对局中（AI 已出牌，轮到真人）
 *   03-aiming   选中「攻击」等待选目标（验证瞄准态）
 *   04-result   结算弹层
 *   05-draw     抽牌反馈
 *   06-09       手机竖屏（CDP 精确视口：390×844 / 360×640 / 430×932 / 360×560）
 *
 * 用法： node tests/screenshot.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const rootDir = path.join(__dirname, '..');
const outDir = path.join(__dirname, '_shots');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const htmlSrc = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');

/**
 * 把驱动脚本注入一份 HTML 副本。
 * 必须写在项目根目录：素材是 JS 里用相对路径 assets/... 动态设置的，
 * 若把副本放进 tests/ 或 _shots/ 就会全部 404（真实 index.html 不受影响，但截图会全花）。
 * 所以这里改成「生成即登记，跑完自清理」：正常结束、异常、Ctrl+C 都会删掉。
 */
const drivenFiles = [];

function makeDriven(name, script) {
  const driven = htmlSrc.replace('</body>', '<script>\n' + script + '\n</script>\n</body>');
  const f = path.join(rootDir, name);
  fs.writeFileSync(f, driven, 'utf8');
  drivenFiles.push(f);
  return f;
}

/** 逐个删除本脚本生成的那几个固定文件（不用通配符，不碰目录里其它东西） */
function cleanupDriven() {
  while (drivenFiles.length) {
    const f = drivenFiles.pop();
    try { fs.rmSync(f, { force: true }); } catch (e) { /* 删不掉也不影响截图结果 */ }
  }
}

// 兜底：正常退出 / 异常退出 / Ctrl+C（SIGINT）/ SIGTERM 都清一次
process.on('exit', cleanupDriven);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const urlOf = f => 'file:///' + f.replace(/\\/g, '/').replace(/ /g, '%20');

/**
 * 桌面截图（CLI 路径，保持原样）。
 * @param {string} outName  输出文件名
 * @param {string} targetFile 页面文件
 * @param {number} height   桌面档的窗口高（1280 宽）
 * @param {number} budget   virtual-time-budget
 */
function shoot(outName, targetFile, height, budget) {
  const out = path.join(outDir, outName);
  const profile = path.join(process.env.TEMP, 'cshot_' + Math.random().toString(36).slice(2, 10));
  // 先删旧图：Chrome 偶尔返回非零码但没写出新图，只看 exists 会把陈旧截图当成成功
  try { fs.rmSync(out, { force: true }); } catch (e) {}
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--user-data-dir=' + profile,
      '--hide-scrollbars',
      '--window-size=1280,' + (height || 800),
      '--virtual-time-budget=' + (budget || 9000),
      '--screenshot=' + out,
      urlOf(targetFile)
    ], { stdio: 'pipe', timeout: 90000 });
  } catch (e) { /* Windows 下 Chrome 常返回非零码，截图通常已生成 */ }

  const ok = fs.existsSync(out);
  console.log((ok ? '  ✓ ' : '  ✗ ') + outName + (ok ? '  (' + fs.statSync(out).size + ' bytes)' : ''));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  return ok;
}

/* ==========================================================================
   手机竖屏：CDP 精确视口
   --------------------------------------------------------------------------
   Windows 上 --window-size 会被夹到最小约 490px 宽（高度也会被窗口边框吃掉），
   --force-device-scale-factor 只放大像素、不缩布局视口：页面按 490 布局，
   --screenshot 只截左边 390 → 看起来像「内容横向溢出」，其实是工具在说谎。
   所以手机档改用 CDP：Emulation.setDeviceMetricsOverride 才能拿到真正的 390×844。
   ========================================================================== */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/** 端口上已经有 DevTools 端点 → 视为被占用 */
async function portBusy(port) {
  try { await httpJson('http://127.0.0.1:' + port + '/json/version'); return true; }
  catch (e) { return false; }
}

async function waitForJson(url, timeout) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try { return await httpJson(url); } catch (e) { last = e; }
    await sleep(150);
  }
  throw last || new Error('等待超时：' + url);
}

/**
 * 起一个带调试端口的 headless Chrome。
 * 注意：不传 --window-size / --force-device-scale-factor（视口由 CDP 覆盖）。
 */
async function launchCdpChrome() {
  const profile = path.join(process.env.TEMP, 'cshot_cdp_' + Math.random().toString(36).slice(2, 10));
  let lastErr = null;
  for (let i = 0; i < 10; i++) {
    const port = 9333 + i;                     // 被占用就 +1 重试
    if (await portBusy(port)) continue;
    const child = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--user-data-dir=' + profile,
      '--hide-scrollbars',
      '--remote-debugging-port=' + port,
      'about:blank'
    ], { stdio: 'ignore' });
    // spawn 失败（Chrome 路径不对）会异步抛 'error'，和端口轮询 race，避免干等 15s×10
    const childErr = new Promise((_, rej) => child.once('error', rej));
    try {
      const ver = await Promise.race([
        waitForJson('http://127.0.0.1:' + port + '/json/version', 15000),
        childErr
      ]);
      const list = await waitForJson('http://127.0.0.1:' + port + '/json/list', 5000);
      const page = (list || []).find(t => t.type === 'page');
      if (!page || !page.webSocketDebuggerUrl) throw new Error('没有可用的 page target');
      return {
        child, port, profile,
        browserWs: ver.webSocketDebuggerUrl,
        pageWs: page.webSocketDebuggerUrl
      };
    } catch (e) {
      lastErr = e;
      try { child.kill(); } catch (e2) {}
      await sleep(400);
    }
  }
  throw lastErr || new Error('无法启动 Chrome 调试端口（9333-9342 都被占用？）');
}

/** 极简 CDP 客户端：send(method, params) → Promise<result>（Node 24 自带全局 WebSocket） */
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() { try { ws.close(); } catch (e) {} }
      });
    });
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message || 'CDP error'));
        else p.res(msg.result || {});
      }
    });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败：' + wsUrl)));
  });
}

async function waitForValue(client, expr, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r && r.result && r.result.value) return r.result.value;
    } catch (e) { /* 导航中上下文销毁，忽略 */ }
    await sleep(120);
  }
  throw new Error('等待超时：' + expr);
}

/** 读 PNG 头里的宽高（3x 像素），用于二次自校验 */
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

let mobileFail = 0;

/**
 * 手机截图：CDP 覆盖视口 → 导航 → 等 App.G + 驱动完成标记 → 截图 → 自校验。
 * 自校验同时看两处：Runtime.evaluate 的 innerWidth/innerHeight/dpr，以及 PNG 头的像素宽高。
 */
async function shootMobile(page, outName, targetFile, width, height, readyExpr) {
  const out = path.join(outDir, outName);
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 3, mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 }
  });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.send('Page.navigate', { url: urlOf(targetFile) });

  // 页面就绪：App.G 已创建（驱动脚本已点过开始）；开局截图没有 App.G，传 readyExpr 覆盖
  await waitForValue(page, readyExpr || '!!(window.BombCats && window.BombCats.App && window.BombCats.App.G)', 8000);
  // 驱动脚本收尾（battle 的 10 次结束回合跑完）
  await waitForValue(page, 'document.title === "MOBILE_READY"', 10000);
  await sleep(350);   // 让最后一张牌/提示条稳定
  // 飞牌克隆是 300-400ms 的一次性元素，可能在 READY 之后才起播；
  // 截前统一清理，避免把半空的卡背/卡面当成布局问题。
  await page.send('Runtime.evaluate', {
    expression: 'document.querySelectorAll(".fly-card").forEach(function (n) { n.remove(); })'
  });

  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(data, 'base64'));

  const vp = await page.send('Runtime.evaluate', {
    expression: 'JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })',
    returnByValue: true
  });
  const got = JSON.parse(vp.result.value);
  const png = pngSize(out);
  const ok = got.w === width && got.h === height && got.dpr === 3 &&
             !!png && png.w === width * 3 && png.h === height * 3;

  console.log((ok ? '  ✓ ' : '  ✗ ') + outName +
    '  (' + (png ? png.w + '×' + png.h : 'PNG?') + '，视口 ' + got.w + '×' + got.h + ' dpr' + got.dpr + ')');
  if (!ok) {
    mobileFail++;
    console.error('    自校验失败：期望视口 ' + width + '×' + height + ' dpr3 / PNG ' +
      (width * 3) + '×' + (height * 3) + '，实际视口 ' + got.w + '×' + got.h + ' dpr' + got.dpr +
      ' / PNG ' + (png ? png.w + '×' + png.h : '读取失败'));
  }
  return ok;
}

/* ---- 驱动脚本 1：开局并推进到真人回合 ---- */
const battleScript = `
window.addEventListener('load', function () {
  setTimeout(function () {
    document.getElementById('btnStart').click();
    var n = 0;
    var iv = setInterval(function () {
      n++;
      var end = document.getElementById('btnEnd');
      if (end && !end.disabled) { try { end.click(); } catch (e) {} }
      if (n > 9) clearInterval(iv);
    }, 320);
  }, 120);
});
`;

/* ---- 驱动脚本 5：手机档（与 battle 同样的推进，额外打一个完成标记给 CDP 等） ---- */
const mobileScript = `
window.addEventListener('load', function () {
  setTimeout(function () {
    document.getElementById('btnStart').click();
    var n = 0;
    var iv = setInterval(function () {
      n++;
      var end = document.getElementById('btnEnd');
      if (end && !end.disabled) { try { end.click(); } catch (e) {} }
      if (n > 9) {
        clearInterval(iv);
        // 先冻结 AI 再等空闲：只让已经开始的那一手播完，不再起新动作。
        // 反过来做（空了才冻结）会撞上 driveAI 已经越过 isAI 检查的异步收尾，
        // READY 之后还会冒出抽牌飞行动画，截到一张盖住牌堆的大卡背。
        (function waitIdle() {
          var App = window.BombCats && window.BombCats.App;
          if (!waitIdle.frozen) {
            waitIdle.frozen = true;
            if (App && App.G && App.G.players) {
              App.G.players.forEach(function (p) {
                if (p.id !== App.humanId) p.isAI = false;
              });
            }
          }
          // 飞牌克隆不写 App.busy：等它飞完再定格
          if ((App && App.busy) ||
              document.querySelector('.fly-card') ||
              document.querySelector('.draw-flash.show')) {
            setTimeout(waitIdle, 100);
            return;
          }
          setTimeout(function () {
            // 静置期间若又起了一帧（上一手 AI 的收尾），继续等而不是直接截图
            if ((App && App.busy) ||
                document.querySelector('.fly-card') ||
                document.querySelector('.draw-flash.show')) {
              setTimeout(waitIdle, 100);
              return;
            }
            document.querySelectorAll('.fly-card').forEach(function (n) { n.remove(); });
            document.title = 'MOBILE_READY';
          }, 600);
        })();
      }
    }, 320);
  }, 120);
});
`;

/* ---- 驱动脚本 6：手机说明条（选中一张可出的牌，主按钮为「出牌」） ---- */
const inspectScript = `
window.addEventListener('load', function () {
  setTimeout(async function () {
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    document.getElementById('btnStart').click();
    await wait(900);
    var BC = window.BombCats, App = BC.App, G = App.G;
    if (!G) { document.title = 'MOBILE_READY'; return; }
    // 模拟触摸输入：说明条只在 App.input === 'touch' 时出现
    App.input = 'touch';
    var appEl = document.querySelector('.app');
    if (appEl) appEl.classList.add('touch-input');
    // 先等开局动画/飞牌结束，再改状态；半路改 busy 会把动画停在中间
    for (var i = 0; i < 30 && (App.busy || document.querySelector('.fly-card')); i++) await wait(100);
    G.current = App.humanId;
    G.pendingBomb = null;   // 清掉开局 AI 抽炸弹留下的待放回状态，否则没有可出的牌
    App.busy = false;
    // 冻结全部 AI：只摘当前座位的 isAI 挡不住别的定时器
    G.players.forEach(function (p) { if (p.id !== App.humanId) p.isAI = false; });
    // 保证手里有一张无需目标、可直接出的牌
    var me = G.players[App.humanId];
    me.hand.push({ uid: 990001, type: 'skip', name: BC.CARDS.skip.name, glyph: BC.CARDS.skip.glyph, kind: 'action' });
    App.render();
    await wait(150);
    var lm = BC.Engine.legalMoves(G, App.humanId);
    var pick = lm.playable[0];
    if (pick) {
      App.selectedUid = pick.cardUid;
      App.selectedAt = Date.now();
      App.awaitingTarget = false;
      App.render();
    }
    // 等动画结束再定格（沿用 App.busy === false + 静置的策略，最多等 4s）
    for (var i = 0; i < 40 && App.busy; i++) await wait(100);
    await wait(450);
    document.title = 'MOBILE_READY';
  }, 150);
});
`;

/* ---- 驱动脚本 7：手机放置条（真人待放炸弹，选中第 2 档） ---- */
const placeScript = `
window.addEventListener('load', function () {
  setTimeout(async function () {
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    document.getElementById('btnStart').click();
    await wait(900);
    var BC = window.BombCats, App = BC.App, G = App.G;
    if (!G) { document.title = 'MOBILE_READY'; return; }
    App.input = 'touch';
    var appEl = document.querySelector('.app');
    if (appEl) appEl.classList.add('touch-input');
    G.current = App.humanId;
    App.busy = false;
    // 造出「真人待放炸弹」的状态（只影响 UI，不提交；放置条由 render 显示）
    G.pendingBomb = { player: App.humanId };
    App.render();
    await wait(200);
    // 选第 2 档：牌堆出现金色插入线，确认按钮变为可用
    var bar = document.getElementById('placeBar');
    var slot2 = bar && bar.querySelector('.pb-slot[data-slot="2"]');
    if (slot2 && !slot2.disabled) slot2.click();
    // 等动画结束再定格（沿用 App.busy === false + 静置的策略，最多等 4s）
    for (var i = 0; i < 40 && App.busy; i++) await wait(100);
    await wait(450);
    document.title = 'MOBILE_READY';
  }, 150);
});
`;

/* ---- 驱动脚本 2：选中一张需要目标的牌（帮忙），进入瞄准态 ----
   截图要的是稳定画面，所以直接把「已选中 + 等待目标」的状态摆好；
   真实点击路径由 browser.test.js 覆盖。 */
const aimingScript = `
window.addEventListener('load', function () {
  setTimeout(async function () {
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    document.getElementById('btnStart').click();
    await wait(1400);
    var BC = window.BombCats, App = BC.App, G = App.G;
    if (!G) { document.title = 'NOG'; return; }
    // 确保轮到真人，并冻结全部 AI，防止开局定时器把回合抢回去
    G.current = App.humanId;
    G.pendingBomb = null;          // 若开局 1.4s 内有人抽到炸弹，清掉待放回状态，否则所有出牌都会被规则正确禁掉
    App.busy = false;
    var me = G.players[App.humanId];
    me.hand = me.hand.filter(function (c) { return c.type !== 'help'; });
    me.hand.push({ uid: 999001, type: 'help',
      name: BC.CARDS.help.name, glyph: BC.CARDS.help.glyph, kind: 'action' });
    // 保证至少两个对手有 2 张以上手牌，才可能出现可选目标
    G.players.forEach(function (p) {
      if (p.id !== App.humanId) {
        p.isAI = false;
        if (p.hand.length < 2) p.hand.push({ uid: 800000 + p.id, type: 'skip', name: '跳过', glyph: '⏭️', kind: 'action' });
      }
    });
    App.render();
    await wait(200);
    var lm = BC.Engine.legalMoves(G, App.humanId);
    var move = lm.needTarget.find(function (m) { return m.cardUid === 999001; });
    if (!move) { document.title = 'NO_TARGET_MOVE'; return; }
    App.selectedUid = 999001;
    App.selectedAt = Date.now();
    App.awaitingTarget = true;
    App.render();
    var cards = document.querySelectorAll('#hand .card');
    var blank = 0;
    for (var i = 0; i < cards.length; i++) {
      var t = cards[i].querySelector('.ctext');
      if (!t || !t.textContent) blank++;
    }
    await wait(280);
    document.querySelectorAll('.fly-card').forEach(function (n) { n.remove(); });
    var aim = document.querySelectorAll('.opponent.targetable').length;
    document.title = 'CARDS=' + cards.length + ',BLANK=' + blank + ',TARGETABLE=' + aim;
  }, 120);
});
`;

/* ---- 驱动脚本 3：走真实结算路径 ---- */
const resultScript = `
window.addEventListener('load', function () {
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  setTimeout(async function () {
    document.getElementById('btnStart').click();
    await wait(900);
    var App = window.BombCats.App, G = App.G;
    if (!G) { document.title = 'NOG'; return; }
    // 让所有 AI 出局，只留真人，然后把对局判定为结束，走真实的 checkGameOver
    G.players.forEach(function (p) {
      if (p.id !== App.humanId) { p.alive = false; p.hand = []; }
    });
    G.turn = 18;
    G.phase = 'over';
    G.winner = App.humanId;
    App.stats.played = 7;
    App.checkGameOver();
    // 等结算弹层淡入完成再截图，否则会拍到半透明的过渡帧
    await wait(1700);
    // 兜底：无头环境下 CSS 过渡偶尔不会被推进到终态，这里强制定格
    var mask = document.getElementById('modalResult');
    mask.style.transition = 'none';
    mask.classList.add('show');
    await wait(400);
    document.title = 'RESULT';
  }, 150);
});
`;

/* ---- 驱动脚本 4：抽牌瞬间（验证「抽到什么」有明确反馈） ---- */
const drawScript = `
window.addEventListener('load', function () {
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  setTimeout(async function () {
    document.getElementById('btnStart').click();
    await wait(900);
    var App = window.BombCats.App, G = App.G;
    G.current = App.humanId;
    App.busy = false;
    App.render();
    await wait(150);
    // 结束回合触发真实抽牌流程
    document.getElementById('btnEnd').click();
    await wait(900);
    // 抽牌反馈是否真的触发了
    var drawn = App.lastDrawn;
    var hadNew = App.newUid != null && drawn != null;
    // 把那一刻抽到的牌定格在台面上，方便截图（否则动画会在截图前结束）。
    // 手牌不用手动重绘：live 渲染已经带上了「新」高亮，
    // 手动渲染还得重算可出牌集合，容易画出全灰的假状态。
    if (drawn) window.BombCats.View.showDrawnCard(drawn, 60000);
    // 定格揭晓后清掉仍在飞的卡背克隆，别让「翻牌」被一张半路卡背挡住
    document.querySelectorAll('.fly-card').forEach(function (n) { n.remove(); });
    document.title = 'DRAW:' + (hadNew ? 'OK' : 'MISS');
  }, 150);
});
`;

/* ---- 驱动脚本 8：手机目标栏（选中需要目标的牌；触摸路径选中即进入选目标） ---- */
const targetScript = `
window.addEventListener('load', function () {
  setTimeout(async function () {
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    document.getElementById('btnStart').click();
    await wait(900);
    var BC = window.BombCats, App = BC.App, G = App.G;
    if (!G) { document.title = 'MOBILE_READY'; return; }
    App.input = 'touch';
    var appEl = document.querySelector('.app');
    if (appEl) appEl.classList.add('touch-input');
    // 等待开局动画结束后再接管状态，否则会把正在飞的牌停在半空
    for (var i = 0; i < 30 && (App.busy || document.querySelector('.fly-card')); i++) await wait(100);
    G.current = App.humanId;
    // 竞态防护：开局 900ms 内可能已经有人抽到炸弹（pendingBomb），
    // 也可能有 AI 回合正在收尾。不清掉待放回状态的话，legalMoves 会正确地返回空，
    // 截图就会退化成「现在不能出」的普通说明条，而不是目标栏。
    G.pendingBomb = null;
    G.players.forEach(function (p) { if (p.id !== App.humanId) p.isAI = false; });
    App.busy = false;
    // 保证手里有一张需要目标的牌（求饶），且至少两个对手可被指定
    var me = G.players[App.humanId];
    me.hand.push({ uid: 990002, type: 'favor', name: BC.CARDS.favor.name, glyph: BC.CARDS.favor.glyph, kind: 'action' });
    G.players.forEach(function (p) {
      if (p.id !== App.humanId && p.hand.length < 2) p.hand.push({ uid: 800000 + p.id, type: 'skip', name: '跳过', glyph: '⏭️', kind: 'action' });
    });
    App.render();
    await wait(150);
    // 模拟触摸 pointerup 的新行为：选中 need-target 牌时直接 awaitingTarget = true
    App.selectedUid = 990002;
    App.selectedAt = Date.now();
    App.awaitingTarget = true;
    App.render();
    for (var i = 0; i < 40 && App.busy; i++) await wait(100);
    await wait(450);
    document.title = 'MOBILE_READY';
  }, 150);
});
`;

/* ---- 驱动脚本 9：事件横幅 + 洗牌动效（触发后冻结动画中段，供截图验收） ---- */
const floaterScript = `
window.addEventListener('load', function () {
  setTimeout(async function () {
    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    document.getElementById('btnStart').click();
    // 竞态防护：AI 回合的事件横幅会在冻结前覆盖我们触发的这条（此前抓到过）
    var G = window.BombCats.App.G;
    if (G) G.players[G.current].isAI = false;
    await wait(1100);
    var BC = window.BombCats;
    BC.App.busy = false;
    BC.View.floater('洗牌', 'var(--gold)', { sub: '牌堆已重洗' });
    BC.View.shufflePile();
    // 确定性冻结：等动画注册后，用 WAAPI 暂停并跳到 riffle 第一峰（180ms）/横幅成形（190ms）。
    // 不用「真实等待 + 全局暂停」——overshoot 缓动前段极快，真实时序很难掐准（已踩过坑）。
    await wait(60);
    var anims = document.getAnimations ? document.getAnimations() : [];
    Array.prototype.forEach.call(anims, function (a) {
      var n = a.animationName || '';
      if (n === 'riffleA' || n === 'riffleB' || n === 'badgeJitter' || n === 'floatUp') {
        try { a.pause(); a.currentTime = (n === 'floatUp') ? 190 : 180; } catch (e) {}
      }
    });
    document.title = 'MOBILE_READY';
  }, 150);
});
`;

/* ---- 驱动脚本 10：手机开局设置（停在弹窗，只给截图打完成标记） ---- */
const mobileSetupScript = `
window.addEventListener('load', function () {
  setTimeout(function () { document.title = 'MOBILE_READY'; }, 400);
});
`;

console.log('\n生成截图 → ' + outDir + '\n');

(async function main() {
  try {
    // ---------- 桌面 5 张：CLI 路径（保持原样，不受 CDP 改动影响） ----------
    shoot('01-setup.png', path.join(rootDir, 'index.html'), 800, 2600);
    shoot('02-battle.png', makeDriven('_driven-battle.html', battleScript), 800, 11000);
    shoot('03-aiming.png', makeDriven('_driven-aiming.html', aimingScript), 800, 9000);
    shoot('04-result.png', makeDriven('_driven-result.html', resultScript), 800, 9000);
    shoot('05-draw.png', makeDriven('_driven-draw.html', drawScript), 800, 7000);

    // ---------- 手机 6 张：CDP 精确视口 ----------
    const mobileFile = makeDriven('_driven-mobile.html', mobileScript);
    const inspectFile = makeDriven('_driven-mobile-inspect.html', inspectScript);
    const placeFile = makeDriven('_driven-mobile-place.html', placeScript);
    const targetFile = makeDriven('_driven-mobile-target.html', targetScript);
    const floaterFile = makeDriven('_driven-floater.html', floaterScript);
    const setupFile = makeDriven('_driven-mobile-setup.html', mobileSetupScript);
    const shots = [
      ['06-mobile-390.png', mobileFile, 390, 844],
      ['07-mobile-360.png', mobileFile, 360, 640],
      ['08-mobile-430.png', mobileFile, 430, 932],
      ['09-mobile-360short.png', mobileFile, 360, 560],   // 触发矮屏档 max-height:620
      ['10-mobile-390-inspect.png', inspectFile, 390, 844],  // 说明条展开（选中可出的牌）
      ['11-mobile-390-place.png', placeFile, 390, 844],      // 放置条展开（炸弹放回）
      ['12-mobile-390-target.png', targetFile, 390, 844],    // 目标栏（触摸选中即选目标）
      ['13-floater-shuffle.png', floaterFile, 390, 844],     // 事件横幅 + 洗牌 riffle（冻结帧）
      ['14-mobile-390-setup.png', setupFile, 390, 844, 'true'] // 手机开局弹窗（不点开始）
    ];
    const chrome = await launchCdpChrome();
    const browser = await cdpConnect(chrome.browserWs);
    const page = await cdpConnect(chrome.pageWs);
    try {
      for (const s of shots) await shootMobile(page, s[0], s[1], s[2], s[3], s[4]);
    } finally {
      page.close();
      try { await browser.send('Browser.close'); } catch (e) {}
      browser.close();
      try { chrome.child.kill(); } catch (e) {}
      try { fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch (e) {}
    }

    if (mobileFail) {
      console.error('\n手机视口自校验失败 ' + mobileFail + ' 张：这些截图不可信，请先修工具。\n');
      process.exitCode = 1;
      return;
    }
    console.log('\n完成。\n');
  } finally {
    // 自清理：即使上面某一步抛异常，也要把根目录里的驱动副本删干净
    cleanupDriven();
  }
})().catch(err => {
  console.error('\n截图失败：' + (err && err.message ? err.message : err) + '\n');
  cleanupDriven();
  process.exitCode = 1;
});

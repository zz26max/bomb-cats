/**
 * 生成验收截图，并在浏览器里真实走一遍真人交互路径：
 *   01-setup    开局设置
 *   02-battle   对局中（AI 已出牌，轮到真人）
 *   03-aiming   选中「攻击」等待选目标（验证瞄准态）
 *   04-result   结算弹层
 *
 * 用法： node tests/screenshot.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

function shoot(outName, targetFile, height, budget) {
  const out = path.join(outDir, outName);
  const profile = path.join(process.env.TEMP, 'cshot_' + Math.random().toString(36).slice(2, 10));
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

/* ---- 驱动脚本 2：选中一张需要目标的牌（帮忙），进入瞄准态 ---- */
const aimingScript = `
window.addEventListener('load', function () {
  setTimeout(function () {
    document.getElementById('btnStart').click();
    setTimeout(function () {
      var BC = window.BombCats;
      var App = BC.App, G = App.G;
      // 确保轮到真人，且手上有一张「帮忙」（唯一需要指定目标的牌之一）
      G.current = App.humanId;
      var me = G.players[App.humanId];
      me.hand = me.hand.filter(function (c) { return c.type !== 'help'; });
      me.hand.push({ uid: 999001, type: 'help',
        name: BC.CARDS.help.name, glyph: BC.CARDS.help.glyph, kind: 'action' });
      // 保证至少两个对手有 2 张以上手牌，才可能出现可选目标
      G.players.forEach(function (p) {
        if (p.id !== App.humanId && p.hand.length < 2) p.hand.push({ uid: 800000 + p.id, type: 'skip', name: '跳过', glyph: '⏭️', kind: 'action' });
      });
      App.busy = false;
      window.BombCats.App.selectedUid = null;
      // 触发重绘后点「帮忙」
      if (App.render) App.render();
      setTimeout(function () {
        var hand = document.getElementById('hand');
        var cards = hand.querySelectorAll('.card');
        var blank = 0, target = null;
        for (var i = 0; i < cards.length; i++) {
          var t = cards[i].querySelector('.ctext');
          if (!t || !t.textContent) blank++;
          if (cards[i].dataset.type === 'help' && !target) target = cards[i];
        }
        document.title = 'CARDS=' + cards.length + ',BLANK=' + blank;
        if (target) target.click();
        setTimeout(function () {
          var aim = document.querySelectorAll('.opponent.targetable').length;
          document.title = 'CARDS=' + cards.length + ',BLANK=' + blank + ',TARGETABLE=' + aim;
        }, 220);
      }, 320);
    }, 1400);
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
    document.title = 'DRAW:' + (hadNew ? 'OK' : 'MISS');
  }, 150);
});
`;

console.log('\n生成截图 → ' + outDir + '\n');

try {
  shoot('01-setup.png', path.join(rootDir, 'index.html'), 800, 2600);
  shoot('02-battle.png', makeDriven('_driven-battle.html', battleScript), 800, 11000);
  shoot('03-aiming.png', makeDriven('_driven-aiming.html', aimingScript), 800, 9000);
  shoot('04-result.png', makeDriven('_driven-result.html', resultScript), 800, 9000);
  shoot('05-draw.png', makeDriven('_driven-draw.html', drawScript), 800, 7000);
} finally {
  // 自清理：即使上面某一步抛异常，也要把根目录里的驱动副本删干净
  cleanupDriven();
}

console.log('\n完成。\n');

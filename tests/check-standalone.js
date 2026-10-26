/**
 * 单文件版验收：在「只有这一个 HTML」的空目录里开局、出牌、抽牌、爆炸，
 * 检查所有图片是否真的加载成功。
 *
 * 用法： node tests/check-standalone.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = path.join(rootDir, '炸弹猫-单文件版.html');

if (!fs.existsSync(SRC)) {
  console.log('未找到单文件版，请先运行： node tools/build-standalone.js');
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-'));
const target = path.join(tmpDir, 'standalone.html');
fs.copyFileSync(SRC, target);

const html = fs.readFileSync(target, 'utf8');
const driver = `
<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    var out = [];
    var ok = function (n, c, extra) { out.push((c ? 'PASS ' : 'FAIL ') + n + (extra ? '(' + extra + ')' : '')); };

    // 1. 开局后所有图片
    document.getElementById('btnStart').click();
    setTimeout(function () {
      var App = window.BombCats.App;
      var broken = [];
      [].forEach.call(document.querySelectorAll('img'), function (im) {
        if (!(im.complete && im.naturalWidth > 0)) broken.push(im.getAttribute('src') ? im.getAttribute('src').slice(0, 40) : '(no src)');
      });
      ok('开局后图片全部加载', broken.length === 0, broken.join(' | '));

      // 2. 手牌用的是内联数据而不是外链
      var cardArt = document.querySelector('#hand .card .cart');
      ok('卡牌插画已内联', !!cardArt && cardArt.src.indexOf('data:image/webp') === 0,
        cardArt ? cardArt.src.slice(0, 30) : '无');
      ok('猫头像已内联', (document.querySelector('.opp-avatar .cat') || {src:''}).src.indexOf('data:') === 0);

      // 3. 牌桌背景是否内联进了 CSS
      var sheet = document.querySelector('style');
      ok('样式已内联', !!sheet);
      ok('CSS 背景图已转 data URI', !!sheet && sheet.textContent.indexOf('url("data:image/webp') >= 0);

      // 4. 正常打一回合（抽牌 + 卡面渲染不报错）
      var before = App.G.deck.length;
      App.G.current = App.humanId;
      App.busy = false;
      App.render();
      setTimeout(function () {
        document.getElementById('btnEnd').click();
        setTimeout(function () {
          ok('结束回合能正常抽牌', App.G.deck.length < before || App.G.pendingBomb,
            before + '->' + App.G.deck.length);
          ok('抽牌后记住了抽到的牌', !!App.lastDrawn, App.lastDrawn ? App.lastDrawn.name : 'null');

          var brok2 = [];
          [].forEach.call(document.querySelectorAll('img'), function (im) {
            if (!(im.complete && im.naturalWidth > 0)) brok2.push('x');
          });
          ok('抽牌后仍无裂图', brok2.length === 0, brok2.length + ' 张');

          out.push('errors=' + (window.__errs ? window.__errs.length : 0));
          document.title = 'SOLO|' + out.join('|');
        }, 1400);
      }, 200);
    }, 700);
  }, 150);
});
window.__errs = [];
window.addEventListener('error', function (e) { window.__errs.push(e.message); });
</script>
`;

fs.writeFileSync(target, html.replace('</body>', driver + '</body>'), 'utf8');

const profile = path.join(os.tmpdir(), 'ck_' + Math.random().toString(36).slice(2, 10));
const url = 'file:///' + target.replace(/\\/g, '/').replace(/ /g, '%20');

let dom = '';
try {
  dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + profile,
    '--window-size=1093,902',
    '--virtual-time-budget=12000',
    '--dump-dom', url
  ], { stdio: 'pipe', timeout: 120000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) { dom = String(e.stdout || ''); }

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

const m = dom.match(/<title>([^<]*)<\/title>/);
console.log('\n=== 单文件版验收（空目录，无 assets/） ===\n');
if (!m || m[1].indexOf('SOLO|') !== 0) {
  console.log('未取到结果，title =', m ? JSON.stringify(m[1].slice(0, 80)) : '(无)');
  process.exit(1);
}

let pass = 0, fail = 0;
m[1].slice(5).split('|').forEach(line => {
  if (line.startsWith('PASS ')) { pass++; console.log('  ✓ ' + line.slice(5)); }
  else if (line.startsWith('FAIL ')) { fail++; console.log('  ✗ ' + line.slice(5)); }
  else if (line.startsWith('errors=')) {
    const n = parseInt(line.slice(7), 10) || 0;
    if (n === 0) { pass++; console.log('  ✓ 无 JavaScript 报错'); }
    else { fail++; console.log('  ✗ 有 ' + n + ' 个 JS 报错'); }
  }
});
console.log(`\n结果：${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);

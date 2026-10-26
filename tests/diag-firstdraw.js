/**
 * 复现「开局必抽到炸弹」问题。
 * 在真实页面里连续开 40 局，记录每局真人第一次抽牌抽到了什么。
 *
 * 用法： node tests/diag-firstdraw.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const htmlSrc = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');

const driver = `
<script>
window.__log = [];
window.addEventListener('error', function (e) { window.__log.push('ERR:' + e.message); });

window.addEventListener('load', function () {
  setTimeout(function () {
    var BC = window.BombCats;
    var results = [];

    for (var i = 0; i < 40; i++) {
      // 每种人数都测一遍
      var counts = [2, 3, 4];
      var pc = counts[i % 3];

      // 直接调引擎，复刻 main.js 的播种方式
      var seed = (Date.now() + i * 7919) >>> 0;
      var G = BC.Engine.createGame({
        playerCount: pc,
        rng: BC.RNG.seeded(seed),
        humanIndex: 0,
        names: ['你', 'AI1', 'AI2', 'AI3']
      });

      // 记录牌堆前 4 张的类型
      var top4 = G.deck.slice(0, 4).map(function (c) { return c.type; }).join(',');

      // 真人直接结束回合，看抽到什么
      G.current = 0;
      var before = G.deck.length;
      var r = BC.Engine.endTurn(G, 0);
      var events = (r.events || []).map(function (e) { return e.type; }).join('+');
      var drawn = null;
      (r.events || []).forEach(function (e) { if (e.type === 'draw' && e.card) drawn = e.card.type; });
      var exploded = (r.events || []).some(function (e) { return e.type === 'explode'; });

      results.push(pc + 'p|' + seed + '|top=' + top4 + '|drew=' + (drawn || '?') +
        (exploded ? '|EXPLODE' : '') + '|ev=' + events + '|deck=' + before + '->' + G.deck.length);
    }

    document.title = 'DIAG|' + results.join('||');
  }, 250);
});
</script>
`;

const driven = htmlSrc.replace('</body>', driver + '</body>').replace(/(src|href)="/g, '$1="../');
const tmpFile = path.join(rootDir, 'tests', '_diag-firstdraw.html');
fs.writeFileSync(tmpFile, driven, 'utf8');

const profile = path.join(process.env.TEMP, 'cdiag_' + Math.random().toString(36).slice(2, 10));
const url = 'file:///' + tmpFile.replace(/\\/g, '/').replace(/ /g, '%20');

let dom = '';
try {
  dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + profile,
    '--window-size=1280,800',
    '--virtual-time-budget=12000',
    '--dump-dom', url
  ], { stdio: 'pipe', timeout: 120000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
} catch (e) { dom = String(e.stdout || ''); }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

const m = dom.match(/<title>([^<]*)<\/title>/);
console.log('\n=== 浏览器内连开 40 局，玩家直接抽牌 ===\n');
if (!m || m[1].indexOf('DIAG|') !== 0) {
  console.log('未取到结果，title =', m ? JSON.stringify(m[1]) : '(无)');
  process.exit(1);
}

const rows = m[1].slice(5).split('||');
let bombDrawn = 0, explode = 0;
rows.forEach(r => {
  console.log('  ' + r);
  if (/drew=bomb/.test(r) || /EXPLODE/.test(r)) bombDrawn++;
  if (/EXPLODE/.test(r)) explode++;
});
console.log(`\n  抽到炸弹 ${bombDrawn}/${rows.length}  其中直接爆炸 ${explode}`);

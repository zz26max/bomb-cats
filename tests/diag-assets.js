/**
 * 资源加载诊断：打开真实 index.html，报告所有加载失败的图片/样式/脚本，
 * 以及它们实际请求的绝对路径，用来定位「素材没加载」到底断在哪一环。
 *
 * 用法： node tests/diag-assets.js
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
window.__report = { broken: [], ok: 0, cssOk: false, jsOk: false, base: location.href };

window.addEventListener('load', function () {
  setTimeout(function () {
    // 1. 所有 <img> 的加载结果
    var imgs = document.querySelectorAll('img');
    [].forEach.call(imgs, function (img) {
      if (img.complete && img.naturalWidth > 0) { window.__report.ok++; }
      else { window.__report.broken.push('IMG|' + img.getAttribute('src')); }
    });

    // 2. 背景图单独测：用 Image 对象去请求 CSS 里用到的素材
    var bgTests = [
      '../assets/cards/frame.webp', // 相对 styles/main.css 会这样写，这里直接用根路径测
      'assets/cards/frame.webp',
      'assets/cards/back.webp',
      'assets/table/felt.webp',
      'assets/brand/logo-cn.svg'
    ];
    var pending = bgTests.length;
    bgTests.forEach(function (u) {
      var t = new Image();
      t.onload = function () { window.__report.ok++; done(); };
      t.onerror = function () { window.__report.broken.push('PROBE|' + u); done(); };
      t.src = u;
    });
    function done() {
      pending--;
      if (pending > 0) return;
      // 3. 样式与脚本是否生效
      window.__report.cssOk = getComputedStyle(document.body).getPropertyValue('--gold').trim() !== '';
      window.__report.jsOk = !!(window.BombCats && window.BombCats.App);
      window.__report.sheetCount = document.styleSheets.length;
      try { window.__report.sheetRules = document.styleSheets[0].cssRules.length; }
      catch (e) { window.__report.sheetRules = 'ERR'; }
      document.title = 'ASSETS|' + JSON.stringify(window.__report);
    }
  }, 900);
});
</script>
`;

const driven = htmlSrc.replace('</body>', driver + '</body>');
const tmp = path.join(rootDir, '_diag-assets.html');
fs.writeFileSync(tmp, driven, 'utf8');

const profile = path.join(process.env.TEMP, 'cdiag_' + Math.random().toString(36).slice(2, 10));
const url = 'file:///' + tmp.replace(/\\/g, '/').replace(/ /g, '%20');

let dom = '';
try {
  dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + profile,
    '--window-size=1093,902',
    '--virtual-time-budget=8000',
    '--dump-dom', url
  ], { stdio: 'pipe', timeout: 120000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
} catch (e) { dom = String(e.stdout || ''); }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
try { fs.rmSync(tmp, { force: true }); } catch (e) {}

const m = dom.match(/<title>([^<]*)<\/title>/);
console.log('\n=== 资源加载诊断 ===\n');
if (!m || m[1].indexOf('ASSETS|') !== 0) {
  console.log('未取到报告，title =', m ? JSON.stringify(m[1]) : '(无)');
  process.exit(1);
}
const r = JSON.parse(m[1].slice(7));
console.log('页面地址   :', r.base);
console.log('CSS 变量   :', r.cssOk ? 'OK' : '未生效');
console.log('JS 命名空间:', r.jsOk ? 'OK' : '未初始化');
console.log('样式表数量 :', r.sheetCount, ' 首表规则数:', r.sheetRules);
console.log('加载成功   :', r.ok);
console.log('加载失败   :', r.broken.length);
r.broken.forEach(b => console.log('   ✗ ' + b));

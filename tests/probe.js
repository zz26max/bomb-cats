/**
 * 运行时诊断：在 headless Chrome 里开局、推进若干回合，
 * 然后把关键 DOM 尺寸与状态打印到 document.title，供外部读取。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = 'file:///' + path.join(rootDir, 'index.html').replace(/\\/g, '/').replace(/ /g, '%20');

const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(function(){
    var out = [];
    try {
      document.getElementById('btnStart').click();
    } catch(e){ out.push('startbtn:' + e.message); }

    setTimeout(function(){
      try {
        var hand = document.getElementById('hand');
        var app = document.querySelector('.app');
        var table = document.querySelector('.table');
        var stage = document.querySelector('.stage');
        var zone = document.querySelector('.handzone');
        function box(n){ if(!n) return 'null'; var r=n.getBoundingClientRect();
          return Math.round(r.width)+'x'+Math.round(r.height)+'@'+Math.round(r.top); }
        out.push('app=' + box(app));
        out.push('table=' + box(table));
        out.push('stage=' + box(stage));
        out.push('handzone=' + box(zone));
        out.push('hand=' + box(hand));
        out.push('handCards=' + (hand ? hand.children.length : -1));
        out.push('winH=' + window.innerHeight);
        if (hand && hand.children.length) {
          var c = hand.children[0];
          var cs = getComputedStyle(c);
          out.push('card0=' + Math.round(c.getBoundingClientRect().width) + 'x' + Math.round(c.getBoundingClientRect().height));
          out.push('cardDisplay=' + cs.display);
          out.push('cardOpacity=' + cs.opacity);
          out.push('cardVis=' + cs.visibility);
        }
        // 检查是否有 JS 报错
        out.push('err=' + (window.__err || 'none'));
      } catch(e){ out.push('probe:' + e.message); }
      document.title = 'PROBE|' + out.join('|');
    }, 4200);
  }, 200);
});
window.addEventListener('error', function(e){ window.__err = e.message; });
</script>
`;

const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const driven = html.replace('</body>', probe + '</body>').replace(/(src|href)="/g, '$1="../');
const tmp = path.join(rootDir, 'tests', '_probe.html');
fs.writeFileSync(tmp, driven, 'utf8');

const probeUrl = 'file:///' + tmp.replace(/\\/g, '/').replace(/ /g, '%20');
const profile = path.join(process.env.TEMP, 'cprobe_' + Math.random().toString(36).slice(2, 10));

// 用 --dump-dom 拿到渲染后的 DOM，再从 title 里取探针结果
let dom = '';
try {
  dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + profile,
    '--virtual-time-budget=9000',
    '--window-size=1280,880',
    '--dump-dom', probeUrl
  ], { stdio: 'pipe', timeout: 90000, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
} catch (e) {
  dom = (e.stdout || '') + '';
}

const m = dom.match(/<title>([^<]*)<\/title>/);
console.log('\n=== 探针结果 ===');
if (m && m[1].indexOf('PROBE|') === 0) {
  m[1].slice(6).split('|').forEach(line => console.log('  ' + line));
} else {
  console.log('  未取到探针数据。title =', m ? m[1] : '(无)');
  // 退而求其次：报告页面里有没有 reportError
  const handMatch = dom.match(/<div class="hand" id="hand"[^>]*>([\s\S]{0,400})/);
  console.log('  hand 片段:', handMatch ? handMatch[1].slice(0, 300) : '(未找到)');
}
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
console.log('');

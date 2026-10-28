/**
 * 浏览器端交互冒烟测试。
 * 在真实 Chrome 里跑一局：开局 → 点手牌出牌 → 结束回合抽牌 → 再出一张需要目标的牌，
 * 最后把「每一步的断言结果」写进 document.title 供外部读取。
 *
 * 用法： node tests/browser.test.js
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
window.__errors = [];
window.addEventListener('error', function (e) { window.__errors.push(e.message); });

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function handIds() {
  return [].map.call(document.querySelectorAll('#hand .card'), function (c) { return c.dataset.type; });
}
// 需要指定目标的牌，点一下只会进入瞄准态，不会立刻打出
var TARGET_CARDS = ['favor', 'help'];
function clickFirstPlayable() {
  var cards = document.querySelectorAll('#hand .card.playable');
  if (!cards.length) return null;
  // 优先挑一张「不需要目标」的牌，保证点下去就是真的出牌
  var pick = null;
  for (var i = 0; i < cards.length; i++) {
    if (TARGET_CARDS.indexOf(cards[i].dataset.type) < 0) { pick = cards[i]; break; }
  }
  if (!pick) return null;
  var t = pick.dataset.type;
  pick.click();
  return t;
}

window.addEventListener('load', function () {
  setTimeout(async function () {
    var out = [];
    var ok = function (name, cond, extra) {
      out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '(' + extra + ')' : ''));
    };

    try {
      // 1. 开局
      document.getElementById('btnStart').click();
      await wait(900);
      var App = window.BombCats.App;
      ok('对局已创建', !!App.G);
      ok('开局有牌堆', App.G.deck.length > 0, 'deck=' + App.G.deck.length);

      // 2. 强制轮到真人，并塞一张确定「无需目标」的牌，保证这一步可复现
      App.G.current = App.humanId;
      App.G.players[App.humanId].hand.push(
        { uid: 990001, type: 'nothing', name: '无效果', glyph: '🃏', kind: 'passive' });
      App.busy = false;
      App.render();
      await wait(150);

      var before = handIds().length;
      var played = clickFirstPlayable();
      await wait(700);
      var after = handIds().length;
      ok('点击手牌能正常出牌', played !== null, '打出了 ' + played);
      // 「摸两张」是 -1+2=净 +1，其余牌都是 -1；攻击的队列检查也要在结束回合前做
      // （等 1100ms 再查 pendingDraws 会被 AI 的回合抢跑，随机翻车）
      var handDelta = (played === 'draw2') ? 1 : -1;
      ok('出牌后手牌数量正确', after === before + handDelta, before + '->' + after);
      if (played === 'attack') {
        ok('打出攻击后攻击队列挂起（下家要抽 2 次）',
          App.G.attackQueue === 2, 'attackQueue=' + App.G.attackQueue);
      }
      ok('出牌进入弃牌堆', App.G.discard.length > 0, 'discard=' + App.G.discard.length);

      // 3. 结束回合 → 抽牌结算。
      //    注意「跳过 / 攻击」的规则就是本回合不抽牌，所以要先看打出的是什么。
      var noDrawCard = (played === 'skip' || played === 'attack');
      var deckBefore = App.G.deck.length;
      document.getElementById('btnEnd').click();
      await wait(1100);

      if (noDrawCard) {
        // 打出跳过后本回合不抽牌，牌堆不变；攻击的队列已在上面查过 attackQueue
        // （这里的 pendingDraws 会被 AI 回合随时改写，不再适合延时断言）
        ok('打出「' + played + '」后本回合不抽牌（规则正确）',
          App.G.deck.length === deckBefore, deckBefore + '->' + App.G.deck.length);
      } else {
        ok('结束回合后确实抽了牌', App.G.deck.length < deckBefore,
          deckBefore + '->' + App.G.deck.length);

        // 抽牌必须有明确反馈：记忆抽到了什么 + 台面展示 + 手牌高亮
        ok('抽牌后记住了抽到的那张牌', !!App.lastDrawn, App.lastDrawn ? App.lastDrawn.name : 'null');
        ok('抽牌后标记了新手牌 uid', App.newUid != null, 'newUid=' + App.newUid);

        var flashText = document.querySelector('#drawFlashCard .card .cname');
        ok('台面中央展示了抽到的牌',
          !!flashText && App.lastDrawn && flashText.textContent === App.lastDrawn.name,
          flashText ? flashText.textContent : '没渲染');

        var marked = document.querySelectorAll('#hand .card.newly-drawn').length;
        if (App.lastDrawn && App.lastDrawn.kind === 'bomb') {
          // 抽到炸弹（已被拆除）：炸弹不进手牌，手上不该有任何「新」高亮。
          // 没写这个分支时，约 1/8 的对局抽到炸弹会让下面两条断言随机翻车。
          ok('抽到炸弹时手牌没有新手牌高亮', marked === 0, marked + ' 张被标记');
        } else {
          ok('手牌里高亮了刚抽到的那一张', marked === 1, marked + ' 张被标记');

          var badge = document.querySelector('#hand .card.newly-drawn');
          ok('高亮的那张牌与抽牌记录一致',
            !!badge && parseInt(badge.dataset.uid, 10) === App.newUid);
        }
      }

      // 4. 需要目标的牌：造一张「帮忙」，验证瞄准态与选择目标
      if (App.G.pendingBomb) {
        // 若停在放回炸弹的流程，先让脚本替他放回
        window.BombCats.Engine.placeBomb(App.G, App.G.pendingBomb.player, App.G.deck.length);
        if (App.G.turnEndPending) window.BombCats.Engine.resumeAfterPlacement(App.G, App.G.current);
      }
      App.busy = false;
      App.G.current = App.humanId;
      // 前面的随机对局可能已经分出胜负（有人抽弹出局）——这里恢复成「进行中」，
      // 否则 legalMoves 恒为空，选目标断言必然是 0 个（间歇翻车点）
      App.G.phase = 'playing';
      App.G.winner = null;
      App.G.players.forEach(function (p) {
        p.alive = true;
        if (p.id !== App.humanId) {
          while (p.hand.length < 2) {
            p.hand.push({ uid: 800000 + p.id * 10 + p.hand.length, type: 'skip', name: '跳过', glyph: '⏭️', kind: 'action' });
          }
        }
      });
      var me = App.G.players[App.humanId];
      me.hand.push({ uid: 999001, type: 'help', name: '帮忙', glyph: '🤝', kind: 'action' });
      App.G.players.forEach(function (p) {
        if (p.id !== App.humanId && p.hand.length < 2) {
          p.hand.push({ uid: 800000 + p.id, type: 'skip', name: '跳过', glyph: '⏭️', kind: 'action' });
        }
      });
      App.render();
      await wait(150);

      var helpCard = document.querySelector('#hand .card[data-type="help"]');
      ok('需要目标的牌出现在手牌里', !!helpCard);
      if (helpCard) {
        helpCard.click();
        await wait(300);
        var aim = document.querySelectorAll('.opponent.targetable').length;
        ok('点击后进入瞄准态', aim > 0, aim + ' 个可选目标');

        var target = document.querySelector('.opponent.targetable');
        if (target) {
          var tid = parseInt(target.dataset.pid, 10);
          var handBefore = App.G.players[App.humanId].hand.length;
          target.click();
          await wait(800);
          ok('选择目标后成功结算',
            App.G.players[App.humanId].hand.length !== handBefore || App.G.discard.length > 0,
            '手牌 ' + handBefore + '->' + App.G.players[App.humanId].hand.length);
        }
      }

      // 5. 界面完整性
      ok('对手区渲染了 3 名对手', document.querySelectorAll('.opponent').length === 3);
      ok('牌堆数字已显示', document.querySelector('.pile-stack .badge-num').textContent !== '');
      ok('日志有内容', document.querySelectorAll('#logList .entry').length > 0);
      ok('卡面文字非空',
        [].every.call(document.querySelectorAll('#hand .card .ctext'), function (t) { return t.textContent; }));

      // 6. 结算面板：出牌数必须真的统计到（这里曾经永远是 0）
      var playedBefore = App.stats.played;
      ok('已统计到玩家出牌数', playedBefore >= 1, 'played=' + playedBefore);

      App.G.phase = 'over';
      App.G.winner = App.humanId;
      App.checkGameOver();
      await wait(900);
      ok('结算弹层已弹出', document.getElementById('modalResult').classList.contains('show'));
      var statPlayed = document.getElementById('statPlayed').textContent;
      ok('结算面板的出牌数与实际一致', String(playedBefore) === statPlayed,
        '面板=' + statPlayed + ' 实际=' + playedBefore);
      ok('结算面板的回合数是数字',
        /^[0-9]+$/.test(document.getElementById('statTurns').textContent),
        'turns=' + document.getElementById('statTurns').textContent);
      ok('结算面板显示了用时',
        /^[0-9]+s$/.test(document.getElementById('statTime').textContent),
        'time=' + document.getElementById('statTime').textContent);
    } catch (e) {
      out.push('FAIL 运行时异常: ' + e.message);
    }

    out.push('errors=' + window.__errors.length + (window.__errors.length ? ':' + window.__errors[0] : ''));
    document.title = 'RESULT|' + out.join('|');
  }, 220);
});
</script>
`;

const driven = htmlSrc
  .replace('</body>', driver + '</body>')
  .replace(/(src|href)="/g, '$1="../');
const tmpFile = path.join(rootDir, 'tests', '_browser-smoke.html');
fs.writeFileSync(tmpFile, driven, 'utf8');

const profile = path.join(process.env.TEMP, 'csmoke_' + Math.random().toString(36).slice(2, 10));
const url = 'file:///' + tmpFile.replace(/\\/g, '/').replace(/ /g, '%20');

let dom = '';
try {
  dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + profile,
    '--window-size=1280,800',
    '--virtual-time-budget=20000',
    '--dump-dom', url
  ], { stdio: 'pipe', timeout: 120000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
} catch (e) {
  dom = String(e.stdout || '');
}
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

const m = dom.match(/<title>([^<]*)<\/title>/);
console.log('\n=== 浏览器交互冒烟测试 ===\n');
if (!m || m[1].indexOf('RESULT|') !== 0) {
  console.log('  未取到结果，title =', m ? JSON.stringify(m[1]) : '(无)');
  process.exit(1);
}

const lines = m[1].slice(7).split('|');
let pass = 0, fail = 0;
lines.forEach(l => {
  if (l.startsWith('PASS ')) { pass++; console.log('  ✓ ' + l.slice(5)); }
  else if (l.startsWith('FAIL ')) { fail++; console.log('  ✗ ' + l.slice(5)); }
  else if (l.startsWith('errors=')) {
    const n = parseInt(l.split('=')[1], 10);
    if (n === 0) { pass++; console.log('  ✓ 页面无 JavaScript 报错'); }
    else { fail++; console.log('  ✗ 页面有 ' + l.slice(7) + ' JS 报错'); }
  }
});
console.log(`\n结果：${pass} 通过, ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);

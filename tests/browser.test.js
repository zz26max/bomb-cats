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
// 等动画播完：固定 700ms 会漏掉「摸两张」这种连续抽牌动画，后续点击被 busy 吞掉
async function waitIdle(app, max) {
  var t0 = Date.now();
  while (app.busy && Date.now() - t0 < (max || 4000)) await wait(50);
  await wait(60);
}

function handIds() {
  return [].map.call(document.querySelectorAll('#hand .card'), function (c) { return c.dataset.type; });
}

window.addEventListener('load', function () {
  setTimeout(async function () {
    var out = [];
    var ok = function (name, cond, extra) {
      out.push((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '(' + extra + ')' : ''));
    };

    try {
      // 1. 开局。立刻冻结 AI 并把回合交给真人：
      //    新局可能随机由 AI 先手，若等 900ms 再接管，在途的 driveAI 会在
      //    后续用例里继续抢 busy / 结束回合，造成随机翻车。
      document.getElementById('btnStart').click();
      var App = window.BombCats.App;
      App.G.players.forEach(function (p) { p.isAI = false; });
      // 冒烟脚本前面的用例都在验证「牌打出去就该生效」；把否决牌从随机牌局里拿走，
      // 免得 AI 偶尔摸到一张否决、把断言要验证的效果取消掉。否决本身在 4b 单独测。
      App.G.deck = App.G.deck.filter(function (c) { return c.type !== 'nope'; });
      App.G.discard = App.G.discard.filter(function (c) { return c.type !== 'nope'; });
      App.G.players.forEach(function (p) {
        p.hand = p.hand.filter(function (c) { return c.type !== 'nope'; });
      });
      App.G.current = App.humanId;
      App.busy = false;
      App.render();
      await wait(900);
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
      // 只打注入的「无效果」：随机挑牌可能抽到「摸两张」再摸到炸弹，
      // 把后面的结束回合流程带进放置分支，整条用例就随机翻车。
      var playedEl = document.querySelector('#hand .card[data-uid="990001"]');
      ok('注入的「无效果」可点', !!playedEl && playedEl.classList.contains('playable'));
      var played = 'nothing';
      if (playedEl) playedEl.click();
      await waitIdle(App);
      var after = handIds().length;
      ok('点击手牌能正常出牌', App.G.discard.some(function (c) { return c.uid === 990001; }),
        '打出了 ' + played);
      ok('出牌后手牌数量正确', after === before - 1, before + '->' + after);
      ok('出牌进入弃牌堆', App.G.discard.length > 0, 'discard=' + App.G.discard.length);

      // 3. 结束回合 → 抽牌结算。
      //    注意「跳过 / 攻击」的规则就是本回合不抽牌，所以要先看打出的是什么。
      var noDrawCard = (played === 'skip' || played === 'attack');
      var deckBefore = App.G.deck.length;
      document.getElementById('btnEnd').click();
      await waitIdle(App);

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

      // 3b. 跳过牌：打出后必须明确告诉玩家「本回合不抽牌」。
      //     之前引擎正确清零了 pendingDraws，但提示、按钮、牌堆入口都还在说「抽牌」，
      //     玩家点完跳过看不出任何变化，误以为这张牌失效。
      App.busy = false;
      App.G.pendingBomb = null;
      App.G.turnEndPending = false;
      App.G.phase = 'playing';
      App.G.winner = null;
      App.G.current = App.humanId;
      App.G.pendingDraws = 1;
      App.G.mustDraw = true;
      App.G.players.forEach(function (p) {
        p.alive = true;
        if (p.id !== App.humanId) p.isAI = false;   // 冻结 AI，避免它抢走回合
      });
      var skipUid = 991001;
      // 手牌里可能本来就有一张「跳过」，而合法动作按牌型去重；
      // 先清掉同类型，保证下面点到的注入牌一定是可出的那一张。
      App.G.players[App.humanId].hand = App.G.players[App.humanId].hand
        .filter(function (c) { return c.type !== 'skip'; });
      App.G.players[App.humanId].hand.push({
        uid: skipUid, type: 'skip', name: '跳过', glyph: '⏭️', kind: 'action'
      });
      App.render();
      await wait(150);
      var skipEl = document.querySelector('#hand .card[data-uid="' + skipUid + '"]');
      ok('跳过牌已进入手牌', !!skipEl);
      var skipDeck = App.G.deck.length;
      if (skipEl) {
        skipEl.click();
        await waitIdle(App);
        ok('打出跳过：本回合抽牌数清零', App.G.pendingDraws === 0,
          'pendingDraws=' + App.G.pendingDraws);
        var skipPrompt = document.getElementById('prompt').textContent;
        ok('跳过后的提示明确写「不抽牌」', skipPrompt.indexOf('不抽牌') >= 0, skipPrompt);
        var endSpan = document.querySelector('#btnEnd > span');
        ok('跳过后的结束按钮不再写「抽牌」',
          !!endSpan && endSpan.textContent.indexOf('抽牌') < 0,
          endSpan ? endSpan.textContent : '找不到按钮');
        var cueEl = document.querySelector('.draw-cue');
        ok('牌堆入口提示切换为「结束回合」',
          !!cueEl && cueEl.textContent === '结束回合',
          cueEl ? cueEl.textContent : '找不到提示');
        document.querySelector('.pile-stack').click();
        await waitIdle(App);
        ok('跳过回合点击牌堆结束时不抽牌', App.G.deck.length === skipDeck,
          skipDeck + '->' + App.G.deck.length);
      }

      // 3b2. 同名卡：合法动作按牌型去重，但玩家手里两张「跳过」都该能点，
      //      点第二张也必须真的打出去（此前 UI 只认第一个 uid）。
      App.busy = false;
      App.selectedUid = null;
      App.awaitingTarget = false;
      App.G.pendingBomb = null;
      App.G.turnEndPending = false;
      App.G.phase = 'playing';
      App.G.winner = null;
      App.G.current = App.humanId;
      App.G.pendingDraws = 1;
      App.G.attackQueue = 0;
      App.G.mustDraw = true;
      App.G.players.forEach(function (p) { p.alive = true; p.isAI = false; });
      App.G.players[App.humanId].hand = App.G.players[App.humanId].hand
        .filter(function (c) { return c.type !== 'skip'; });
      App.G.players[App.humanId].hand.push(
        { uid: 993001, type: 'skip', name: '跳过', glyph: '⏭️', kind: 'action' },
        { uid: 993002, type: 'skip', name: '跳过', glyph: '⏭️', kind: 'action' }
      );
      App.render();
      await wait(150);
      var dup1 = document.querySelector('#hand .card[data-uid="993001"]');
      var dup2 = document.querySelector('#hand .card[data-uid="993002"]');
      ok('两张同名「跳过」都显示为可点',
        !!dup1 && !!dup2 &&
        dup1.classList.contains('playable') && dup2.classList.contains('playable'),
        '第一张=' + (dup1 && dup1.className) + ' 第二张=' + (dup2 && dup2.className));
      if (dup2) {
        dup2.click();
        await waitIdle(App);
        ok('点第二张同名「跳过」也能打出', App.G.pendingDraws === 0,
          'pendingDraws=' + App.G.pendingDraws);
      }

      // 3c. 键盘结束回合的边界：瞄准目标、焦点在按钮上时都不能抢走回合。
      //     空格/回车曾绕过 canHumanDraw：瞄准时直接结束回合，焦点在「提示」上
      //     按回车会既看提示又结束回合。
      App.busy = false;
      App.selectedUid = null;
      App.awaitingTarget = false;
      App.G.pendingBomb = null;
      App.G.turnEndPending = false;
      App.G.phase = 'playing';
      App.G.winner = null;
      App.G.current = App.humanId;
      App.G.pendingDraws = 1;
      App.G.attackQueue = 0;
      App.G.mustDraw = true;
      App.G.players.forEach(function (p) {
        p.alive = true;
        p.isAI = false;
        while (p.id !== App.humanId && p.hand.length < 2) {
          p.hand.push({ uid: 870000 + p.id * 10 + p.hand.length, type: 'skip', name: '跳过', glyph: '⏭️', kind: 'action' });
        }
      });
      App.G.players[App.humanId].hand = App.G.players[App.humanId].hand
        .filter(function (c) { return c.type !== 'help'; });
      App.G.players[App.humanId].hand.push({
        uid: 992001, type: 'help', name: '帮忙', glyph: '🤝', kind: 'action'
      });
      App.render();
      await wait(150);
      var aimCard = document.querySelector('#hand .card[data-uid="992001"]');
      ok('键盘用例的「帮忙」已就位', !!aimCard);
      if (aimCard) {
        aimCard.click();
        await wait(250);
        ok('瞄准态结束按钮不可点', document.getElementById('btnEnd').disabled === true);
        var keyCur = App.G.current;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        await wait(700);
        ok('瞄准态按空格不会结束回合',
          App.G.current === keyCur && App.awaitingTarget === true,
          'current ' + keyCur + '->' + App.G.current);

        App.awaitingTarget = false;
        App.selectedUid = null;
        var hintBtn = document.getElementById('btnHint');
        hintBtn.focus();
        keyCur = App.G.current;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await wait(700);
        ok('焦点在提示按钮时回车不会结束回合',
          App.G.current === keyCur, 'current ' + keyCur + '->' + App.G.current);
        hintBtn.blur();
        App.render();
        await wait(120);
      }

      // 4. 需要目标的牌：造一张「帮忙」，验证瞄准态与选择目标
      App.awaitingTarget = false;
      App.selectedUid = null;
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
      me.hand = me.hand.filter(function (c) { return c.type !== 'help'; });
      me.hand.push(
        { uid: 999001, type: 'help', name: '帮忙', glyph: '🤝', kind: 'action' },
        { uid: 999002, type: 'help', name: '帮忙', glyph: '🤝', kind: 'action' }
      );
      App.G.players.forEach(function (p) {
        if (p.id !== App.humanId && p.hand.length < 2) {
          p.hand.push({ uid: 800000 + p.id, type: 'skip', name: '跳过', glyph: '⏭️', kind: 'action' });
        }
      });
      App.render();
      await wait(150);

      // 必须按注入的 uid 取：被过滤掉的旧「帮忙」卡还会以 leaving 动画短暂留在 DOM 里。
      // 点第二张同名卡，顺带验证「按牌型映射」：只匹配首个 uid 时它会直接取消瞄准。
      var helpCard = document.querySelector('#hand .card[data-uid="999002"]');
      var helpCard1 = document.querySelector('#hand .card[data-uid="999001"]');
      ok('需要目标的牌出现在手牌里', !!helpCard && !helpCard.classList.contains('leaving'));
      ok('两张同名「帮忙」都显示为可点',
        !!helpCard1 && !!helpCard &&
        helpCard1.classList.contains('playable') && helpCard.classList.contains('playable'));
      if (helpCard) {
        helpCard.click();
        await wait(300);
        var aim = document.querySelectorAll('.opponent.targetable').length;
        ok('点击后进入瞄准态', aim > 0,
          aim + ' 个可选目标, aiming=' + App.awaitingTarget +
          ', selected=' + App.selectedUid);

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

      // 4b. 否决窗口：AI 打出牌后，真人手里有否决时回应条必须出现；
      //     点「否决」取消原牌，点「放过」让原牌生效。
      function setupNopeWindow(uid) {
        App.online = null;
        App.busy = false;
        App.input = 'mouse';
        App.awaitingTarget = false;
        App.selectedUid = null;
        App.G.pendingAction = null;
        App.G.pendingBomb = null;
        App.G.turnEndPending = false;
        App.G.phase = 'playing';
        App.G.winner = null;
        App.G.current = 1;
        App.G.pendingDraws = 1;
        App.G.attackQueue = 0;
        App.G.mustDraw = true;
        App.G.players.forEach(function (p) {
          p.alive = true;
          p.isAI = false;
          p.hand = p.hand.filter(function (c) { return c.type !== 'nope' && c.type !== 'skip'; });
        });
        App.G.players[0].hand.push(
          { uid: uid + 1, type: 'nope', name: '否决', glyph: 'x', kind: 'action' });
        App.G.players[1].hand.push(
          { uid: uid, type: 'skip', name: '跳过', glyph: 'x', kind: 'action' });
        var r = window.BombCats.Engine.playCard(App.G, 1, uid);
        App.render();
        return r;
      }

      var nopeBar = document.getElementById('nopeBar');
      var r1 = setupNopeWindow(996000);
      ok('引擎进入否决窗口', r1.ok && r1.pending === true && !!App.G.pendingAction);
      ok('轮到自己回应时回应条出现', nopeBar.classList.contains('show'));
      ok('回应条写明被打出的牌',
        document.getElementById('nopeTitle').textContent.indexOf('跳过') >= 0,
        document.getElementById('nopeTitle').textContent);
      ok('否决窗口内结束回合不可点', document.getElementById('btnEnd').disabled === true);
      var statsBeforeNope = App.stats.played;
      var pending1 = App.resolvePendingResponses();
      document.getElementById('btnNope').click();
      await pending1;
      ok('打出否决后窗口关闭', App.G.pendingAction === null);
      ok('被否决的牌没有生效', App.G.pendingDraws === 1 && App.G.mustDraw === true,
        'pendingDraws=' + App.G.pendingDraws + ' mustDraw=' + App.G.mustDraw);
      ok('否决后回应条收起', !nopeBar.classList.contains('show'));
      ok('否决计入出牌统计', App.stats.played === statsBeforeNope + 1,
        statsBeforeNope + '->' + App.stats.played + '（含窗口里打出的否决）');

      var r2 = setupNopeWindow(996010);
      ok('第二个窗口正常打开', r2.ok && r2.pending === true);
      var pending2 = App.resolvePendingResponses();
      document.getElementById('btnNopePass').click();
      await pending2;
      ok('放过之后原牌正常生效', App.G.pendingDraws === 0 && App.G.mustDraw === false,
        'pendingDraws=' + App.G.pendingDraws + ' mustDraw=' + App.G.mustDraw);
      ok('放过后回应条收起', !nopeBar.classList.contains('show'));

      // 手里没有否决：窗口不由真人处理，回应条不能出现；AI 自己回应完后窗口关闭
      App.G.pendingAction = null;
      App.G.current = 1;
      App.G.pendingDraws = 1;
      App.G.mustDraw = true;
      App.G.players.forEach(function (p) {
        p.hand = p.hand.filter(function (c) { return c.type !== 'nope' && c.type !== 'skip'; });
      });
      App.G.players[2].hand.push(
        { uid: 996020, type: 'nope', name: '否决', glyph: 'x', kind: 'action' });
      App.G.players[1].hand.push(
        { uid: 996021, type: 'skip', name: '跳过', glyph: 'x', kind: 'action' });
      window.BombCats.Engine.playCard(App.G, 1, 996021);
      App.render();
      ok('手里没有否决时回应条不出现', !nopeBar.classList.contains('show'));
      await App.resolvePendingResponses();
      ok('AI 回应后窗口自动关闭', App.G.pendingAction === null);
      App.G.current = App.humanId;
      App.G.pendingDraws = 1;
      App.G.mustDraw = true;
      App.render();
      await wait(120);

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

      // 7. 重开：打开设置面板后，旧对局的 AI 不能继续在后台出牌。
      //    否则玩家在设置面板里挑选人数时，旧牌桌还在自己推进（甚至弹出结算层）。
      document.getElementById('btnRestart').click();   // 结算面板 → 设置面板
      await wait(100);
      document.getElementById('btnStart').click();      // 开一局新的
      await wait(900);
      App.busy = false;
      App.G.phase = 'playing';
      App.G.winner = null;
      App.G.pendingBomb = null;
      App.G.turnEndPending = false;
      App.G.pendingDraws = 0;
      App.G.attackQueue = 0;
      App.G.players.forEach(function (p) { p.alive = true; });
      App.G.current = App.humanId;
      App.render();
      await wait(150);
      document.getElementById('btnEnd').click();        // 推进到 AI，挂上 AI 计时器
      await wait(450);
      var restartTurn = App.G.turn;
      var restartDeck = App.G.deck.length;
      var restartDiscard = App.G.discard.length;
      document.getElementById('btnRestart').click();
      await wait(1800);
      ok('打开重开面板后旧对局的 AI 停止行动',
        App.G.turn === restartTurn && App.G.deck.length === restartDeck &&
        App.G.discard.length === restartDiscard,
        'turn ' + restartTurn + '->' + App.G.turn +
        ', deck ' + restartDeck + '->' + App.G.deck.length +
        ', discard ' + restartDiscard + '->' + App.G.discard.length);
      ok('重开面板保持打开', document.getElementById('modalSetup').classList.contains('show'));

      // 8. 联机桌面端放回炸弹：待放状态由服务器推送，本地没有 handlePlacementIfNeeded。
      //    渲染后必须给牌堆挂上临时放置监听器，否则 1280px 桌面（放置条只在窄屏出现）
      //    点牌堆毫无反应，玩家会卡死在「炸弹放回哪里？」。
      var fakeState = JSON.parse(JSON.stringify(window.BombCats.Engine.getState(App.G)));
      fakeState.phase = 'playing';
      fakeState.winner = null;
      fakeState.current = App.humanId;
      fakeState.pendingBomb = { player: App.humanId };
      fakeState.deckSize = 10;
      fakeState.players.forEach(function (p) {
        p.hand = p.id === App.humanId ? [] : null;
      });
      App.G.pendingBomb = null;
      var sent = [];
      App.online = {
        state: fakeState,
        moves: { playable: [], needTarget: [] },
        conn: { send: function (m) { sent.push(m); return true; } },
        code: 'TEST', seat: App.humanId, token: 'x', name: 'T', host: false, pendingOpen: []
      };
      App.busy = false;
      App.selectedUid = null;
      App.awaitingTarget = false;
      App.render();
      await wait(150);
      var onlinePile = document.querySelector('.pile-stack');
      ok('联机待放炸弹时牌堆进入放置模式', onlinePile.style.cursor === 'pointer',
        'cursor=' + JSON.stringify(onlinePile.style.cursor));
      // 点牌堆正中间：牌堆 10 张，插入位置应为第 5 张（12 槽预览的中间档）
      var pileRect = onlinePile.getBoundingClientRect();
      onlinePile.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: pileRect.left + pileRect.width / 2,
        clientY: pileRect.top + pileRect.height / 2
      }));
      await wait(150);
      ok('联机桌面端能提交炸弹放回',
        sent.some(function (m) { return m.t === 'act' && m.act === 'place'; }),
        JSON.stringify(sent));
      var placeMsg = sent.filter(function (m) { return m.act === 'place'; })[0];
      ok('联机放回位置与点击高度一致', !!placeMsg && placeMsg.pos === 5,
        placeMsg ? 'pos=' + placeMsg.pos : '没提交');

      // 8b. 手机 / 窄屏走放置条：联机局没有本地 App.G，
      //     档位与确认若仍读 App.G 就会静默返回，玩家在「炸弹放回哪里」永久卡住。
      sent.length = 0;
      fakeState.pendingBomb = { player: App.humanId };
      App.input = 'touch';
      App.busy = false;
      App.render();
      await wait(150);
      var placeBar = document.getElementById('placeBar');
      ok('联机手机端显示放置条', placeBar.classList.contains('show'));
      var slotBtn = placeBar.querySelector('.pb-slot[data-slot="3"]');
      ok('放置条档位可点', !!slotBtn && !slotBtn.disabled);
      if (slotBtn) {
        slotBtn.click();
        await wait(120);
        var okBtn = placeBar.querySelector('.pb-ok');
        ok('选档后确认按钮可用', !!okBtn && !okBtn.disabled);
        if (okBtn) okBtn.click();
        await wait(150);
      }
      var mobilePlace = sent.filter(function (m) { return m.act === 'place'; })[0];
      ok('联机手机端能提交炸弹放回', !!mobilePlace, JSON.stringify(sent));
      ok('联机手机端放回位置正确', !!mobilePlace && mobilePlace.pos === 2,
        mobilePlace ? 'pos=' + mobilePlace.pos : '没提交');

      // 8c. 联机爆炸事件：全新联机会话没有本地 App.G，
      //     播放事件不能解引用 App.G，否则对手一炸就抛异常、事件队列卡死。
      var savedG = App.G;
      App.G = null;
      fakeState.pendingBomb = null;
      App.busy = false;
      await App.playEvents([{ type: 'explode', player: 2 }]);
      var boomSub = document.querySelector('#floater .f-sub');
      ok('联机爆炸事件在无本地 App.G 时也能播放',
        !!boomSub && boomSub.textContent.indexOf(fakeState.players[2].name) >= 0,
        boomSub ? boomSub.textContent : '无飘字');
      App.G = savedG;

      // 8c2. 联机否决邀请：回应条由服务器的私有 respond 驱动。
      //      动画播放中（busy）不能抢焦点；点「否决」只发 respond，不碰本地引擎。
      fakeState.pendingAction = {
        player: 1, card: { type: 'skip', name: '跳过' }, target: null, nopes: []
      };
      sent.length = 0;
      App.online.state = fakeState;
      App.online.respond = { pending: true, deadline: Date.now() + 6000 };
      App.busy = true;
      App.render();
      await wait(120);
      ok('联机动画播放中不弹否决条',
        !document.getElementById('nopeBar').classList.contains('show'));
      App.busy = false;
      App.render();
      await wait(120);
      var onlineNopeBar = document.getElementById('nopeBar');
      ok('联机收到私有邀请后回应条出现', onlineNopeBar.classList.contains('show'));
      var onlineNopeTitle = document.getElementById('nopeTitle').textContent;
      ok('联机回应条写明被打出的牌', onlineNopeTitle.indexOf('跳过') >= 0, onlineNopeTitle);
      ok('联机回应条显示倒计时',
        /^[0-9]+ 秒$|自动放过/.test(document.getElementById('nopeTimer').textContent),
        document.getElementById('nopeTimer').textContent);
      document.getElementById('btnNope').click();
      await wait(120);
      ok('联机否决只发 respond 消息',
        sent.length === 1 && sent[0].t === 'respond' && sent[0].nope === true,
        JSON.stringify(sent));
      ok('联机否决后回应条收起', !onlineNopeBar.classList.contains('show'));
      document.getElementById('btnNope').click();
      await wait(80);
      ok('联机否决后重复点击不会再发消息', sent.length === 1, JSON.stringify(sent));
      App.busy = false;
      App.online.respond = null;
      fakeState.pendingAction = null;

      // 8c3. 回应邀请的时序：服务器先广播 update 再私发 respond，而 update 可能
      //      在动画期间排队。等它出队时若把更新的 respond 一起清掉，回应条就永远
      //      不出现，玩家只能看着服务器 8 秒后自动放过。
      App.online.respond = null;
      App.online.msgSeq = 0;
      var queueStateA = JSON.parse(JSON.stringify(fakeState));
      queueStateA.pendingAction = null;
      var queueStateB = JSON.parse(JSON.stringify(fakeState));
      queueStateB.pendingAction = {
        player: 1, card: { type: 'skip', name: '跳过' }, target: null, nopes: []
      };
      var queueMoves = { playable: [], needTarget: [] };
      App.busy = false;
      App.netReceive({ t: 'update', state: queueStateA, moves: queueMoves,
        events: [{ type: 'nope', player: 2, chain: 1 }] });   // 动画占住队列
      App.netReceive({ t: 'update', state: queueStateB, moves: queueMoves, events: [] });
      App.netReceive({ t: 'respond', deadline: Date.now() + 8000 });
      await wait(600);
      ok('动画期间排队的快照不会吃掉随后到达的否决邀请',
        document.getElementById('nopeBar').classList.contains('show'),
        'busy=' + App.busy + ', respond=' + JSON.stringify(App.online.respond));
      // 反过来：比邀请更新的快照说明上一轮窗口已结束，回应条不能残留
      App.netReceive({ t: 'update', state: queueStateA, moves: queueMoves, events: [] });
      await wait(150);
      ok('更新的快照仍会收起过期的否决回应条',
        !document.getElementById('nopeBar').classList.contains('show'));
      App.busy = false;
      App.online.respond = null;
      App.online.state = fakeState;

      App.input = 'mouse';
      App.online = null;
      App.busy = false;

      // 8d. 单机桌面放回炸弹：与联机共用放置逻辑，改完要确认本地路径没被带坏
      App.G.phase = 'playing';
      App.G.winner = null;
      App.G.turnEndPending = false;
      App.G.current = App.humanId;
      App.G.pendingBomb = {
        player: App.humanId,
        card: { uid: 777001, type: 'bomb', name: '炸弹猫', glyph: '💣', kind: 'bomb' }
      };
      App.render();
      await wait(150);
      var localDeck = App.G.deck.length;
      var localPile = document.querySelector('.pile-stack');
      var localRect = localPile.getBoundingClientRect();
      localPile.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: localRect.left + localRect.width / 2,
        clientY: localRect.top + localRect.height / 2
      }));
      await wait(500);
      ok('单机桌面能把炸弹放回牌堆',
        App.G.pendingBomb === null && App.G.deck.length === localDeck + 1,
        'pending=' + !!App.G.pendingBomb + ', deck ' + localDeck + '->' + App.G.deck.length);
      ok('放回的炸弹确实进了牌堆',
        App.G.deck.some(function (c) { return c.uid === 777001; }));

      // 9. 玩家名 XSS：提示条是唯一把名字拼进 innerHTML 的位置。
      //    联机时名字由对手填写，必须当纯文本渲染，不能生成元素或执行 onerror。
      var evilName = '<img src=x onerror="window.__xss=1">';
      App.G.players[1].name = evilName;
      App.G.phase = 'playing';
      App.G.winner = null;
      App.G.pendingBomb = null;
      App.G.current = 1;
      App.G.players.forEach(function (p) { p.isAI = false; });
      App.render();
      await wait(200);
      var promptEl = document.getElementById('prompt');
      ok('对手名不会在提示条里变成 HTML 元素',
        !promptEl.querySelector('img'), promptEl.innerHTML);
      ok('提示条把对手名当纯文本显示',
        promptEl.textContent.indexOf('<img') >= 0, promptEl.textContent);
      ok('恶意名字的 onerror 没有执行', typeof window.__xss === 'undefined');

      App.G.pendingBomb = { player: 1 };
      App.render();
      await wait(100);
      ok('待放炸弹提示同样转义',
        !promptEl.querySelector('img') && promptEl.textContent.indexOf('<img') >= 0,
        promptEl.textContent);

      App.G.pendingBomb = null;
      App.G.phase = 'over';
      App.G.winner = 1;
      App.render();
      await wait(100);
      ok('获胜提示同样转义',
        !promptEl.querySelector('img') && promptEl.textContent.indexOf('<img') >= 0,
        promptEl.textContent);

      App.G.phase = 'playing';
      App.G.winner = null;
      App.G.current = App.humanId;
      App.G.players[1].name = 'AI 1';
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

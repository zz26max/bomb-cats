/**
 * 事件按座位脱敏（纯函数，可单独测试）。
 *   draw.card     抽到的牌：只给本人（客户端本来就有「对手抽牌不亮牌面」的分支）
 *   draw2.cards   「摸两张」一次抽到的两张牌：只给本人（否则绕过 draw 脱敏）
 *   peek.cards    预测未来看到的牌：只给本人
 *   place-bomb.position  炸弹插回位置：只给本人（实体桌游里这也是私密信息）
 *   transfer.card 求饶/帮忙转移的牌：公开（引擎代选牌，与离线一致；README 已记取舍）
 */
'use strict';

function eventsForSeat(events, seat) {
  return events.map(e => {
    if (e.type === 'draw' && e.player !== seat) return Object.assign({}, e, { card: null });
    if (e.type === 'peek' && e.player !== seat) return Object.assign({}, e, { cards: null });
    if (e.type === 'draw2' && e.player !== seat) return Object.assign({}, e, { cards: null });
    if (e.type === 'place-bomb' && e.player !== seat) return Object.assign({}, e, { position: null });
    return e;
  });
}

module.exports = { eventsForSeat };

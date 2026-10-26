/**
 * 卡牌定义表
 * 纯数据，无逻辑依赖，浏览器与 Node 共用。
 *
 * 字段说明：
 *   id      唯一标识，也是 CSS/绘图选取的 key
 *   name    卡面名称
 *   kind    bomb | defuse | action | passive
 *   glyph   卡面主图形（unicode，避免引入图片资源）
 *   need    'none' 无需目标 | 'player' 必须指定一名其他玩家
 *   key     是否计入「关键牌」（AI 估值用）
 *   text    卡面效果说明
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    // 浏览器端约定：
    //   BombCats.CARDS     → 卡牌定义表本身（视图直接按 type 取用）
    //   BombCats.CardData  → 整个模块（含 BASE_COUNTS / startHandSize 等辅助函数）
    const mod = factory();
    root.BombCats = Object.assign(root.BombCats || {}, {
      CARDS: mod.CARDS,
      CardData: mod
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CARDS = {
    bomb: {
      id: 'bomb',
      name: '炸弹猫',
      kind: 'bomb',
      glyph: '💣',
      need: 'none',
      key: true,
      text: '抽到它就会爆炸。除非打出「拆除」，否则立刻出局。'
    },
    defuse: {
      id: 'defuse',
      name: '拆除',
      kind: 'defuse',
      glyph: '✂️',
      need: 'none',
      key: true,
      text: '拆掉炸弹。然后把炸弹秘密放回牌堆的任意位置。'
    },
    see: {
      id: 'see',
      name: '预测未来',
      kind: 'action',
      glyph: '🔮',
      need: 'none',
      key: false,
      text: '偷看牌堆顶部的 3 张牌，不改变顺序。'
    },
    attack: {
      id: 'attack',
      name: '攻击',
      kind: 'action',
      glyph: '⚔️',
      need: 'none',
      key: false,
      text: '不抽牌直接结束回合，下一位玩家要抽 2 次。'
    },
    skip: {
      id: 'skip',
      name: '跳过',
      kind: 'action',
      glyph: '⏭️',
      need: 'none',
      key: false,
      text: '不抽牌，直接结束回合。'
    },
    shuffle: {
      id: 'shuffle',
      name: '洗牌',
      kind: 'action',
      glyph: '🌀',
      need: 'none',
      key: false,
      text: '打乱牌堆。顶部已知的牌也会被洗进去。'
    },
    favor: {
      id: 'favor',
      name: '求饶',
      kind: 'action',
      glyph: '🙏',
      need: 'player',
      key: false,
      text: '让对方交给你一张牌（他选给哪张）。'
    },
    help: {
      id: 'help',
      name: '帮忙',
      kind: 'action',
      glyph: '🤝',
      need: 'player',
      key: false,
      text: '让对方主动给你一张牌（他选给哪张）。'
    },
    nope: {
      id: 'nope',
      name: '否决',
      kind: 'action',
      glyph: '🚫',
      need: 'none',
      key: true,
      text: '取消上一张牌的效果。否决本身也可以被否决。'
    },
    draw2: {
      id: 'draw2',
      name: '摸两张',
      kind: 'action',
      glyph: '🎴',
      need: 'none',
      key: false,
      text: '抽 2 张牌，然后可以弃掉其中 0 到 2 张。'
    },
    nothing: {
      id: 'nothing',
      name: '无效果',
      kind: 'passive',
      glyph: '🃏',
      need: 'none',
      key: false,
      text: '什么都没发生。它只是用来充数的。'
    }
  };

  /**
   * 基础版牌堆构成（4 人局共 56 张）。
   * 炸弹与拆除的数量随人数在 buildDeck 里动态调整。
   */
  const BASE_COUNTS = {
    defuse: 6,
    see: 5,
    attack: 4,
    skip: 4,
    shuffle: 4,
    favor: 4,
    help: 4,
    nope: 4,
    draw2: 1,
    nothing: 5
  };

  const PLAYER_LIMITS = { min: 2, max: 5 };

  /** 每个玩家开局手牌数：按人数递增，保证前期有操作空间又不至于太肥 */
  function startHandSize(playerCount) {
    if (playerCount <= 2) return 5;
    if (playerCount === 3) return 5;
    if (playerCount === 4) return 5;
    return 4;
  }

  /** 除翻开的那张外，进入牌堆的炸弹数 = 玩家人数 - 1 */
  function bombCount(playerCount) {
    return Math.max(1, playerCount - 1);
  }

  return {
    CARDS,
    BASE_COUNTS,
    PLAYER_LIMITS,
    startHandSize,
    bombCount
  };
});

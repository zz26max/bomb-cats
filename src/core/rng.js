/**
 * 确定性随机数工具。
 * 引擎所有随机行为都走这里注入的 rng，方便测试复现。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BombCats = Object.assign(root.BombCats || {}, { RNG: factory() });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** xorshift32：小而快，给定种子可完全复现 */
  function seeded(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 0x100000000;
    };
  }

  /** Fisher-Yates 原地洗牌 */
  function shuffle(list, rng) {
    const r = rng || Math.random;
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
  }

  /** [0, n) 整数 */
  function int(rng, n) {
    return Math.floor((rng || Math.random)() * n);
  }

  /** 从数组中随机取一个元素 */
  function pick(list, rng) {
    return list[int(rng, list.length)];
  }

  return { seeded, shuffle, int, pick };
});

/**
 * 音效层：全部用 WebAudio 现场合成，不依赖任何音频文件。
 * 浏览器在首次用户交互前不允许播放，因此 AudioContext 延迟到首次调用时创建。
 */
(function (root) {
  'use strict';

  let ctx = null;
  let enabled = true;

  function audio() {
    if (!enabled) return null;
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { enabled = false; return null; }
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    } catch (e) {
      enabled = false;
      return null;
    }
  }

  /** 单个音符：频率、时长、波形、音量、延迟 */
  function tone(freq, dur, type, vol, delay) {
    const a = audio();
    if (!a) return;
    const t0 = a.currentTime + (delay || 0);
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol == null ? 0.16 : vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** 噪声：用于爆炸、洗牌等质感音 */
  function noise(dur, vol, filterFreq) {
    const a = audio();
    if (!a) return;
    const len = Math.max(1, Math.floor(a.sampleRate * dur));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      // 带衰减包络的噪声，避免尾部突兀
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    }
    const src = a.createBufferSource();
    src.buffer = buf;
    const filter = a.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq || 1400;
    const gain = a.createGain();
    gain.gain.value = vol == null ? 0.5 : vol;
    src.connect(filter).connect(gain).connect(a.destination);
    src.start();
  }

  const SFX = {
    /** 抽牌：短促的纸张摩擦 */
    draw() { noise(0.09, 0.16, 2600); tone(520, 0.05, 'triangle', 0.05); },

    /** 出牌：清脆的落牌声 */
    play() { tone(760, 0.07, 'triangle', 0.12); tone(1180, 0.05, 'sine', 0.07, 0.03); },

    /** 切换/点击：极轻的反馈 */
    click() { tone(880, 0.04, 'sine', 0.07); },

    /** 预测未来：空灵上扬 */
    peek() { tone(660, 0.16, 'sine', 0.1); tone(990, 0.2, 'sine', 0.08, 0.09); tone(1320, 0.24, 'sine', 0.05, 0.18); },

    /** 洗牌：一阵噪声 */
    shuffle() { noise(0.34, 0.22, 3200); tone(300, 0.3, 'sawtooth', 0.03); },

    /** 拆除成功：紧张后的松弛 */
    defuse() { tone(520, 0.1, 'square', 0.09); tone(780, 0.14, 'square', 0.08, 0.09); tone(1040, 0.26, 'sine', 0.09, 0.2); },

    /** 爆炸：低频轰鸣 + 噪声，游戏里最有分量的一下 */
    explode() {
      noise(0.7, 0.6, 900);
      tone(150, 0.6, 'sawtooth', 0.28);
      tone(90, 0.8, 'sine', 0.3, 0.02);
      tone(60, 1.0, 'sine', 0.22, 0.05);
    },

    /** 否决：金属味的短促下坠 */
    nope() { tone(420, 0.1, 'square', 0.13); tone(240, 0.16, 'square', 0.11, 0.07); },

    /** 攻击：冲锋号式的双音 */
    attack() { tone(300, 0.1, 'sawtooth', 0.12); tone(420, 0.12, 'sawtooth', 0.12, 0.08); },

    /** 转移卡牌（求饶/帮忙） */
    transfer() { tone(700, 0.07, 'triangle', 0.1); tone(520, 0.09, 'triangle', 0.09, 0.06); },

    /** 回合切换 */
    turn() { tone(600, 0.08, 'sine', 0.08); tone(760, 0.1, 'sine', 0.06, 0.06); },

    /** 胜利：上行三和弦 */
    win() {
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.32, 'sine', 0.13, i * 0.11));
    },

    /** 失败：下行 */
    lose() {
      [392, 330, 262].forEach((f, i) => tone(f, 0.34, 'triangle', 0.12, i * 0.13));
    }
  };

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled && ctx) { try { ctx.suspend(); } catch (e) { /* 忽略 */ } }
    if (enabled && ctx) { try { ctx.resume(); } catch (e) { /* 忽略 */ } }
  }

  function isEnabled() { return enabled; }

  root.BombCats = Object.assign(root.BombCats || {}, { SFX, setSoundEnabled: setEnabled, isSoundEnabled: isEnabled });
})(typeof window !== 'undefined' ? window : globalThis);

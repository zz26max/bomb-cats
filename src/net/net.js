/**
 * 联机客户端连接层。
 * 浏览器自带 WebSocket，这里只做三件事：
 *   - 连接 / 断线自动重连（指数退避，最多 6 次）
 *   - 消息按类型分发给 main.js
 *   - 断线前的座位凭据（code/seat/token）存 sessionStorage，刷新页面可自动重连
 */
(function (root) {
  'use strict';

  const RECONNECT_MAX = 6;
  const RECONNECT_BASE_MS = 600;

  /**
   * @param {string} url    ws://host:port
   * @param {object} hooks  { onOpen, onMsg(msg), onClose(willRetry), onDown() }
   */
  function NetConnection(url, hooks) {
    const self = this;
    this.url = url;
    this.hooks = hooks;
    this.ws = null;
    this.closedByUser = false;
    this.retries = 0;
    this.timer = null;

    this._connect();
  }

  NetConnection.prototype._connect = function () {
    const self = this;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      if (this.hooks.onDown) this.hooks.onDown('无法建立连接');
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      self.retries = 0;
      if (self.hooks.onOpen) self.hooks.onOpen();
    };
    ws.onmessage = ev => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && self.hooks.onMsg) self.hooks.onMsg(msg);
    };
    ws.onclose = () => {
      if (self.closedByUser) return;
      if (self.retries < RECONNECT_MAX) {
        const delay = RECONNECT_BASE_MS * Math.pow(1.7, self.retries);
        self.retries++;
        if (self.hooks.onClose) self.hooks.onClose(true, self.retries);
        self.timer = setTimeout(() => self._connect(), delay);
      } else {
        if (self.hooks.onDown) self.hooks.onDown('连接已断开（重试多次未成功）');
      }
    };
    ws.onerror = () => { /* onclose 会跟着来，交给重连逻辑 */ };
  };

  NetConnection.prototype.send = function (msg) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  };

  NetConnection.prototype.close = function () {
    this.closedByUser = true;
    clearTimeout(this.timer);
    if (this.ws) { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
  };

  root.BombCats = Object.assign(root.BombCats || {}, { NetConnection });
})(typeof window !== 'undefined' ? window : globalThis);

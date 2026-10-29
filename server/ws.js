/**
 * 零依赖 WebSocket 服务端实现（RFC6455 最小子集）。
 *
 * 项目没有任何 npm 依赖，这里手写协议而不是引 ws/socket.io：
 *   - 握手：Sec-WebSocket-Key → SHA1 + GUID → Accept
 *   - 帧：只支持文本（opcode 1）；ping/pong、close 照协议走
 *   - 客户端帧必须带 mask（RFC 要求），服务器回帧不 mask
 *   - 分片消息（continuation）不支持：房间消息都是小 JSON，超长直接断开
 *
 * 只暴露 minimal 的 Socket 类：events 'text' / 'close'，方法 send() / close()。
 */
'use strict';
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;   // 房间消息都是小 JSON，64KB 上限防滥用

/** 把 HTTP 升级请求变成 WebSocket；成功返回 true（socket 所有权随之转移） */
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return false;
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey + '\r\n' +
    '\r\n');
  return true;
}

class WsSocket {
  constructor(socket) {
    this.raw = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this._onText = null;     // (string) => void
    this._onClose = null;    // () => void

    socket.on('data', chunk => this._feed(chunk));
    const dead = () => this._shutdown();
    socket.on('close', dead);
    socket.on('error', dead);
    // HTTP upgrade 的 socket 默认 allowHalfOpen：对端 FIN 只发 'end'，不主动 close。
    // 不在这里收尾，掉线要等到下一次写失败才被发现（否决窗口会白等满超时）。
    socket.on('end', dead);
    socket.setNoDelay(true);
  }

  onText(fn) { this._onText = fn; }
  onClose(fn) { this._onClose = fn; }

  /** 发送一条文本消息（服务器→客户端不需要 mask） */
  send(text) {
    if (this.closed) return;
    this.raw.write(this._frame(Buffer.from(text, 'utf8'), 0x1));
  }

  /** 协议层 ping（保活探测） */
  ping() {
    if (!this.closed) this.raw.write(this._frame(Buffer.alloc(0), 0x9));
  }

  /** 优雅关闭：发 close 帧后断开 */
  close() {
    if (this.closed) return;
    try { this.raw.write(this._frame(Buffer.alloc(0), 0x8)); } catch (e) { /* 忽略 */ }
    this._shutdown();
  }

  _shutdown() {
    if (this.closed) return;
    this.closed = true;
    try { this.raw.destroy(); } catch (e) { /* 忽略 */ }
    if (this._onClose) this._onClose();
  }

  _frame(payload, opcode) {
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode; head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | opcode; head[1] = 127;
      head.writeUInt32BE(0, 2);
      head.writeUInt32BE(len, 6);
    }
    return Buffer.concat([head, payload]);
  }

  /** 增量解析客户端帧。返回 false 表示协议错误，连接应当关闭。 */
  _feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const frame = this._parseFrame();
      if (frame === null) break;                 // 半包，等下一段
      if (frame === false) { this.close(); return; }
      const { opcode, payload } = frame;
      if (opcode === 0x1) {
        if (this._onText) this._onText(payload.toString('utf8'));
      } else if (opcode === 0x9) {
        this.raw.write(this._frame(payload, 0xA));   // ping → pong
      } else if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x0 || opcode === 0x2) {
        // 分片 / 二进制：本服务用不到，一律视为协议错误断开
        this.close();
        return;
      } /* 0xA pong：忽略 */
    }
  }

  /** 尝试从 buf 头部解析一帧；半包返回 null，坏包返回 false */
  _parseFrame() {
    const buf = this.buf;
    if (buf.length < 2) return null;
    const b0 = buf[0], b1 = buf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const hi = buf.readUInt32BE(2);
      if (hi !== 0) return false;                  // 超过 4GB 的长度声明，必然是攻击
      len = buf.readUInt32BE(6); off = 10;
    }
    if (len > MAX_PAYLOAD) return false;
    if (!masked) return false;                     // RFC 要求客户端帧必须 mask
    if (buf.length < off + 4 + len) return null;
    const mask = buf.slice(off, off + 4);
    const payload = buf.slice(off + 4, off + 4 + len);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.buf = buf.slice(off + 4 + len);
    return { opcode, payload };
  }
}

module.exports = { accept, WsSocket };

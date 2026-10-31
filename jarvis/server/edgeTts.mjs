/**
 * Edge 在线朗读（免费、免密钥）：和 Edge 浏览器“大声朗读”同一套神经网络声音。
 * 这不是微软正式开放的接口（开源项目 edge-tts 等使用的就是这个方式），可能随时变化；
 * 失败时前端会自动退回系统自带声音。
 *
 * 只依赖 Node 自带模块：自己完成 WebSocket 握手与收发帧（需要带特定的请求头，浏览器 / Node 自带的 WebSocket 设置不了）。
 */
import https from 'node:https';
import crypto from 'node:crypto';

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const HOST = 'speech.platform.bing.com';
const PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const CHROMIUM = '143.0.3650.75';
import { secMsGec, EDGE_GEC_VERSION } from '../shared/edgeGec.js';
export { secMsGec } from '../shared/edgeGec.js';

export { EDGE_VOICES } from '../shared/edgeVoices.js';
import { EDGE_VOICES } from '../shared/edgeVoices.js';
const VOICE_OK = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const pct = (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;

export function ssml(text, { voice = EDGE_VOICES[0][0], rate = 0, pitch = 0 } = {}) {
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${voice}'><prosody pitch='${pitch >= 0 ? '+' : ''}${Math.round(pitch)}Hz' rate='${pct(rate)}' volume='+0%'>${esc(text)}</prosody></voice></speak>`;
}

// ---------------------------------------------------------------- 最小 WebSocket 帧
/** 客户端发出的帧必须加掩码 */
export function encodeFrame(payload, opcode = 1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = data.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255])
      : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  const mask = crypto.randomBytes(4);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, out]);
}

/** 从缓冲区里切出完整的帧：返回 { frames: [{ opcode, payload }], rest } */
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    let len = b1 & 127;
    let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const masked = b1 & 128;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (buf.length - p < len) break;
    let payload = buf.subarray(p, p + len);
    if (mask) payload = Buffer.from(payload.map((v, i) => v ^ mask[i & 3]));
    frames.push({ fin: Boolean(b0 & 128), opcode: b0 & 15, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** 二进制消息：前 2 字节是头部长度，头部里 Path:audio 的后面是音频数据 */
export function audioOf(payload) {
  if (payload.length < 2) return null;
  const hl = payload.readUInt16BE(0);
  const head = payload.subarray(2, 2 + hl).toString('utf8');
  return /Path:audio/.test(head) ? payload.subarray(2 + hl) : null;
}

const stamp = () => new Date().toString().replace(/ \(.+\)$/, '').replace(/GMT([+-]\d{4}).*/, 'GMT$1 (Coordinated Universal Time)');

/**
 * 合成一段文字，返回 mp3（Buffer）
 * @param {string} text
 * @param {{ voice?: string, rate?: number, pitch?: number, timeoutMs?: number, connect?: Function }} [o]
 */
export function edgeSpeak(text, { voice = EDGE_VOICES[0][0], rate = 0, pitch = 0, timeoutMs = 10000, connect } = {}) {
  text = String(text || '').trim().slice(0, 1500);
  if (!text) return Promise.reject(new Error('没有要朗读的文字'));
  if (!VOICE_OK.test(voice)) return Promise.reject(new Error('声音名称不对'));
  const connId = crypto.randomUUID().replace(/-/g, '');
  const key = crypto.randomBytes(16).toString('base64');
  const path = `${PATH}?TrustedClientToken=${TOKEN}&ConnectionId=${connId}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}`;
  const headers = {
    Host: HOST,
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Key': key,
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM.split('.')[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM.split('.')[0]}.0.0.0`,
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`
  };

  return new Promise((resolve, reject) => {
    let done = false;
    let socket = null;
    const chunks = [];
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket?.end(encodeFrame(Buffer.alloc(0), 8)); socket?.destroy(); } catch { /* 已关闭 */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('Edge 朗读超时')), timeoutMs);
    const req = (connect ?? https.request)({ host: HOST, port: 443, path, method: 'GET', headers, servername: HOST });
    req.on('error', (e) => finish(new Error(`连不上 Edge 朗读服务：${e.message}`)));
    req.on('response', (res) => finish(new Error(`Edge 朗读服务拒绝了请求（${res.statusCode}）`)));
    req.on('upgrade', (res, sock, head) => {
      socket = sock;
      const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (res.headers['sec-websocket-accept'] !== accept) return finish(new Error('Edge 朗读握手失败'));
      let buf = Buffer.from(head || []);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          if (f.opcode === 2) { const a = audioOf(f.payload); if (a?.length) chunks.push(a); }
          else if (f.opcode === 1 && /Path:turn\.end/.test(f.payload.toString('utf8'))) {
            const audio = Buffer.concat(chunks);
            return finish(audio.length ? null : new Error('Edge 朗读没有返回声音'), audio);
          } else if (f.opcode === 8) return finish(chunks.length ? null : new Error('Edge 朗读服务断开了连接'), Buffer.concat(chunks));
          else if (f.opcode === 9) sock.write(encodeFrame(f.payload, 10)); // ping → pong
        }
      });
      sock.on('error', (e) => finish(new Error(`Edge 朗读连接出错：${e.message}`)));
      sock.on('close', () => finish(chunks.length ? null : new Error('Edge 朗读连接被关闭'), Buffer.concat(chunks)));
      const ts = stamp();
      sock.write(encodeFrame(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`));
      sock.write(encodeFrame(`X-RequestId:${crypto.randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml(text, { voice, rate, pitch })}`));
    });
    req.end();
  });
}

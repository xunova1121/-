import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { edgeSpeak, secMsGec, ssml, encodeFrame, decodeFrames, audioOf } from '../server/edgeTts.mjs';
import { createServer } from '../server/server.mjs';
import { MockAgent } from '../server/agents.mjs';

/** 假的 Edge 朗读服务：校验握手与请求，按真实协议回两段音频 + turn.end */
function fakeEdge({ reject = false } = {}) {
  const seen = { headers: null, url: '', messages: [] };
  const server = http.createServer((_req, res) => res.writeHead(400).end());
  server.on('upgrade', (req, sock) => {
    seen.headers = req.headers;
    seen.url = req.url;
    if (reject) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const frame = (op, payload) => { const p = Buffer.from(payload); const h = p.length < 126 ? Buffer.from([0x80 | op, p.length]) : Buffer.from([0x80 | op, 126, p.length >> 8, p.length & 255]); return Buffer.concat([h, p]); };
    const audio = (bytes) => { const head = Buffer.from('X-RequestId:x\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n'); const len = Buffer.alloc(2); len.writeUInt16BE(head.length); return frame(2, Buffer.concat([len, head, Buffer.from(bytes)])); };
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        if (f.opcode !== 1) continue;
        const t = f.payload.toString();
        seen.messages.push(t);
        if (/Path:ssml/.test(t)) {
          sock.write(frame(1, 'Path:turn.start\r\n\r\n{}'));
          sock.write(audio([1, 2, 3]));
          sock.write(audio([4, 5]));
          sock.write(frame(1, 'X-RequestId:x\r\nPath:turn.end\r\n\r\n{}'));
        }
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, connect: (o) => http.request({ ...o, host: '127.0.0.1', port: server.address().port }) })));
}

describe('Edge 在线朗读', () => {
  const servers = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it('签名：按 5 分钟取整，同一时间段内不变', () => {
    expect(secMsGec(1760000000000)).toMatch(/^[0-9A-F]{64}$/);
    expect(secMsGec(1760000000000)).toBe(secMsGec(1760000000000 + 60_000));
  });

  it('SSML 转义文字并带上声音和语速', () => {
    const x = ssml('1 < 2 & "引号"', { voice: 'zh-CN-YunxiNeural', rate: -4 });
    expect(x).toContain("<voice name='zh-CN-YunxiNeural'>");
    expect(x).toContain("rate='-4%'");
    expect(x).toContain('1 &lt; 2 &amp; &quot;引号&quot;');
  });

  it('帧编码 / 解码往返（客户端帧带掩码）', () => {
    const f = encodeFrame('你好');
    expect(f[1] & 0x80).toBe(0x80);
    const { frames, rest } = decodeFrames(Buffer.concat([f, f.subarray(0, 3)]));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.toString()).toBe('你好');
    expect(rest).toHaveLength(3);
    const big = 'x'.repeat(70000);
    expect(decodeFrames(encodeFrame(big)).frames[0].payload.toString()).toBe(big);
    const head = Buffer.from('Path:audio\r\n'); const len = Buffer.alloc(2); len.writeUInt16BE(head.length);
    expect([...audioOf(Buffer.concat([len, head, Buffer.from([9])]))]).toEqual([9]);
  });

  it('完整流程：握手 → 配置 → SSML → 拼接音频', async () => {
    const f = await fakeEdge();
    servers.push(f.server);
    const audio = await edgeSpeak('你好，我是贾维斯', { voice: 'zh-CN-YunyangNeural', connect: f.connect });
    expect([...audio]).toEqual([1, 2, 3, 4, 5]);
    expect(f.seen.url).toMatch(/TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=[0-9a-f]{32}&Sec-MS-GEC=[0-9A-F]{64}&Sec-MS-GEC-Version=1-/);
    expect(f.seen.headers.origin).toBe('chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold');
    expect(f.seen.messages[0]).toMatch(/Path:speech\.config[\s\S]*audio-24khz-48kbitrate-mono-mp3/);
    expect(f.seen.messages[1]).toMatch(/Path:ssml[\s\S]*zh-CN-YunyangNeural[\s\S]*你好，我是贾维斯/);
  });

  it('服务拒绝 / 声音名不对时给出明确错误', async () => {
    const f = await fakeEdge({ reject: true });
    servers.push(f.server);
    await expect(edgeSpeak('你好', { connect: f.connect, timeoutMs: 3000 })).rejects.toThrow(/Edge 朗读/);
    await expect(edgeSpeak('你好', { voice: 'evil<script>' })).rejects.toThrow(/声音名称/);
  });

  it('网关接口：本机页面可用，其他网站不行', async () => {
    const s = createServer({ agent: new MockAgent({ charDelayMs: 0 }), staticDir: '/nonexistent', edgeTts: async (text, o) => Buffer.from(`${o.voice}|${text}`) });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    servers.push(s);
    const base = `http://127.0.0.1:${s.address().port}`;
    const H = { 'content-type': 'application/json', 'x-jarvis-client': '1' };
    const ok = await fetch(`${base}/api/tts/edge`, { method: 'POST', headers: H, body: JSON.stringify({ text: '早上好', voice: 'en-GB-RyanNeural' }) });
    expect(ok.headers.get('content-type')).toBe('audio/mpeg');
    expect(await ok.text()).toBe('en-GB-RyanNeural|早上好');
    expect((await fetch(`${base}/api/tts/edge`, { method: 'POST', headers: { ...H, Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${base}/api/tts/edge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  });
});

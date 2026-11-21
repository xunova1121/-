import WebSocket from 'ws';
import { streamDeepseekPcm, validateSpeech } from '../shared/deepseekSpeech.js';
import { deepseekAsr, deepseekTts } from '../src/llm/deepseekSuite.js';
import { withAbortSignals } from '../src/core/abortableFetch.js';

export function createDeepseekVoiceRoute({ loadConfig, readBody, readJson, json, fetchImpl = fetch, open = (url, key) => new WebSocket(url, { headers: { Authorization: 'Bearer ' + key }, handshakeTimeout: 15000, maxPayload: 256 * 1024 }) }) {
  return async (req, res, path, principal) => {
    const match = /^\/api\/server\/deepseek\/voice\/(asr|tts|tts-stream)$/.exec(path);
    if (!match) return false;
    if (req.method !== 'POST') { json(res, 405, { error: '仅支持 POST' }); return true; }
    const cfg = loadConfig();
    if (!principal || principal.role === 'evaluation' || (principal.role === 'member' && cfg.deepseekSuite !== true)) { json(res, 403, { error: '当前授权无法使用服务器语音' }); return true; }
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    res.once('close', stop);
    try {
      await withAbortSignals([ctrl.signal], async signal => {
        if (match[1] === 'asr') {
          const raw = await readBody(req, 8 * 1024 * 1024 + 65536);
          const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] || '' } }).formData();
          const file = form.get('file');
          if (!(file instanceof Blob)) throw new Error('缺少语音文件');
          json(res, 200, { text: await deepseekAsr(cfg, file, { signal, fetchImpl }) });
        } else {
          const { text, voice } = await readJson(req, 65536);
          if (match[1] === 'tts-stream') {
            validateSpeech(text, voice);
            if (!cfg.keys?.deepseek) throw new Error('请配置服务器的 DeepSeek 官方密钥');
            res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
            try {
              await streamDeepseekPcm(text, { key: cfg.keys.deepseek, voice, signal, open, onChunk: chunk => {
                if (res.writableLength > 1024 * 1024) throw new Error('语音传输阻塞');
                res.write(JSON.stringify({ pcm: Buffer.from(chunk).toString('base64') }) + '\n');
              } });
              res.end('{"done":true}\n');
            } catch { if (!res.destroyed) res.end('{"error":"流式朗读中断"}\n'); }
            return;
          }
          const wav = await deepseekTts(cfg, text, voice, { signal, fetchImpl });
          res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
          res.end(Buffer.from(wav));
        }
      }, 120000);
    } catch (e) {
      if (!res.destroyed && !res.headersSent) json(res, e.status >= 400 && e.status <= 599 ? e.status : 400, { error: e.message });
    } finally { res.off('close', stop); }
    return true;
  };
}

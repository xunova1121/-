import { streamDeepseekPcm } from '../../shared/deepseekSpeech.js';
import { loadServerSettings } from '../core/serverClient.js';
import { deepseekAsr, deepseekTts } from '../llm/deepseekSuite.js';

// 服务器模式只给用户自己的服务器发送登录凭证，官方 Key 留在服务器。
export async function deepseekVoice(kind, cfg, input, options) {
  const remote = loadServerSettings();
  if (!remote.enabled) return kind === 'asr' ? deepseekAsr(cfg, input, options) : deepseekTts(cfg, input.text, input.voice, options);
  if (!remote.token || !remote.url) throw new Error('请先登录未央服务器以使用服务器语音');
  const headers = { authorization: 'Bearer ' + remote.token };
  let body;
  if (kind === 'asr') {
    body = new FormData();
    body.append('file', input, input.type.includes('ogg') ? 'speech.ogg' : 'speech.wav');
  } else {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(input);
  }
  const res = await options.fetchImpl(new URL('/api/server/deepseek/voice/' + kind, remote.url).href, {
    method: 'POST', noNetworkRetry: true, headers, body, binary: kind === 'tts', redirect: 'error', signal: options.signal
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || '未央服务器语音请求失败（HTTP ' + res.status + '）');
  }
  return kind === 'asr' ? (await res.json()).text : res.arrayBuffer();
}

// 本机仅有网关环境变量时走 WAV 接口，密钥不会为了流式播放下发给浏览器。
export function streamDeepseekAvailable(keys) {
  const remote = loadServerSettings();
  return remote.enabled || Boolean(keys?.deepseek && !keys.deepseek.startsWith('••••') && globalThis.WebSocket);
}
export async function streamDeepseekSpeech(text, { key, voice, signal, onAudio, fetchImpl = fetch, open }) {
  const remote = loadServerSettings();
  function pcm(bytes) {
    if (!bytes.length || bytes.length % 2) throw new Error('收到无效 PCM 音频');
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(bytes.byteLength / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = data.getInt16(i * 2, true) / 32768;
    onAudio(samples, 24000);
  }
  if (!remote.enabled) return streamDeepseekPcm(text, { key, voice, signal, open, onChunk: pcm });
  if (!remote.token || !remote.url) throw new Error('请先登录未央服务器以使用服务器语音');
  const res = await fetchImpl(new URL('/api/server/deepseek/voice/tts-stream', remote.url).href, {
    method: 'POST', noNetworkRetry: true, redirect: 'error', stream: true, headers: { authorization: 'Bearer ' + remote.token, 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice }), signal
  });
  if (!res.ok || !res.body) throw new Error('服务器流式朗读失败（HTTP ' + res.status + '）');
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let pending = '', completed = false, received = false;
  try {
    while (!completed) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      if (pending.length > 512 * 1024) throw new Error('服务器朗读分片过长');
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.done === true) { completed = true; break; }
        if (typeof event.pcm !== 'string' || event.pcm.length > 512 * 1024) throw new Error('服务器流式朗读中断');
        pcm(Uint8Array.from(atob(event.pcm), c => c.charCodeAt(0)));
        received = true;
      }
    }
    if (!completed || !received) throw new Error('服务器语音未完整返回');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

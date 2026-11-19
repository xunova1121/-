// DeepSeek WebSocket TTS 使用 24 kHz、16 位单声道 PCM。只有最终 finish/success 表示成功。
export function validateSpeech(text, voice) {
  const chars = Array.from(typeof text === 'string' ? text : '');
  if (!chars.length || !text.trim() || chars.reduce((n, c) => n + (/\p{Script=Han}/u.test(c) ? 2 : 1), 0) > 10000 ||
      !['stella', 'tide'].includes(voice)) throw new Error('朗读文本或音色无效，单次最多 10000 个计费字符');
}

export async function streamDeepseekPcm(text, { key, voice = 'stella', signal, onChunk, open }) {
  validateSpeech(text, voice);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!key || /[\r\n]/.test(key) || key.startsWith('••••')) throw new Error('缺少 DeepSeek 官方密钥');
  const url = 'wss://api.deepseek.com/v1/tools/tts?format=pcm&filter_markdown=true&voice_id=' + voice;
  const ws = open ? open(url, key) : new WebSocket(url, ['tts', 'bearer.' + key]);
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    let bytes = 0, settled = false;
    const end = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      ws.onmessage = ws.onopen = ws.onclose = null;
      try { ws.close(); } catch { /* 已断开 */ }
      if (error) reject(error); else resolve();
    };
    const abort = () => end(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => end(new Error('DeepSeek 流式语音超时')), 120000);
    signal?.addEventListener('abort', abort, { once: true });
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ event: 'text', text })); ws.send(JSON.stringify({ event: 'finish_text' })); }
      catch { end(new Error('发送朗读内容失败')); }
    };
    ws.onmessage = ({ data }) => {
      try {
        if (typeof data === 'string') {
          const event = JSON.parse(data);
          if (event.event === 'finish') end(event.code === 'success' && bytes ? null : new Error('DeepSeek 流式朗读未完成'));
          return;
        }
        const chunk = new Uint8Array(data);
        bytes += chunk.byteLength;
        if (!chunk.length || chunk.length % 2 || bytes > 32 * 1024 * 1024) throw new Error('语音分片异常');
        onChunk(chunk);
      } catch (error) { end(error); }
    };
    ws.onclose = ws.onerror = () => end(new Error('DeepSeek 流式语音连接中断'));
    if (signal?.aborted) abort();
  });
}

/**
 * 对话流客户端（需求 7.1）。POST 消息历史，按 SSE 帧解析：
 *   data: {"delta": "...", "emotion_hint": "专注" | null, "task_state": "idle|listening|processing|error|done"}
 * 用 fetch 而不是 EventSource，因为需要 POST 请求体，也需要 AbortController 随时中断。
 */
import { API } from '../config.js';

export async function streamChat({ messages, signal, onMessage, url = API.chat }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ messages }),
    signal
  });
  if (!res.ok || !res.body) throw new Error(`对话接口返回 ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '');
      const msg = parseFrame(frame);
      if (msg) onMessage(msg);
    }
  }
  const tail = parseFrame(buf);
  if (tail) onMessage(tail);
}

export function parseFrame(frame) {
  const data = frame
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    const msg = JSON.parse(data);
    return {
      delta: typeof msg.delta === 'string' ? msg.delta : '',
      emotion_hint: msg.emotion_hint ?? null,
      task_state: msg.task_state ?? null,
      tool: msg.tool ?? null
    };
  } catch {
    return null;
  }
}

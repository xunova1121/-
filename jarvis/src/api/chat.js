/**
 * 对话流客户端（需求 7.1）。POST 消息历史，按 SSE 帧解析：
 *   data: {"delta": "...", "emotion_hint": "专注" | null, "task_state": "idle|listening|processing|error|done"}
 * 用 fetch 而不是 EventSource，因为需要 POST 请求体，也需要 AbortController 随时中断。
 */
import { API, STANDALONE } from '../config.js';
import { browserMetrics } from './browserMetrics.js';

const KEY_STORAGE = 'jarvis.claudeKey';

/** 用户在设置里填写的 Claude API Key（只存在本机 localStorage，单文件版 / 没有网关时使用） */
export function getBrowserKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
}
export function setBrowserKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* 存储不可用：本次会话不保存 */ }
}

let serverDown = STANDALONE;

/** 当前对话后端：server（网关）/ claude-browser（浏览器直连）/ local（内置演示智能体） */
export function chatBackend() {
  if (!serverDown) return 'server';
  return getBrowserKey() ? 'claude-browser' : 'local';
}

/**
 * 对话入口：有网关走网关；单文件版或网关连不上时，在浏览器里直接运行智能体 ——
 * 填了 Claude 密钥就直连 Claude，否则用内置演示智能体。事件形状与网关完全一致。
 */
export async function chat({ messages, signal, onMessage }) {
  if (!serverDown) {
    let got = false;
    try {
      await streamChat({ messages, signal, onMessage: (m) => { got = true; onMessage(m); } });
      return;
    } catch (err) {
      if (err.name === 'AbortError' || got) throw err;
      serverDown = true; // 网关不可用：本轮起改在浏览器内运行
    }
  }
  const { ClaudeAgent, MockAgent } = await import('../../shared/agents.js');
  const key = getBrowserKey();
  const agent = key
    ? new ClaudeAgent({ apiKey: key, browser: true, metrics: browserMetrics })
    : new MockAgent({ metrics: browserMetrics });
  for await (const ev of agent.run(messages, { signal })) {
    if (signal?.aborted) break;
    onMessage({ delta: ev.delta ?? '', emotion_hint: ev.emotion_hint ?? null, task_state: ev.task_state ?? null, tool: ev.tool ?? null });
  }
}

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

/**
 * OpenAI 兼容适配器：/chat/completions 流式 + 函数调用。
 * OpenAI、Gemini（OpenAI 兼容端点）、DeepSeek、通义千问、Kimi、智谱、豆包、硅基流动、OpenRouter、Ollama 都走这里。
 *
 * 内部统一消息格式：
 *   { role: 'user', content }
 *   { role: 'assistant', content, toolCalls: [{ id, name, args }] }
 *   { role: 'tool', toolCallId, name, content, isError }
 * user / tool 消息可带 images: [{ mime, data(base64) }]。OpenAI 只允许用户消息带图，
 * 所以工具返回的图片（如截屏）放在紧随其后的一条用户消息里。
 */
const imagePart = (img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });

export function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system.map((s) => s.text ?? s).join('\n\n') }];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({ role: 'user', content: [{ type: 'text', text: '（以上工具返回的图片）' }, ...pending.map(imagePart)] });
    pending = [];
  };
  for (const m of messages) {
    if (m.role !== 'tool') flush();
    if (m.role === 'user') out.push({ role: 'user', content: m.images?.length ? [{ type: 'text', text: m.content }, ...m.images.map(imagePart)] : m.content });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
        if (!m.content) msg.content = null;
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      if (m.images?.length) pending.push(...m.images);
    }
  }
  flush();
  return out;
}

export function toOpenAITools(tools) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

/** 解析 SSE 文本块，返回 data 行（JSON 或 '[DONE]'） */
export function sseLines(buffer) {
  const events = [];
  let rest = buffer;
  let idx;
  while ((idx = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, idx).replace(/\r$/, '');
    rest = rest.slice(idx + 1);
    if (line.startsWith('data:')) events.push(line.slice(5).trim());
  }
  return { events, rest };
}

/** 累积流式 delta：文本与按 index 拼接的 tool_calls */
export function createAccumulator(onText) {
  const calls = [];
  let text = '';
  let finish = null;
  return {
    push(chunk) {
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const d = choice.delta ?? {};
      if (typeof d.content === 'string' && d.content) { text += d.content; onText?.(d.content); }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: '', name: '', argText: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].argText += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    },
    result() {
      const toolCalls = calls.filter(Boolean).map((c, i) => {
        let args = {};
        let parseError = null;
        try { args = c.argText ? JSON.parse(c.argText) : {}; } catch (e) { parseError = `参数不是合法 JSON：${e.message}`; }
        return { id: c.id || `call_${i}_${Date.now().toString(36)}`, name: c.name, args, parseError };
      });
      return { text, toolCalls, stop: finish };
    }
  };
}

/** 已知不支持工具调用的模型（本次运行内记住，避免每轮都先失败一次） */
const noToolModels = new Set();
/** 不认 reasoning_effort 参数的模型 */
const noEffortModels = new Set();

/** 中转站 / 服务商的临时故障：网关超时（524 等）、限流、连接被重置——自动重试 */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
export const isTransient = (err) => Boolean(err) && err.name !== 'AbortError' && (TRANSIENT_STATUS.has(err.status) || err.name === 'TypeError' || /connection reset|econnreset|socket hang up|network ?error|failed to fetch|load failed|premature close|terminated|etimedout|unexpected end/i.test(String(err.message)));
const RETRY_DELAYS = [1500, 4000, 8000];
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

/** 续写时发给模型的话：接着刚才断开的地方写，不要重复 */
export const CONTINUE_PROMPT = '（网络中断了，你上一条回答只发出了上面这一部分。）请从中断的地方直接接着往下写，不要重复已经写过的内容，也不要提到中断。';

export function createOpenAIAdapter({ baseURL, apiKey, headers = {}, retryDelays = RETRY_DELAYS }) {
  const once = createOnce({ baseURL, apiKey, headers });
  return {
    kind: 'openai',
    async stream(opts) {
      const { signal, onText, onRetry } = opts;
      let partial = ''; // 已经显示给用户的文字（跨重试累计）
      let messages = opts.messages;
      for (let attempt = 0; ; attempt++) {
        let got = '';
        try {
          const r = await once.stream({ ...opts, messages, onText: (d) => { got += d; onText?.(d); } });
          // 续写的结果拼在已显示的部分后面
          return partial ? { ...r, text: partial + r.text } : r;
        } catch (err) {
          partial += got;
          if (signal?.aborted || !isTransient(err) || attempt >= retryDelays.length) throw Object.assign(err, { partialText: partial });
          onRetry?.(attempt + 1, err);
          // 已经写了一部分：带上这部分让模型接着写，而不是从头再来
          if (partial.trim()) messages = [...opts.messages, { role: 'assistant', content: partial }, { role: 'user', content: CONTINUE_PROMPT }];
          await sleep(retryDelays[attempt], signal);
        }
      }
    }
  };
}

function createOnce({ baseURL, apiKey, headers = {} }) {
  return {
    async stream({ model, system, messages, tools, signal, onText, effort }) {
      const send = (withTools, withEffort) => fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }), ...headers },
        body: JSON.stringify({
          model,
          stream: true,
          messages: toOpenAIMessages(system, messages),
          ...(withTools && tools?.length && { tools: toOpenAITools(tools) }),
          // 思考强度：日常对话让推理模型少想一点，首字快很多（不支持的模型会报错，自动去掉重试）
          ...(withEffort && { reasoning_effort: effort })
        }),
        signal
      });
      let useTools = !noToolModels.has(model);
      let useEffort = Boolean(effort) && !noEffortModels.has(model);
      let res = await send(useTools, useEffort);
      for (let retry = 0; retry < 2 && res.status === 400; retry++) {
        const detail = await res.clone().text().catch(() => '');
        if (useEffort && /reasoning_effort|reasoning effort|unsupported parameter|unknown parameter|unrecognized/i.test(detail)) {
          noEffortModels.add(model);
          useEffort = false;
        } else if (useTools && tools?.length && /does not support tools|tools? (is|are) not supported/i.test(detail)) {
          // 有些本机模型（如 gemma3、qwen2.5vl）不支持工具调用：去掉工具再试，只聊天
          noToolModels.add(model);
          useTools = false;
        } else break;
        res = await send(useTools, useEffort);
      }
      if (!res.ok || !res.body) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
        throw Object.assign(new Error(`模型接口返回 ${res.status}${detail ? `：${detail}` : ''}`), { status: res.status });
      }
      const acc = createAccumulator(onText);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const { events, rest } = sseLines(buf);
        buf = rest;
        for (const e of events) {
          if (e === '[DONE]') continue;
          try { acc.push(JSON.parse(e)); } catch { /* 忽略心跳等非 JSON 行 */ }
        }
      }
      const r = acc.result();
      return { ...r, stop: r.toolCalls.length ? 'tool_use' : r.stop };
    }
  };
}

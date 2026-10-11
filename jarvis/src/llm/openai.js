/**
 * OpenAI 兼容适配器：/chat/completions 流式 + 函数调用。
 * OpenAI、Gemini（OpenAI 兼容端点）、DeepSeek、通义千问、Kimi、智谱、豆包、硅基流动、OpenRouter、Ollama 都走这里。
 *
 * 内部统一消息格式：
 *   { role: 'user', content }
 *   { role: 'assistant', content, toolCalls: [{ id, name, args }] }
 *   { role: 'tool', toolCallId, name, content, isError }
 */
export function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system.map((s) => s.text ?? s).join('\n\n') }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
        if (!m.content) msg.content = null;
      }
      out.push(msg);
    } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
  }
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

export function createOpenAIAdapter({ baseURL, apiKey, headers = {} }) {
  return {
    kind: 'openai',
    async stream({ model, system, messages, tools, signal, onText }) {
      const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }), ...headers },
        body: JSON.stringify({
          model,
          stream: true,
          messages: toOpenAIMessages(system, messages),
          ...(tools?.length && { tools: toOpenAITools(tools) })
        }),
        signal
      });
      if (!res.ok || !res.body) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
        throw new Error(`模型接口返回 ${res.status}${detail ? `：${detail}` : ''}`);
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

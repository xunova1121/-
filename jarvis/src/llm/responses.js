/**
 * OpenAI Responses 格式（/v1/responses）适配器：GPT 用它才能开 OpenAI 自带的联网搜索（web_search 工具，
 * 由 OpenAI 那边执行）。普通函数调用照常走。不保存对话（store: false），每次带上完整历史。
 *
 * 中转站可能不认联网搜索或推理参数：被拒（400 / 404 / 422）且还没输出文字时，按顺序降级重试并记住：
 *   0 全部（联网搜索 + 推理强度）→ 1 去掉推理强度 → 2 再去掉联网搜索
 */
import { sseLines, isTransient, stallGuard } from './openai.js';

const imagePart = (img) => ({ type: 'input_image', image_url: `data:${img.mime};base64,${img.data}` });

/** 统一消息 → Responses 的 input（函数调用和结果是独立的条目） */
export function toResponsesInput(messages) {
  const out = [];
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({ role: 'user', content: [{ type: 'input_text', text: '（以上工具返回的图片）' }, ...pending.map(imagePart)] });
    pending = [];
  };
  for (const m of messages) {
    if (m.role !== 'tool') flush();
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.images?.length ? [{ type: 'input_text', text: String(m.content ?? '') }, ...m.images.map(imagePart)] : String(m.content ?? '') });
    } else if (m.role === 'assistant') {
      if (m.content) out.push({ role: 'assistant', content: String(m.content) });
      for (const c of m.toolCalls ?? []) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    } else if (m.role === 'tool') {
      out.push({ type: 'function_call_output', call_id: m.toolCallId, output: String(m.content ?? '') });
      if (m.images?.length) pending.push(...m.images);
    }
  }
  flush();
  return out;
}

/** 从流式事件里收集文字、函数调用；最后以 response.completed 里的完整结果为准 */
export function createResponsesAccumulator(onText) {
  let text = '';
  let final = null;
  const calls = new Map(); // item_id → { call_id, name, args }
  return {
    push(ev) {
      if (ev.type === 'response.output_text.delta' && ev.delta) { text += ev.delta; onText?.(ev.delta); }
      else if (ev.type === 'response.output_item.added' && ev.item?.type === 'web_search_call') onText?.('', { serverTool: 'web_search' });
      else if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call') calls.set(ev.item.id, { call_id: ev.item.call_id, name: ev.item.name, args: ev.item.arguments || '' });
      else if (ev.type === 'response.function_call_arguments.delta' && calls.has(ev.item_id)) calls.get(ev.item_id).args += ev.delta || '';
      else if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call') calls.set(ev.item.id, { call_id: ev.item.call_id, name: ev.item.name, args: ev.item.arguments || '' });
      else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') final = ev.response;
      else if (ev.type === 'response.failed' || ev.type === 'error') {
        const msg = ev.response?.error?.message || ev.error?.message || ev.message || '模型接口出错';
        throw Object.assign(new Error(msg), { status: ev.status ?? 500 });
      }
    },
    result() {
      let list = [...calls.values()];
      if (final?.output) {
        const fromFinal = final.output.filter((o) => o.type === 'function_call').map((o) => ({ call_id: o.call_id, name: o.name, args: o.arguments || '' }));
        if (fromFinal.length) list = fromFinal;
        if (!text) text = final.output.filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      }
      const toolCalls = list.map((c, i) => {
        let args = {};
        let parseError = null;
        try { args = c.args ? JSON.parse(c.args) : {}; } catch (e) { parseError = `参数不是合法 JSON：${e.message}`; }
        return { id: c.call_id || `call_${i}_${Date.now().toString(36)}`, name: c.name, args, parseError };
      });
      return { text, toolCalls, stop: toolCalls.length ? 'tool_use' : final?.status === 'incomplete' ? 'max_tokens' : 'end_turn' };
    }
  };
}

export function createResponsesAdapter({ baseURL, apiKey, headers = {}, webSearch = true, fetchImpl = (...a) => fetch(...a) }) {
  let level = 0;
  const maxLevel = webSearch ? 2 : 1;
  async function once({ model, system, messages, tools, signal, onText, effort, allowWebSearch = true, stallTimeouts }, lvl, state) {
    const search = webSearch && lvl < 2 && allowWebSearch;
    const body = {
      model,
      stream: true,
      store: false,
      instructions: system.map((s) => s.text ?? s).filter(Boolean).join('\n\n'),
      input: toResponsesInput(messages),
      tools: [
        ...(tools ?? []).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema })),
        ...(search ? [{ type: 'web_search' }] : [])
      ],
      ...(lvl === 0 && effort && { reasoning: { effort } })
    };
    if (!body.tools.length) delete body.tools;
    const guard = stallGuard(signal, stallTimeouts);
    try {
      const res = await guard.race(fetchImpl(`${baseURL.replace(/\/$/, '')}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }), ...headers },
        body: JSON.stringify(body),
        signal: guard.signal
      }));
      guard.touch();
      if (!res.ok || !res.body) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
        throw Object.assign(new Error(`模型接口返回 ${res.status}${detail ? `：${detail}` : ''}`), { status: res.status });
      }
      const acc = createResponsesAccumulator((d, extra) => { if (d) state.started = true; onText?.(d, extra); });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await guard.race(reader.read());
        if (done) break;
        guard.touch();
        buf += dec.decode(value, { stream: true });
        const { events, rest } = sseLines(buf);
        buf = rest;
        for (const e of events) {
          if (e === '[DONE]') continue;
          let ev;
          try { ev = JSON.parse(e); } catch { continue; } // 心跳等非 JSON 行
          acc.push(ev);
        }
      }
      return acc.result();
    } catch (e) { throw guard.error(e); } finally { guard.done(); }
  }
  return {
    kind: 'openai-responses',
    get webSearchOn() { return webSearch && level < 2; },
    async stream(req) {
      const state = { started: false };
      for (let transient = 0; ; ) {
        try {
          return await once(req, level, state);
        } catch (e) {
          if (req.signal?.aborted || state.started) throw e;
          if ([400, 404, 422].includes(e?.status) && level < maxLevel) { level++; continue; }
          if (isTransient(e) && transient++ < (req.maxTransientRetries ?? 2)) { await new Promise((r) => setTimeout(r, 1500 * transient)); continue; }
          throw e;
        }
      }
    }
  };
}



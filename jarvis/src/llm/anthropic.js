/**
 * Anthropic Claude 适配器（官方 SDK，流式）。
 *   - 系统提示分两段：固定的人设段打缓存标记（prompt caching），动态的记忆 / 知识段放后面；
 *   - 可选服务端联网搜索（web_search 工具，由 Anthropic 执行，没有浏览器跨域问题）；
 *   - 支持服务端拒绝兜底（fallbacks: "default"）的型号会自动带上；
 *   - 工具轮内原样回传本轮 content（含思考块），跨轮只保留文本。
 */
import Anthropic from '@anthropic-ai/sdk';
import { nativeSearchAllowed } from './nativeSearch.js';
import { readAnthropicStream } from './anthropicStream.js';
import { stallGuard, isTransient, retryWait, retryAfterMs, sleep } from './openai.js';

const FALLBACK_MODELS = /^(claude-opus-5-5|claude-opus-5|claude-sonnet-5-5|claude-fable-5-1)$/;

const imageBlock = (img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });

export function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.images?.length ? [...m.images.map(imageBlock), { type: 'text', text: m.content }] : m.content });
    else if (m.role === 'assistant') {
      if (m.raw) out.push({ role: 'assistant', content: m.raw });
      else {
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
        if (content.length) out.push({ role: 'assistant', content });
      }
    } else if (m.role === 'tool') {
      const content = m.images?.length ? [{ type: 'text', text: m.content }, ...m.images.map(imageBlock)] : m.content;
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content, ...(m.isError && { is_error: true }) };
      const last = out.at(-1);
      // 同一轮的多个工具结果必须放在同一条 user 消息里
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

/**
 * compat：经中转站时，中转站可能不认新参数（推理档位、快速工具参数、模型兜底、联网搜索）。
 * 被拒（400 / 404 / 422）且还没输出文字时，按顺序降级重试：先去掉新参数，最后才去掉联网搜索；记住能用的档位。
 */
export function createAnthropicAdapter({ apiKey, baseURL, headers, browser = true, webSearch = false, compat = false, client: injected }) {
  const client = injected ?? new Anthropic({ maxRetries: 0, apiKey: apiKey || 'use-gateway-key', ...(baseURL && { baseURL }), ...(headers && { defaultHeaders: headers }), dangerouslyAllowBrowser: browser });
  let level = 0; // 0 全部参数；1 去掉新参数；2 再去掉联网搜索（只在 compat 时降级）
  const maxLevel = !compat ? 0 : webSearch ? 2 : 1;
  const usesNativeSearch = (options, lvl = level) => nativeSearchAllowed({ ...options, enabled: webSearch && lvl < 2 });

  async function once({ model, system, messages, tools, signal, onText, effort, allowWebSearch = true, maxWebSearches = 5, stallTimeouts }, lvl, state) {
    const search = usesNativeSearch({ tools, allowWebSearch, maxWebSearches }, lvl);
    const [stable, dynamic] = system;
    const params = {
      model,
      max_tokens: 32000,
      system: [
        { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
        ...(dynamic ? [{ type: 'text', text: dynamic }] : [])
      ],
      messages: toAnthropicMessages(messages),
      tools: [
        ...tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, ...(lvl === 0 && { eager_input_streaming: true }) })),
        ...(search ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: Math.min(5, Math.floor(maxWebSearches)) }] : [])
      ],
      ...(lvl === 0 && { output_config: { effort: effort || 'medium' } })
    };
    if (lvl === 0 && FALLBACK_MODELS.test(model)) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    // 卡住检测：中转站挂住不回时断开，交给上层换备用模型或重试
    const guard = stallGuard(signal, stallTimeouts);
    try {
      const stream = client.beta.messages.stream(params, { signal: guard.signal });
      const { text, message: msg } = await readAnthropicStream(stream, {
        guard,
        signal,
        onText: (delta) => {
          state.started = true;
          onText?.(delta);
        },
        onServerTool: (name) => onText?.('', { serverTool: name })
      });
      if (msg.stop_reason === 'refusal') {
        const note = '抱歉，这个请求我没办法协助。';
        onText?.(note);
        return { text: text + note, toolCalls: [], raw: null, stop: 'end_turn' };
      }
      const toolCalls = msg.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
      // 用量只记数字（评测用）；cache_read 是缓存命中的输入
      const u = msg.usage;
      const usage = u && Number.isFinite(u.input_tokens) ? { input: u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: Number.isFinite(u.output_tokens) ? u.output_tokens : null, cached: u.cache_read_input_tokens ?? null } : null;
      return { text, toolCalls, raw: msg.content, stop: msg.stop_reason, ...(usage && { usage }) };
    } catch (e) {
      const error = guard.error(e);
      // 卡住检测会重建错误，已展示的半成品仍要交给上层保留。
      if (e.partialText !== undefined) error.partialText = e.partialText;
      throw error;
    } finally {
      guard.done();
    }
  }

  return {
    kind: 'anthropic',
    usesNativeSearch,
    /** 联网搜索现在是否还开着（中转站不支持时会被降级关掉） */
    get webSearchOn() { return webSearch && level < 2; },
    async stream(req) {
      const state = { started: false };
      for (let transient = 0; ; ) {
        try {
          return await once(req, level, state);
        } catch (e) {
          if (req.signal?.aborted) throw e;
          // 连接卡住 / 连接出错，而且还没输出文字：等一下重试（最多两次），再不行交给上层换备用模型
          if (!state.started && isTransient(e) && transient++ < (req.maxTransientRetries ?? 2)) { e.retryAfterMs ??= retryAfterMs(e.headers?.get?.('retry-after') ?? e.headers?.['retry-after']); await sleep(retryWait(1500 * transient, e), req.signal); continue; }
          const rejected = [400, 404, 422].includes(e?.status) && !state.started;
          if (!rejected || level >= maxLevel) throw e;
          level++;
        }
      }
    }
  };
}




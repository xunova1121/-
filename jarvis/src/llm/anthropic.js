/**
 * Anthropic Claude 适配器（官方 SDK，流式）。
 *   - 系统提示分两段：固定的人设段打缓存标记（prompt caching），动态的记忆 / 知识段放后面；
 *   - 可选服务端联网搜索（web_search 工具，由 Anthropic 执行，没有浏览器跨域问题）；
 *   - 支持服务端拒绝兜底（fallbacks: "default"）的型号会自动带上；
 *   - 工具轮内原样回传本轮 content（含思考块），跨轮只保留文本。
 */
import Anthropic from '@anthropic-ai/sdk';

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

export function createAnthropicAdapter({ apiKey, baseURL, browser = true, webSearch = false }) {
  const client = new Anthropic({ apiKey: apiKey || 'use-gateway-key', ...(baseURL && { baseURL }), dangerouslyAllowBrowser: browser });
  return {
    kind: 'anthropic',
    async stream({ model, system, messages, tools, signal, onText }) {
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
          ...tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true })),
          ...(webSearch ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }] : [])
        ],
        output_config: { effort: 'medium' }
      };
      if (FALLBACK_MODELS.test(model)) {
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
      }
      const stream = client.beta.messages.stream(params, { signal });
      let text = '';
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          text += ev.delta.text;
          onText?.(ev.delta.text);
        } else if (ev.type === 'content_block_start' && ev.content_block.type === 'server_tool_use') {
          onText?.('', { serverTool: ev.content_block.name });
        }
      }
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') {
        const note = '抱歉，这个请求我没办法协助。';
        onText?.(note);
        return { text: text + note, toolCalls: [], raw: null, stop: 'end_turn' };
      }
      const toolCalls = msg.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
      return { text, toolCalls, raw: msg.content, stop: msg.stop_reason };
    }
  };
}

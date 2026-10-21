import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createAnthropicAdapter } from '../src/llm/anthropic.js';
import { createResponsesAdapter } from '../src/llm/responses.js';
import { createTools } from '../src/agent/tools.js';
import { runAgent } from '../src/agent/agent.js';
import { dialoguePolicy } from '../src/agent/dialoguePolicy.js';

const searchTool = { name: 'web_search', description: '应用搜索', input_schema: { type: 'object', properties: {} } };
const request = { model: 'fixture', system: ['测试', ''], messages: [{ role: 'user', content: '查资料' }], tools: [searchTool] };
const completed = [{ type: 'response.output_text.delta', delta: '完成' }, { type: 'response.completed', response: { output: [] } }];

// 仅模拟协议，不访问服务商；重复工具名按真实接口约束直接拒绝。
function claudeClient(makeMessage = () => ({ content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn' })) {
  const seen = [];
  return {
    seen,
    beta: { messages: { stream(params) {
      expect(new Set(params.tools.map((tool) => tool.name)).size).toBe(params.tools.length);
      seen.push(params);
      const message = makeMessage(params, seen.length);
      return {
        async *[Symbol.asyncIterator]() {
          for (const block of message.content) if (block.type === 'text') yield { type: 'content_block_delta', delta: { type: 'text_delta', text: block.text } };
        },
        finalMessage: async () => message
      };
    } } }
  };
}

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
afterEach(() => { delete globalThis.indexedDB; });

describe('应用搜索与模型原生搜索互斥', () => {
  it.each([false, true])('Claude兼容模式=%s：保留应用工具，后续无应用工具时恢复原生搜索', async (compat) => {
    const client = claudeClient();
    const adapter = createAnthropicAdapter({ client, webSearch: true, compat });
    await adapter.stream(request);
    expect(client.seen[0].tools.filter((tool) => tool.name === 'web_search')).toHaveLength(1);
    expect(client.seen[0].tools[0].input_schema).toEqual(searchTool.input_schema);
    expect(client.seen[0].tools.some((tool) => tool.type === 'web_search_20260209')).toBe(false);
    await adapter.stream({ ...request, tools: [] });
    expect(client.seen[1].tools.some((tool) => tool.type === 'web_search_20260209')).toBe(true);
    expect(adapter.webSearchOn).toBe(true);
    await adapter.stream({ ...request, tools: [], allowWebSearch: false });
    expect(client.seen[2].tools).toEqual([]);
  });

  it('Responses保留应用搜索，不同时附带原生搜索，下一轮不永久关闭', async () => {
    const bodies = [];
    const adapter = createResponsesAdapter({ baseURL: 'https://fixture.invalid/v1', apiKey: 'fixture', fetchImpl: async (_, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(completed.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } });
    await adapter.stream(request);
    expect(bodies[0].tools).toEqual([{ type: 'function', name: 'web_search', description: searchTool.description, parameters: searchTool.input_schema }]);
    await adapter.stream({ ...request, tools: [] });
    expect(bodies[1].tools).toEqual([{ type: 'web_search' }]);
    await adapter.stream({ ...request, tools: [], allowWebSearch: false });
    expect(bodies[2].tools).toBeUndefined();
  });

  it('实际智能体经Claude适配器调用DeepSeek，并将结果交还模型，不走原生搜索', async () => {
    const query = '今日A股收盘';
    const client = claudeClient((params, step) => {
      if (step === 1) return { content: [{ type: 'tool_use', id: 'search-1', name: 'web_search', input: { query } }], stop_reason: 'tool_use' };
      const results = params.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'tool_result');
      expect(results.some((block) => block.content.includes('DeepSeek检索摘要') && block.content.includes('https://example.com/report'))).toBe(true);
      return { content: [{ type: 'text', text: '找到了报道：https://example.com/report' }], stop_reason: 'end_turn' };
    });
    const fetchViaGateway = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.deepseek.com/v1/tools/search');
      expect(JSON.parse(init.body).query).toContain(query);
      return new Response(JSON.stringify({ results: [{ title: '收盘报道', url: 'https://example.com/report', summary: '测试摘要' }] }));
    });
    const tools = createTools({ deepseekSearchEnabled: true, deepseekSearchKey: 'fixture', fetchViaGateway }).filter((tool) => tool.name === 'web_search');
    const events = [];
    const result = await runAgent({ adapter: createAnthropicAdapter({ client, webSearch: true }), model: 'fixture', history: [], userText: query, tools, context: { dynamic: '测试', kbHits: [] }, quiet: true, emit: (event) => events.push(event) });
    expect(result.text).toContain('https://example.com/report');
    expect(fetchViaGateway).toHaveBeenCalledTimes(1);
    expect(client.seen).toHaveLength(2);
    expect(client.seen.every((params) => !params.tools.some((tool) => tool.type === 'web_search_20260209'))).toBe(true);
    expect(events.some((event) => event.type === 'server_tool')).toBe(false);
    expect(JSON.stringify(events)).toContain('DeepSeek搜索返回1条结果');
    expect(events.filter((event) => event.type === 'tool_start').map((event) => event.name)).toEqual(['web_search']);
  });

  it('普通今日查询优先已有时间，保留精确时间和数值核验工具', () => {
    const policy = dialoguePolicy('今天A股行情');
    expect(policy).toContain('普通今日查询直接检索');
    expect(policy).toContain('跨日或需要精确时刻');
    expect(policy).toContain('verify_numbers');
  });
});

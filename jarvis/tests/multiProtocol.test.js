import { describe, it, expect } from 'vitest';
import { createResponsesAdapter, toResponsesInput, createResponsesAccumulator } from '../src/llm/responses.js';
import { createAdapter, protocolFor, listModels } from '../src/llm/config.js';
import { providerEndpoint } from '../src/llm/images.js';
import { cachedModelRefs } from '../src/ui/modelPicker.js';

const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const req = { model: 'gpt-6.1-sol', system: ['你是未央', ''], messages: [{ role: 'user', content: '今天新闻' }], tools: [{ name: 'read_file', description: 'd', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] };

describe('多协议中转：按模型用原生格式', () => {
  it('按模型名选协议', () => {
    expect(protocolFor('claude-fable-5-1')).toBe('anthropic');
    expect(protocolFor('gpt-6.1-sol')).toBe('responses');
    expect(protocolFor('o4-mini')).toBe('responses');
    expect(protocolFor('gemini-3.5-flash')).toBe('chat');
    expect(protocolFor('deepseek-chat')).toBe('chat');
  });
  it('适配器：地址填根地址或带 /v1 都行', () => {
    const cfg = { provider: 'relay-multi', keys: { 'relay-multi': 'sk-teamo-x' }, baseURLs: { 'relay-multi': 'https://api.teamorouter.com/v1/' }, models: { 'relay-multi': 'gpt-6.1-sol' }, claudeWebSearch: true };
    expect(createAdapter(cfg).adapter.kind).toBe('openai-responses');
    expect(createAdapter({ ...cfg, models: { 'relay-multi': 'claude-fable-5-1' } }).adapter.kind).toBe('anthropic');
    expect(createAdapter({ ...cfg, models: { 'relay-multi': 'deepseek-chat' } }).adapter.kind).toBe('openai');
    expect(providerEndpoint(cfg).base).toBe('https://api.teamorouter.com/v1'); // 画图走 /v1/images
  });
  it('读模型列表：GET 根地址/v1/models', async () => {
    const asked = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url) => { asked.push(url); return new Response(JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'claude-fable-5-1' }] })); };
    try {
      const ids = await listModels({ provider: 'relay-multi', keys: { 'relay-multi': 'k' }, baseURLs: { 'relay-multi': 'https://api.teamorouter.com' } });
      expect(asked[0]).toBe('https://api.teamorouter.com/v1/models');
      expect(ids).toEqual(['claude-fable-5-1', 'gpt-6.1-sol']);
    } finally { globalThis.fetch = orig; }
  });
});

describe('Responses 格式（GPT）', () => {
  it('预算收尾请求禁用原生搜索，下一次正常请求仍可搜索', async () => {
    const bodies=[];
    const a=createResponsesAdapter({baseURL:'https://r/v1',apiKey:'test',fetchImpl:async(url,init)=>{bodies.push(JSON.parse(init.body));return sse([{type:'response.output_text.delta',delta:'答'},{type:'response.completed',response:{output:[]}}]);}});
    await a.stream({...req,allowWebSearch:false});await a.stream(req);
    expect(bodies[0].tools.some(t=>t.type==='web_search')).toBe(false);
    expect(bodies[1].tools.some(t=>t.type==='web_search')).toBe(true);
    expect(a.webSearchOn).toBe(true);
  });
  it('历史转换：函数调用和结果是单独的条目', () => {
    const input = toResponsesInput([
      { role: 'user', content: '读文件' },
      { role: 'assistant', content: '好的', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'read_file', content: '内容' }
    ]);
    expect(input).toEqual([
      { role: 'user', content: '读文件' },
      { role: 'assistant', content: '好的' },
      { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'c1', output: '内容' }
    ]);
  });
  it('流式：文字、联网搜索、函数调用', async () => {
    const texts = [];
    const extras = [];
    let body;
    const a = createResponsesAdapter({ baseURL: 'https://r/v1', apiKey: 'k', fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return sse([
        { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws' } },
        { type: 'response.output_text.delta', delta: '今天' },
        { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc', call_id: 'c9', name: 'read_file', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: 'fc', delta: '{"path":' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc', delta: '"x"}' },
        { type: 'response.completed', response: { status: 'completed', output: [] } }
      ]);
    } });
    const r = await a.stream({ ...req, onText: (d, extra) => { if (d) texts.push(d); if (extra) extras.push(extra); } });
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', stream: true, store: false, instructions: '你是未央' });
    expect(body.tools.map((t) => t.type)).toEqual(['function', 'web_search']);
    expect(texts.join('')).toBe('今天');
    expect(extras).toEqual([{ serverTool: 'web_search' }]);
    expect(r.toolCalls).toEqual([{ id: 'c9', name: 'read_file', args: { path: 'x' }, parseError: null }]);
    expect(r.stop).toBe('tool_use');
  });
  it('中转站不认推理参数 / 联网搜索：依次去掉重试', async () => {
    const bodies = [];
    const a = createResponsesAdapter({ baseURL: 'https://r/v1', apiKey: 'k', fetchImpl: async (url, init) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if (b.tools?.some((t) => t.type === 'web_search')) return new Response('web_search not supported', { status: 400 });
      return sse([{ type: 'response.output_text.delta', delta: '好' }, { type: 'response.completed', response: { output: [] } }]);
    } });
    const r = await a.stream({ ...req, effort: 'low', onText: () => {} });
    expect(r.text).toBe('好');
    expect(bodies).toHaveLength(3);
    expect(bodies[1].reasoning).toBeUndefined();
    expect(a.webSearchOn).toBe(false);
  });
  it('只给了最终结果（没有逐字）也能取到文字', () => {
    const acc = createResponsesAccumulator();
    acc.push({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: '完整回答' }] }] } });
    expect(acc.result().text).toBe('完整回答');
  });
});

describe('模型分工下拉框', () => {
  it('不发请求，用缓存里的各服务商模型（当前服务商只写模型名）', () => {
    const cfg = { provider: 'relay-multi', keys: { 'relay-multi': 'k', deepseek: 'k2' }, baseURLs: { 'relay-multi': 'https://api.teamorouter.com' }, models: {},
      modelLists: { 'relay-multi|https://api.teamorouter.com': { ids: ['gpt-6.1-sol', 'gpt-image-2'], at: Date.now() } } };
    const refs = cachedModelRefs(cfg);
    expect(refs[0]).toBe('gpt-6.1-sol');
    expect(refs).not.toContain('gpt-image-2'); // 画图模型不进聊天分工
    expect(refs.length).toBeGreaterThan(1); // DeepSeek 还没读过列表：用它预置的型号
    expect(refs.slice(1).every((r) => r.startsWith('deepseek::'))).toBe(true);
  });
});


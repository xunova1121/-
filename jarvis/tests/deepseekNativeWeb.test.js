import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepseekSearchPanel } from '../src/ui/deepseekSearchPanel.js';
import { createEvaluationAccess, evaluationAdapter } from '../server/evaluationAccess.mjs';
import { runAgent } from '../src/agent/agent.js';
import { lookupIntent } from '../src/agent/lookup/intent.js';
import { deepseekQuestionMode } from '../src/agent/deepseekQuestion.js';
import { createAdapter, DEFAULT_CONFIG } from '../src/llm/config.js';
import { createImageSight } from '../src/agent/imageSight.js';
import { seesImages } from '../src/llm/router.js';
import { createBusinessTools } from '../src/agent/businessIntelligence.js';
import { inline } from '../src/core/markdown.js';

const url = 'https://example.org/bulletin';
const date = '2026-11-18T01:00:00Z';
const now = () => Date.parse('2026-11-18T03:00:00Z');
const story = '📰 今早展览开幕，展期三天。';
const tool = name => ({ name, description: name, input_schema: { type: 'object', properties: {} }, run: vi.fn(async () => '公开资料') });
const tools = ['web_search', 'fetch_url'].map(tool);
const official = (other = {}) => createAdapter({ ...DEFAULT_CONFIG, provider: 'deepseek', models: { deepseek: 'deepseek-flash' }, keys: { deepseek: 'test-fixture' }, deepseekNativeWeb: true, ...other });

function frames(choices, usage = { prompt_tokens: 34, completion_tokens: 16 }) {
  return new Response([...choices.map(choice => ({ choices: [choice] })), { choices: [], usage }].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function webReply({ mode = 'quick', content = story, source = url, cite = source, published = date, start = 0, end = Array.from(content).length, status = 'completed' } = {}) {
  const read = mode === 'link';
  const page = { url: source, title: '展览公告', published_at: published };
  const call = { id: 'srv-1', type: read ? 'deepseek_read_url' : 'deepseek_web_search', action: { type: read ? 'read_link' : 'search' }, status, ...(read ? { page } : { sources: [page] }) };
  return frames([
    { server_tool_event: { type: 'call_started', call: { ...call, status: 'in_progress' } }, delta: {} },
    { server_tool_event: { type: 'call_completed', call }, delta: {} },
    { delta: { content } },
    { finish_reason: 'stop', delta: { server_tool_calls: [{ index: 0, calls: [call] }], annotations: cite ? [{ type: 'url_citation', url_citation: { url: cite, title: page.title, start_index: start, end_index: end } }] : [] } }
  ]);
}
const plainReply = () => frames([{ delta: { content: '这是一份公开资料摘要。' }, finish_reason: 'stop' }]);
function capture(reply) {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn(async (address, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return reply(body, requests.length);
  }));
  return requests;
}
async function turn(userText, options = {}) {
  const events = [];
  const result = await runAgent({ ...official(), tools, history: [], userText, quiet: true, isolated: true, now, emit: e => events.push(e), ...options });
  return { result, events };
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('官方 Flash 的联网问答和原图输入', () => {
  it('从正常问答进入，新闻只搜一次，微信式聊天气泡里的引用可点，流尾用量可见', async () => {
    const requests = capture(() => webReply());
    const { result, events } = await turn('今天有什么新闻？', { history: [{ role: 'user', content: '上一轮的海报', images: [{ mime: 'image/png', data: 'old' }] }, { role: 'assistant', content: '已经看过海报。' }] });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).not.toContain('上一轮的海报');
    expect(requests[0]).toMatchObject({ model: 'deepseek-flash', tools: [{ type: 'deepseek_web_search' }], thinking: { type: 'disabled' }, safety_check: { level: 'high' } });
    expect(inline(result.text)).toContainEqual({ text: '1', link: url });
    expect(events.filter(e => e.type === 'server_tool').map(e => e.name)).toEqual(['web_search']);
    expect(events.filter(e => e.phase === 'model_end')[0].usage).toMatchObject({ input: 34, output: 16 });
    expect(tools[0].run).not.toHaveBeenCalled();
  });
  it('指定公开链接单独读，来源与目标一致', async () => {
    const requests = capture(() => webReply({ mode: 'link' }));
    const { result } = await turn('请总结 ' + url);
    expect(requests.map(x => x.tools)).toEqual([[{ type: 'deepseek_read_url' }]]);
    expect(inline(result.text).some(span => span.link === url)).toBe(true);
  });
  it('显式深度搜索开启思考', async () => {
    const requests = capture(() => webReply());
    await turn('深度搜索博物馆展览的最新进展');
    expect(requests[0].thinking).toEqual({ type: 'enabled' });
  });
  it.each([
    ['无引用', { cite: null }], ['未经工具返回的引用', { cite: 'https://other.org/' }], ['无效范围', { end: 500 }],
    ['失败调用', { status: 'failed' }], ['不满足今日时效', { published: '2026-11-16' }],
    ['正文夹带未知链接', { content: '看看 https://other.org/leak' }]
  ])('%s时只回到原流程，不展示未通过的草稿', async (_label, invalid) => {
    const requests = capture((_body, n) => n === 1 ? webReply(invalid) : plainReply());
    const { result } = await turn('今天有什么新闻？');
    expect(requests.filter(b => b.tools?.some(t => t.type === 'deepseek_web_search'))).toHaveLength(1);
    expect(requests.length).toBeGreaterThan(1);
    expect(result.text).not.toContain(invalid.content || story);
  });
  it('网页编码点位置正确，链接中的括号可在聊天中打开', async () => {
    const source = 'https://example.org/item(2)';
    capture(() => webReply({ source, start: 0, end: 1 }));
    const { result } = await turn('搜索展览信息');
    expect(result.text.startsWith('📰 [1]')).toBe(true);
    expect(inline(result.text)).toContainEqual({ text: '1', link: 'https://example.org/item%282%29' });
  });
  it.each(['搜索这家公司的股东', '搜索江苏天合云商股份有限公司最新信息', '搜索这张截图里的消息', '搜索招投标信息', '定时搜索今天新闻', '搜索上证指数行情', '不用联网搜索今天的新闻', '帮我总结 http://127.0.0.1/a', '请读取 https://example.org/a?token=test', '搜索上面这些产品'])('专用任务、私有链接或追问保留现有路线：%s', text => {
    expect(deepseekQuestionMode(text, lookupIntent(text), tools)).toBe('');
  });
  it('股东查询经过真实企业工具，保留查询类型，不重复调用模型内搜索', async () => {
    const company = '江苏天合云商股份有限公司';
    const search = vi.fn(async () => []);
    const lookup = createBusinessTools({}, { search }).find(t => t.name === 'lookup_company');
    const run = vi.spyOn(lookup, 'run');
    const requests = capture((_body, n) => n === 1 ? frames([{ finish_reason: 'tool_calls', delta: { tool_calls: [
      { index: 0, id: 'company-1', function: { name: 'lookup_company', arguments: JSON.stringify({ company, section: 'shareholders' }) } }
    ] } }]) : plainReply());
    await turn('查江苏天合云商股份有限公司的股东信息', { tools: [...tools, lookup] });
    expect(run.mock.calls[0][0]).toMatchObject({ company, section: 'shareholders' });
    expect(search).toHaveBeenCalled();
    expect(requests.every(b => !b.tools?.some(t => t.type?.startsWith('deepseek_')))).toBe(true);
  });
  it('用户中止时不再另开搜索，不展示未完成内容', async () => {
    const controller = new AbortController();
    const requests = capture(() => { controller.abort(); throw new DOMException('cancelled', 'AbortError'); });
    await expect(turn('今天有什么新闻？', { signal: controller.signal })).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(tools[0].run).not.toHaveBeenCalled();
  });
  it('服务商明确过滤的内容不转递给备用搜索', async () => {
    const requests = capture(() => frames([{ delta: {}, finish_reason: 'content_filter' }]));
    await expect(turn('今天有什么新闻？')).rejects.toMatchObject({ code: 'MODEL_CONTENT_FILTER' });
    expect(requests).toHaveLength(1);
  });
  it('截图原图进入 Flash，不触发网页请求或重复转述', async () => {
    const requests = capture(plainReply);
    const describe = vi.fn();
    const img = { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3mQAAAAASUVORK5CYII=' };
    await turn('这张海报主体在哪里？', { images: [img], describeImages: describe });
    expect(describe).not.toHaveBeenCalled();
    expect(requests.some(b => b.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.image_url?.url?.endsWith(img.data))))).toBe(true);
    expect(requests.every(b => !b.tools?.some(t => t.type?.startsWith('deepseek_')))).toBe(true);
    expect(seesImages('deepseek-v4-pro')).toBe(false);
    const message = { content: '看看', images: [img] };
    await createImageSight({ model: 'deepseek-v4-pro', describe: async () => '白底截图' })(message);
    expect(message.content).toContain('白底截图');
  });
  it('完整工作台只启用原生开关也能搜，限制为无联网工具的范围继续生效', async () => {
    const reqs = capture(() => webReply());
    const { result } = await turn('搜索展览信息', { tools: ['get_today_news', 'fetch_url'].map(tool) });
    expect(reqs).toHaveLength(1);
    expect(inline(result.text).some(s => s.link === url)).toBe(true);
    expect(deepseekQuestionMode('搜索展览信息', lookupIntent('搜索展览信息'), [])).toBe('');
  });
  it('有每日次数上限的评测身份不能启用不支持上游次数上限的原生工具', async () => {
    const security = { consume: vi.fn(), remaining: () => 100 };
    const access = createEvaluationAccess({ store: {}, dataDir: '.', security });
    const adapter = evaluationAdapter(official().adapter);
    const requests = capture(plainReply);
    expect(adapter.deepseekWeb).toBe(true);
    await access.run({ evaluationId: 'test', evaluationAuthorization: { id: 'fixture' } }, async () => {
      expect(adapter.deepseekWeb).toBe(false);
      await adapter.stream({ model: 'deepseek-flash', system: [], messages: [], tools: [], webMode: 'quick', maxWebSearches: 3, allowWebSearch: true });
    });
    expect(requests[0]).not.toHaveProperty('thinking');
    expect(requests[0]).not.toHaveProperty('tools');
    expect(security.consume.mock.calls.map(args => args[1])).toEqual(['model']);
  });
  it('云端开关单独保存，当前聊天模型和独立搜索密钥仍按原配置读取', async () => {
    const node = (tag, props = {}, ...children) => ({ tag, value: '', ...props, children, addEventListener(event, fn) { this[event] = fn; } });
    let saved = { deepseekSearchKey: 'fixture-only', provider: 'deepseek', deepseekSearchEnabled: false };
    const workspace = { scope: 'server', patch: vi.fn(async update => { saved = update(saved); }) };
    const tree = deepseekSearchPanel({ cfg: saved, workspace, node, toast: vi.fn() });
    const label = tree.children.find(c => c.children?.includes('用官方 Flash 联网回答问题并附来源'));
    label.children[0].checked = true;
    const find = (n, title) => n?.textContent === title ? n : n?.children?.map(child => find(child, title)).find(Boolean);
    await find(tree, '保存搜索设置').click();
    expect(workspace.patch.mock.calls[0][1]).toBe('server');
    expect(saved).toEqual({ deepseekSearchKey: 'fixture-only', provider: 'deepseek', deepseekSearchEnabled: false, deepseekNativeWeb: true });
  });
  it('默认关闭，其他型号和服务商不接受官方工具', () => {
    expect(DEFAULT_CONFIG.deepseekNativeWeb).toBe(false);
    expect(official({ deepseekNativeWeb: false }).adapter.deepseekWeb).toBe(false);
    expect(official({ models: { deepseek: 'deepseek-v4-pro' } }).adapter.deepseekWeb).toBe(false);
    expect(official({ provider: 'openai', keys: { openai: 'test' }, models: { openai: 'deepseek-flash' } }).adapter.deepseekWeb).toBe(false);
  });
});

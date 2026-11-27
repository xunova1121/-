/**
 * 需求上下文A/B：默认拦截真实OpenAI适配器生成的请求体，不联网、不伪造服务首字耗时。
 * --live：显式使用JARVIS_BENCHMARK_URL/MODEL/KEY，交替运行3组A/B；只输出大小与时间，不写密钥/请求正文/模型回复。
 */
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createOpenAIAdapter } from '../src/llm/openai.js';
import { EmotionTagStripper } from '../shared/emotionTag.js';
import { archiveRequirements, collectRequirements, requirementsBlock, requirementsTool } from '../src/agent/taskRequirements.js';
import { createTurnArchive } from '../src/agent/turnContext.js';

const baseline = JSON.parse(await fs.readFile(new URL('../tests/fixtures/requirements-v122.json', import.meta.url), 'utf8'));
const old = await import(`data:text/javascript;base64,${Buffer.from(baseline.requirementsSource).toString('base64')}`);
const promptValue = (literal) => {
  if (literal.includes('${')) throw new Error('基准提示含插值，不能作为独立模板读取');
  return vm.runInNewContext(literal, Object.create(null), { timeout: 100 });
};
const beforePrompt = promptValue(baseline.promptLiteral);
const source = await fs.readFile(new URL('../src/agent/agent.js', import.meta.url), 'utf8');
const afterPrompt = promptValue(source.match(/export const STABLE_PROMPT = (`[\s\S]*?`);/)[1]);
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const message = (content, ts, role = 'user') => ({ role, content, ts });

export function fixtures() {
  const history = [message('你好', 1), message('你好，有什么事交给我？', 2, 'assistant')];
  for (let i = 0; i < 20; i++) history.push(message(`项目${i}：PPT预算67万元，15页。${'保留资料中的数字、对象和原文内容。'.repeat(35)}`, 3 + i * 2), message(`已记录项目${i}的要求。`, 4 + i * 2, 'assistant'));
  const query = '预算PPT要求是否保留？只用一句话确认，不要调用工具。';
  return [
    { name: '未压缩长对话', history, all: history, query },
    { name: '已压缩长对话', history: history.slice(-8), all: history, query },
    { name: '已有项目对话中问候', history: history.slice(-8), all: history, query: '你好' }
  ];
}

function excerpts(block) {
  try { return JSON.parse(block.slice(block.indexOf('{'))).entries ?? []; } catch { return []; }
}

async function capture(options) {
  const original = globalThis.fetch;
  let body = '';
  globalThis.fetch = async (_url, init) => {
    body = init.body;
    return new Response('data: {"choices":[{"delta":{"content":"测"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    await createOpenAIAdapter({ baseURL: 'https://body-capture.invalid', apiKey: '', retryDelays: [] }).stream({ ...options, onText: () => {} });
    return body;
  } finally { globalThis.fetch = original; }
}

export async function measureRequests() {
  const rows = [];
  for (const f of fixtures()) {
    const record = collectRequirements([...f.all, message(f.query, 1000)]);
    const blocks = { before: old.requirementsBlock(record, f.query), after: requirementsBlock(record, f.query, { history: f.history }) };
    const tools = [requirementsTool(record), createTurnArchive().tool];
    const visible = new Set([...f.history.filter((m) => m.role === 'user').map((m) => m.content), f.query]);
    const byId = new Map(record.entries.map((e) => [e.id, e]));
    const variants = {};
    for (const variant of ['before', 'after']) {
      const options = { model: 'benchmark-model', system: [variant === 'before' ? beforePrompt : afterPrompt, blocks[variant]], messages: [...f.history, message(f.query, 1000)], tools };
      const body = await capture(options);
      variants[variant] = { requestBytes: bytes(body), indexChars: blocks[variant].length,
        repeatedRequirementChars: excerpts(blocks[variant]).reduce((n, e) => n + (visible.has(byId.get(e.id)?.text) ? e.excerpt.length : 0), 0) };
    }
    rows.push({ scenario: f.name, ...variants, savedRequestBytes: variants.before.requestBytes - variants.after.requestBytes });
  }
  const messages = Array.from({ length: 900 }, (_, i) => message(`需求${i}：${'原话'.repeat(250)}`, i + 1));
  const legacy = old.collectRequirements(messages);
  const before = { messages: messages.slice(-400), requirements: legacy };
  const after = archiveRequirements(messages, legacy);
  return { baselineCommit: baseline.commit, method: '同一OpenAI适配器实际序列化请求体；固定两个读取工具，不含图片/MCP；默认拦截fetch，不联网',
    rows, storage: { beforeBytes: bytes(JSON.stringify(before)), afterBytes: bytes(JSON.stringify(after)), archivedEntries: after.requirements.entries.length,
      visibleUserMessages: after.messages.length, mergedEntries: collectRequirements(after.messages, after.requirements).entries.length },
    firstVisibleText: { status: 'not_measured', reason: '默认只测请求体；没有真实服务请求，不报告模拟首字耗时' } };
}

async function live() {
  const baseURL = process.env.JARVIS_BENCHMARK_URL, apiKey = process.env.JARVIS_BENCHMARK_KEY, model = process.env.JARVIS_BENCHMARK_MODEL;
  if (!baseURL || !apiKey || !model) throw new Error('未配置真实测试服务：需要JARVIS_BENCHMARK_URL/MODEL/KEY；请在受信任环境配置，不要在聊天或仓库填写密钥');
  const f = fixtures()[0], record = collectRequirements([...f.all, message(f.query, 1000)]);
  const blocks = { before: old.requirementsBlock(record, f.query), after: requirementsBlock(record, f.query, { history: f.history }) };
  const adapter = createOpenAIAdapter({ baseURL, apiKey, retryDelays: [] }), runs = [];
  for (let pair = 0; pair < 3; pair++) {
    for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
      const start = performance.now(), strip = new EmotionTagStripper();
      let firstTextMs = null, firstVisibleMs = null;
      const out = await adapter.stream({ model, signal: AbortSignal.timeout(120000), system: [variant === 'before' ? beforePrompt : afterPrompt, blocks[variant]],
        messages: [...f.history, message(f.query, 1000)], tools: [requirementsTool(record), createTurnArchive().tool],
        onText: (text) => { if (text && firstTextMs === null) firstTextMs = performance.now() - start; if (strip.push(text).text && firstVisibleMs === null) firstVisibleMs = performance.now() - start; } });
      if (strip.flush().text && firstVisibleMs === null) firstVisibleMs = performance.now() - start;
      runs.push({ pair: pair + 1, variant, firstTextMs, firstVisibleMs, totalMs: performance.now() - start, toolCalls: out.toolCalls.length });
    }
  }
  return { status: 'measured', model, samplesPerVariant: 3, runs, note: '含网络和服务耗时；交替顺序降低顺序偏差，不能只凭3组结果保证用户设备提速' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const report = await measureRequests();
  if (process.argv.includes('--live')) {
    try { report.firstVisibleText = await live(); }
    catch { report.firstVisibleText = { status: 'not_measured', reason: '真实服务未配置或调用失败；为避免泄露凭据，不输出服务返回内容' }; process.exitCode = 1; }
  }
  console.log(JSON.stringify(report, null, 2));
}

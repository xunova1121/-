// 在已配置 DEEPSEEK_API_KEY 的环境执行。每次只跑一组公开样例，标准输出不含密钥或模型返回的正文。
import { createCanvas } from '@napi-rs/canvas';
import { runAgent } from '../src/agent/agent.js';
import { createTools } from '../src/agent/tools.js';
import { createAdapter, DEFAULT_CONFIG } from '../src/llm/config.js';
import { inline } from '../src/core/markdown.js';

const mode = process.argv[2];
const key = process.env.DEEPSEEK_API_KEY;
if (!['native', 'existing'].includes(mode) || !key) {
  console.error('请设置 DEEPSEEK_API_KEY，再运行 node scripts/measure-deepseek-web.mjs native 或 existing。未发出请求。');
  process.exit(2);
}

function posterImage() {
  const canvas = createCanvas(320, 200);
  const g = canvas.getContext('2d');
  g.fillStyle = '#ebf1f7';
  g.fillRect(0, 0, 320, 200);
  g.fillStyle = '#af3a2c';
  g.fillRect(26, 25, 105, 150);
  return { mime: 'image/png', data: canvas.toBuffer('image/png').toString('base64') };
}

for (const sample of [
  { id: 'news', userText: '今天有什么新闻？' },
  { id: 'company', userText: '查江苏天合云商股份有限公司的股东，有可靠来源再写。' },
  { id: 'poster', userText: '这张海报红色块在左边还是右边？', images: [posterImage()] }
]) {
  const allowed = new Set(['web_search', 'fetch_url', 'get_today_news', 'lookup_company']);
  let standaloneSuccess = 0;
  const fetchViaGateway = async (url, init) => {
    const response = await fetch(url, init);
    if (response.ok && /^https:\/\/api\.deepseek\.com\/v1\/tools\/(search|fetch)$/.test(url)) standaloneSuccess++;
    return response;
  };
  const tools = createTools({ fetchViaGateway, deepseekSearchEnabled: true, deepseekSearchKey: key }).filter(tool => allowed.has(tool.name));
  const cfg = { ...DEFAULT_CONFIG, provider: 'deepseek', models: { deepseek: 'deepseek-flash' }, keys: { deepseek: key }, deepseekNativeWeb: mode === 'native' };
  const started = performance.now();
  let firstTextMs = null;
  const modelCalls = [], nativeTools = [], appTools = [];
  const emit = event => {
    if (event.type === 'text' && event.delta?.trim()) firstTextMs ??= Math.round(performance.now() - started);
    if (event.phase === 'model_end') modelCalls.push(event.usage || null);
    if (event.type === 'server_tool') nativeTools.push(event.name);
    if (event.type === 'tool_end') appTools.push({ name: event.name, ok: event.ok });
  };
  let outcome;
  try {
    const result = await runAgent({ ...createAdapter(cfg), ...sample, history: [], isolated: true, quiet: true, emit, tools, signal: AbortSignal.timeout(90_000), lookupDeadline: true });
    const sources = new Set(inline(result.text).filter(part => part.link).map(part => part.link));
    outcome = { sources: sources.size, ...(sample.id === 'poster' && { answeredLeft: /左/.test(result.text) && !/右/.test(result.text) }) };
  } catch (error) {
    outcome = { error: error.code || error.name, status: error.status || null };
  }
  console.log(JSON.stringify({ sample: sample.id, mode, firstTextMs, totalMs: Math.round(performance.now() - started), modelCalls, nativeTools, appTools, standaloneSuccess, ...outcome }));
}

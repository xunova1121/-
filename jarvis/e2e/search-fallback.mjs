/** 真实任务执行器→工具→HTTP替身；没有真实模型/用户Key，不冒充国内服务器验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { createTools } from '../src/agent/tools.js';
import { createLookupService, memoryLookupStorage } from '../src/agent/lookup/service.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';
import { newsDate } from '../src/agent/newsSources.js';

const output = process.argv[2] || await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-search-e2e-'));
await fs.mkdir(output, { recursive: true });
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-search-state-'));
useBackend(createFileStore(state));
let question = '', receipts = [], requests = [], modelCalls = 0;
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push(req.url);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/qianfan') {
    assert.equal(req.headers.authorization, 'Bearer fixture-qianfan');
    assert.ok(JSON.parse(body).messages?.length);
    if (question === '日本新闻') { res.statusCode = 503; res.end('{}'); }
    else res.end('{"references":[]}');
  } else if (req.url === '/deepseek') {
    assert.equal(req.headers.authorization, 'Bearer fixture-deepseek');
    assert.ok(JSON.parse(body).query);
    const gold = question.includes('金价');
    res.end(JSON.stringify({ results: [{ title: gold ? '黄金金价报价报道' : '日本新闻报道', url: 'https://www.chinanews.com.cn/fixture-search-recovery', summary: gold ? '合成金价840元每克，仅用于测试。' : '合成公共新闻资料，仅用于回归。', date: newsDate() }] }));
  } else res.end('{}');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const get = (url, init) => fetch(base + (String(url).includes('qianfan.baidubce.com') ? '/qianfan' : String(url).includes('/tools/search') ? '/deepseek' : '/source'), init);
const lookup = createLookupService({ storage: memoryLookupStorage(), get });
for (const id of ['query_search', 'query_quote', 'query_weather', 'query_sports']) for (let i = 0; i < 3; i++) await lookup.health.record(id, { state: 'failed', code: 'TimeoutError' });
const runner = createTaskRunner({
  lookupService: lookup,
  getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock', autoMemory: false, reflectionEnabled: false, routing: { enabled: false }, searchRegion: 'cn', lookupRegion: 'cn', qianfanSearchKey: 'fixture-qianfan', deepseekSearchEnabled: true, deepseekSearchKey: 'fixture-deepseek' }),
  makeTools: ctx => createTools({ ...ctx, fetchViaGateway: get }).map(tool => ({ ...tool, run: async (...args) => {
    const value = await tool.run(...args);
    if (['web_search', 'get_today_news', 'get_market_quote'].includes(tool.name)) receipts.push({ tool: tool.name, value: typeof value === 'string' ? value : value.text });
    return value;
  } })),
  makeAdapter: () => ({ model: 'synthetic-search-fixture', adapter: { async stream({ onText }) {
    modelCalls++;
    assert.ok(receipts.some(row => row.value.includes('合成')), '模型总结之前必须实际取得备用API内容');
    const text = question.includes('金价') ? '搜到测试报价：840元每克。这是合成测试数据。来源：https://www.chinanews.com.cn/fixture-search-recovery' : '搜到日本新闻的测试报道。这是合成测试资料。来源：https://www.chinanews.com.cn/fixture-search-recovery';
    onText?.(text); return { text, toolCalls: [], stop: 'end_turn' };
  } } })
});
const reports = [];
try {
  for (question of ['今天新闻', '日本新闻', '今天金价多少']) {
    receipts = []; requests = []; modelCalls = 0;
    const task = await runner.start({ text: question });
    const deadline = Date.now() + 15000;
    while (['queued', 'running'].includes(runner.get(task.id).status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(runner.get(task.id).status, 'done', question);
    assert.ok(requests.includes('/qianfan'), '实际HTTP访问千帆替身');
    assert.ok(requests.includes('/deepseek'), '实际HTTP访问DeepSeek替身');
    assert.equal(requests.filter(route => route === '/deepseek').length, 1);
    assert.ok(modelCalls >= 1 && modelCalls <= 3);
    reports.push({ question, state: 'passed', requests, receipts, modelCalls });
    console.log('通过：' + question + '；保留旧入口冷却仍取得备用API数据');
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ state: 'passed', realModelTested: false, userServerTested: false, cases: reports }, null, 2));
} finally {
  for (const task of runner.list()) runner.stop(task.id);
  await runner.settled(); useBackend(null);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await fs.rm(state, { recursive: true, force: true });
}

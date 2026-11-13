/** 同一夹具对照已发布源码；不联网、不调用模型，不把夹具毫秒或估算Token当生产实测。 */
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createFetchPageRun } from '../src/agent/fetchPageTool.js';
import { createPageReader } from '../src/agent/pageReader.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { staggeredSearch } from '../src/agent/webSearch.js';
import { pageReadBatch } from '../src/agent/pageReadReceipt.js';
import { projectLookupMessages } from '../src/agent/requestContext.js';
import { createTurnArchive } from '../src/agent/turnContext.js';
import { measureModelInput, measureModelTokens } from '../shared/modelMetrics.js';
import { distribution } from './speed-quality-report.mjs';

const base = process.argv[2] || '626aeac890e308768fdbfc09b6b24b961bb3ee76';
const destination = process.argv[3] || '/tmp/weiyang-search-speed.json';
if (!/^[a-f0-9]{7,40}$/.test(base)) throw Error('基线必须是明确提交SHA');
async function fromBase(relative) {
  const source = execFileSync('git', ['show', `${base}:jarvis/${relative}`], { encoding: 'utf8', maxBuffer: 200_000 });
  const location = new URL('../' + relative, import.meta.url);
  const resolved = source.replace(/from\s+(['"])(\.[^'"]+)\1/g, (_all, quote, specifier) => `from ${quote}${new URL(specifier, location).href}${quote}`);
  return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(resolved));
}
const oldPages = await fromBase('src/agent/fetchPageTool.js');
const oldSearch = await fromBase('src/agent/webSearch.js');
const oldReader = await fromBase('src/agent/pageReader.js');
const urls = [1, 2, 3].map(index => `https://page${index}.example.com/article`);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
});
async function compare(label, count, before, after) {
  const a = [], b = [];
  for (let index = 0; index < count; index++) {
    for (const [work, rows] of index % 2 ? [[after, b], [before, a]] : [[before, a], [after, b]]) {
      const started = performance.now();
      const detail = await work(index);
      rows.push({ ms: Math.round(performance.now() - started), ...detail });
    }
  }
  const summary = rows => ({ ...distribution(rows.map(row => row.ms)), failures: rows.filter(row => !row.ok).length, requests: rows.map(row => row.requests), quality: rows.every(row => row.ok) });
  console.log(JSON.stringify({ label, before: summary(a), after: summary(b) }));
  return { label, before: { ...summary(a), rows: a }, after: { ...summary(b), rows: b } };
}
const cases = [];
const pageSample = factory => async index => {
  let requests = 0;
  const read = async url => { requests++; await sleep([90, 75, 105][urls.indexOf(url)] + index % 3); return `${url} 已读原文：示例企业主营农业服务，预算600万元。`; };
  read.publicOnly = true;
  const retrieval = createRetrievalBudget('查询公司'); retrieval.begin();
  const output = await factory({}, read)({ urls: [...urls] }, { retrieval });
  assert.deepEqual(pageReadBatch(output).map(page => ({ url: page.url, read: page.read })), urls.map(url => ({ url, read: true })));
  assert.equal(requests, 3);
  return { requests, ok: true, sources: 3 };
};
cases.push(await compare('三页相同正文、保留全部来源', 12, pageSample(oldPages.createFetchPageRun), pageSample(createFetchPageRun)));
const searchSample = (search, delay) => async () => {
  let requests = 0;
  const engines = [4500, 100].map((ms, index) => ({ name: `来源${index}`, search: async (_query, _n, { signal }) => {
    requests++; await sleep(ms, signal);
    return [{ title: '示例企业业务', url: `https://source${index}.example.com/article`, snippet: '示例企业公开农业服务资料' }];
  } }));
  const hits = await search(engines, '示例企业业务', 1, {}, null, delay);
  assert.equal(hits[0].url, 'https://source1.example.com/article');
  assert.equal(requests, 2);
  return { requests, ok: true, sources: 1 };
};
cases.push(await compare('慢首源、同一100毫秒备用源；2500到1200毫秒错峰', 10, searchSample(oldSearch.staggeredSearch, 2500), searchSample(staggeredSearch, 1200)));
const duplicateSample = create => async () => {
  let requests = 0;
  const reader = create({ fetchImpl: async () => { requests++; await sleep(25); return new Response('示例企业实际公开正文，预算600万元。'.repeat(50), { headers: { 'content-type': 'text/plain' } }); } });
  const rows = await Promise.all([1, 2, 3].map(() => reader(urls[0])));
  assert.equal(new Set(rows).size, 1);
  return { requests, ok: true, sources: 1 };
};
cases.push(await compare('同一账号同一公开地址三项同时读取', 12, duplicateSample(oldReader.createPageReader), duplicateSample(createPageReader)));

const history = Array.from({ length: 9 }, (_, index) => [{ role: 'user', content: `历史问题${index}` }, { role: 'assistant', content: '既往内容。'.repeat(800) }]).flat();
const original = [...history, { role: 'user', content: '查询示例企业有限公司简介' }, { role: 'tool', name: 'fetch_url', toolCallId: 'current', content: '网站导航。'.repeat(1200) + '示例企业有限公司主营农业服务，公开预算600万元。' + '其他栏目。'.repeat(1200) }];
const projection = projectLookupMessages(original, { historyLength: history.length, enabled: true, archive: createTurnArchive(), query: '查询示例企业有限公司简介' });
assert.ok(projection.messages.at(-1).content.includes('预算600万元'));
const measured = messages => ({ ...measureModelInput({ system: '相同系统要求', messages, tools: [] }), ...measureModelTokens({ system: '相同系统要求', messages, tools: [] }) });
const payload = { before: measured(original), after: measured(projection.messages), droppedMessages: projection.droppedMessages, savedChars: projection.savedChars, actualBillableTokens: null, quality: '当前约束、目标中段和回读编号保留，原历史未改；较早历史未发送' };
const sourceDigests = {};
for (const file of ['src/agent/fetchPageTool.js', 'src/agent/pageReader.js', 'src/agent/publicReadCache.js', 'src/agent/webSearch.js', 'src/agent/searchPolicy.js', 'src/agent/requestContext.js', 'src/agent/turnContext.js', 'shared/modelMetrics.js', 'shared/tokenEstimate.js']) sourceDigests[file] = createHash('sha256').update(await fs.readFile(new URL('../' + file, import.meta.url))).digest('hex');
const candidateDirty = Boolean(execFileSync('git', ['status', '--porcelain', '--', 'src', 'server', 'shared', 'evals', 'tests'], { encoding: 'utf8' }).trim());
const report = { mode: 'deterministic-public-data-fixtures', baseline: base, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), candidateDirty, sourceDigests, createdAt: new Date().toISOString(), conditions: { model: null, provider: null, paidRequests: 0, actualBillableTokens: null, notes: '同一机器交替顺序，各场景同样正文和来源；延迟来自固定夹具，不能承诺真实联网或真实模型耗时。源码基线仅替换被比较模块，其依赖与候选相同。' }, cases, payload };
await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log('夹具对照完成：' + destination);

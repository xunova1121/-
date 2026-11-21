/** 只读公开来源验收：不读取用户配置/凭据，不调用模型，不改查询健康记录。 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createBusinessTools } from '../src/agent/businessIntelligence.js';
import { createSearch } from '../src/agent/webSearch.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { publicFetch } from '../server/taskRunner.mjs';

const output = path.resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice(6) || '/tmp/weiyang-business-public');
const withSearch = process.argv.includes('--search');
const ctx = { fetchViaGateway: publicFetch, searchRegion: 'cn' };
const tools = createBusinessTools(ctx, withSearch ? createSearch(ctx) : null);
const rows = [];
const cases = [
  { name: '最新公开采购公告', tool: 'search_tenders', args: { period: 'today', limit: 4 } },
  ...(withSearch ? [{ name: '江苏智慧农业相关招标', tool: 'search_tenders', args: { query: '智慧农业', region: '江苏', period: 'month' } },
    { name: '江苏银行公开企业资料', tool: 'lookup_company', args: { company: '江苏银行', section: 'basic', source: 'public' } }] : [])
];
async function run(item) {
  const start = Date.now();
  try {
    const output = JSON.parse(await tools.find(tool => tool.name === item.tool).run(item.args, {
      signal: AbortSignal.timeout(45000), retrieval: createRetrievalBudget(item.name), requestText: item.name
    }));
    rows.push({ ...item, ms: Date.now() - start, output });
    console.log(`${item.name}：${output.state || output.evidence}，${output.items?.length ?? 1}条，${Date.now() - start}ms`);
    return output;
  } catch (error) {
    const result = { ...item, ms: Date.now() - start, failure: { code: error.code || error.name, status: error.status } };
    rows.push(result); console.log(`${item.name}：未完成，${result.failure.code}`);
    return null;
  }
}
for (const item of cases) {
  const result = await run(item);
  if (item === cases[0] && result?.items?.length) {
    const first = result.items.find(row => row.type === 'tender') || result.items[0];
    await run({ name: '公告原文核对', tool: 'read_tender_notice', args: { url: first.url, title: first.title } });
  }
}
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'report.json'), JSON.stringify({ at: new Date().toISOString(), scope: '当前运行机器；无模型、无凭据、无用户设置', withSearch, rows }, null, 2));
console.log('结果已保存：' + path.join(output, 'report.json'));
if (rows.some(row => row.failure || row.output?.state === 'unavailable')) process.exitCode = 1;

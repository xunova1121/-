import { it, expect, vi } from 'vitest';
import { createLookupHealth, LOOKUP_COOLDOWN_MS } from '../src/agent/lookup/health.js';
import { runLookupOperation, connectLookupTools } from '../src/agent/lookup/operations.js';
import { memoryLookupStorage } from '../src/agent/lookup/service.js';
import { createToolLoader } from '../src/agent/toolLoader.js';
import { createMarketQuoteTool } from '../src/agent/marketQuote.js';
import { selfDriveNote } from '../src/agent/lookup/selfDrive.js';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
const now = 1793691845353;
const failure = code => ({ at: now, code, connected: false, state: 'failed', elapsedMs: 1 });

it('真实服务器旧记录：三次REPEATED_SEARCH夹两次超时，不足三次网络失败，恢复搜索而保留诊断', async () => {
  const storage = memoryLookupStorage();
  await storage.put({ id: 'lookup.health.query_search', cooldownUntil: now + LOOKUP_COOLDOWN_MS, samples: [
    { at: now - 100, connected: true, state: 'ok', elapsedMs: 2361, code: '' },
    failure('REPEATED_SEARCH'), failure('REPEATED_SEARCH'), failure('REPEATED_SEARCH'), failure('TimeoutError'), failure('TimeoutError')
  ] });
  const health = createLookupHealth({ storage, now: () => now });
  expect(await health.get('query_search')).toMatchObject({ cooling: false, cooldownUntil: 0 });
  expect((await health.get('query_search')).samples).toHaveLength(6);
  await health.record('query_search', { state: 'failed', code: 'TimeoutError' });
  expect((await health.get('query_search')).cooling).toBe(true);
});

it('本地重复/预算/参数不写入网络故障；报价连续失败不使成功搜索冷却', async () => {
  const health = createLookupHealth({ storage: memoryLookupStorage(), now: () => now });
  for (const code of ['REPEATED_SEARCH', 'RETRIEVAL_BUDGET', 'INVALID_QUOTE_INPUT', 'LOOKUP_SOURCE_COOLING']) {
    const tool = { name: 'web_search', run: async () => { throw Object.assign(new Error('local'), { code }); } };
    await expect(runLookupOperation(tool, {}, {}, { health })).rejects.toMatchObject({ code });
  }
  expect((await health.get('query_search')).samples).toHaveLength(0);
  const quote = { name: 'get_market_quote', run: async () => { throw Object.assign(new Error('upstream'), { code: 'NO_MARKET_DATA' }); } };
  const search = { name: 'web_search', run: async () => '已取得搜索结果' };
  for (let i = 0; i < 3; i++) {
    await expect(runLookupOperation(quote, {}, {}, { health })).rejects.toThrow();
    await runLookupOperation(search, {}, {}, { health });
  }
  expect((await health.get('query_quote')).cooling).toBe(true);
  expect((await health.get('query_search')).cooling).toBe(false);
});

it('冷却回执保留期限、工具名；不再对同一个冷却搜索换词重跑', async () => {
  const health = createLookupHealth({ storage: memoryLookupStorage(), now: () => now });
  for (const id of ['query_quote', 'query_search']) for (let i = 0; i < 3; i++) await health.record(id, { state: 'failed', code: 'TimeoutError' });
  const raw = ['get_market_quote', 'web_search'].map(name => ({ name, run: vi.fn() }));
  const wrapped = connectLookupTools(raw, { health, now: () => now });
  try { await wrapped[0].run({ target: '茅台' }, { requestText: '茅台股价' }); throw new Error('必须失败'); }
  catch (error) {
    expect(error.code).toBe('LOOKUP_RECOVERY_EXHAUSTED');
    expect(error.message).toMatch(/冷却至北京时间.*不要重复调用/);
    expect(error.lookupRecovery.attempts).toHaveLength(2);
    expect(error.lookupRecovery.attempts.map(a => a.tool)).toEqual(['get_market_quote', 'web_search']);
    expect(error.lookupRecovery.attempts[0].cooldownUntil).toBe(now + LOOKUP_COOLDOWN_MS);
  }
  expect(raw[0].run).not.toHaveBeenCalled(); expect(raw[1].run).not.toHaveBeenCalled();
});

it('工具加载器冷却期间隐藏且搜索不能重新加载，到期恢复，不影响其他工具', async () => {
  let time = now;
  const tools = ['get_market_quote', 'web_search'].map(name => ({ name, description: name }));
  const loader = createToolLoader(tools, { limit: 0, core: new Set(), now: () => time });
  loader.cool('get_market_quote', now + 1000);
  expect(loader.hint()).not.toContain('get_market_quote');
  expect(await loader.get('tool_search').run({ names: ['get_market_quote'] })).toContain('没有找到');
  expect(loader.get('web_search')).toBeTruthy();
  expect(loader.list().some(t => t.name === 'web_search')).toBe(true);
  time += 1001;
  expect(loader.cooldownUntil('get_market_quote')).toBe(0);
  expect(loader.hint()).toContain('get_market_quote');
  expect(createToolLoader(tools).cooled()).toEqual([]);
});

it('执行层阻止模型换参数反复调已冷却工具，不发网络请求', async () => {
  const until = Date.now() + 60000;
  const quote = { name: 'get_market_quote', input_schema: { properties: {} }, run: vi.fn(async () => { throw Object.assign(new Error('cooling'), { code: 'LOOKUP_SOURCE_COOLING', cooldownUntil: until }); }) };
  const loader = createToolLoader([quote]);
  const options = { loader, emit() {}, seen: new Map(), retrieval: { extensive: false }, review: createExecutionReview('茅台股价'), webTools: new Set(), parallelSafe: new Set(), sessionId: 'cooling-test' };
  await executeToolCalls([{ id: 'a', name: quote.name, args: { target: '茅台' } }], options);
  const [result] = await executeToolCalls([{ id: 'b', name: quote.name, args: { target: '600519' } }], options);
  expect(quote.run).toHaveBeenCalledTimes(1);
  expect(result.output).toContain('本次未执行');
  expect(loader.list()).toEqual([]);
  expect(selfDriveNote({ kind: 'market', cooled: loader.cooled() })).not.toContain('至少换两种');
});

it('HTTP已连接但无可解析行情，不伪装网络故障冷却整个入口；失败码可追溯', async () => {
  const health = createLookupHealth({ storage: memoryLookupStorage() });
  const tool = createMarketQuoteTool({ fetchImpl: async () => new Response('{"data":null}') });
  for (let i = 0; i < 3; i++) await expect(runLookupOperation(tool, { target: '金价' }, {}, { health })).rejects.toMatchObject({ code: 'NO_MARKET_DATA', connected: true });
  const result = await health.get('query_quote');
  expect(result.cooling).toBe(false);
  expect(result.samples[0]).toMatchObject({ state: 'empty', sourceFailures: [{ source: '上海金', code: 'EMPTY_OR_UNRECOGNIZED' }, { source: '伦敦金', code: 'EMPTY_OR_UNRECOGNIZED' }] });
});

it('原始网络底层错误保留安全代码，绝不把密钥/URL/正文落健康记录', async () => {
  const health = createLookupHealth({ storage: memoryLookupStorage() });
  const tool = createMarketQuoteTool({ fetchImpl: async () => { throw Object.assign(new TypeError('secret-key-body'), { cause: { code: 'ENOTFOUND' } }); } });
  await expect(runLookupOperation(tool, { target: '金价' }, {}, { health })).rejects.toMatchObject({ code: 'NO_MARKET_DATA' });
  const record = await health.get('query_quote');
  expect(record.samples[0].sourceFailures[0].code).toBe('ENOTFOUND');
  expect(JSON.stringify(record)).not.toContain('secret-key-body');
});

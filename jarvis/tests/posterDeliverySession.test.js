import { beforeEach, it, expect, vi } from 'vitest';
import { withPosterDelivery } from '../src/agent/posterDeliverySession.js';
import { collection, useBackend } from '../src/agent/store.js';
import { recordWorkAttempt, listWorkRecords } from '../src/agent/workLedger.js';
import { catalogGroups } from '../src/ui/workspaceCatalog.js';
import { missingDeliveries } from '../src/agent/finalDelivery.js';
import * as ws from '../src/agent/workspace.js';

beforeEach(async () => {
  useBackend(null);
  for (const name of ['files', 'kv', 'sessions']) await collection(name).clear();
});
// 协议夹具；真实字体/PNG/PPTX/浏览器由poster-task-delivery e2e覆盖。
function fixture(ctx = {}, hook) {
  const factory = inner => withPosterDelivery({ run: async input => {
    if (input.invalid) throw Object.assign(new Error('画布需整数'), { code: 'DESIGN_INPUT' });
    const base = input.path.replace(/\.png$/, ''), files = [];
    for (const format of ['png', 'svg', 'pptx']) {
      const saved = await ws.write(`${base}.${format}`, new Blob([input.title || format]));
      inner.onFileChanged?.(saved.path);
      files.push({ path: saved.path, format, readback: 'passed', structure: 'passed', render: format === 'png' ? 'passed' : 'not_checked' });
    }
    const designPath = (await ws.write(`${base}.design.json`, '{}')).path;
    inner.onImage?.('internal', files[0].path);
    await hook?.();
    return JSON.stringify({ kind: 'poster', status: 'complete', files, designPath, fontCheck: 'passed', textRendering: 'program', width: 1080, height: 1920, errors: [], visual: 'not_checked' });
  } }, inner, factory);
  return factory(ctx);
}
it('6次重复调用只执行一次，默认一张成品，源文件可追溯且旧文件不变', async () => {
  await ws.write('海报/旧成品.png', 'original');
  await collection('sessions').put({ id: 'poster-session', messages: [] });
  const scope = {}, images = vi.fn(), changes = vi.fn(), coreCalls = vi.fn();
  const tool = fixture({ onImage: images, onFileChanged: changes }, coreCalls);
  let receipt;
  for (let n = 0; n < 6; n++) {
    const output = await tool.run({ title: '指数速览', path: `海报/重复${n}.png` }, { executionScope: scope });
    receipt = JSON.parse(output);
    await recordWorkAttempt({ tool: 'make_poster', args: { title: '指数速览' }, output, ok: true, sessionId: 'poster-session', scope, callId: String(n) });
  }
  expect(coreCalls).toHaveBeenCalledTimes(1);
  expect(images).toHaveBeenCalledTimes(1);
  expect(changes).toHaveBeenCalledTimes(1);
  expect(receipt.designPath).toBe('海报/重复0.design.json');
  expect(await ws.readText(receipt.designPath)).toBe('{}');
  const records = (await listWorkRecords({ kind: 'image' })).items;
  expect(records).toHaveLength(1);
  expect(records[0].files).toEqual([receipt.delivery.primaryPath]);
  const groups = catalogGroups(await ws.list(), { records });
  expect(groups).toHaveLength(2); // 旧成品保留，新任务一张
  const poster = groups.find(g => g.poster);
  expect(poster.files).toHaveLength(1);
  expect(new Set(poster.poster.sourceFiles.map(f => f.path.split('.').pop()))).toEqual(new Set(['svg', 'pptx', 'json']));
  expect(await ws.readText('海报/旧成品.png')).toBe('original');
  const ending = missingDeliveries('', { media: { kind: 'poster', delivery: receipt.delivery } });
  expect(decodeURI(ending)).toContain(receipt.delivery.primaryPath);
  expect(ending).not.toContain('.pptx');
});
it('不同试排最多3次，后续失败不抹去已成功的成果索引和历史稿', async () => {
  await collection('sessions').put({ id: 'poster-session', messages: [] });
  const scope = {}, coreCalls = vi.fn(), tool = fixture({}, coreCalls);
  for (let n = 0; n < 6; n++) {
    const output = await tool.run({ title: '稿件' + n, invalid: n === 2 }, { executionScope: scope });
    await recordWorkAttempt({ tool: 'make_poster', args: {}, output, ok: true, sessionId: 'poster-session', scope, callId: String(n) });
    if (n > 2) expect(JSON.parse(output)).toMatchObject({ status: 'partial', retryAllowed: false });
  }
  expect(coreCalls).toHaveBeenCalledTimes(2);
  const records = (await listWorkRecords({ kind: 'image' })).items;
  expect(records).toHaveLength(1);
  const groups = catalogGroups(await ws.list(), { records });
  expect(groups).toHaveLength(1);
  expect(groups[0].title).toBe('稿件1');
  // 2026-11-17 用户反馈“做海报产出那么多历史稿”：同一轮的试排不再列为历史稿（原断言为4个试排文件）；试排文件仍保留不删，只在“处理文件”里看得到
  expect(groups[0].poster.historyFiles).toEqual([]);
  const trial = (await ws.list()).filter(f => f.path.startsWith(records[0].historyPrefix) && f.path.includes('/attempt-1/'));
  expect(trial).toHaveLength(4);
  expect(catalogGroups(await ws.list(), { records, process: true }).length).toBeGreaterThan(1);
});
it('明确多张海报、新一轮任务及另一账号均独立，不合并用户指定作品', async () => {
  const tool = fixture(), scope = {};
  const a = JSON.parse(await tool.run({ title: '甲' }, { executionScope: scope, rawRequestText: '做两张海报' }));
  const b = JSON.parse(await tool.run({ title: '乙' }, { executionScope: scope, rawRequestText: '做两张海报' }));
  const c = JSON.parse(await tool.run({ title: '甲' }, { executionScope: {} }));
  expect(new Set([a.delivery.id, b.delivery.id, c.delivery.id]).size).toBe(3);
  const backend = { all: async () => [], get: async () => null, put: async () => {} };
  useBackend(backend);
  // 空后端无法读回成品；后台状态仍不能沿用上个用户的已完成回执。
  await expect(tool.run({ title: '甲' }, { executionScope: scope })).rejects.toThrow();
  useBackend(null);
});
it('切换账号与取消后，旧任务不能继续触发图片回调', async () => {
  const images = vi.fn(), stop = new AbortController();
  const cancelled = fixture({ onImage: images }, () => stop.abort());
  await expect(cancelled.run({}, { executionScope: {}, signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(images).not.toHaveBeenCalled();
  const switched = fixture({ onImage: images }, () => useBackend({ get: async () => null }));
  await expect(switched.run({}, { executionScope: {} })).rejects.toMatchObject({ code: 'POSTER_TASK_LIMIT' });
  expect(images).not.toHaveBeenCalled();
  useBackend(null);
});
it('要求图文并茂时，无图文语义证据只能交候选，不能伪装成完成', async () => {
  const result = JSON.parse(await fixture().run({ title: '文本卡片' }, { executionScope: {}, rawRequestText: '做成图文并茂的海报' }));
  expect(result.status).toBe('partial');
  expect(result.delivery.quality).toBe('needs_review');
  expect(result.contentCheck.semantic).toBe('not_checked');
});
it('指定源稿名称已存在时另存，不能覆盖旧稿；归组仍只有一张新成品', async () => {
  await ws.write('海报/保留.design.json', '{"original":true}');
  await collection('sessions').put({ id: 'alias-session', messages: [] });
  const scope = {}, output = await fixture().run({ title: '保留', path: '海报/保留.png' }, { executionScope: scope, sessionId: 'alias-session' });
  const result = JSON.parse(output);
  expect(result.designPath).not.toBe('海报/保留.design.json');
  expect(await ws.readText('海报/保留.design.json')).toBe('{"original":true}');
  const record = (await listWorkRecords({ kind: 'image' })).items[0];
  const grouped = catalogGroups(await ws.list(), { records: [record] });
  expect(grouped).toHaveLength(2);
  expect(grouped.find(g => g.poster).poster.sourceFiles.some(f => f.path === result.designPath)).toBe(true);
});
it('历史稿只列以前回合交付过的成品：改稿后列出上一版PNG，同轮试排不列', async () => {
  await collection('sessions').put({ id: 'poster-session', messages: [] });
  const tool = fixture();
  const record = async output => recordWorkAttempt({ tool: 'make_poster', args: {}, output, ok: true, sessionId: 'poster-session', scope: {}, callId: 'x' });
  const first = JSON.parse(await tool.run({ title: '初稿' }, { executionScope: {}, sessionId: 'poster-session', rawRequestText: '做一张海报' }));
  const trial = JSON.parse(await tool.run({ title: '初稿二' }, { executionScope: {}, sessionId: 'poster-session', rawRequestText: '做一张海报' }));
  expect(trial.delivery.previousVersions).toEqual([]);
  // 新一轮：用户要求改稿，沿用上一轮的作品
  const revisionScope = {};
  const a = JSON.parse(await tool.run({ title: '改稿甲' }, { executionScope: revisionScope, sessionId: 'poster-session', rawRequestText: '只改标题' }));
  expect(a.delivery.id).toBe(trial.delivery.id);
  expect(a.delivery.previousVersions).toEqual([trial.delivery.primaryPath]);
  // 同一轮里再试排一次：上一版仍只有一张，不把本轮试排算进去
  const b = JSON.parse(await tool.run({ title: '改稿乙' }, { executionScope: revisionScope, sessionId: 'poster-session', rawRequestText: '只改标题' }));
  expect(b.delivery.previousVersions).toEqual([trial.delivery.primaryPath]);
  await record(JSON.stringify(b));
  const records = (await listWorkRecords({ kind: 'image' })).items;
  expect(records[0].previousVersions).toEqual([trial.delivery.primaryPath]);
  const poster = catalogGroups(await ws.list(), { records }).find(g => g.poster);
  expect(poster.files.map(f => f.path)).toEqual([b.delivery.primaryPath]);
  expect(poster.poster.historyFiles.map(f => f.path)).toEqual([trial.delivery.primaryPath]);
  expect(first.delivery.primaryPath).not.toBe(trial.delivery.primaryPath);
});
it('设计自审最多两轮：第1、2次试排可要求重排，第3次只提示', async () => {
  const seen = [];
  const factory = inner => withPosterDelivery({ posterLifecycle: false, run: async (input, options) => {
    seen.push(options.designReviewBlocking());
    const saved = await ws.write(input.path, new Blob(['png']));
    return JSON.stringify({ kind: 'poster', status: 'partial', files: [{ path: saved.path, format: 'png', readback: 'passed', structure: 'passed', render: 'passed' }], errors: [{ code: 'DESIGN_LAYOUT_NEEDS_WORK' }] });
  } }, inner, factory);
  const tool = factory({}), scope = {};
  for (const title of ['一', '二', '三']) await tool.run({ title }, { executionScope: scope });
  expect(seen).toEqual([true, true, false]);
});

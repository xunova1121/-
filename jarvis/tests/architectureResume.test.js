import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { createHelperLlm } from '../src/llm/helper.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { loadArchitecture } from '../src/agent/architectureProjection.js';
import { resumeArchitectureReview } from '../src/agent/architectureResume.js';

const request = '建设预警';
const spec = () => ({
  title: '合成业务',
  entities: [
    { id: 'a', title: '预警', kind: 'application', responsibility: '处理预警', inputs: ['事件'], outputs: ['工单'], source: 'user', excerpt: request }
  ],
  relations: [],
  requirements: [{ text: request, entities: ['a'], source: 'user', excerpt: request }]
});
const passed = '{"passed":true,"issues":[]}';
const draw = (receipt, target = '恢复.svg') => ({ path: target, formats: ['svg'], architecturePath: receipt.architecturePath });
let folder;
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-resume-'));
  useBackend(createFileStore(folder));
});
afterEach(() => {
  useBackend(null);
  fs.rmSync(folder, { recursive: true, force: true });
});

it('首次格式失败不伪装可出图，沿用真实底稿恢复一次后正式SVG落盘', async () => {
  const adapter = {
    stream: vi
      .fn()
      .mockResolvedValueOnce({ text: '格式错误' })
      .mockResolvedValueOnce({ text: '\n\ufeff```JSON\n' + passed + '\n```\n' })
  };
  const ctx = { llm: createHelperLlm(adapter, 'fixture') };
  const receipt = JSON.parse(await createArchitecturePlanTool(ctx).run(spec(), { rawRequestText: request }));
  expect(receipt).toMatchObject({ readyForRender: false, semantic: 'not_checked', reviewErrorCode: 'ARCHITECTURE_REVIEW_FORMAT' });
  expect(receipt.reviewNote).toContain('格式');
  const original = await ws.readText(receipt.architecturePath);
  await createDiagramTool(ctx, { requireArchitecture: true }).run(draw(receipt), { rawRequestText: '继续制作架构图' });
  expect(await ws.readText('恢复.svg')).toContain('预警');
  expect(await ws.readText(receipt.architecturePath)).toBe(original);
  expect(JSON.parse(await ws.readText(receipt.reviewPath))).toMatchObject({ semantic: 'passed', resumeAttempts: 1 });
  expect(await ws.readText(receipt.relationTablePath)).toContain('业务语义：passed');
  expect(adapter.stream).toHaveBeenCalledTimes(2);
  for (const [options] of adapter.stream.mock.calls)
    expect(options).toMatchObject({ allowWebSearch: false, maxWebSearches: 0, maxTransientRetries: 0, maxPartialRetries: 0 });
});

it('持续失败只恢复一次，换输出文件名也不能绕过；错误定位业务审查而非参数', async () => {
  const ctx = { llm: vi.fn(async () => '不是JSON') };
  const receipt = JSON.parse(await createArchitecturePlanTool(ctx).run(spec(), { rawRequestText: request }));
  const tool = createDiagramTool(ctx, { requireArchitecture: true });
  for (const target of ['失败.svg', '换名.svg']) {
    await expect(tool.run(draw(receipt, target))).rejects.toMatchObject({
      diagnostics: [{ field: 'architecturePath', stage: 'review', action: expect.stringContaining('已恢复审查一次') }]
    });
    expect(await ws.exists(target)).toBe(false);
  }
  expect(ctx.llm).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await ws.readText(receipt.reviewPath)).resumeAttempts).toBe(1);
});

it('旧快照晚到也不能重置恢复次数，直接复用已通过的最新报告', async () => {
  const ctx = { llm: vi.fn().mockResolvedValueOnce('bad').mockResolvedValue(passed) };
  const receipt = JSON.parse(await createArchitecturePlanTool(ctx).run(spec(), { rawRequestText: request }));
  const stale = await loadArchitecture(receipt.architecturePath);
  await createDiagramTool(ctx, { requireArchitecture: true }).run(draw(receipt));
  const current = await resumeArchitectureReview(ctx, stale);
  expect(current.report).toMatchObject({ semantic: 'passed', resumeAttempts: 1 });
  expect(ctx.llm).toHaveBeenCalledTimes(2);
});

it('推理分工失败时只恢复一次到用户已配置的写作分工，不重建底稿', async () => {
  const ctx = { reasonLlm: vi.fn(async () => '错误格式'), llm: vi.fn(async () => passed) };
  const receipt = JSON.parse(await createArchitecturePlanTool(ctx).run(spec(), { rawRequestText: request }));
  await createDiagramTool(ctx, { requireArchitecture: true }).run(draw(receipt));
  expect(ctx.reasonLlm).toHaveBeenCalledTimes(1);
  expect(ctx.llm).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await ws.readText(receipt.reviewPath))).toMatchObject({ semantic: 'passed', reviewerRole: 'write', resumeAttempts: 1 });
});

it('审查明确失败不能反复审到通过；缺少模型给配置原因不冒充参数问题', async () => {
  const ctx = { llm: vi.fn(async () => '{"passed":false,"issues":[]}') };
  const failed = JSON.parse(await createArchitecturePlanTool(ctx).run(spec(), { rawRequestText: request }));
  expect(failed.readyForRender).toBe(false);
  await expect(createDiagramTool(ctx, { requireArchitecture: true }).run(draw(failed))).rejects.toThrow('审查未通过');
  expect(ctx.llm).toHaveBeenCalledTimes(1);
  const missing = JSON.parse(await createArchitecturePlanTool({}).run(spec(), { rawRequestText: request }));
  expect(missing).toMatchObject({ reviewErrorCode: 'ARCHITECTURE_REVIEW_UNAVAILABLE', readyForRender: false });
  expect(missing.nextAction).toContain('模型连接配置');
  await expect(createDiagramTool({}, { requireArchitecture: true }).run(draw(missing))).rejects.toThrow('缺少审查模型');
});

it('恢复期间停止继续上抛，不出图；提前记恢复次数，重启后不重复调用', async () => {
  const ctx = { llm: vi.fn().mockResolvedValueOnce('bad').mockRejectedValueOnce(new DOMException('停止', 'AbortError')) };
  const receipt = JSON.parse(await createArchitecturePlanTool(ctx).run(spec(), { rawRequestText: request }));
  await expect(createDiagramTool(ctx, { requireArchitecture: true }).run(draw(receipt))).rejects.toHaveProperty('name', 'AbortError');
  expect(await ws.exists('恢复.svg')).toBe(false);
  expect(JSON.parse(await ws.readText(receipt.reviewPath)).resumeAttempts).toBe(1);
  await expect(createDiagramTool(ctx, { requireArchitecture: true }).run(draw(receipt))).rejects.toThrow('已恢复审查一次');
  expect(ctx.llm).toHaveBeenCalledTimes(2);
});

it('恢复中来源改变，即便模型说通过也不能正式出图', async () => {
  await ws.write('来源.md', request);
  const input = spec();
  input.entities[0].source = '来源.md';
  input.requirements[0].source = '来源.md';
  const ctx = {
    llm: vi
      .fn()
      .mockResolvedValueOnce('bad')
      .mockImplementationOnce(async () => {
        await ws.write('来源.md', '已经变更');
        return passed;
      })
  };
  const receipt = JSON.parse(await createArchitecturePlanTool(ctx).run(input, { rawRequestText: request }));
  await expect(createDiagramTool(ctx, { requireArchitecture: true }).run(draw(receipt))).rejects.toThrow('材料已变化');
  expect(await ws.exists('恢复.svg')).toBe(false);
});

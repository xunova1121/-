import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { isArchitectureProduction, runArchitectureDirector, selectArchitectureTask } from '../src/agent/architectureDirector.js';

const source = '上传/虚构招标.md';
const jobPath = '文档检查/架构任务/director-fixture.json';
const request = `根据${source}制作总体架构图，产物存到交付/测试/`;
let directory;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-director-'));
  useBackend(createFileStore(directory));
  await ws.write(source, '虚构业务：受理事项后办理，门户展示办理结果。');
});
afterEach(() => { useBackend(null); fs.rmSync(directory, { recursive: true, force: true }); });

function receipt(views = ['overview']) {
  return { status: 'complete', jobPath, completedViews: views.map(view => ({
    view, editable: true, previewPath: `交付/测试/${view}.png`,
    files: ['svg', 'png', 'pdf', 'pptx'].map(format => ({ format, path: `交付/测试/${view}${format === 'pptx' ? '-可编辑' : ''}.${format}` }))
  })) };
}
const success = value => ({ ok: true, output: JSON.stringify(value) });
function director(run, extra = {}) {
  return runArchitectureDirector({ text: request, tools: [{ name: 'build_architecture' }], run, emit: vi.fn(), ...extra });
}

it('只接明确的新架构制作，讨论、拒绝、混合写作和旧图修改保留普通入口', () => {
  expect(isArchitectureProduction(request)).toBe(true);
  expect(isArchitectureProduction(`根据${source}制作总体架构图，导出SVG、PNG、PDF和可编辑PPT`)).toBe(true);
  for (const text of [
    '分析这份文件，讨论如何制作架构图', '先别生成架构图', '不要制作总体架构图',
    '根据原图修改这张架构图并输出', '制作5页PPT并生成架构图',
    `根据${source}制作PPT，并生成架构图`, `根据${source}写一份方案PPT，里面生成架构图`,
    `材料${source}里面的“制作架构图”要求是什么意思？`,
    '制作Word文档并生成架构图', '画一张温馨图片', '解释架构图是什么', null, '架构图制作'.repeat(1000)
  ]) expect(isArchitectureProduction(text), String(text)).toBe(false);
});

it('精确文件路径与指定视图、交付目录直接绑定，不把内部摘录当原件', async () => {
  await ws.write('文档检查/虚构招标.md', '内部摘录不得替代原件');
  await ws.write('其他/虚构招标.md', '同名另一份');
  expect(await selectArchitectureTask(request + '，另外需要业务闭环和数据流')).toEqual({
    files: [source], request: request + '，另外需要业务闭环和数据流', directory: '交付/测试', views: ['overview', 'workflow', 'dataflow']
  });
  expect(await selectArchitectureTask('根据虚构招标.md制作总体架构图')).toBeNull();
});

it('完整嵌套路径优先，不能把内部子串路径也当成第二份指定原件', async () => {
  const nested = '备份/' + source;
  await ws.write(nested, '另一份虚构源文件');
  expect((await selectArchitectureTask(`根据${nested}制作总体架构图`)).files).toEqual([nested]);
  expect((await selectArchitectureTask(`根据${source}和${nested}制作总体架构图`)).files).toEqual([source, nested]);
});

it('明确要求多份原件时，不能因工作区只有一份而静默按单份制作', async () => {
  for (const text of ['根据两个文件制作总体架构图', '根据两份招标材料制作总体架构图', '根据全部文件制作总体架构图'])
    expect(await selectArchitectureTask(text)).toBeNull();
});

it('仅有一份采购原件时可选择，含多文件意图或超过四份时不猜来源', async () => {
  expect((await selectArchitectureTask('根据上传的招标文件制作总体架构图')).files).toEqual([source]);
  await ws.write('其他/日记.md', '无关资料');
  expect(await selectArchitectureTask('根据两个文件制作总体架构图')).toBeNull();
  const files = [source];
  for (let i = 0; i < 4; i++) { files.push(`上传/其他${i}.md`); await ws.write(files.at(-1), '虚构资料'); }
  expect(await selectArchitectureTask(`根据${files.join('、')}制作总体架构图`)).toBeNull();
});

it('非法交付目录不能进入执行器，未开放专用工具时直接保留原入口', async () => {
  const run = vi.fn();
  for (const target of ['/tmp/交付', '../交付', '交付/../其他', '交付\\其他', '交付//其他'])
    await expect(director(run, { text: `根据${source}制作总体架构图，保存到${target}` })).rejects.toHaveProperty('code', 'ARCHITECTURE_DIRECTORY');
  expect(await director(run, { tools: [{ name: 'read_file' }] })).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

it('按真实任务指针续接，只调用专用工具，完整四格式及全部视图才交付', async () => {
  await ws.writeArchitectureState(jobPath, '{"stage":"content"}');
  const run = vi.fn().mockResolvedValueOnce([success({ status: 'running', jobPath })]).mockResolvedValueOnce([success(receipt(['overview', 'workflow', 'dataflow']))]);
  const emit = vi.fn(), onStart = vi.fn();
  const result = await director(run, { text: request + '，业务闭环和数据流也要', emit, onStart });
  expect(result).toMatchObject({ calls: 2, failures: 0, lastOk: true, jobPath });
  expect(result.text).toContain('总体架构、业务闭环、数据流');
  expect(result.text).toContain('overview-可编辑.pptx');
  expect(run.mock.calls.map(([calls]) => calls[0].name)).toEqual(['build_architecture', 'build_architecture']);
  expect(run.mock.calls[0][0][0].args).toMatchObject({ files: [source], directory: '交付/测试', views: ['overview', 'workflow', 'dataflow'] });
  expect(run.mock.calls[1][0][0].args).toEqual({ jobPath });
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'architecture_director_end', status: 'complete', mainModelCalls: 0 }));
});

it('缺格式、不可编辑或漏掉专题的complete回执不能伪装成交付完成', async () => {
  for (const mutate of [
    value => { value.completedViews[0].files = value.completedViews[0].files.filter(file => file.format !== 'pptx'); },
    value => { value.completedViews[0].editable = false; },
    value => { value.completedViews = []; }
  ]) {
    const value = receipt(); delete value.jobPath; mutate(value);
    const run = vi.fn().mockResolvedValue([success(value)]);
    expect(await director(run)).toMatchObject({ calls: 1, lastOk: false });
  }
  const value = receipt(); delete value.jobPath;
  expect(await director(vi.fn().mockResolvedValue([success(value)]), { text: request + '，另外要数据流' })).toMatchObject({ calls: 1, lastOk: false });
});

it('终止回执和不存在的任务指针一次即停，错误说明有界', async () => {
  for (const last of [
    { ok: false, output: '错误：真实业务审查失败' + '说明'.repeat(3000), recoveryStop: '已终止' },
    success({ status: 'running', jobPath: '文档检查/架构任务/missing.json' })
  ]) {
    const run = vi.fn().mockResolvedValue([last]);
    const result = await director(run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ calls: 1, lastOk: false, jobPath: null });
    expect(result.text.length).toBeLessThan(2000);
    expect(result.text).not.toContain('已生成总体架构');
  }
});

it('阶段续接最多六次，工具回执不能换任务指针绕过同任务额度', async () => {
  const other = '文档检查/架构任务/other.json';
  await ws.writeArchitectureState(jobPath, '{}'); await ws.writeArchitectureState(other, '{}');
  const run = vi.fn().mockResolvedValue([success({ status: 'running', jobPath: other })]);
  run.mockResolvedValueOnce([success({ status: 'running', jobPath })]);
  const result = await director(run);
  expect(result).toMatchObject({ calls: 6, lastOk: false, jobPath });
  expect(run).toHaveBeenCalledTimes(6);
  for (const [calls] of run.mock.calls.slice(1)) expect(calls[0].args).toEqual({ jobPath });
});

it('另一任务的complete回执和普通文件路径不能成为当前任务的成功凭证', async () => {
  const other = '文档检查/架构任务/other-complete.json';
  await ws.writeArchitectureState(jobPath, '{}'); await ws.writeArchitectureState(other, '{}');
  const value = { ...receipt(), jobPath: other };
  const run = vi.fn().mockResolvedValueOnce([success({ status: 'running', jobPath })]).mockResolvedValue([success(value)]);
  expect(await director(run)).toMatchObject({ calls: 6, lastOk: false, jobPath });
  const forged = { ...receipt(), jobPath: source };
  expect(await director(vi.fn().mockResolvedValue([success(forged)]))).toMatchObject({ calls: 1, lastOk: false, jobPath: null });
});

it('用户插话在阶段边界让出控制，停止信号阻止下一次调用', async () => {
  await ws.writeArchitectureState(jobPath, '{}');
  const run = vi.fn().mockResolvedValue([success({ status: 'running', jobPath })]);
  expect(await director(run, { shouldYield: () => true })).toMatchObject({ yielded: true, calls: 0 });
  expect(run).not.toHaveBeenCalled();
  let inbox = false;
  run.mockImplementation(async () => { inbox = true; return [success({ status: 'running', jobPath })]; });
  expect(await director(run, { shouldYield: () => inbox })).toMatchObject({ yielded: true, calls: 1, jobPath });
  const controller = new AbortController(); controller.abort(); run.mockClear();
  await expect(director(run, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(run).not.toHaveBeenCalled();
  const active = new AbortController();
  run.mockImplementation(async () => { active.abort(); return [success({ status: 'running', jobPath })]; });
  await expect(director(run, { signal: active.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(run).toHaveBeenCalledTimes(1);
});

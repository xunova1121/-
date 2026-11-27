import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { runAgent } from '../src/agent/agent.js';

const source = '上传/虚构采购.md';
const jobPath = '文档检查/架构任务/agent-director.json';
// 2026-10-29 起严格流水线只在用户明确要“逐条核对需求原文”时接管（平时直接 create_diagram 出图），这里的请求带上这句
const request = `根据${source}制作总体架构图，逐条核对需求原文，产物存到交付/虚构`;
let directory;
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-director-agent-'));
  useBackend(createFileStore(directory));
  await ws.write(source, '门户展示办理态势，业务服务受理并办理事项。');
});
afterEach(() => { useBackend(null); fs.rmSync(directory, { recursive: true, force: true }); });
function build(run) {
  return { name: 'build_architecture', description: 'fixture', isStatefulResume: args => Boolean(args.jobPath),
    input_schema: { type: 'object', properties: {
      files: { type: 'array', items: { type: 'string' } }, request: { type: 'string' }, directory: { type: 'string' },
      views: { type: 'array', items: { type: 'string' } }, jobPath: { type: 'string' }
    }, additionalProperties: false }, run };
}
function options(run, extra = {}) {
  const adapter = { stream: vi.fn(async ({ onText }) => { onText?.('按你当前要求分析。'); return { text: '按你当前要求分析。', toolCalls: [], stop: 'end_turn' }; }) };
  const extras = ['read_file', 'find_files', 'search_in_files', 'web_search', 'edit_file', 'write_file', 'create_diagram'].map(name => ({
    name, description: '禁止绕过专用流程', input_schema: { type: 'object', properties: {} }, run: vi.fn(() => { throw Error('不应调用通用工具'); })
  }));
  return { adapter, extras, args: { model: 'fixture', quiet: true, context: { dynamic: '' }, userText: request, history: [], maxSteps: 8,
    adapter, tools: [build(run), ...extras], emit: vi.fn(), ...extra } };
}
async function complete() {
  const files = ['svg', 'png', 'pdf', 'pptx'].map(format => ({ format, path: `交付/虚构/总体${format === 'pptx' ? '-可编辑' : ''}.${format}` }));
  for (const file of files) await ws.write(file.path, 'synthetic receipt artifact');
  return JSON.stringify({ status: 'complete', jobPath, completedViews: [{ view: 'overview', editable: true, previewPath: files[1].path, files }] });
}

it('真实runAgent精确材料制作绕过主模型，阶段续接不经过搜索、读取、编辑直通工具', async () => {
  const run = vi.fn(async args => {
    if (!args.jobPath) { await ws.writeArchitectureState(jobPath, '{"stage":"content"}'); return JSON.stringify({ status: 'running', jobPath }); }
    return complete();
  });
  const fixture = options(run);
  const result = await runAgent(fixture.args);
  expect(fixture.adapter.stream).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[0][0]).toMatchObject({ files: [source], directory: '交付/虚构', views: ['overview'] });
  expect(run.mock.calls[1][0]).toEqual({ jobPath });
  for (const tool of fixture.extras) expect(tool.run).not.toHaveBeenCalled();
  expect(result).toMatchObject({ toolCalls: 2, review: { media: expect.objectContaining({ state: 'completed' }) } });
  expect(result.text).toContain('总体-可编辑.pptx');
  expect(fixture.args.emit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'architecture_director_end', status: 'complete', mainModelCalls: 0 }));
});

it('真实终止错误保留阶段与具体原因，一次停止且不让主模型重复修稿', async () => {
  const run = vi.fn(async () => { throw Object.assign(new Error('relations[0]呈现方向未核实，不能交付'), {
    code: 'ARCHITECTURE_WORKFLOW', kind: 'input', terminal: true,
    diagnostics: [{ field: 'relations[0]', stage: 'review', action: '核对原文展示方向' }]
  }); });
  const fixture = options(run);
  const result = await runAgent(fixture.args);
  expect(run).toHaveBeenCalledTimes(1);
  expect(fixture.adapter.stream).not.toHaveBeenCalled();
  for (const tool of fixture.extras) expect(tool.run).not.toHaveBeenCalled();
  expect(result.text).toContain('relations[0]呈现方向未核实');
  expect(result.text).toContain('未完成架构图交付');
  expect(result.review).toMatchObject({ outcome: 'partial', media: { state: 'failed' } });
});

it.each([
  `分析${source}，讨论如何制作架构图`,
  `根据${source}制作5页PPT并生成架构图`,
  `根据${source}制作PPT，并生成架构图`,
  `材料${source}里面的“制作架构图”要求是什么意思？`,
  `根据${source}修改这张原图的架构图并输出`,
  // 普通的“制作总体架构图”（没说逐条核对）：交主模型直接 create_diagram 出图，不进严格流水线
  `根据${source}制作总体架构图，产物存到交付/虚构`
])('分析/混合PPT/原图修改保留原主模型入口：%s', async userText => {
  const run = vi.fn(); const fixture = options(run, { userText });
  await runAgent(fixture.args);
  expect(fixture.adapter.stream).toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(fixture.args.emit.mock.calls.some(([event]) => event.phase === 'architecture_director_start')).toBe(false);
});

it('阶段中用户插话进入原主循环且保留任务指针，不再续跑旧制作', async () => {
  const inbox = [];
  const run = vi.fn(async () => {
    await ws.writeArchitectureState(jobPath, '{"stage":"content"}');
    inbox.push('先停止制图，解释刚才采用的业务分层。');
    return JSON.stringify({ status: 'running', jobPath });
  });
  const fixture = options(run, { inbox });
  await runAgent(fixture.args);
  expect(run).toHaveBeenCalledTimes(1);
  expect(fixture.adapter.stream).toHaveBeenCalled();
  const messages = fixture.adapter.stream.mock.calls[0][0].messages;
  expect(JSON.stringify(messages)).toContain(jobPath);
  expect(JSON.stringify(messages)).toContain('先停止制图');
  expect(fixture.args.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'interjection_accepted', count: 1 }));
});

it('真实执行器的停止信号直接中止，不再发第二次制作或模型调用', async () => {
  const controller = new AbortController();
  const run = vi.fn(async () => {
    await ws.writeArchitectureState(jobPath, '{"stage":"content"}'); controller.abort();
    return JSON.stringify({ status: 'running', jobPath });
  });
  const fixture = options(run, { signal: controller.signal });
  await expect(runAgent(fixture.args)).rejects.toHaveProperty('name', 'AbortError');
  expect(run).toHaveBeenCalledTimes(1);
  expect(fixture.adapter.stream).not.toHaveBeenCalled();
});

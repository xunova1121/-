import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { collection, useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import * as packs from '../src/agent/skillPacks.js';
import { createTools } from '../src/agent/tools.js';
import { skillRunnerTool } from '../server/skillRunner.mjs';

let temporaryRoot;
const skillName = 'synthetic-demo';
const owner = JSON.stringify({ architecturePath: '文档检查/架构底稿/synthetic.architecture.json', planHash: 'sha256:synthetic', status: 'complete' });
const ordinaryManifest = '{"files":["普通成果.txt"]}';
const install = async files => collection('packs').put({ id: skillName, name: skillName, enabled: true, body: '测试技能', files });
const copiedTool = ctx => createTools(ctx).find(tool => tool.name === 'copy_skill_file');
const runnerResult = files => ({ exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, files: files.map(([filePath, data]) => ({ path: filePath, data: Buffer.from(data) })) });
function fakeRunner(result) {
  const runner = { run: vi.fn(async () => result) };
  const saveFile = vi.fn(async (target, data) => ws.write(target, new Blob([data])));
  const getPack = vi.fn(async () => ({ name: 'Synthetic Demo/1', enabled: true, body: '合成技能', files: {} }));
  return { runner, saveFile, getPack, tool: skillRunnerTool({ runner, saveFile, getPack }) };
}

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-skill-output-'));
  useBackend(createFileStore(temporaryRoot));
});
afterEach(() => {
  vi.restoreAllMocks();
  useBackend(null);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

it('copy_skill_file整批预检新架构清单，拒绝前不先写普通文件或读取普通大模板', async () => {
  const fileBlob = vi.spyOn(packs, 'fileBlob');
  const onFileChanged = vi.fn();
  for (const prefix of ['', 'templates/']) {
    const ordinary = '普通附件独有内容-' + prefix;
    await install({ [prefix + 'ordinary.txt']: ordinary, [prefix + '交付清单.json']: owner });
    fileBlob.mockClear();
    await expect(copiedTool({ onFileChanged }).run({ name: skillName, path: prefix })).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
    expect(await ws.list()).toEqual([]);
    expect(onFileChanged).not.toHaveBeenCalled();
    expect(fileBlob.mock.calls.some(([value]) => value === ordinary)).toBe(false);
  }
});

it('copy_skill_file直接调用单份复制也不能把受管私有文件作为to目标', async () => {
  await install({ 'template.json': '{"ordinary":true}' });
  const fileBlob = vi.spyOn(packs, 'fileBlob');
  await expect(copiedTool({}).run({ name: skillName, path: 'template.json', to: '文档检查/架构任务/synthetic.json' })).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
  expect(fileBlob).not.toHaveBeenCalled();
  expect(await ws.list()).toEqual([]);
});

it('copy_skill_file普通批量、二进制模板和同名非架构JSON继续复制', async () => {
  await install({ 'templates/ordinary.txt': '正常文件', 'templates/template.pptx': packs.binaryFile(new Uint8Array([1, 2, 3]).buffer), 'templates/交付清单.json': ordinaryManifest });
  const onFileChanged = vi.fn();
  const output = await copiedTool({ onFileChanged }).run({ name: skillName, path: 'templates/' });
  expect(output).toContain('已复制 3 个文件');
  expect(await ws.readText('skills/' + skillName + '/templates/ordinary.txt')).toBe('正常文件');
  expect(await ws.readText('skills/' + skillName + '/templates/交付清单.json')).toBe(ordinaryManifest);
  expect(new Uint8Array(await (await ws.readBlob('skills/' + skillName + '/templates/template.pptx')).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  expect(onFileChanged).toHaveBeenCalledTimes(3);
  expect(await copiedTool({}).run({ name: skillName, path: 'templates/交付清单.json', to: '用户/交付清单.json' })).toContain('用户/交付清单.json');
  expect(await ws.readText('用户/交付清单.json')).toBe(ordinaryManifest);
});

it('copy_skill_file调用前和附件返回后停止均不落盘', async () => {
  await install({ 'ordinary.txt': '普通内容' });
  const before = new AbortController();
  before.abort();
  await expect(copiedTool({}).run({ name: skillName, path: 'ordinary.txt' }, { signal: before.signal })).rejects.toHaveProperty('name', 'AbortError');
  const during = new AbortController();
  const original = packs.fileBlob;
  vi.spyOn(packs, 'fileBlob').mockImplementation(async (...args) => {
    const blob = await original(...args);
    during.abort();
    return blob;
  });
  await expect(copiedTool({}).run({ name: skillName, path: 'ordinary.txt' }, { signal: during.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(await ws.list()).toEqual([]);
});

it('技能运行器输出含新架构清单时，整批拒绝且不调用任何saveFile', async () => {
  const { tool, saveFile, runner } = fakeRunner(runnerResult([['ordinary.txt', '先生成的普通文件'], ['交付清单.json', owner]]));
  await expect(tool.run({ skill: 'synthetic', command: 'produce-files' })).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
  expect(runner.run).toHaveBeenCalledOnce();
  expect(saveFile).not.toHaveBeenCalled();
  expect(await ws.list()).toEqual([]);
});

it('技能运行器普通输出及同名普通JSON继续保存，真实目标使用安全技能名前缀', async () => {
  const { tool, saveFile } = fakeRunner(runnerResult([['ordinary.txt', '正常输出'], ['nested/交付清单.json', ordinaryManifest]]));
  const output = await tool.run({ skill: 'synthetic', command: 'produce-files' });
  expect(output).toContain('退出码：0');
  expect(output).toContain('/workspace/skills-output/Synthetic-Demo-1/ordinary.txt');
  expect(saveFile.mock.calls.map(([target]) => target)).toEqual(['skills-output/Synthetic-Demo-1/ordinary.txt', 'skills-output/Synthetic-Demo-1/nested/交付清单.json']);
  expect(await ws.readText('skills-output/Synthetic-Demo-1/ordinary.txt')).toBe('正常输出');
  expect(await ws.readText('skills-output/Synthetic-Demo-1/nested/交付清单.json')).toBe(ordinaryManifest);
});

it('技能运行器调用前停止不启动命令，也不保存任何输出', async () => {
  const { tool, runner, saveFile } = fakeRunner(runnerResult([['ordinary.txt', '不得保存']]));
  const controller = new AbortController();
  controller.abort();
  await expect(tool.run({ skill: 'synthetic', command: 'produce-files' }, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(runner.run).not.toHaveBeenCalled();
  expect(saveFile).not.toHaveBeenCalled();
});

it('技能运行器返回输出时已停止，AbortError向上传递且无部分保存', async () => {
  const { tool, runner, saveFile } = fakeRunner(runnerResult([]));
  const controller = new AbortController();
  runner.run.mockImplementationOnce(async () => {
    controller.abort();
    return runnerResult([['ordinary.txt', '不得保存'], ['nested/交付清单.json', ordinaryManifest]]);
  });
  await expect(tool.run({ skill: 'synthetic', command: 'produce-files' }, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(saveFile).not.toHaveBeenCalled();
  expect(await ws.list()).toEqual([]);
});

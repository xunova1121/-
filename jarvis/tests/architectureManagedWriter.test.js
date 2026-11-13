import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import * as fileHistory from '../src/agent/fileHistory.js';

let temporaryRoot;
let fileReadError;
let onStreamWrite;
const streamAbort = vi.fn();
const statePath = '文档检查/架构任务/synthetic.json';
const manifestPath = '交付/交付清单.json';
const owner = { version: 1, architecturePath: '文档检查/架构底稿/synthetic.architecture.json', planHash: 'sha256:synthetic', status: 'running' };

// 模拟目录/文件句柄和缓冲写入：只有close才替换原文件，避免把FSA模式测成内存后端。
function directoryHandle(directoryName = '测试文件夹') {
  const children = new Map();
  const missing = () => new DOMException('Not found', 'NotFoundError');
  return {
    kind: 'directory', name: directoryName,
    queryPermission: async () => 'granted',
    getDirectoryHandle: async (entryName, { create = false } = {}) => {
      let handle = children.get(entryName);
      if (!handle && create) { handle = directoryHandle(entryName); children.set(entryName, handle); }
      if (!handle) throw missing();
      if (handle.kind !== 'directory') throw new DOMException('Not a directory', 'TypeMismatchError');
      return handle;
    },
    getFileHandle: async (entryName, { create = false } = {}) => {
      let handle = children.get(entryName);
      if (!handle && create) {
        let committed = new Blob([]);
        handle = {
          kind: 'file', name: entryName,
          getFile: async () => {
            if (fileReadError) throw fileReadError;
            return Object.assign(new Blob([committed]), { lastModified: Date.now(), name: entryName });
          },
          createWritable: async () => {
            let pending = committed;
            return {
              write: async data => { pending = new Blob([data]); onStreamWrite?.(); },
              close: async () => { committed = pending; },
              abort: async () => { pending = committed; streamAbort(); }
            };
          }
        };
        children.set(entryName, handle);
      }
      if (!handle) throw missing();
      if (handle.kind !== 'file') throw new DOMException('Not a file', 'TypeMismatchError');
      return handle;
    },
    entries: async function* () { yield* children.entries(); }
  };
}

beforeEach(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-writer-'));
  fileReadError = null;
  onStreamWrite = null;
  streamAbort.mockClear();
  useBackend(createFileStore(temporaryRoot));
  const handle = directoryHandle();
  vi.stubGlobal('window', { showDirectoryPicker: vi.fn(async () => handle) });
  await ws.connectFolder();
});
afterEach(async () => {
  await ws.disconnectFolder();
  useBackend(null);
  vi.unstubAllGlobals();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

it('FSA默认写入继续同名另存，架构内部状态用专用入口更新原路径', async () => {
  expect(ws.mode()).toBe('folder');
  await ws.write('普通报告.txt', '原成果');
  expect(await ws.write('普通报告.txt', '另一个成果')).toMatchObject({ path: '普通报告 (2).txt', renamed: true });
  expect(await ws.readText('普通报告.txt')).toBe('原成果');
  expect(await ws.readText('普通报告 (2).txt')).toBe('另一个成果');

  await ws.writeArchitectureState(statePath, '{"stage":"content","attempts":1}');
  expect(await ws.writeArchitectureState(statePath, '{"stage":"review","attempts":2}')).toMatchObject({ path: statePath, renamed: false, backup: null });
  expect(await ws.readText(statePath)).toBe('{"stage":"review","attempts":2}');
  expect((await ws.list('文档检查/架构任务')).map(file => file.path)).toEqual([statePath]);
  // 专用入口没有改变默认write的同名保护，误用默认入口依然会另存。
  expect(await ws.write(statePath, '默认写入')).toMatchObject({ path: '文档检查/架构任务/synthetic (2).json', renamed: true });
  expect(await ws.readText(statePath)).toContain('"stage":"review"');
});

it('只授权根目录的架构私有文件，目录本身和普通用户成果不能显式覆盖', async () => {
  for (const folder of ['架构任务', '架构底稿', '架构输入', '架构诊断', '架构回复', '架构审查回复', '架构内容', '架构候选', '架构证据']) {
    const target = '文档检查/' + folder + '/synthetic.json';
    await ws.writeArchitectureState(target, '第一版');
    await ws.writeArchitectureState(target, '第二版');
    expect(await ws.readText(target)).toBe('第二版');
  }
  for (const target of ['文档检查', '文档检查/架构任务', '文档检查/普通说明.json', '其他/文档检查/架构任务/a.json', 'public/文档检查/架构任务/state.json', '文档检查/' + encodeURIComponent('架构任务') + '/state.json', encodeURIComponent(statePath), '普通报告.txt', '交付/图.svg']) {
    await expect(ws.writeArchitectureState(target, '{}')).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_WRITE_SCOPE');
    expect(await ws.exists(target)).toBe(false);
  }
});

it('架构交付清单同路径续写且保留所有权，不能剥除所有权或放行普通图形清单', async () => {
  await ws.writeArchitectureState(manifestPath, JSON.stringify(owner));
  const complete = { ...owner, status: 'complete', files: ['总体.svg'] };
  expect(await ws.writeArchitectureState(manifestPath, JSON.stringify(complete))).toMatchObject({ path: manifestPath, renamed: false });
  expect(JSON.parse(await ws.readText(manifestPath))).toEqual(complete);
  expect((await ws.list('交付')).map(file => file.path)).toEqual([manifestPath]);
  await expect(ws.writeArchitectureState(manifestPath, '{"status":"complete"}')).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_WRITE_SCOPE');
  expect(JSON.parse(await ws.readText(manifestPath))).toEqual(complete);
  await expect(ws.writeArchitectureState('普通/图.exports.json', JSON.stringify({ designHash: 'sha256:synthetic', artifacts: [], sourcePath: '普通/图.svg' }))).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_WRITE_SCOPE');
  expect(await ws.exists('普通/图.exports.json')).toBe(false);
});

it('内部清单兼容已有非空opaque版本号，内容有效性仍交给原架构加载校验', async () => {
  const legacyPath = '兼容/交付清单.json';
  const legacyOwner = { ...owner, planHash: 'v1' };
  await ws.writeArchitectureState(legacyPath, JSON.stringify(legacyOwner));
  const complete = { ...legacyOwner, status: 'complete' };
  expect(await ws.writeArchitectureState(legacyPath, JSON.stringify(complete))).toMatchObject({ path: legacyPath, renamed: false });
  expect(JSON.parse(await ws.readText(legacyPath))).toEqual(complete);
  expect((await ws.list('兼容')).map(file => file.path)).toEqual([legacyPath]);
  for (const invalid of [{ ...complete, architecturePath: '' }, { ...complete, planHash: '' }, { status: 'complete' }]) {
    await expect(ws.writeArchitectureState(legacyPath, JSON.stringify(invalid))).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_WRITE_SCOPE');
    expect(JSON.parse(await ws.readText(legacyPath))).toEqual(complete);
  }
});

it('用户已有同名非架构清单不能被架构专用写入覆盖或另存冒充成功', async () => {
  const original = '{"files":["用户报告.docx"],"note":"用户自己的清单"}';
  await ws.write(manifestPath, original);
  await expect(ws.writeArchitectureState(manifestPath, JSON.stringify(owner))).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_WRITE_SCOPE');
  expect(await ws.readText(manifestPath)).toBe(original);
  expect((await ws.list('交付')).map(file => file.path)).toEqual([manifestPath]);
});

it('虚拟工作区专用写入继续保留旧版本，默认文件历史行为不变', async () => {
  await ws.disconnectFolder();
  expect(ws.mode()).toBe('virtual');
  expect(await ws.writeArchitectureState(statePath, '{"attempts":1}')).toMatchObject({ path: statePath, renamed: false, backup: 'recorded' });
  expect(await ws.writeArchitectureState(statePath, '{"attempts":2}')).toMatchObject({ path: statePath, renamed: false, backup: 'saved' });
  expect(await ws.readText(statePath)).toBe('{"attempts":2}');
  const records = await fileHistory.list();
  const overwritten = records.find(record => record.path === statePath && record.op === 'overwrite');
  expect(overwritten).toMatchObject({ stored: true });
  expect((await fileHistory.get(overwritten.id)).data).toBeInstanceOf(Blob);
  expect(await (await fileHistory.get(overwritten.id)).data.text()).toBe('{"attempts":1}');
  await ws.write('普通.txt', '一');
  expect(await ws.write('普通.txt', '二')).toMatchObject({ path: '普通.txt', renamed: false, backup: 'saved' });
  expect(await ws.readText('普通.txt')).toBe('二');
});

it('已停止的任务不创建或替换架构状态文件', async () => {
  await ws.writeArchitectureState(statePath, '{"attempts":1}');
  const controller = new AbortController();
  controller.abort();
  await expect(ws.writeArchitectureState(statePath, '{"attempts":2}', { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
  await expect(ws.writeArchitectureState('文档检查/架构任务/未创建.json', '{}', { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(await ws.readText(statePath)).toBe('{"attempts":1}');
  expect(await ws.exists('文档检查/架构任务/未创建.json')).toBe(false);
});

it('现有动态文件读取被拒绝时保持失败，不能把它当作新文件覆盖', async () => {
  await ws.writeArchitectureState(manifestPath, JSON.stringify(owner));
  const denied = new DOMException('Read denied', 'NotAllowedError');
  fileReadError = denied;
  await expect(ws.writeArchitectureState(manifestPath, JSON.stringify({ ...owner, status: 'complete' }))).rejects.toBe(denied);
  fileReadError = null;
  expect(JSON.parse(await ws.readText(manifestPath))).toEqual(owner);
});

it('FSA写入缓冲后close前停止会abort，原状态不会变成半份新内容', async () => {
  await ws.writeArchitectureState(statePath, '{"attempts":1}');
  const controller = new AbortController();
  onStreamWrite = () => controller.abort();
  await expect(ws.writeArchitectureState(statePath, '{"attempts":2}', { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(streamAbort).toHaveBeenCalledOnce();
  expect(await ws.readText(statePath)).toBe('{"attempts":1}');
});

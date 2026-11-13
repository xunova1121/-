import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { assertArchitectureWriteAllowed, assertArchitectureToolCall } from '../src/agent/architectureStateProtection.js';

let temporaryRoot;
const owned = JSON.stringify({ architecturePath: '文档检查/架构底稿/synthetic.architecture.json', planHash: 'sha256:synthetic', status: 'complete' });
beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-metadata-'));
  useBackend(createFileStore(temporaryRoot));
});
afterEach(() => {
  vi.restoreAllMocks();
  useBackend(null);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

it('深目录的架构清单不依赖有深度/数量上限的列表，列表缺失或故障也不能绕开修改保护', async () => {
  const target = '项目/版本/视图/汇总/成果/实际交付/交付清单.json';
  await ws.write(target, owned);
  const listing = vi.spyOn(ws, 'list');
  for (const implementation of [async () => [], async () => { throw new Error('列表已达到500项或不可用'); }]) {
    listing.mockImplementation(implementation);
    await expect(assertArchitectureToolCall('edit_file', { path: target, edits: [] })).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
    expect(listing).not.toHaveBeenCalled();
    expect(await ws.readText(target)).toBe(owned);
  }
});

it('真实缺失文件带明确错误码，普通缺失/现存同名JSON继续可修改', async () => {
  const missing = '不存在/交付清单.json';
  await expect(ws.readBlob(missing)).rejects.toHaveProperty('code', 'WORKSPACE_NOT_FOUND');
  await expect(assertArchitectureWriteAllowed(missing, '{"files":["普通报告.docx"]}')).resolves.toBeUndefined();
  for (const target of ['用户/交付清单.json', '用户/设计.diagram.json', '用户/版本.architecture.json', '用户/结果.review.json', '用户/导出.exports.json']) {
    await ws.write(target, '{"note":"用户普通文件"}');
    await expect(assertArchitectureToolCall('edit_file', { path: target, edits: [] })).resolves.toBeUndefined();
    await expect(assertArchitectureWriteAllowed(target, '{"note":"更新普通文件"}')).resolves.toBeUndefined();
    expect(await ws.readText(target)).toBe('{"note":"用户普通文件"}');
  }
});

it('元数据直接读取的权限/IO及停止异常必须原样上抛，不能当文件不存在而放行', async () => {
  const read = vi.spyOn(ws, 'readBlob');
  const errors = [
    new DOMException('Read denied', 'NotAllowedError'),
    Object.assign(new Error('I/O failure'), { code: 'EIO' }),
    Object.assign(new Error('Stopped'), { name: 'AbortError' })
  ];
  for (const error of errors) {
    read.mockRejectedValue(error);
    await expect(assertArchitectureToolCall('edit_file', { path: '项目/交付清单.json', edits: [] })).rejects.toBe(error);
  }
});

it('字面百分号编码文件和解码别名都核对实际内容，普通同名JSON不被误封', async () => {
  const literalPaths = [
    '项目/' + encodeURIComponent('架构稿') + '/交付清单.json',
    '项目/' + encodeURIComponent('交付清单') + '.json',
    encodeURIComponent('整段/交付清单.json')
  ];
  for (const target of literalPaths) {
    await ws.write(target, owned);
    await expect(assertArchitectureToolCall('edit_file', { path: target, edits: [] })).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
    expect(await ws.readText(target)).toBe(owned);
  }
  const decodedPath = '已解码/交付清单.json';
  await ws.write(decodedPath, owned);
  await expect(assertArchitectureWriteAllowed(encodeURIComponent(decodedPath), undefined)).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
  for (const target of ['普通/' + encodeURIComponent('交付清单') + '.json', encodeURIComponent('普通整段/交付清单.json')]) {
    await ws.write(target, '{"files":["普通成果.txt"]}');
    await expect(assertArchitectureToolCall('edit_file', { path: target, edits: [] })).resolves.toBeUndefined();
  }
});

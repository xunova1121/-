import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../src/agent/sandbox.js', async importOriginal => ({ ...(await importOriginal()), runPython: vi.fn() }));
import { runPython } from '../src/agent/sandbox.js';
import { createTools } from '../src/agent/tools.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
let root;
const managed = ['文档检查', '架构任务', 'synthetic.content.json'].join('/');
const bytes = text => new TextEncoder().encode(text).buffer;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-python-'));
  useBackend(createFileStore(root)); runPython.mockReset();
  await ws.write(managed, '{"relations":[{"from":"a","to":"b"}]}');
});
afterEach(() => { useBackend(null); fs.rmSync(root, { recursive: true, force: true }); });
it('Python回写真实路径在落盘前整体核对：字符串构造/编码路径都不能绕开，也不先写普通文件', async () => {
  const original = await ws.readText(managed);
  const tool = createTools({}).find(item => item.name === 'run_python');
  for (const returnedPath of [managed, encodeURIComponent(managed)]) {
    runPython.mockResolvedValueOnce({ ok: true, logs: [], changed: [
      { path: '普通成果.txt', bytes: bytes('这一份也必须不落盘') },
      { path: returnedPath, bytes: bytes('{"relations":[]}') }
    ] });
    // mock只替代Python运行时；执行真实工具的文件选择、回写预检和保存代码。
    await expect(tool.run({ code: 'parts = ["文档检查", "架构任务", "synthetic.content.json"]; p = "/".join(parts)' })).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
    expect(await ws.exists('普通成果.txt')).toBe(false);
    expect(await ws.readText(managed)).toBe(original);
  }
});
it('Python不能新造架构交付清单，普通项目同名非架构JSON仍可写', async () => {
  const tool = createTools({}).find(item => item.name === 'run_python');
  runPython.mockResolvedValueOnce({ ok: true, logs: [], changed: [{ path: '输出/交付清单.json', bytes: bytes(JSON.stringify({ version: 1, architecturePath: '文档检查/架构底稿/a.architecture.json', planHash: 'sha256:fixture', status: 'complete' })) }] });
  await expect(tool.run({ code: 'generate_manifest()' })).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
  expect(await ws.exists('输出/交付清单.json')).toBe(false);
  runPython.mockResolvedValueOnce({ ok: true, logs: [], changed: [{ path: '输出/交付清单.json', bytes: bytes('{"files":["普通报告.docx"]}') }] });
  await tool.run({ code: 'generate_normal_manifest()' });
  expect(await ws.readText('输出/交付清单.json')).toBe('{"files":["普通报告.docx"]}');
});
it('普通Python新建/修改文件、变更回执和停止信号保持', async () => {
  const onFileChanged = vi.fn(), tool = createTools({ onFileChanged }).find(item => item.name === 'run_python');
  runPython.mockResolvedValueOnce({ ok: true, logs: ['done'], value: 'result', changed: [{ path: '普通.txt', bytes: bytes('正常结果') }] });
  expect(await tool.run({ code: 'ordinary_work()' })).toContain('已同步到工作区：普通.txt');
  expect(await ws.readText('普通.txt')).toBe('正常结果'); expect(onFileChanged).toHaveBeenCalledWith('普通.txt');
  const controller = new AbortController(); controller.abort();
  runPython.mockResolvedValueOnce({ ok: true, logs: [], changed: [{ path: '停止后.txt', bytes: bytes('不得写') }] });
  await expect(tool.run({ code: 'later_work()' }, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(await ws.exists('停止后.txt')).toBe(false);
});

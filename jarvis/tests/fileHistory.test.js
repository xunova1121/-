/** 工作区（网页版 / 安卓）的改动记录：覆盖、删除前留旧版本，一键恢复 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

let ws;
let history;
let tools;
beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  ws = await import('../src/agent/workspace.js');
  history = await import('../src/agent/fileHistory.js');
  tools = await import('../src/agent/tools.js');
});
afterEach(() => { delete globalThis.indexedDB; });

describe('工作区改动记录', () => {
  it('覆盖同名文件：旧内容留一份，恢复后回到旧内容；恢复本身也能撤回', async () => {
    expect((await ws.write('site/index.html', '<h1>v1</h1>')).backup).toBe('recorded');
    expect((await ws.write('site/index.html', '<h1>v2</h1>')).backup).toBe('saved');
    const [over, created] = await history.list();
    expect(created).toMatchObject({ op: 'create', stored: false });
    expect(over).toMatchObject({ op: 'overwrite', opName: '覆盖', stored: true, path: 'site/index.html' });
    expect(over.data).toBeUndefined(); // 列表里不带文件内容
    await ws.restoreVersion(over.id);
    expect(await ws.readText('site/index.html')).toBe('<h1>v1</h1>');
    const undo = (await history.list()).find((e) => e.note === '恢复前的内容');
    await ws.restoreVersion(undo.id);
    expect(await ws.readText('site/index.html')).toBe('<h1>v2</h1>');
  });

  it('新建的文件：撤销 = 删掉（删掉前的内容也留一份）', async () => {
    await ws.write('a.md', '新内容');
    const [c] = await history.list();
    await ws.restoreVersion(c.id);
    expect(await ws.exists('a.md')).toBe(false);
    const del = (await history.list()).find((e) => e.op === 'delete');
    expect(del.note).toBe('撤销新建前的内容');
    await ws.restoreVersion(del.id);
    expect(await ws.readText('a.md')).toBe('新内容');
  });

  it('用户手动删除：可以恢复', async () => {
    await ws.write('报告.csv', 'a,b\n1,2');
    await ws.removeVirtual('报告.csv');
    const [d] = await history.list();
    expect(d).toMatchObject({ op: 'delete', opName: '删除', stored: true });
    await ws.restoreVersion(d.id);
    expect(await ws.readText('报告.csv')).toBe('a,b\n1,2');
  });

  it('之后又被改过：恢复前提醒；不能恢复的说明原因', async () => {
    await ws.write('a.txt', '1');
    await ws.write('a.txt', '2');
    const [over] = await history.list();
    expect(await ws.checkVersion(over.id)).toEqual({ ok: true, warning: '' });
    await new Promise((r) => setTimeout(r, 5));
    await ws.write('a.txt', '3');
    expect((await ws.checkVersion(over.id)).warning).toMatch(/又被改过/);
    expect(await ws.checkVersion('nope')).toMatchObject({ ok: false, problem: expect.stringContaining('找不到') });
  });

  it('超过 20 MB 的文件不备份，如实说明', async () => {
    const big = new Blob([new Uint8Array(history.LIMITS.maxFile + 1)]);
    await ws.write('big.bin', big);
    expect((await ws.write('big.bin', 'small')).backup).toBe('too-big');
    const [e] = await history.list();
    expect(e.stored).toBe(false);
    await expect(ws.restoreVersion(e.id)).rejects.toThrow(/太大/);
  });

  it('清理：超过 30 天、同一文件超过 10 份、总大小超过 100 MB 的从最旧的开始删', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    const limits = { ...history.LIMITS, totalBytes: 25, perPath: 3 };
    for (let i = 0; i < 5; i++) await history.record({ path: 'a.txt', op: 'overwrite', blob: new Blob(['0123456789']), at: t0 + i, limits });
    expect((await history.list()).length).toBeLessThanOrEqual(3);
    expect((await history.usage()).bytes).toBeLessThanOrEqual(25);
    await history.prune({ at: t0 + 31 * 86400_000 });
    expect(await history.list()).toEqual([]);
    expect(history.LIMITS).toEqual({ days: 30, totalBytes: 100 * 1024 * 1024, maxFile: 20 * 1024 * 1024, perPath: 10 });
  });

  it('write_file 工具：覆盖时告诉模型已备份', async () => {
    const t = tools.createTools({}).find((x) => x.name === 'write_file');
    expect(await t.run({ path: 'x.md', content: '1' })).not.toMatch(/备份/);
    expect(await t.run({ path: 'x.md', content: '2' })).toMatch(/原来的内容已自动备份，可在“工作区 → 改动记录”里恢复/);
  });
});

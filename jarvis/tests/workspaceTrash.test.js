import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import fs, { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';

it('两个浏览器连接通过同一条事务移动原字节，过期操作不能删改新文件', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  try {
    vi.resetModules();
    const a = await import('../src/agent/workspace.js');
    vi.resetModules();
    const b = await import('../src/agent/workspace.js');
    const file = '资料/原件.bin';
    const bytes = new Uint8Array([0, 200, 255, 17]);
    await a.write(file, bytes.buffer);
    const [snapshot] = await a.list();
    const moves = await Promise.allSettled([a.trash(file, snapshot), b.trash(file, snapshot)]);
    expect(moves.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(await b.list()).toEqual([]);
    await expect(a.readBlob(file)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    const [deleted] = await b.listTrash();
    expect(deleted).toMatchObject({ ...snapshot, trashedAt: expect.any(Number) });
    await a.restoreTrash(file, deleted);
    expect(new Uint8Array(await (await b.readBlob(file)).arrayBuffer())).toEqual(bytes);
    await expect(b.trash(file, snapshot)).rejects.toMatchObject({ status: 409 });
    await b.trash(file);
    await a.write(file, '同名新材料');
    await expect(b.restoreTrash(file)).rejects.toMatchObject({ status: 409 });
    await expect(a.purgeTrash(file, deleted)).rejects.toMatchObject({ status: 409 });
    await b.purgeTrash(file);
    expect(await a.listTrash()).toEqual([]);
    expect(await a.readText(file)).toBe('同名新材料');
    const history = await import('../src/agent/fileHistory.js');
    const entry = (await history.list()).find(e => e.op === 'delete' && e.path === file && e.stored);
    expect(new Uint8Array(await (await history.get(entry.id)).data.arrayBuffer())).toEqual(bytes);
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
});

it('本机全空间以确认快照批量处理，包含隐藏过程、上传文件，保护新写入的字节', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  try {
    vi.resetModules();
    const ws = await import('../src/agent/workspace.js');
    const { trashSnapshot } = await import('../src/agent/workspaceTrash.js');
    const source = new Map();
    for (let i = 0; i < 32; i++) {
      const path = (i % 2 ? '.workflows/稿件/' : 'uploads/用户/') + i;
      const bytes = Uint8Array.of(0, 255, i, 0x84);
      source.set(path, bytes);
      await ws.write(path, bytes.buffer);
    }
    const snapshot = await ws.list();
    const changed = snapshot.at(-1).path;
    await ws.write(changed, '改过');
    await ws.write('后建/1', '另存');
    const progress = [];
    const result = await trashSnapshot(snapshot, { trashFile: ws.trash, onProgress: v => progress.push(v) });
    expect(result.paths).toEqual(snapshot.filter(f => f.path !== changed).map(f => f.path));
    expect(result.errors).toEqual([{ path: changed, reason: expect.stringContaining('变化') }]);
    expect(progress).toEqual(snapshot.map((_, index) => ({ done: index + 1, total: snapshot.length })));
    expect(await ws.readText(changed)).toBe('改过');
    expect(await ws.readText('后建/1')).toBe('另存');
    for (const row of await ws.listTrash()) {
      await ws.restoreTrash(row.path, row);
      expect(new Uint8Array(await (await ws.readBlob(row.path)).arrayBuffer())).toEqual(source.get(row.path));
    }
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
});

it('中止立即停止派发，四个在途回执全部收束后按原顺序提供结果', async () => {
  const { trashSnapshot } = await import('../src/agent/workspaceTrash.js');
  const controller = new AbortController(), resolvers = [];
  const files = Array.from({ length: 15 }, (_, i) => ({ path: '材料/' + i, mtime: i + 1, size: i }));
  let finished = false;
  const task = trashSnapshot(files, {
    signal: controller.signal,
    trashFile: (path, file) => new Promise(resolve => resolvers.push(() => resolve({ path: file.path })))
  }).then(result => { finished = true; return result; });
  expect(resolvers).toHaveLength(4);
  controller.abort();
  for (let i = 3; i > 0; i--) resolvers[i]();
  await Promise.resolve();
  expect(finished).toBe(false);
  resolvers[0]();
  const result = await task;
  expect(result.paths).toEqual(files.slice(0, 4).map(f => f.path));
  expect(result.errors).toEqual(files.slice(4).map(f => ({ path: f.path, reason: '已停止，未执行' })));
});

it('硬盘旧记录可恢复，移动时沿用原二进制，重启后仍可读', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weiyang-trash-'));
  const { useBackend } = await import('../src/agent/store.js');
  const ws = await import('../src/agent/workspace.js');
  const file = '资料/老系统的文件.dat';
  try {
    // 兼容旧服务器的 JSON 记录 / .data.bin 命名。
    const key = createHash('sha1').update(file).digest('hex');
    const folder = path.join(dir, 'files');
    await mkdir(folder);
    const bytes = Buffer.from([0, 1, 3, 7, 255]);
    await writeFile(path.join(folder, key + '.data.bin'), bytes);
    await writeFile(path.join(folder, key + '.json'), JSON.stringify({ id: file, data: { $file: key + '.data.bin', type: 'application/octet-stream' }, mtime: 11, size: bytes.length }));
    useBackend(createFileStore(dir));
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('模拟落盘失败'));
    try { await expect(ws.trash(file)).rejects.toThrow('模拟落盘失败'); }
    finally { rename.mockRestore(); }
    expect(await ws.listTrash()).toEqual([]);
    expect(Buffer.from(await (await ws.readBlob(file)).arrayBuffer())).toEqual(bytes);
    await ws.trash(file);
    expect((await readdir(folder)).filter(p => p.endsWith('.bin'))).toEqual([key + '.data.bin']);
    useBackend(createFileStore(dir));
    expect(await ws.exists(file)).toBe(false);
    expect(await ws.listTrash()).toHaveLength(1);
    await ws.restoreTrash(file);
    expect(Buffer.from(await (await ws.readBlob(file)).arrayBuffer())).toEqual(bytes);
    await ws.trash(file);
    await ws.write(file, '新内容');
    await expect(ws.restoreTrash(file)).rejects.toMatchObject({ status: 409 });
    await ws.purgeTrash(file);
    expect(await ws.readText(file)).toBe('新内容');
    expect((await readdir(folder)).filter(p => p.endsWith('.bin'))).toHaveLength(1);
  } finally { useBackend(null); await rm(dir, { recursive: true, force: true }); }
});

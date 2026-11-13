import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-store-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('服务器存储：记录和文件存到硬盘', () => {
  it('存取、列出、删除；重启（新建实例）后还在', async () => {
    const dir = tmp();
    const a = createFileStore(dir);
    await a.put('sessions', { id: 'c1', title: '汇报', messages: [{ role: 'user', content: '做个 PPT' }] });
    await a.put('sessions', { id: 'c2', title: '第二段', messages: [] });
    await a.put('sessions', { id: 'c1', title: '汇报（改）', messages: [] });
    expect((await a.get('sessions', 'c1')).title).toBe('汇报（改）');
    expect((await a.all('sessions')).length).toBe(2);
    await a.delete('sessions', 'c2');
    const b = createFileStore(dir);
    expect((await b.all('sessions')).map((s) => s.id)).toEqual(['c1']);
    expect(await b.get('sessions', 'nope')).toBeUndefined();
  });
  it('文件内容（Blob）单独存，读回来内容和类型都对', async () => {
    const dir = tmp();
    const a = createFileStore(dir);
    await a.put('files', { id: '报告/汇报.docx', data: new Blob(['你好'], { type: 'text/plain' }), size: 6, mtime: 1 });
    const b = createFileStore(dir);
    const f = await b.get('files', '报告/汇报.docx');
    expect(f.data).toBeInstanceOf(Blob);
    expect(await f.data.text()).toBe('你好');
    expect(f.data.type).toBe('text/plain');
    expect(f.size).toBe(6);
    await b.delete('files', '报告/汇报.docx');
    expect(fs.readdirSync(path.join(dir, 'files'))).toEqual([]);
  });
  it('未央自己的存储层可以换成硬盘', async () => {
    const dir = tmp();
    const store = await import('../src/agent/store.js');
    store.useBackend(createFileStore(dir));
    try {
      const ws = await import('../src/agent/workspace.js');
      await ws.write('a/b.txt', '内容');
      expect(await ws.readText('a/b.txt')).toBe('内容');
      expect((await ws.list()).map((f) => f.path)).toEqual(['a/b.txt']);
      expect(fs.readdirSync(path.join(dir, 'files')).some((f) => f.endsWith('.bin'))).toBe(true);
    } finally { store.useBackend(null); }
  });
});

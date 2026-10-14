import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackups } from '../desktop/backups.mjs';
import { createOps } from '../desktop/ops.mjs';
import { createDesktopTools } from '../src/agent/desktopTools.js';

const DAY = 86400_000;
let root;
let work;
let bdir;
let trashed;
let clock;
let backups;
let ops;
const read = (p) => fs.readFileSync(p, 'utf8');
const P = (...x) => path.join(work, ...x);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bk-'));
  work = path.join(root, 'work');
  bdir = path.join(root, 'backups');
  fs.mkdirSync(work);
  trashed = [];
  clock = Date.UTC(2026, 9, 14, 2);
  const trash = async (f) => { trashed.push(f); fs.rmSync(f, { recursive: true, force: true }); };
  backups = createBackups({ dir: bdir, now: () => clock++, trash });
  ops = createOps({ backups, shell: { trashItem: trash } });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('桌面版：改文件前自动备份', () => {
  it('覆盖写文件：旧内容进备份，一键恢复；恢复前的内容也留了一份，可以再撤回', async () => {
    fs.writeFileSync(P('报告.md'), '第一版');
    const r = await ops.writeFile({ path: P('报告.md'), text: '第二版' });
    expect(r.backup).toBe('saved');
    expect(read(P('报告.md'))).toBe('第二版');
    const [e] = await backups.list();
    expect(e).toMatchObject({ op: 'overwrite', opName: '覆盖', path: P('报告.md'), stored: true, size: Buffer.byteLength('第一版') });
    await ops.backupRestore({ id: e.id });
    expect(read(P('报告.md'))).toBe('第一版');
    // 恢复前的“第二版”也存了一份，可以撤回这次恢复
    const undo = (await backups.list()).find((x) => x.note === '恢复前的内容');
    await ops.backupRestore({ id: undo.id });
    expect(read(P('报告.md'))).toBe('第二版');
    expect((await backups.list()).find((x) => x.id === e.id).restoredAt).toBeTruthy();
  });

  it('新建文件：只记一笔，撤销 = 移到回收站', async () => {
    const r = await ops.writeFile({ path: P('新文件.txt'), text: 'hi' });
    expect(r.backup).toBe('recorded');
    const [e] = await backups.list();
    expect(e).toMatchObject({ op: 'create', stored: false, size: 0 });
    await ops.backupRestore({ id: e.id });
    expect(fs.existsSync(P('新文件.txt'))).toBe(false);
    expect(trashed).toEqual([P('新文件.txt')]);
    // 已经不在了：再撤销会说明原因，不报奇怪的错
    await expect(ops.backupCheck({ id: e.id })).resolves.toMatchObject({ ok: false, problem: expect.stringContaining('已经不在了') });
  });

  it('移动 / 改名：记下从哪到哪，恢复时移回；原位置被占用就不动', async () => {
    fs.mkdirSync(P('资料'));
    fs.writeFileSync(P('资料', 'a.txt'), 'A');
    const r = await ops.move({ from: P('资料'), to: P('归档', '资料2024') });
    expect(r.backup).toBe('recorded');
    const [e] = await backups.list();
    expect(e).toMatchObject({ op: 'move', path: P('资料'), to: P('归档', '资料2024') });
    // 原位置又出现了同名文件夹：不覆盖
    fs.mkdirSync(P('资料'));
    await expect(ops.backupRestore({ id: e.id })).rejects.toThrow(/原位置已经有同名文件/);
    fs.rmdirSync(P('资料'));
    await ops.backupRestore({ id: e.id });
    expect(read(P('资料', 'a.txt'))).toBe('A');
    expect(fs.existsSync(P('归档', '资料2024'))).toBe(false);
  });

  it('删除（移到回收站）：先复制一份，回收站清空了也能恢复，文件夹也行', async () => {
    fs.mkdirSync(P('项目', 'src'), { recursive: true });
    fs.writeFileSync(P('项目', 'src', 'main.js'), 'console.log(1)');
    fs.writeFileSync(P('项目', 'README.md'), '说明');
    const r = await ops.trash({ path: P('项目') });
    expect(r.backup).toBe('saved');
    expect(fs.existsSync(P('项目'))).toBe(false); // 回收站（测试里直接删掉了，相当于清空回收站）
    const [e] = await backups.list();
    expect(e).toMatchObject({ op: 'delete', isDir: true, stored: true });
    await ops.backupRestore({ id: e.id });
    expect(read(P('项目', 'src', 'main.js'))).toBe('console.log(1)');
    expect(read(P('项目', 'README.md'))).toBe('说明');
  });

  it('复制：撤销 = 把复制出来的那份移到回收站', async () => {
    fs.writeFileSync(P('a.txt'), 'A');
    await ops.copy({ from: P('a.txt'), to: P('b.txt') });
    const [e] = await backups.list();
    expect(e.op).toBe('copy');
    await ops.backupRestore({ id: e.id });
    expect(fs.existsSync(P('b.txt'))).toBe(false);
    expect(read(P('a.txt'))).toBe('A');
  });

  it('文件太大不备份：如实告诉用户，删除的请从回收站还原', async () => {
    const small = createBackups({ dir: bdir, limits: { maxFile: 10 }, trash: async (f) => fs.rmSync(f) });
    const o = createOps({ backups: small, shell: { trashItem: async (f) => fs.rmSync(f) } });
    fs.writeFileSync(P('big.log'), 'x'.repeat(50));
    expect((await o.writeFile({ path: P('big.log'), text: 'y'.repeat(50) })).backup).toBe('too-big');
    expect((await o.trash({ path: P('big.log') })).backup).toBe('too-big');
    const [del, over] = await small.list();
    await expect(small.restore({ id: del.id })).rejects.toThrow(/请从回收站还原/);
    await expect(small.restore({ id: over.id })).rejects.toThrow(/太大，没有备份/);
    const filesDir = path.join(bdir, 'files');
    expect(fs.existsSync(filesDir) ? fs.readdirSync(filesDir).length : 0).toBe(0); // 确实没有复制
  });

  it('之后又被改过：恢复前提醒', async () => {
    fs.writeFileSync(P('a.txt'), '1');
    await ops.writeFile({ path: P('a.txt'), text: '2' });
    const [e] = await backups.list();
    expect((await ops.backupCheck({ id: e.id })).warning).toBe('');
    const later = new Date(Date.now() + 60_000);
    fs.writeFileSync(P('a.txt'), '用户自己改的');
    fs.utimesSync(P('a.txt'), later, later);
    expect((await ops.backupCheck({ id: e.id })).warning).toMatch(/又被改过/);
  });

  it('备份失败就不写、不删，旧内容不会丢', async () => {
    const broken = { beforeWrite: async () => { throw new Error('磁盘已满'); }, beforeTrash: async () => { throw new Error('磁盘已满'); } };
    const o = createOps({ backups: broken, shell: { trashItem: async (f) => fs.rmSync(f) } });
    fs.writeFileSync(P('a.txt'), '原文');
    await expect(o.writeFile({ path: P('a.txt'), text: '新' })).rejects.toThrow(/备份旧文件失败，没有写入：磁盘已满/);
    await expect(o.trash({ path: P('a.txt') })).rejects.toThrow(/备份失败，没有删除/);
    expect(read(P('a.txt'))).toBe('原文');
  });

  it('清理：超过 30 天、同一文件超过 20 份、总大小超限的从最旧的开始删，备份文件一起删掉', async () => {
    let t = Date.UTC(2026, 0, 1);
    const b = createBackups({ dir: bdir, now: () => t, limits: { totalBytes: 30, perPath: 3 } });
    fs.writeFileSync(P('a.txt'), '0123456789'); // 10 字节
    for (let i = 0; i < 4; i++) { await b.beforeWrite(P('a.txt')); t += 1000; }
    expect((await b.list()).length).toBe(3); // 同一文件最多 3 份
    fs.writeFileSync(P('b.txt'), '0123456789');
    await b.beforeWrite(P('b.txt'));
    const list = await b.list();
    expect(list.reduce((s, e) => s + e.size, 0)).toBeLessThanOrEqual(30);
    expect(list[0].path).toBe(P('b.txt')); // 新的留下，旧的删掉
    expect(fs.readdirSync(path.join(bdir, 'files')).length).toBe(list.length);
    t += 31 * DAY;
    await b.prune();
    expect(await b.list()).toEqual([]);
    expect(fs.readdirSync(path.join(bdir, 'files')).length).toBe(0);
    expect((await b.usage()).bytes).toBe(0);
  });

  it('默认上限：30 天、500 MB、单个文件 100 MB、同一文件 20 份', () => {
    expect(backups.LIMITS).toEqual({ days: 30, totalBytes: 500 * 1024 * 1024, maxFile: 100 * 1024 * 1024, perPath: 20 });
  });

  it('同时发生的几次操作不会把清单写乱', async () => {
    for (let i = 0; i < 8; i++) fs.writeFileSync(P(`f${i}.txt`), String(i));
    await Promise.all(Array.from({ length: 8 }, (_, i) => ops.writeFile({ path: P(`f${i}.txt`), text: 'new' })));
    const list = await backups.list();
    expect(list.length).toBe(8);
    expect(new Set(list.map((e) => e.path)).size).toBe(8);
  });

  it('工具结果里告诉模型有没有备份', async () => {
    const tools = createDesktopTools({ platform: process.platform, invoke: (op, args) => ops[op](args) });
    const run = (name, args) => tools.find((t) => t.name === name).run(args);
    fs.writeFileSync(P('a.txt'), '1');
    expect(await run('computer_write_file', { path: P('a.txt'), content: '2' })).toMatch(/原来的内容已自动备份，可在“工作区 → 改动记录”里恢复/);
    expect(await run('computer_move', { from: P('a.txt'), to: P('b.txt') })).toMatch(/已记入“工作区 → 改动记录”/);
    expect(await run('computer_trash', { path: P('b.txt') })).toMatch(/原来的内容已自动备份/);
  });
});

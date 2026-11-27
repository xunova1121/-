/** 2026-11-17 用户：大文件模型读不完整；压缩打包的文件怎么读取 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { gzipSync } from 'node:zlib';
import { listArchive, extractArchive, archiveKind, decodeEntryName, safeEntryPath, ARCHIVE_LIMITS } from '../src/agent/archiveReader.js';
import { digestDocument, splitForDigest } from '../src/agent/documentDigest.js';
import { createTools } from '../src/agent/tools.js';
import { collection, useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';

beforeEach(async () => { useBackend(null); for (const name of ['files', 'kv']) await collection(name).clear(); });
const gbk = s => new Uint8Array(Buffer.from({ '招标文件.txt': 'd5d0b1eacec4bcfe2e747874' }[s], 'hex'));
function tar(files) {
  const blocks = [];
  for (const [name, text] of files) {
    const data = Buffer.from(text), h = Buffer.alloc(512);
    h.write(name, 0); h.write('0000644\0', 100); h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('0', 156); h.write('ustar\0', 257);
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

describe('打开压缩包', () => {
  it('认得出 zip / gzip / tar / rar / 7z', () => {
    expect(archiveKind(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe('zip');
    expect(archiveKind(new Uint8Array([0x1f, 0x8b, 8]))).toBe('gzip');
    expect(archiveKind(new Uint8Array(tar([['a.txt', 'x']])))).toBe('tar');
    expect(archiveKind(new Uint8Array([...Buffer.from('Rar!'), 0x1a]))).toBe('rar');
    expect(archiveKind(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('7z');
  });
  it('中文 Windows 打包的 GBK 文件名不乱码；不安全路径跳过', () => {
    expect(decodeEntryName(gbk('招标文件.txt'))).toBe('招标文件.txt');
    expect(decodeEntryName(new TextEncoder().encode('合同/附件一.pdf'))).toBe('合同/附件一.pdf');
    expect(safeEntryPath('../etc/passwd')).toBeNull();
    expect(safeEntryPath('/abs/x')).toBeNull();
    expect(safeEntryPath('C:/x')).toBeNull();
    expect(safeEntryPath('__MACOSX/._a')).toBeNull();
    expect(safeEntryPath('./资料/a.docx')).toBe('资料/a.docx');
  });
  it('zip：列清单、解压到同名文件夹、能读出原文；再解压一次不覆盖', async () => {
    const zip = new JSZip();
    zip.file('标书/技术要求.txt', '第一章 总则\n投标保证金20万元。');
    zip.file('标书/附件.zip', 'nested');
    zip.file('../逃逸.txt', 'bad');
    await ws.write('上传/标书.zip', new Blob([await zip.generateAsync({ type: 'uint8array' })]));
    const listed = await listArchive(await ws.readBlob('上传/标书.zip'), '上传/标书.zip');
    expect(listed.kind).toBe('zip');
    expect(listed.entries.filter(e => !e.dir).map(e => e.name).sort()).toEqual(['../逃逸.txt', '标书/技术要求.txt', '标书/附件.zip'].sort());
    const r = await extractArchive('上传/标书.zip');
    expect(r.folder).toBe('上传/标书');
    expect(await ws.readText('上传/标书/标书/技术要求.txt')).toContain('投标保证金20万元');
    expect(r.skipped.map(s => s.name)).toEqual(['../逃逸.txt']);
    expect(r.written.find(f => f.path.endsWith('附件.zip')).nested).toBe(true);
    expect((await extractArchive('上传/标书.zip')).folder).toBe('上传/标书（2）');
  });
  it('tar 与 tar.gz 都能解开', async () => {
    const raw = tar([['docs/说明.txt', '你好，世界']]);
    await ws.write('a/包.tar', new Blob([raw]));
    await ws.write('a/包.tar.gz', new Blob([gzipSync(raw)]));
    for (const p of ['a/包.tar', 'a/包.tar.gz']) {
      const r = await extractArchive(p);
      expect(await ws.readText(r.written[0].path)).toBe('你好，世界');
    }
  });
  it('rar/7z、超量文件、损坏的包如实报错', async () => {
    await expect(listArchive(new Blob([Buffer.from('Rar!\x1a\x07\x00')]), 'a.rar')).rejects.toThrow(/转成 zip|zip 再上传/);
    await expect(listArchive(new Blob([Buffer.from('PK\x03\x04garbage')]), 'a.zip')).rejects.toThrow(/损坏/);
    const zip = new JSZip();
    for (let i = 0; i <= ARCHIVE_LIMITS.files; i++) zip.file(`f${i}.txt`, 'x');
    await ws.write('多.zip', new Blob([await zip.generateAsync({ type: 'uint8array' })]));
    await expect(extractArchive('多.zip')).rejects.toThrow(/500个/);
    expect((await extractArchive('多.zip', { only: ['f1.txt', 'f2.txt'] })).written).toHaveLength(2);
  });
  it('open_archive 工具：list 和 extract', async () => {
    const zip = new JSZip(); zip.file('a.txt', 'A');
    await ws.write('包/x.zip', new Blob([await zip.generateAsync({ type: 'uint8array' })]));
    const tool = createTools({}).find(t => t.name === 'open_archive');
    expect(JSON.parse(await tool.run({ path: '包/x.zip' }))).toMatchObject({ kind: 'zip', files: 1, entries: [{ name: 'a.txt', size: 1 }] });
    expect(JSON.parse(await tool.run({ path: '包/x.zip', action: 'extract' }))).toMatchObject({ extracted: 1, folder: '包/x' });
  });
});

describe('通读全文', () => {
  const doc = Array.from({ length: 30 }, (_, i) => `第${i + 1}章 条款${i + 1}\n` + `本章约定第${i + 1}项内容，金额${(i + 1) * 1000}元。`.repeat(60)).join('\n');
  it('按章节边界切段，每段不超过上限，首尾相接覆盖全文', () => {
    const sections = [...doc.matchAll(/第\d+章/g)].map(m => ({ start: m.index, title: m[0] }));
    const segs = splitForDigest(doc, sections, 12000);
    expect(segs[0].start).toBe(0); expect(segs.at(-1).end).toBe(doc.length);
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end);
    for (const s of segs) expect(s.end - s.start).toBeLessThanOrEqual(12000);
    expect(segs.slice(1).every(s => /^第\d+章/.test(doc.slice(s.start, s.start + 6)))).toBe(true);
  });
  it('逐段做笔记、汇总存进工作区；失败段如实标出；同一文件同一关注点再次通读直接复用', async () => {
    await ws.write('资料/长文档.txt', doc);
    let calls = 0;
    const llm = vi.fn(async ({ prompt }) => { calls++; if (/第2\/\d+段/.test(prompt)) throw new Error('超时'); return '要点：' + /第(\d+)章/.exec(prompt.split('\n\n')[1] || '')?.[0]; });
    const readText = async p => ({ text: await ws.readText(p), hash: 'h1' });
    const r = await digestDocument({ path: '资料/长文档.txt', focus: '金额', llm, readText });
    expect(r.notesPath).toBe('资料/长文档.通读笔记.md');
    expect(r.failed).toEqual([2]);
    expect(r.done).toBe(r.segments - 1);
    const notes = await ws.readText(r.notesPath);
    expect(notes).toContain(`已读${r.done}段，第2段失败`);
    expect(notes).toContain('这一段没读成');
    expect(llm.mock.calls[0][0].system).toContain('金额');
    // 有失败段：不复用，重读；全部成功后再读直接复用
    const ok = vi.fn(async () => '要点');
    const again = await digestDocument({ path: '资料/长文档.txt', focus: '金额', llm: ok, readText });
    expect(again.reused).toBe(false);
    const third = await digestDocument({ path: '资料/长文档.txt', focus: '金额', llm: ok, readText });
    expect(third).toMatchObject({ reused: true, done: third.segments });
    expect(ok).toHaveBeenCalledTimes(again.segments);
    void calls;
  });
  it('没有辅助模型时如实说明', async () => {
    await expect(digestDocument({ path: 'x.txt', llm: null, readText: async () => ({ text: 'a', hash: 'h' }) })).rejects.toThrow(/辅助模型/);
  });
  it('digest_document 工具走真实文件读取', async () => {
    await ws.write('资料/短.txt', '第一章 总则\n保证金5万元。');
    const tool = createTools({ llm: async () => '保证金5万元' }).find(t => t.name === 'digest_document');
    const r = JSON.parse(await tool.run({ path: '资料/短.txt' }));
    expect(r).toMatchObject({ segments: 1, done: 1, coverage: '1/1' });
    expect(await ws.readText(r.notesPath)).toContain('保证金5万元');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { prepareShareCache } from '../src/mobile/shareCache.js';
import { createNativeSharer } from '../src/mobile/saveNative.js';

const Directory = { Cache: 'CACHE' }, now = 100 * 86400000;
const folder = (i, mtime = now - 2 * 86400000) => ({ name: `share_case_${i}`, type: 'directory', mtime });
const setup = entries => ({ readdir: vi.fn(async () => ({ files: entries })), rmdir: vi.fn(async () => {}) });

describe('分享缓存有界且不打断近期文件读取', () => {
  it('只清超过24小时旧目录，每次最多16，保留最新8及当前返回指针', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => folder(i, now - (i + 2) * 86400000));
    const fs = setup([...entries, { name: '旧版.docx', type: 'file', mtime: 1 }, { name: 'other_plugin', type: 'directory', mtime: 1 }]);
    expect(await prepareShareCache(fs, Directory, { now, protectedIds: ['share_case_39'] })).toEqual({ count: 24, removed: 16 });
    const paths = fs.rmdir.mock.calls.map(([value]) => value.path);
    expect(paths).not.toContain('share/share_case_39');
    for (let i = 0; i < 8; i++) expect(paths).not.toContain(`share/share_case_${i}`);
    expect(paths.every(value => /^share\/share_case_\d+$/.test(value))).toBe(true);
  });
  it('64份都在保留期则拒绝新增，不强删近期或时间未知目录', async () => {
    const fs = setup(Array.from({ length: 64 }, (_, i) => folder(i, i % 2 ? now - 1000 : undefined)));
    for (const entry of (await fs.readdir()).files) if (Number(entry.name.split('_').at(-1)) % 2 === 0) delete entry.mtime;
    await expect(prepareShareCache(fs, Directory, { now })).rejects.toThrow(/空间已满/);
    expect(fs.rmdir).not.toHaveBeenCalled();
  });
  it('删除失败仍计入上限，不假装已腾出空间', async () => {
    const fs = setup(Array.from({ length: 64 }, (_, i) => folder(i)));
    fs.rmdir.mockRejectedValue(new Error('读取中'));
    await expect(prepareShareCache(fs, Directory, { now })).rejects.toThrow(/空间已满/);
    expect(fs.rmdir).toHaveBeenCalledTimes(16);
  });
  it('首次目录不存在允许创建，其他读取失败及错误格式明确停止', async () => {
    for (const code of ['ENOENT', 'OS-PLUG-FILE-0008']) {
      const fs = setup([]); fs.readdir.mockRejectedValue({ code });
      expect(await prepareShareCache(fs, Directory, { now })).toEqual({ count: 0, removed: 0 });
    }
    const failed = setup([]); failed.readdir.mockRejectedValue({ code: 'EACCES' });
    await expect(prepareShareCache(failed, Directory)).rejects.toThrow(/无法检查/);
    await expect(prepareShareCache(setup(null), Directory)).rejects.toThrow(/无法安全核对/);
    await expect(prepareShareCache(setup(Array.from({ length: 1025 }, (_, i) => folder(i))), Directory)).rejects.toThrow(/无法安全核对/);
  });
  it('路径伪装和旧版文件不是本功能目录，不能删除', async () => {
    const fs = setup([{ name: 'share_../../data', type: 'directory', mtime: 1 }, { name: 'share_document', type: 'file', mtime: 1 }]);
    expect(await prepareShareCache(fs, Directory, { now })).toEqual({ count: 0, removed: 0 });
    expect(fs.rmdir).not.toHaveBeenCalled();
  });
  it('生产启用管理时，检查失败不写新图或启动选择器，后续成功可重试', async () => {
    const fs = { ...setup([]), writeFile: vi.fn(async () => ({ uri: 'file:///cache/a.png' })) }, Share = { share: vi.fn(async () => {}) };
    fs.readdir.mockRejectedValueOnce({ code: 'EACCES' });
    const share = createNativeSharer({ Filesystem: fs, Directory, Share, manageShareCache: true });
    await expect(share(new Blob(['pixels']), 'a.png')).rejects.toThrow(/无法检查/);
    expect(fs.writeFile).not.toHaveBeenCalled(); expect(Share.share).not.toHaveBeenCalled();
    await expect(share(new Blob(['pixels']), 'a.png')).resolves.toContain('已请求打开');
    expect(Share.share).toHaveBeenCalledTimes(1);
  });
});

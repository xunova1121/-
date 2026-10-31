import { describe, it, expect } from 'vitest';
import { createNativeSaver, createNativeSharer, blobToBase64, BACK_TIP } from '../src/mobile/saveNative.js';

const Directory = { Cache: 'CACHE', Documents: 'DOCUMENTS' };
const blob = new Blob(['hello']);

describe('手机下载文件（以前点下载自动弹分享面板，选了微信、WPS 就跳过去回不来）', () => {
  it('下载：只存到“文档/Jarvis”，不弹分享面板、不跳去别的应用', async () => {
    const writes = []; const shared = []; const toasts = [];
    const Filesystem = { writeFile: async (o) => { writes.push([o.directory, o.path, o.data]); return { uri: `file:///${o.path}` }; } };
    const Share = { share: async (o) => { shared.push(o.files[0]); } };
    const msg = await createNativeSaver({ Filesystem, Directory, Share, toast: (t) => toasts.push(t) })(blob, '周报.docx');
    expect(writes.map((w) => w.slice(0, 2))).toEqual([['DOCUMENTS', 'Jarvis/周报.docx']]);
    expect(writes[0][2]).toBe(btoa('hello'));
    expect(shared).toEqual([]);
    expect(msg).toContain('文档/Jarvis/周报.docx');
    expect(msg).toContain('分享');
    expect(toasts[0]).toContain('正在保存');
  });
  it('存不进“文档”（没权限）：才用分享面板兜底，并说明怎么回到未央', async () => {
    const shared = [];
    const Filesystem = { writeFile: async (o) => { if (o.directory === 'DOCUMENTS') throw new Error('没有权限'); return { uri: 'file:///share/a.docx' }; } };
    const msg = await createNativeSaver({ Filesystem, Directory, Share: { share: async (o) => { shared.push(o.files[0]); } } })(blob, 'a.docx');
    expect(shared).toEqual(['file:///share/a.docx']);
    expect(msg).toContain(BACK_TIP);
  });
  it('原生插件没响应：超时后也给出说明，不会一直没反应', async () => {
    const Filesystem = { writeFile: (o) => (o.directory === 'DOCUMENTS' ? new Promise(() => {}) : Promise.resolve({ uri: 'file:///x' })) };
    const Share = { share: () => new Promise(() => {}) };
    const msg = await createNativeSaver({ Filesystem, Directory, Share, timeoutMs: 20 })(blob, 'a.docx');
    expect(msg).toContain('分享面板');
  });
  it('都失败：报错说明原因', async () => {
    const Filesystem = { writeFile: async () => { throw new Error('磁盘已满'); } };
    await expect(createNativeSaver({ Filesystem, Directory, Share: { share: async () => {} } })(blob, 'a')).rejects.toThrow('磁盘已满');
  });
  it('点“分享”才弹分享面板；失败（不是用户取消）时提示', async () => {
    const toasts = []; const shared = [];
    const Filesystem = { writeFile: async () => ({ uri: 'file:///x' }) };
    const msg = await createNativeSharer({ Filesystem, Directory, Share: { share: async (o) => { shared.push(o.files[0]); } } })(blob, 'a');
    expect(shared).toEqual(['file:///x']);
    expect(msg).toContain(BACK_TIP);
    await createNativeSharer({ Filesystem, Directory, Share: { share: async () => { throw new Error('No activity found'); } }, toast: (t) => toasts.push(t) })(blob, 'a');
    await new Promise((r) => setTimeout(r, 0));
    expect(toasts.some((t) => t.includes('No activity found'))).toBe(true);
  });
  it('大文件 Base64 正确', async () => {
    const big = new Uint8Array(100000).map((_, i) => i % 256);
    expect(await blobToBase64(new Blob([big]))).toBe(Buffer.from(big).toString('base64'));
  });
});

import { topColor } from '../src/mobile/topColor.js';
describe('状态栏底色跟随界面', () => {
  it('取背景渐变的第一个颜色', () => {
    expect(topColor({ backgroundImage: 'linear-gradient(140deg, rgb(35, 40, 57), rgb(45, 48, 70) 38%)', backgroundColor: 'rgba(0, 0, 0, 0)' })).toBe('#232839');
    expect(topColor({ backgroundImage: 'linear-gradient(rgb(221, 225, 251), rgb(229, 227, 251) 55%)' })).toBe('#DDE1FB');
  });
  it('没有渐变用背景色；透明时用默认', () => {
    expect(topColor({ backgroundImage: 'none', backgroundColor: 'rgb(10, 20, 30)' })).toBe('#0A141E');
    expect(topColor({ backgroundImage: 'none', backgroundColor: 'rgba(0, 0, 0, 0)' })).toBe('#DDE1FB');
  });
});

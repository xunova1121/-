import { describe, it, expect } from 'vitest';
import { createNativeSaver, blobToBase64 } from '../src/mobile/saveNative.js';

const Directory = { Cache: 'CACHE', Documents: 'DOCUMENTS' };
const blob = new Blob(['hello']);

describe('手机下载文件', () => {
  it('写缓存 → 弹分享面板，并存一份到“文档/Jarvis”', async () => {
    const writes = []; const shared = []; const toasts = [];
    const Filesystem = { writeFile: async (o) => { writes.push([o.directory, o.path, o.data]); return { uri: `file:///${o.path}` }; } };
    const Share = { share: async (o) => { shared.push(o.files[0]); } };
    const msg = await createNativeSaver({ Filesystem, Directory, Share, toast: (t) => toasts.push(t) })(blob, '周报.docx');
    expect(writes.map((w) => w.slice(0, 2))).toEqual([['CACHE', 'share/周报.docx'], ['DOCUMENTS', 'Jarvis/周报.docx']]);
    expect(writes[0][2]).toBe(btoa('hello'));
    expect(shared).toEqual(['file:///share/周报.docx']);
    expect(msg).toContain('文档/Jarvis/周报.docx');
    expect(toasts[0]).toContain('正在准备');
  });
  it('原生插件没响应：超时后也给出说明，不会一直没反应', async () => {
    const Filesystem = { writeFile: (o) => (o.directory === 'DOCUMENTS' ? new Promise(() => {}) : Promise.resolve({ uri: 'file:///x' })) };
    const Share = { share: () => new Promise(() => {}) };
    const msg = await createNativeSaver({ Filesystem, Directory, Share, timeoutMs: 20 })(blob, 'a.docx');
    expect(msg).toContain('在弹出的面板里');
  });
  it('都失败：报错说明原因', async () => {
    const Filesystem = { writeFile: async () => { throw new Error('磁盘已满'); } };
    await expect(createNativeSaver({ Filesystem, Directory, Share: { share: async () => {} } })(blob, 'a')).rejects.toThrow('磁盘已满');
  });
  it('分享失败（不是用户取消）时提示', async () => {
    const toasts = [];
    const Filesystem = { writeFile: async () => ({ uri: 'file:///x' }) };
    await createNativeSaver({ Filesystem, Directory, Share: { share: async () => { throw new Error('No activity found'); } }, toast: (t) => toasts.push(t) })(blob, 'a');
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

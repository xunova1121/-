import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import catalog from '../src/assets/ppt-sources/catalog.json';
import { importPptSource } from '../src/app/pptSourceImport.js';

describe('可编辑开源版式样板', () => {
  for (const t of catalog) it(`${t.id} 文件、许可、真实预览与原生元素齐全`, async () => {
    const base = new URL('../src/assets/ppt-sources/', import.meta.url);
    const bytes = await fs.readFile(new URL(t.filename, base));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(t.sha256);
    expect(bytes.length).toBe(t.bytes);
    if (t.license === 'MIT') expect(t.source).toContain('f3633771fe699d327f02ae86393831bbcf5169f7');
    else expect(t.source).toContain('不含原文件内容');
    const zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p));
    expect(slides).toHaveLength(t.pages);
    for (let n = 1; n <= t.pages; n++) {
      const xml = await zip.file(`ppt/slides/slide${n}.xml`).async('string');
      expect((xml.match(/<a:t>/g) || []).length).toBeGreaterThan(6);
      expect(xml).toContain('<p:sp>');
      expect(xml).not.toContain('<p:pic>');
      const note = await zip.file(`ppt/notesSlides/notesSlide${n}.xml`).async('string');
      if (t.license === 'MIT') expect(note).toContain('MIT License');
      else {
        expect(note).toContain('公司标识');
        expect(xml).toContain('【');
        expect(xml).not.toMatch(/中国移动|中科感知|江苏|水域违规|九天|≥ 95%/);
      }
      const jpg = await fs.readFile(new URL(`${t.id}-${n}.jpg`, base));
      expect(jpg.subarray(0, 2)).toEqual(Buffer.from([255, 216]));
      expect(jpg.length).toBeGreaterThan(20000);
    }
    expect(Object.keys(zip.files).some(p => /vbaProject|embeddings\//.test(p))).toBe(false);
    for (const p of Object.keys(zip.files).filter(p => p.endsWith('.rels'))) expect(await zip.file(p).async('string')).not.toContain('TargetMode="External"');
  });
});

function setup(server = null) {
  let account = 'user-a';
  const app = { session: { agentId: 'ppt-maker', messages: [], agentForm: { template: 'gov-annual', pages: '10' } }, server };
  const workspace = { write: vi.fn(async path => ({ path: path.replace('.pptx', ' (2).pptx') })) };
  const fill = vi.fn();
  const args = { app, workspace, fill, template: catalog[0], url: 'data:template', scope: () => account, fetchFile: vi.fn(async () => new Response(new Blob(['PPTX']))), uuid: () => 'unique-test' };
  return { args, app, workspace, fill, changeAccount: () => { account = 'user-b'; } };
}
describe('样板导入不发送、不串会话、不回退其他账号', () => {
  it('导入保留已写的主题和要求', async () => {
    const s = setup(); s.args.readDraft = () => '请做园区季度汇报，重点说明节能。';
    await importPptSource(s.args);
    expect(s.fill).toHaveBeenCalledWith(expect.stringContaining('修改要求：请做园区季度汇报，重点说明节能。'));
  });
  it('导入期间继续写字，不覆盖新输入', async () => {
    const s = setup(); let draft = '原主题'; s.args.readDraft = () => draft;
    s.args.fetchFile = async () => { draft = '用户刚补充的新要求'; return new Response('ppt'); };
    await expect(importPptSource(s.args)).rejects.toThrow('已保留你的草稿');
    expect(s.workspace.write).not.toHaveBeenCalled(); expect(s.fill).not.toHaveBeenCalled();
  });
  it('使用实际另存路径填草稿，保留其他表单', async () => {
    const { args, fill, app } = setup();
    const out = await importPptSource(args);
    expect(out.path).toContain(' (2).pptx');
    expect(fill).toHaveBeenCalledWith(expect.stringContaining(out.path));
    expect(app.session.agentForm).toEqual({ template: '', pages: '10' });
    expect(app.session.messages).toEqual([]);
  });
  it('云端写失败不写本机、不填草稿、不清理已有选择', async () => {
    const server = { upload: vi.fn(async () => { throw new Error('上传失败'); }) };
    const { args, workspace, fill, app } = setup(server);
    await expect(importPptSource(args)).rejects.toThrow('上传失败');
    expect(workspace.write).not.toHaveBeenCalled(); expect(fill).not.toHaveBeenCalled();
    expect(app.session.agentForm.template).toBe('gov-annual');
  });
  it('云端成功使用本人的客户端且不写本机', async () => {
    const server = { upload: vi.fn(async () => {}) };
    const { args, workspace, fill } = setup(server);
    await importPptSource(args);
    expect(server.upload).toHaveBeenCalledOnce(); expect(workspace.write).not.toHaveBeenCalled(); expect(fill).toHaveBeenCalledOnce();
  });
  for (const kind of ['session', 'account', 'server']) it(`${kind} 在读样板时切换，不写入`, async () => {
    const s = setup();
    s.args.fetchFile = async () => { if (kind === 'session') s.app.session = { agentId: 'ppt-maker' }; else if (kind === 'account') s.changeAccount(); else s.app.server = {}; return new Response('ppt'); };
    await expect(importPptSource(s.args)).rejects.toThrow('已切换');
    expect(s.workspace.write).not.toHaveBeenCalled(); expect(s.fill).not.toHaveBeenCalled();
  });
  it('上传中切换对话，完成后不污染新草稿', async () => {
    const s = setup({ upload: vi.fn(async () => { s.app.session = { agentId: 'ppt-maker', messages: [] }; }) });
    await expect(importPptSource(s.args)).rejects.toThrow('已切换'); expect(s.fill).not.toHaveBeenCalled();
  });
  it('有消息的对话与非 PPT 智能体均拒绝导入', async () => {
    const s = setup(); s.app.session.messages.push({ role: 'user', content: '已有消息' });
    await expect(importPptSource(s.args)).rejects.toThrow('新对话');
    s.app.session = { agentId: 'health-advisor', messages: [] };
    await expect(importPptSource(s.args)).rejects.toThrow('新对话');
    expect(s.args.fetchFile).not.toHaveBeenCalled();
  });
  it('资源读取失败或空文件不写入', async () => {
    const s = setup(); s.args.fetchFile = async () => new Response('', { status: 404 });
    await expect(importPptSource(s.args)).rejects.toThrow('读取失败');
    s.args.fetchFile = async () => new Response('');
    await expect(importPptSource(s.args)).rejects.toThrow('文件为空');
    expect(s.workspace.write).not.toHaveBeenCalled();
  });
});

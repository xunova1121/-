import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generate } from '../src/agent/docs.js';
import { restyleDocx } from '../src/agent/docxRestyle.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { formattingSource } from '../src/agent/documentPreservation.js';
import { createTools } from '../src/agent/tools.js';
import * as ws from '../src/agent/workspace.js';
import * as sessions from '../src/agent/sessions.js';
import { useBackend } from '../src/agent/store.js';
import { createFileStore } from '../server/fileStore.mjs';

const BODY = '# 合成原稿\n\n## 范围\n\n正文金额1234.56元，不得漏项。\n\n| 项目 | 数量 |\n|---|---|\n| 传感器 | 17 |\n| 网关 | 3 |\n\n![合成图片](tiny.png)';
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const sourceDoc = () => generate('docx', { content: BODY, theme: 'business', loadImage: async () => PNG });
const profileDoc = () => generate('docx', { content: '# 样式\n\n样式。', theme: 'gongwen' });

describe('上传Word只换样式，原文件结构保持', () => {
  let folder;
  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-file-format-'));
    useBackend(createFileStore(folder));
  });
  afterEach(() => {
    useBackend(null);
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('真实Word中正文、表格、图片及所有非样式部件逐字节保持，样式确实更新', async () => {
    const original = (await sourceDoc()).blob;
    const result = await restyleDocx(original, (await profileDoc()).blob);
    expect(result.preservation.state).toBe('passed');
    expect(result.changed).toBeGreaterThan(0);
    const before = await openOfficePackage(original);
    const after = await openOfficePackage(result.blob);
    expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort());
    expect(Object.keys(before.files).some((key) => key.startsWith('word/media/'))).toBe(true);
    expect(await before.file('word/document.xml').async('string')).toContain('<w:tbl>');
    for (const key of Object.keys(before.files).filter((key) => !before.files[key].dir && key !== 'word/styles.xml')) {
      expect(await after.file(key).async('uint8array')).toEqual(await before.file(key).async('uint8array'));
    }
    const styles = await after.file('word/styles.xml').async('string');
    expect(styles).not.toBe(await before.file('word/styles.xml').async('string'));
    expect(styles).toContain('仿宋');
  });

  it('中文Word常见的数字标题样式编号保留，不丢自定义样式', async () => {
    const original = await openOfficePackage((await sourceDoc()).blob);
    const body = (await original.file('word/document.xml').async('string')).replace(/w:val="Heading1"/g, 'w:val="1"');
    original.file('word/document.xml', body);
    original.file(
      'word/styles.xml',
      (await original.file('word/styles.xml').async('string'))
        .replace('w:styleId="Heading1"', 'w:styleId="1"')
        .replace('</w:styles>', '<w:style w:type="paragraph" w:styleId="CustomA"><w:name w:val="自定义正文"/><w:basedOn w:val="Normal"/></w:style></w:styles>')
    );
    const blob = new Blob([await original.generateAsync({ type: 'uint8array' })]);
    const result = await restyleDocx(blob, (await profileDoc()).blob);
    const after = await openOfficePackage(result.blob);
    expect(await after.file('word/document.xml').async('string')).toBe(body);
    expect(await after.file('word/styles.xml').async('string')).toContain('w:styleId="1"');
    expect(await after.file('word/styles.xml').async('string')).toContain('w:styleId="CustomA"');
  });

  it('实际工具自动绑定最新上传原件，忽略模型旧稿；原件不变、不调用改写模型', async () => {
    const original = (await sourceDoc()).blob;
    await ws.write('上传/原稿.docx', original);
    const request = '按照我的偏好重新做一版\n\n[已上传到工作区：上传/原稿.docx]';
    const session = sessions.create({ messages: [{ role: 'user', content: request }] });
    await sessions.save(session);
    const llm = vi.fn(() => {
      throw new Error('不得改写');
    });
    const tool = createTools({ reasonLlm: llm }).find((item) => item.name === 'create_document');
    const result = await tool.run(
      { format: 'docx', path: '新版.docx', theme: 'gongwen', content: '# 旧稿\n\n旧摘要' },
      { sessionId: session.id, rawRequestText: request }
    );
    expect(result).toContain('非样式部件逐字节保持');
    expect(llm).not.toHaveBeenCalled();
    expect(new Uint8Array(await (await ws.readBlob('上传/原稿.docx')).arrayBuffer())).toEqual(new Uint8Array(await original.arrayBuffer()));
    const report = JSON.parse(await ws.readText('文档检查/新版-docx.json'));
    expect(report.contentPreservation).toMatchObject({ state: 'passed', sourceId: 'file:上传/原稿.docx', sourceSessionId: session.id });
    expect(report.contentPreservation.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.errors).toBe(0);
  });

  it('最新上传/正文不被旧路径覆盖，附件编号不当正文，路径前缀不误认', async () => {
    await ws.write('旧稿.docx', (await sourceDoc()).blob);
    const session = sessions.create({
      messages: [
        { role: 'user', content: '[已上传到工作区：旧稿.docx]' },
        { role: 'user', content: '[已上传到工作区：新版.docx]', requirementId: 'r2' }
      ]
    });
    await sessions.save(session);
    await expect(formattingSource({ request: '只排版', sessionId: session.id, sourcePath: '旧稿.docx' })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
    await expect(formattingSource({ request: '只排版', sessionId: session.id, sourceId: 'r2' })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
    await expect(formattingSource({ request: '只排版 旧稿.docx.bak', sourcePath: '旧稿.docx' })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
    session.messages.push({ role: 'user', content: '# 新正文\n\n不得回用旧文件。' });
    await sessions.save(session);
    const selected = await formattingSource({ request: '只排版', sessionId: session.id, sourcePath: '旧稿.docx' });
    expect(selected.content).toContain('新正文');
    expect(selected.kind).not.toBe('docx');
  });

  it('允许据真实生成回执重排最近Word，不信助手正文；停止信号不吞', async () => {
    await ws.write('生成.docx', (await sourceDoc()).blob);
    const session = sessions.create({
      messages: [
        { role: 'user', content: '制作一份Word' },
        { role: 'assistant', content: '这里口头提了旧稿.docx', files: ['生成.docx'] }
      ]
    });
    await sessions.save(session);
    expect((await formattingSource({ request: '只排版', sessionId: session.id, sourcePath: '生成.docx' })).kind).toBe('docx');
    await expect(formattingSource({ request: '只排版', sessionId: session.id, sourcePath: '旧稿.docx' })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(restyleDocx(new Blob(), new Blob(), { signal: ctrl.signal })).rejects.toHaveProperty('name', 'AbortError');
  });

  it('同名输出另存排版副本；原件更新后再次读取，不复用旧内容或摘要', async () => {
    const original = (await sourceDoc()).blob;
    await ws.write('原稿.docx', original);
    const tool = createTools({}).find((item) => item.name === 'create_document');
    const args = { format: 'docx', path: './原稿.docx', content: '', source_path: '原稿.docx', theme: 'gongwen' };
    const execution = { rawRequestText: '只排版 "原稿.docx"' };
    expect(await tool.run(args, execution)).toContain('原稿_排版.docx');
    expect(new Uint8Array(await (await ws.readBlob('原稿.docx')).arrayBuffer())).toEqual(new Uint8Array(await original.arrayBuffer()));
    const old = JSON.parse(await ws.readText('文档检查/原稿_排版-docx.json')).contentPreservation.sourceDigest;
    const changed = await generate('docx', { content: BODY.replace('1234.56', '9999.88'), loadImage: async () => PNG });
    await ws.write('原稿.docx', changed.blob);
    await tool.run(args, execution);
    const updated = JSON.parse(await ws.readText('文档检查/原稿_排版-docx.json')).contentPreservation.sourceDigest;
    expect(updated).not.toBe(old);
    const out = await openOfficePackage(await ws.readBlob('原稿_排版.docx'));
    expect(await out.file('word/document.xml').async('string')).toContain('9999.88');
  });

  it('样式命名空间冲突和附件上限不静默降级，混合正文优先使用新正文', async () => {
    const original = (await sourceDoc()).blob;
    const profile = await openOfficePackage((await profileDoc()).blob);
    profile.file(
      'word/styles.xml',
      (await profile.file('word/styles.xml').async('string')).replace(
        'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
        'xmlns:w="urn:conflicting-test-namespace"'
      )
    );
    await expect(restyleDocx(original, new Blob([await profile.generateAsync({ type: 'uint8array' })]))).rejects.toHaveProperty('code', 'DOCUMENT_STYLES');
    const metadata = Array.from({ length: 33 }, (_, index) => `[已上传到工作区：文件${index}.docx]`).join('\n');
    await expect(formattingSource({ request: '只排版\n' + metadata })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
    const selected = await formattingSource({ request: '只排版\n# 新正文\n\n以新正文为准。\n[已上传到工作区：旧稿.docx]', sourcePath: '旧稿.docx' });
    expect(selected.kind).not.toBe('docx');
    expect(selected.content).toContain('新正文');
    await expect(formattingSource({ request: '需要重写正文', sourcePath: '旧稿.docx' })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
    expect(await formattingSource({ request: '需要重写正文' })).toBeNull();
    const tool = createTools({}).find((item) => item.name === 'create_document');
    await expect(tool.run({ format: 'pdf', path: '不应生成.pdf', source_path: '旧稿.docx', content: '' }, { rawRequestText: '只排版' })).rejects.toHaveProperty(
      'code',
      'DOCUMENT_SOURCE'
    );
    expect(await ws.exists('不应生成.pdf')).toBe(false);
  });

  it('排除的旧原件不会被附件索引重新放行，最后一次明确更正优先', async () => {
    await ws.write('旧稿.docx', (await sourceDoc()).blob);
    await ws.write('新版.docx', (await sourceDoc()).blob);
    const session = sessions.create({ messages: [{ role: 'user', content: '[已上传到工作区：旧稿.docx]' }] });
    await sessions.save(session);
    await expect(formattingSource({ request: '只排版，不要用 "旧稿.docx"', sessionId: session.id, sourcePath: '旧稿.docx' })).rejects.toHaveProperty(
      'code',
      'DOCUMENT_SOURCE'
    );
    expect((await formattingSource({ request: '只排版，不要用 "旧稿.docx"，改为使用 "旧稿.docx"', sessionId: session.id, sourcePath: '旧稿.docx' })).kind).toBe(
      'docx'
    );
    expect((await formattingSource({ request: '只排版，不是 "旧稿.docx" 而是 "新版.docx"', sessionId: session.id, sourcePath: '新版.docx' })).path).toBe(
      '新版.docx'
    );
  });
});

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';
import * as ws from '../src/agent/workspace.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import { createTools } from '../src/agent/tools.js';
import { formattingOnly, formattingSource, verifyFormattingContent } from '../src/agent/documentPreservation.js';
import { generate } from '../src/agent/docs.js';

const ORIGINAL =
  '# 测试方案\n\n## 交付\n\n保留本段全部文字，不可换成旧稿。\n\n| 物料 | 数量 |\n|---|---|\n| 传感器 | 17 |\n| 网关 | 3 |\n\n## 结算\n\n总额为1234.56元，验收后付款。';

describe('只排版正文保真（虚构原文，不调用真实模型）', () => {
  let folder;
  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-preserve-'));
    useBackend(createFileStore(folder));
  });
  afterEach(() => {
    useBackend(null);
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('只匹配明确内容不变要求，不将普通写作当成排版', () => {
    expect(formattingOnly('只做版式调整，内容不变')).toBe(true);
    expect(formattingOnly('只调整排版')).toBe(true);
    expect(formattingOnly('写一份方案，改进格式')).toBe(false);
    expect(formattingOnly('不要只排版，需要重写')).toBe(false);
    expect(formattingOnly('只让你做个版式调整，不需要改写')).toBe(true);
  });

  it('本轮已落盘原话可用原编号；正文标题前的业务文字不得丢失', async () => {
    const request = '只排版\n' + ORIGINAL;
    const session = sessions.create({ messages: [{ role: 'user', content: request, requirementId: 'r1' }] });
    await sessions.save(session);
    expect((await formattingSource({ request, sessionId: session.id, sourceId: 'r1' })).content).toBe(ORIGINAL);
    session.messages.push({ role: 'user', content: '业务前言必须保留。\n' + ORIGINAL, requirementId: 'r2' });
    await sessions.save(session);
    expect((await formattingSource({ request: '只排版', sessionId: session.id, sourceId: 'r2' })).content).toContain('业务前言必须保留。');
  });

  it('模型误传旧稿时，实际Word沿用最新用户正文，且不调用改写审稿', async () => {
    const session = sessions.create({
      messages: [
        { role: 'user', content: '# 旧方案\n\n旧稿只有摘要。' },
        { role: 'assistant', content: '# 错误助手稿\n\n缺少表格。' },
        { role: 'user', content: ORIGINAL },
        { role: 'user', content: '只调整排版，正文不变' }
      ]
    });
    await sessions.save(session);
    const llm = vi.fn(() => {
      throw new Error('不应改写');
    });
    const tool = createDocumentGenerateTool({ reasonLlm: llm });
    const result = await tool.run(
      { format: 'docx', path: '测试/新版.docx', content: '# 旧方案\n\n旧稿只有摘要。' },
      {
        sessionId: session.id,
        rawRequestText: '只调整排版，正文不变'
      }
    );
    expect(llm).not.toHaveBeenCalled();
    expect(result).toContain('逐段逐格核对真实Word');
    const blob = await ws.readBlob('测试/新版.docx');
    expect((await verifyFormattingContent(blob, ORIGINAL)).state).toBe('passed');
    const report = JSON.parse(await ws.readText('测试/文档检查/新版-docx.json'));
    expect(report.contentPreservation.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report.contentPreservation)).not.toContain('1234.56');
  });

  it('压缩后仍可按原话编号读取，使用任务会话而不是界面会话', async () => {
    const session = sessions.create({ messages: [{ role: 'user', content: '只排版' }] });
    session.requirements = { version: 1, entries: [{ id: 'r8', text: ORIGINAL }] };
    await sessions.save(session);
    const source = await formattingSource({ request: '只排版', sessionId: session.id, sourceId: 'r8' });
    expect(source.content).toBe(ORIGINAL);
    await expect(formattingSource({ request: '只排版', sessionId: '不存在', sourceId: 'r8' })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
  });

  it('无法绑定原文时不写目标，也不覆盖已有文件', async () => {
    await ws.write('保留.docx', new Blob(['existing']));
    const tool = createDocumentGenerateTool({});
    await expect(tool.run({ format: 'docx', path: '保留.docx', content: ORIGINAL }, { rawRequestText: '只排版' })).rejects.toHaveProperty(
      'code',
      'DOCUMENT_SOURCE'
    );
    expect(await (await ws.readBlob('保留.docx')).text()).toBe('existing');
  });

  it('不接受模型指定较旧原文，也不跨过最新无边界正文选旧稿', async () => {
    const session = sessions.create({
      messages: [
        { role: 'user', content: '# 旧方案\n\n不应回用。', requirementId: 'r1' },
        { role: 'user', content: ORIGINAL, requirementId: 'r2' }
      ]
    });
    await sessions.save(session);
    await expect(formattingSource({ request: '只排版', sessionId: session.id, sourceId: 'r1' })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
    session.messages.push({ role: 'user', content: '这是最新正文。'.repeat(30) });
    await sessions.save(session);
    await expect(formattingSource({ request: '只排版', sessionId: session.id })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
    expect((await formattingSource({ request: '只排版，原文用r1', sessionId: session.id, sourceId: 'r1' })).id).toBe('r1');
    await expect(formattingSource({ request: '只排版，原文用r10', sessionId: session.id, sourceId: 'r1' })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
    session.messages.push({ role: 'user', content: '只排版', requirementId: 'r10' });
    await sessions.save(session);
    await expect(formattingSource({ request: '只排版，原文用r10', sessionId: session.id, sourceId: 'r10' })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
  });

  it('实际Word缺表格、改金额或换顺序都会拒绝，格式标记不导致误报', async () => {
    for (const content of [
      ORIGINAL.replace('| 网关 | 3 |\n', ''),
      ORIGINAL.replace('1234.56', '1234.57'),
      ORIGINAL.replace('总额为1234.56元，验收后付款。', ''),
      ORIGINAL.replace('总额为1234.56元，验收后付款。', '').replace('## 交付', '总额为1234.56元，验收后付款。\n\n## 交付')
    ]) {
      const out = await generate('docx', { content });
      await expect(verifyFormattingContent(out.blob, ORIGINAL)).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
    }
    const out = await generate('docx', { content: ORIGINAL.replace('保留本段全部文字', '**保留本段全部文字**') });
    expect((await verifyFormattingContent(out.blob, ORIGINAL)).state).toBe('passed');
  });

  it('其他Word起草入口不能绕过只排版保真', async () => {
    const llm = vi.fn();
    const tools = createTools({ llm, reasonLlm: llm });
    for (const name of ['write_long_document', 'write_professional_document']) {
      await expect(tools.find((tool) => tool.name === name).run({ path: '正文.docx' }, { rawRequestText: '只排版，内容不变' })).rejects.toHaveProperty(
        'code',
        'DOCUMENT_SOURCE'
      );
    }
    expect(llm).not.toHaveBeenCalled();
  });

  it('停止信号及原文上限不能被吞掉或截断', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(formattingSource({ request: '只排版', signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
    await expect(formattingSource({ request: '只排版\n# 标题\n' + '文'.repeat(120001) })).rejects.toHaveProperty('code', 'DOCUMENT_SOURCE');
  });
});

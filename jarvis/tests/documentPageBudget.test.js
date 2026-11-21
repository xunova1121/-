import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestedSlides, slideBudget } from '../src/agent/documentPageBudget.js';
import { singleDocumentTask } from '../src/agent/documentExecutionPolicy.js';
import { generate } from '../src/agent/docs.js';
import { inspectDocument } from '../src/agent/documentQuality.js';
import { createTools } from '../src/agent/tools.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
const body = (n) => '# 介绍\n\n' + Array.from({ length: n }, (_, i) => `## 场景${i + 1}\n\n要点${i + 1}需要完整保留。`).join('\n\n');
describe('总页数属于真实交付约束', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-page-budget-')); useBackend(createFileStore(dir)); });
  afterEach(() => { useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });
  it('提取明确总页数，范围不猜，正文另加封面计入总数', () => {
    expect(requestedSlides('做五页PPT')).toBe(5);
    expect(requestedSlides('PPT 5页，改成6页')).toBe(6);
    expect(requestedSlides('PPT正文5页另加封面')).toBe(6);
    expect(requestedSlides('PPT 5至8页')).toBeNull();
    expect(requestedSlides('Word 5页')).toBeNull();
    expect(requestedSlides('修改PPT第5页')).toBeNull();
    expect(() => slideBudget(4, 5, false, true)).toThrow(/不自动删内容/);
    expect(() => slideBudget(7, 5)).toThrow(/不自动删内容/);
    expect(() => slideBudget(5, 5, true)).toThrow(/封面也计入/);
  });
  it('五段正文生成真实五页，不悄悄附加封面；四段可配一页封面', async () => {
    for (const count of [4, 5]) {
      const out = await generate('pptx', { title: '介绍', content: body(count), expectedSlides: 5 });
      const actual = await inspectDocument(out.blob, '介绍.pptx', { info: out.info });
      expect(actual.slides).toBe(5);
      expect(out.info.slides).toBe(5);
      expect(out.info.layouts.includes('cover')).toBe(count === 4);
    }
  });
  it('不指定页数保留自动封面，自动提纲也必须计入实际页数', async () => {
    const out = await generate('pptx', { title: '介绍', content: '# 介绍\n\n## 第一部分 现状\n\n现状\n\n## 第二部分 目标\n\n目标' });
    const actual = await inspectDocument(out.blob, '介绍.pptx', { info: out.info });
    expect(out.info.slides).toBe(actual.slides);
    expect(out.info.layouts).toContain('cover');
  });
  it('使用本轮原始要求，模型不能用自己的页数覆盖用户要求', async () => {
    const tool = createTools({}).find((item) => item.name === 'create_document');
    await tool.run({ format: 'pptx', path: '介绍.pptx', content: body(5), requirements: '六页PPT' }, { requestText: '做五页PPT' });
    const actual = await inspectDocument(await ws.readBlob('介绍.pptx'), '介绍.pptx');
    expect(actual.slides).toBe(5);
  });
  it('单份长方案不套第二层计划，明确先计划和多文件任务保留', () => {
    expect(singleDocumentTask('生成一份Word建设方案，详细说明交易流程和异常处理。')).toBe(true);
    expect(singleDocumentTask('先列大纲，再生成一份Word方案')).toBe(false);
    expect(singleDocumentTask('分别生成Word和PPT')).toBe(false);
  });
});

// 有效PDF走真实解析器，故意返回不同页数，不能把“转换成功”当作分页通过。
function samplePdf(count) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${count} >>`, ...Array.from({ length: count }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] >>')];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([out], { type: 'application/pdf' });
}
it('PDF预览页数不匹配必须记录错误，不能声称无需修改', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-page-pdf-'));
  useBackend(createFileStore(dir));
  try {
    const tool = createTools({ officeRender: async () => ({ available: true, blob: samplePdf(6) }) }).find((item) => item.name === 'create_document');
    const receipts = [];
    const result = await tool.run({ format: 'pptx', path: '预览.pptx', content: body(5), requirements: '做5页PPT' }, { checkpoint: (event) => receipts.push(event) });
    expect(result).toContain('页数不一致');
    expect(result).not.toContain('不需要再 read_file');
    expect(receipts.at(-1).validation).toMatchObject({ slides: 5, expectedSlides: 5, pages: 6, pdfPageMatch: 'failed', errors: 1 });
    expect(await ws.exists('预览.pptx')).toBe(true);
  } finally {
    useBackend(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

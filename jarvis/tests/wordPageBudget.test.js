import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestedWordPages, checkWordPages } from '../src/agent/wordPageBudget.js';
import { createTools } from '../src/agent/tools.js';
import { useBackend } from '../src/agent/store.js';
import { createFileStore } from '../server/fileStore.mjs';
import * as ws from '../src/agent/workspace.js';

function pdf(count) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${i + 3} 0 R`).join(' ')}] /Count ${count} >>`,
    ...Array.from({ length: count }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] >>')
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([text], { type: 'application/pdf' });
}

describe('Word页数必须来自真实PDF，不能删正文凑数', () => {
  let folder;
  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'word-pages-'));
    useBackend(createFileStore(folder));
  });
  afterEach(() => {
    useBackend(null);
    fs.rmSync(folder, { recursive: true, force: true });
  });
  it('识别明确页数和范围，不把页码引用、近似要求、PPT或正文当Word总页数', () => {
    expect(requestedWordPages('Word总共3页')).toEqual({ min: 3, max: 3 });
    expect(requestedWordPages('Word不超过五页')).toEqual({ min: 1, max: 5 });
    expect(requestedWordPages('Word控制在3页以内')).toEqual({ min: 1, max: 3 });
    expect(requestedWordPages('Word至少2页')).toEqual({ min: 2, max: null });
    expect(requestedWordPages('Word三至五页')).toEqual({ min: 3, max: 5 });
    expect(requestedWordPages('Word3页，改成4页')).toEqual({ min: 4, max: 4 });
    for (const text of [
      'Word约3页',
      'Word3页左右',
      '修改Word第3页',
      '参考PPT5页',
      'Word和PPT各3页',
      'Word\n# 正文\n3页',
      'Word5至3页',
      'Word0至3页',
      'Word正文3页另加1页封面'
    ])
      expect(requestedWordPages(text)).toBeNull();
    expect(checkWordPages({ min: 2, max: 4 }, 3).state).toBe('passed');
    expect(checkWordPages({ min: 2, max: 4 }, 1).state).toBe('failed');
    expect(checkWordPages({ min: 2, max: 4 }).state).toBe('not_checked');
  });
  it('实际有效PDF超过目标：记录失败、保留Word，重复调用不能复用成功缓存', async () => {
    let renders = 0;
    const tool = createTools({
      officeRender: async () => {
        renders++;
        return { available: true, blob: pdf(3) };
      }
    }).find((t) => t.name === 'create_document');
    const args = { format: 'docx', path: '验收.docx', content: '# 合成方案\n\n必须保留的原文1234.56元。', requirements: 'Word总共2页' };
    const result = await tool.run(args);
    expect(result).toContain('Word实际3页，要求2页');
    expect(result).not.toContain('不需要再 read_file');
    const report = JSON.parse(await ws.readText('文档检查/验收-docx.json'));
    expect(report.wordPageBudget).toMatchObject({ min: 2, max: 2, actual: 3, state: 'failed' });
    expect(report.errors).toBeGreaterThan(0);
    expect(await ws.exists('验收.docx')).toBe(true);
    await tool.run(args);
    expect(renders).toBe(2);
  });
  it('无法渲染时单独记录未检查，不宣称分页通过且不缓存成功', async () => {
    const tool = createTools({}).find((t) => t.name === 'create_document');
    const result = await tool.run({ format: 'docx', path: '未渲染.docx', content: '# 合成方案\n\n正文。', requirements: 'Word3页' });
    expect(result).toContain('分页未校验');
    expect(result).not.toContain('不需要再 read_file');
    const report = JSON.parse(await ws.readText('文档检查/未渲染-docx.json'));
    expect(report.wordPageBudget).toMatchObject({ actual: null, state: 'not_checked' });
    expect(report.render).toBe('not_checked');
  });
  it('实际PDF页数在范围内才通过，用户原要求优先模型填入的页数', async () => {
    const tool = createTools({ officeRender: async () => ({ available: true, blob: pdf(3) }) }).find((t) => t.name === 'create_document');
    await tool.run({ format: 'docx', path: '通过.docx', content: '# 合成方案\n\n正文。', requirements: 'Word100页' }, { rawRequestText: 'Word2至4页' });
    const report = JSON.parse(await ws.readText('文档检查/通过-docx.json'));
    expect(report.wordPageBudget).toMatchObject({ min: 2, max: 4, actual: 3, state: 'passed' });
    const edit = createTools({ officeRender: async () => ({ available: true, blob: pdf(3) }) }).find((t) => t.name === 'edit_office_document');
    const result = await edit.run(
      { path: '通过.docx', replacements: [{ find: '正文。', replace: '编辑后的完整正文。' }] },
      { rawRequestText: '修改这份Word，Word最多2页' }
    );
    expect(result).toContain('Word实际3页');
    const edited = JSON.parse(await ws.readText('文档检查/通过-docx.json'));
    expect(edited.wordPageBudget.state).toBe('failed');
  });
});

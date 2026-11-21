import { beforeEach, afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typographyFromText, documentTypography, normalizeTypography } from '../src/agent/documentTypography.js';
import { generate } from '../src/agent/docs.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { applyDocxTypography, directTypographyConflicts } from '../src/agent/docxTypography.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import { createDocumentStyles } from '../src/agent/documentStyles.js';
import { requestedWordPages } from '../src/agent/wordPageBudget.js';
import { useBackend } from '../src/agent/store.js';
import { createFileStore } from '../server/fileStore.mjs';
import * as ws from '../src/agent/workspace.js';
let folder;
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'word-type-')); useBackend(createFileStore(folder)); });
afterEach(() => { useBackend(null); fs.rmSync(folder, { recursive: true, force: true }); });

it('中文字号、标题层级、行段距分别落到角色，正文内容与PPT偏好不参与', () => {
  expect(typographyFromText('Word正文宋体小四，1.5倍行距；一级标题黑体三号；主标题微软雅黑二号\n# 正文\n正文用楷体六号')).toMatchObject({ body: { font: '宋体', size: 12, line: { rule: 'auto', value: 1.5 } }, heading1: { font: '黑体', size: 16 }, title: { font: '微软雅黑', size: 22 } });
  expect(typographyFromText('PPT正文黑体三号')).toEqual({});
  expect(typographyFromText('Word正文宋体小四，固定行距28磅，段前6磅，段后0磅').body).toMatchObject({ size: 12, line: { rule: 'exact', value: 28 }, before: 6, after: 0 });
  expect(() => normalizeTypography({ body: { size: 2 } })).toThrow();
});
it('最新Word偏好覆盖all，当前要求再次覆盖，移除偏好后不复用旧值', async () => {
  let history = '- all · 正文黑体四号\n- docx · 正文宋体小四\n- pptx · 正文楷体三号';
  const ctx = { documentStylePreferences: async () => history };
  expect((await documentTypography(ctx, '')).body).toMatchObject({ font: '宋体', size: 12 });
  expect((await documentTypography(ctx, '正文微软雅黑五号')).body).toMatchObject({ font: '微软雅黑', size: 10.5 });
  history = '';
  expect(await documentTypography(ctx, '')).toEqual({});
});
it('独立偏好条目不继承上一条标题角色；确定是Word时接受省略Word字样的页数要求', async () => {
  const ctx = { documentStylePreferences: async () => '- docx · 用宋体\n- docx · 一级标题黑体三号' };
  expect((await documentTypography(ctx, '')).body.font).toBe('宋体');
  expect(requestedWordPages('做成3页')).toBeNull();
  expect(requestedWordPages('做成3页', { wordContext: true })).toEqual({ min: 3, max: 3 });
  expect(requestedWordPages('PPT做成3页', { wordContext: true })).toBeNull();
  const negative = await documentTypography({ documentStylePreferences: async () => '- docx · 正文不要宋体\n- docx · 正文宋体小四' }, '');
  expect(negative.body.font).toBeUndefined();
  expect(negative.body.excludedFonts).toContain('宋体');
});
it('长期偏好实际保留字号与行距，不只留下最后一个字体名', async () => {
  const values = new Map();
  const styles = createDocumentStyles({ store: { get: async id => values.get(id), put: async item => values.set(item.id, item), all: async () => [...values.values()], delete: async id => values.delete(id) } });
  await styles.learn(['以后Word正文宋体小四，一级标题黑体三号，正文1.5倍行距']);
  const parsed = await documentTypography({ documentStylePreferences: styles.context }, '');
  expect(parsed.body).toMatchObject({ font: '宋体', size: 12, line: { value: 1.5 } });
  expect(parsed.heading1).toMatchObject({ font: '黑体', size: 16 });
});
it('实际生成器写入字体字号/标题，封面直接字号亦服从当前要求', async () => {
  const out = await generate('docx', { title: '合成字体测试', content: '# 合成字体测试\n\n## 第一节\n\n正文金额1234.56元。', cover: true, typography: { body: { font: 'Noto Sans CJK SC', size: 14 }, title: { font: 'Noto Sans CJK SC', size: 24 }, heading1: { font: '黑体', size: 18 } } });
  const zip = await openOfficePackage(out.blob);
  const styles = await zip.file('word/styles.xml').async('string');
  const text = await zip.file('word/document.xml').async('string');
  expect(styles).toContain('w:val="28"');
  expect(styles).toContain('Noto Sans CJK SC');
  expect(text).toContain('w:val="48"');
  expect(await directTypographyConflicts(out.blob, out.info.typographyProfile)).toEqual([]);
});
it('仅改样式仍保持其他部件，直接格式冲突须报告，不悄悄声称生效', async () => {
  const out = await generate('docx', { title: '原件', content: '# 原件\n\n金额1234.56元。' });
  const zip = await openOfficePackage(out.blob);
  zip.file('word/document.xml', (await zip.file('word/document.xml').async('string')).replace('<w:r><w:t xml:space="preserve">金额', '<w:r><w:rPr><w:sz w:val="40"/></w:rPr><w:t xml:space="preserve">金额'));
  const source = new Blob([await zip.generateAsync({ type: 'uint8array' })]);
  const patched = await applyDocxTypography(source, { body: { size: 12 } });
  const after = await openOfficePackage(patched.blob);
  for (const file of Object.keys(zip.files).filter(name => !zip.files[name].dir && name !== 'word/styles.xml'))
    expect(await after.file(file).async('uint8array')).toEqual(await zip.file(file).async('uint8array'));
  expect(await directTypographyConflicts(patched.blob, { body: { size: 12 } })).toEqual([expect.objectContaining({ level: 'error' })]);
});
it('真实工具读取偏好且缓存随字体改变失效，当前字号不被模型改掉', async () => {
  let history = '- docx · 正文宋体小四';
  const tool = createDocumentGenerateTool({ documentStylePreferences: async () => history });
  const args = { format: 'docx', path: '字体.docx', content: '# 合成\n\n正文金额1234.56元。', requirements: 'Word正文五号' };
  await tool.run(args);
  let xml = await (await openOfficePackage(await ws.readBlob('字体.docx'))).file('word/styles.xml').async('string');
  expect(xml).toContain('宋体'); expect(xml).toContain('w:val="21"');
  history = '- docx · 正文楷体小四';
  const result = await tool.run(args);
  expect(result).not.toContain('没有重新生成');
  xml = await (await openOfficePackage(await ws.readBlob('字体.docx'))).file('word/styles.xml').async('string');
  expect(xml).toContain('楷体');
});

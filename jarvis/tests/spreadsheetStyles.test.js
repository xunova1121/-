import { beforeEach, afterEach, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeXlsx } from '../src/agent/xlsxWriter.js';
import { THEMES } from '../src/agent/themes.js';
import { SHEET_STYLE_IDS, spreadsheetDesign } from '../src/agent/spreadsheetDesign.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import { createProfessionalDocumentTools } from '../src/agent/professionalDocumentTools.js';
import { createDocumentStyles } from '../src/agent/documentStyles.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
const material = '## 合成预算\n| 类别 | 预算 | 实际 | 差异 | 执行率 |\n|--|--|--|--|--|\n| 软件 | 100 | 120 | =C2-B2 | |\n| 设备 | 200 | 150 | =C3-B3 | |\n| 合计 | | | | |';
const open = async blob => { const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(await blob.arrayBuffer())); return book.worksheets[0]; };
let folder;
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-style-')); useBackend(createFileStore(folder)); });
afterEach(() => { useBackend(null); fs.rmSync(folder, { recursive: true, force: true }); });

it('四种真实工作簿样式不同，单元格值/公式/地址、筛选冻结和打印范围相同', async () => {
  const snapshots = [], looks = [];
  for (const sheetStyle of SHEET_STYLE_IDS) {
    const out = await makeXlsx(material, { theme: THEMES.business, kind: 'budget', sheetStyle });
    const sheet = await open(out.blob);
    const cells = [];
    sheet.eachRow(row => row.eachCell((cell, col) => cells.push([cell.address, cell.value])));
    snapshots.push(JSON.stringify({ cells, filter: sheet.autoFilter, print: sheet.pageSetup.printArea, freeze: [sheet.views[0].xSplit, sheet.views[0].ySplit] }));
    looks.push(JSON.stringify({ head: sheet.getCell('A1').style, body: sheet.getRow(2).height, total: sheet.getCell('A4').style }));
    expect(out.info.sheetStyle).toBe(sheetStyle);
    expect(sheet.getCell('D4').value).toMatchObject({ formula: 'SUM(D2:D3)', result: -30 });
    expect(sheet.getCell('E2').fill.fgColor.argb).toBe('FFF1F3F6');
    expect(sheet.getCell('B2').font.color.argb).toBe('FF1F4E9A');
    const zip = await openOfficePackage(out.blob);
    expect(await zip.file('xl/worksheets/sheet1.xml').async('string')).toContain('<autoFilter ref="A1:E4"');
  }
  expect(new Set(snapshots).size).toBe(1); expect(new Set(looks).size).toBe(4);
});
it('当前要求与Excel专用偏好覆盖通用要求，不使用PPT/Word偏好，排除与停止有效', async () => {
  const ctx = { documentStylePreferences: async () => '- all · 商务风\n- xlsx · 紧凑台账\n- pptx · 极简\n- docx · 数据风' };
  expect((await spreadsheetDesign(ctx, '', { kind: 'budget' })).style).toBe('ledger');
  expect((await spreadsheetDesign(ctx, '不要台账风、商务风，用极简', { sheetStyle: 'ledger' })).style).toBe('minimal');
  await expect(spreadsheetDesign({}, '不要商务风、极简、台账风、数据风', {})).rejects.toMatchObject({ code: 'DOCUMENT_DESIGN' });
  const controller = new AbortController(); controller.abort();
  await expect(spreadsheetDesign(ctx, '', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
it('真实生成工具随Excel偏好变化重建缓存；公文冲突不能假称请求已应用', async () => {
  let preference = '- xlsx · 极简';
  const tool = createDocumentGenerateTool({ documentStylePreferences: async () => preference });
  const args = { format: 'xlsx', path: '预算.xlsx', content: material, theme: 'business', requirements: '制作预算Excel' };
  expect(await tool.run(args)).toContain('表格样式：简洁留白');
  preference = '- xlsx · 数据风';
  const again = await tool.run(args);
  expect(again).toContain('表格样式：分析报表'); expect(again).not.toContain('没有重新生成');
  const conflict = await tool.run({ ...args, theme: 'gongwen', sheet_style: 'minimal' });
  expect(conflict).toContain('未按请求风格生成');
  const report = JSON.parse(await ws.readText('文档检查/预算-xlsx.json'));
  expect(report.design).toEqual({ requested: 'minimal', effective: 'business', state: 'conflict' }); expect(report.errors).toBeGreaterThan(0);
});
it('长期Excel样式可保存与删除，专业文档恢复保留样式且不重写正文', async () => {
  const values = new Map();
  const prefs = createDocumentStyles({ store: { all: async () => [...values.values()], get: async id => values.get(id), put: async item => values.set(item.id, item), delete: async id => values.delete(id) } });
  await prefs.learn(['以后Excel用极简风']);
  expect(values.has('docstyle_xlsx_spreadsheet')).toBe(true);
  const ctx = { documentStylePreferences: prefs.context };
  expect((await spreadsheetDesign(ctx, '', { kind: 'ledger' })).style).toBe('minimal');
  await prefs.remove('docstyle_xlsx_spreadsheet');
  expect((await spreadsheetDesign(ctx, '', { kind: 'ledger' })).style).toBe('ledger');
  let calls = 0;
  const tool = createProfessionalDocumentTools({ llm: async () => { calls++; return material; } }).find(t => t.name === 'write_professional_document');
  await tool.run({ task: '做预算Excel', format: 'xlsx', style: 'story', sheet_style: 'minimal', path: '专业.xlsx', depth: 'simple', research: false }, { sessionId: 'sheet-style' });
  const report = JSON.parse(await ws.readText('文档检查/专业-xlsx.json'));
  const stateFile = report.contentReview.workflowFile;
  expect(JSON.parse(await ws.readText(stateFile)).input.sheetStyle).toBe('minimal');
  expect(JSON.parse(await ws.readText(stateFile)).input.style).toBeUndefined();
  const restored = await tool.run({ state_file: stateFile, path: '恢复.xlsx' }, { sessionId: 'sheet-style' });
  expect(restored).toContain('表格样式：简洁留白'); expect(calls).toBe(1);
});

/** 同一虚构预算，四种真实Excel/PDF；行列/公式不动，Office实际读回与预览。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import { SHEET_STYLE_IDS } from '../src/agent/spreadsheetDesign.js';
import * as ws from '../src/agent/workspace.js';
import { parseFile, loadPdfjs } from '../src/agent/docs.js';
import { inspectWorkbook } from '../src/agent/documentQuality.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { renderOffice, officeRenderAvailable } from '../server/officeRender.mjs';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-spreadsheet-style-acceptance');
await fs.mkdir(output, { recursive: true });
const storage = await fs.mkdtemp('/tmp/weiyang-sheet-style-store-');
useBackend(createFileStore(storage));
const content = `## 协作试点预算
虚构演示材料，金额单位：元

### 投入与执行

| 项目 | 预算 | 实际 | 差异 | 执行率 |
|---|---:|---:|---:|---:|
| 平台配置 | 10000 | 9000 | =C6-B6 | |
| 流程联调 | 8000 | 6000 | =C7-B7 | |
| 试点培训 | 12000 | 15000 | =C8-B8 | |
| 合计 | | | | |

说明：全部为合成数据。先核对试点范围，再确认支出；保留超预算提醒。`;
let baseline;
const summary = [];
try {
  assert.ok(await officeRenderAvailable(), '需要真实Office，不跳过');
  const tool = createDocumentGenerateTool({ officeRender: renderOffice });
  for (const style of SHEET_STYLE_IDS) {
    const name = `${style}.xlsx`;
    const receipt = await tool.run({ format: 'xlsx', path: name, content, sheet_style: style, kind: 'budget', theme: 'business', requirements: '按全部虚构材料制作Excel，保留公式和数据，不要改动单元格地址' });
    const report = JSON.parse(await ws.readText(`文档检查/${style}-xlsx.json`));
    assert.equal(report.errors, 0, JSON.stringify(report)); assert.equal(report.design.effective, style); assert.equal(report.pages, 1);
    const blob = await ws.readBlob(name), pdf = await ws.readBlob(report.previewPath);
    await fs.writeFile(path.join(output, name), new Uint8Array(await blob.arrayBuffer()));
    await fs.writeFile(path.join(output, `${style}.pdf`), new Uint8Array(await pdf.arrayBuffer()));
    await fs.writeFile(path.join(output, `${style}-receipt.json`), JSON.stringify({ receipt, report }, null, 2));
    const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(await blob.arrayBuffer()));
    const zip = await openOfficePackage(blob);
    assert.ok((await zip.file('xl/worksheets/sheet1.xml').async('string')).includes('<autoFilter ref="A5:E9"'), '筛选必须覆盖数据行，而非只有表头');
    const sheet = book.worksheets[0], cells = [];
    sheet.eachRow(row => row.eachCell(cell => cells.push([cell.address, cell.value])));
    const snapshot = JSON.stringify({ cells, filter: sheet.autoFilter, freeze: [sheet.views[0].xSplit, sheet.views[0].ySplit], print: sheet.pageSetup });
    if (baseline) assert.equal(snapshot, baseline, '换样式不能改行列、数值、公式、筛选、冻结或打印范围');
    baseline = snapshot;
    // ExcelJS读回时省略0缓存；用生产校验器读真实XML数值，不能把undefined当0。
    const verified = (await inspectWorkbook(blob)).sheets[0].cells;
    assert.equal(verified.get('B9').result, 30000); assert.equal(verified.get('C9').result, 30000); assert.equal(verified.get('D9').result, 0);
    assert.equal(verified.get('E9').result, 1);
    const text = (await parseFile(pdf, name + '.pdf', { limit: Infinity })).text.replace(/[,，\s]/g, '');
    for (const term of ['协作试点预算', '平台配置', '流程联调', '试点培训', '30000', '15000', '合成数据']) assert.ok(text.includes(term), style + '真实PDF缺' + term);
    const pdfjs = await loadPdfjs();
    const rendered = await pdfjs.getDocument({ data: new Uint8Array(await pdf.arrayBuffer()), isEvalSupported: false }).promise;
    try {
      const page = await rendered.getPage(1), terms = await page.getTextContent();
      const lastColumn = terms.items.find(item => item.str.includes('执行率'));
      assert.ok(lastColumn && lastColumn.transform[4] > page.view[2] * 0.6, '真实报表不能挤在打印页面左半边');
    } finally { await rendered.destroy(); }
    await promisify(execFile)('pdftoppm', ['-scale-to', '1000', '-png', '-singlefile', `${style}.pdf`, style], { cwd: output, timeout: 30000 });
    summary.push({ style, pages: report.pages, design: report.design, formulaTotals: [30000, 30000, 0, 1], modelCalls: 0 });
    console.log(JSON.stringify(summary.at(-1)));
  }
  await fs.writeFile(path.join(output, '验收.json'), JSON.stringify({ summary, facts: '全部虚构', boundary: '真实Excel公式读回/Office PDF/数据地址保持，不等于真实模型或用户Excel/WPS验收' }, null, 2));
} finally { useBackend(null); await fs.rm(storage, { recursive: true, force: true }); }

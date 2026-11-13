/** 同一份虚构材料，四种真实可编辑PPT及Office PDF；不调用模型，不冒充业务或真机验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { parseFile } from '../src/agent/docs.js';
import { STYLE_IDS, STYLE_NAMES } from '../src/agent/pptStyles.js';
import * as ws from '../src/agent/workspace.js';
import { renderOffice, officeRenderAvailable } from '../server/officeRender.mjs';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-ppt-style-acceptance');
await fs.mkdir(output, { recursive: true });
const storage = await fs.mkdtemp('/tmp/weiyang-ppt-style-store-');
useBackend(createFileStore(storage));
const content = `## 把零散工作变成清晰协作

每件事有人接、有人办，也能找到处理记录。

## 三项能力，连接协作中的断点

- 统一受理：把分散事项收进同一张清单
- 明确分工：每项任务确认负责人和交付物
- 留痕复核：让办理过程和结果可以追溯

## 形成从受理到归档的闭环

受理 → 分派 → 办理 → 复核 → 归档

## 虚构样本呈现逐季增长

| 季度 | 办理量 |
|---|---:|
| 第一季度 | 120 |
| 第二季度 | 150 |
| 第三季度 | 190 |
| 第四季度 | 240 |

说明：四个季度均为合成演示数据，不对应真实单位。

## 四周试点，逐步验证协作效果

- 第1周：梳理事项，确认试点范围
- 第2周：配置表单，安排负责人
- 第3周：小范围使用，收集实际问题
- 第4周：核对结果，决定后续推广`;
const mandatory = ['把零散工作变成清晰协作', '三项能力', '受理', '分派', '办理', '复核', '归档', '第一季度', '第四季度', '四周试点'];
const summary = [];
try {
  assert.ok(await officeRenderAvailable(), '缺真实Office不能跳过验收');
  const tool = createDocumentGenerateTool({ officeRender: renderOffice });
  for (const style of STYLE_IDS) {
    const file = `${style}.pptx`;
    const receipt = await tool.run({ format: 'pptx', path: file, title: '让协作更清楚', content, style, theme: 'business', requirements: '同一份材料制作5页PPT，不要封面，不加结尾页，保留全部要点与合成数据' });
    assert.ok(receipt.includes(`设计：${STYLE_NAMES[style]}`));
    const report = JSON.parse(await ws.readText(`文档检查/${style}-pptx.json`));
    assert.equal(report.errors, 0, JSON.stringify(report));
    assert.equal(report.slides, 5); assert.equal(report.pages, 5); assert.equal(report.pdfPageMatch, 'passed');
    const ppt = await ws.readBlob(file), pdf = await ws.readBlob(report.previewPath);
    await fs.writeFile(path.join(output, file), new Uint8Array(await ppt.arrayBuffer()));
    await fs.writeFile(path.join(output, `${style}.pdf`), new Uint8Array(await pdf.arrayBuffer()));
    await fs.writeFile(path.join(output, `${style}-receipt.json`), JSON.stringify({ receipt, report }, null, 2));
    const zip = await openOfficePackage(ppt);
    const presentation = await zip.file('ppt/presentation.xml').async('string');
    const dimensions = presentation.match(/<p:sldSz\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
    assert.ok(dimensions);
    const xml = await Promise.all(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name => zip.file(name).async('string')));
    assert.equal(xml.length, 5);
    for (const page of xml) {
      assert.ok(page.includes('<a:t>'), '每页必须有原生可编辑文本');
      // 渲染器的装饰图标是图片；只拒绝整页截图，正文和图表仍必须原生。
      for (const pic of page.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)) {
        const size = pic[0].match(/<a:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
        assert.ok(!size || Number(size[1]) < Number(dimensions[1]) * 0.8 || Number(size[2]) < Number(dimensions[2]) * 0.8, '不能用整页截图冒充原生PPT');
      }
    }
    const charts = await Promise.all(Object.keys(zip.files).filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name)).map(name => zip.file(name).async('string')));
    assert.ok(charts.length > 0, '数据页必须含原生图表');
    for (const value of [120, 150, 190, 240]) assert.ok(charts.join('').includes(`>${value}<`), '原生图表数据不变');
    const text = (await parseFile(pdf, file + '.pdf', { limit: Infinity })).text.replace(/\s/g, '');
    for (const term of mandatory) assert.ok(text.includes(term), `${style}真实PDF缺少${term}`);
    await promisify(execFile)('pdftoppm', ['-scale-to', '1000', '-png', `${style}.pdf`, style], { cwd: output, timeout: 30000 });
    summary.push({ style, name: STYLE_NAMES[style], nativeSlides: xml.length, pdfPages: report.pages, nativeCharts: charts.length, modelCalls: 0 });
    console.log(JSON.stringify(summary.at(-1)));
  }
  await fs.writeFile(path.join(output, '验收.json'), JSON.stringify({ summary, data: '全部虚构', boundary: '结构/文本/真实Office检查；画面需人工比较，不等于真实模型内容或用户真机验收' }, null, 2));
} finally { useBackend(null); await fs.rm(storage, { recursive: true, force: true }); }

/** 政企汇报风格：真实工具生成 + LibreOffice 转 PDF；查页数、原生渐变、无排版错误、提纲与结论句上屏。不调用模型，不冒充真实业务或真机验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import { createDocumentGenerateTool } from '../src/agent/documentGenerateTool.js';
import * as ws from '../src/agent/workspace.js';
import { renderOffice, officeRenderAvailable } from '../server/officeRender.mjs';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-ppt-report');
await fs.mkdir(output, { recursive: true });
useBackend(createFileStore(await fs.mkdtemp('/tmp/weiyang-ppt-report-store-')));
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAFCAIAAAD38zoCAAAAFklEQVR4nGNkYPjPwMDAxMDAwMDAAAA0BwIB8p4pqwAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
await ws.write('img/a.png', new Blob([PNG], { type: 'image/png' }));
const content = `## 一、项目核心痛点

结论：园区系统分散，**看不全、管不住**

- 1200公顷：园区规划面积
- 386家：入驻企业
- 18套：独立业务系统

## 一、项目核心痛点：四大难题

- 看不全：监控盲区多｜重点区域覆盖率不足60%
- 管不住：事件发现晚｜违规问题平均2小时后才被发现
- 调不动：协同效率低｜三支队伍各自派单
- 算不清：能耗底数不明｜月度统计需要3天

## 二、解决方案：1.智能感知

结论：前端设施部署完成，实现**全域覆盖**

![运营驾驶舱：园区一张图](img/a.png)

- 视频感知：新增摄像头420路｜覆盖率提升到98%
- 物联感知：部署传感器2300个
- 能耗感知：接入表计1150块

## 二、解决方案：2.统一调度

### 一屏统管
- 实时感知：异常自动告警
- 精准匹配：自动匹配最近处置人员

### 一键调度
- 一键派发：工单自动推送
- 一键跟踪：实时查看处置进度

## 感谢聆听

以数字化运营赋能园区高质量发展`;
const summary = [];
try {
  assert.ok(await officeRenderAvailable(), '缺真实Office不能跳过验收');
  const tool = createDocumentGenerateTool({ officeRender: renderOffice });
  for (const [file, extra] of [['report.pptx', {}], ['report-print.pptx', { print_friendly: true }]]) {
    const receipt = await tool.run({ format: 'pptx', path: file, title: '智慧园区项目汇报', content, author: '示例科技有限公司', requirements: '按政企汇报风格制作PPT', ...extra });
    assert.ok(receipt.includes('设计：政企汇报'), receipt.slice(0, 300));
    const report = JSON.parse(await ws.readText(`文档检查/${file.replace('.pptx', '')}-pptx.json`));
    assert.equal(report.errors, 0, JSON.stringify(report.issues));
    assert.equal(report.pdfPageMatch, 'passed');
    assert.equal(report.slides, 7, '封面、提纲、指标、四宫格、左图右文、面板、结尾');
    const ppt = await ws.readBlob(file), pdf = await ws.readBlob(report.previewPath);
    await fs.writeFile(path.join(output, file), new Uint8Array(await ppt.arrayBuffer()));
    await fs.writeFile(path.join(output, file.replace('.pptx', '.pdf')), new Uint8Array(await pdf.arrayBuffer()));
    const zip = await JSZip.loadAsync(await ppt.arrayBuffer());
    const xml = (await Promise.all(Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).map(n => zip.file(n).async('string')))).join('');
    const gradients = (xml.match(/<a:gradFill/g) || []).length;
    if (extra.print_friendly) assert.ok(gradients <= 3, '打印友好：封面、结尾不用整页渐变（只剩指标块的浅色渐变）');
    else assert.ok(gradients >= 5, '封面、结尾整页渐变和指标块渐变');
    assert.ok(xml.includes('园区系统分散'), '结论句上屏');
    assert.ok(xml.includes('项目核心痛点') && xml.includes('汇报提纲'), '提纲页');
    summary.push({ file, slides: report.slides, pdfPages: report.pages, gradients, warnings: report.issues.filter(i => i.level === 'warn').length });
  }
  for (const row of summary) console.log(JSON.stringify(row));
  console.log(`政企汇报 ${summary.length}/2 通过；固定样例，不代表真实模型或用户服务器已验收`);
} catch (error) {
  console.error(error);
  process.exit(1);
}

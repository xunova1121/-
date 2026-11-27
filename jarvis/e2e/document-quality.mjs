/** 真实文件/真实LibreOffice验收；使用明确标注的合成资料，不借用用户私有文档。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../src/agent/tools.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { renderOffice, officeRenderAvailable } from '../server/officeRender.mjs';
import { inspectWorkbook } from '../src/agent/documentQuality.js';
import { openOfficePackage, orderedSlidePaths } from '../src/agent/officePackage.js';

const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'jarvis-document-quality'));
await fs.mkdir(output, { recursive: true });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-doc-quality-'));
if (!(await officeRenderAvailable())) throw new Error('本验收必须安装LibreOffice，不允许跳过');
useBackend(createFileStore(directory));
const tools = createTools({ officeRender: renderOffice });
const run = async (toolName, args) => {
  const tool = tools.find((item) => item.name === toolName);
  assert.ok(tool, toolName + '已接入实际工具组');
  return tool.run(args);
};
const cases = [
  {
    id: 'cold-chain-review',
    format: 'pptx',
    template_id: 'ppt-business',
    title: '冷链经营复盘｜合成测试资料',
    content:
      '## 本期收入达到目标的90%\n统计期间：2026年9月。所有数字为合成测试资料，不对应实际经营。\n\n## 目标与实际对比\n| 指标 | 目标 | 实际 |\n|--|--|--|\n| 收入（万元） | 100 | 90 |\n| 回款（万元） | 80 | 72 |\n\n## 差异来自两个已知环节\n版式：卡片\n- 客户交付：需核对交付延期记录。\n- 费用控制：需核对仓储计费口径。\n- 数据边界：本页原因是示例假设，不作真实结论。\n\n## 下一阶段按证据落实行动\n| 行动 | 责任人 | 期限 | 验收依据 |\n|--|--|--|--|\n| 核对交付 | 测试角色A | 2026-10-25 | 交付清单 |\n| 核对费用 | 测试角色B | 2026-10-26 | 费用明细 |'
  },
  {
    id: 'project-proposal',
    format: 'docx',
    template_id: 'word-proposal',
    title: '冷链数据治理项目建议书｜合成测试资料',
    content:
      '# 冷链数据治理项目建议书\n\n本文件全部内容为合成测试资料，用于验证生成、修改和真实分页，不代表实际项目。\n\n## 摘要与建议\n建议先用一个仓库开展数据口径试点，再按试点结果决定是否推广。\n\n## 现状与必要性\n示例材料中收入与回款统计分散，存在核对成本。该判断仅限本测试设定。\n\n## 建设目标与范围\n本期只整理试点仓库的数据口径、来源和核对流程，不包含采购新硬件。\n\n## 实施安排\n| 阶段 | 交付物 | 验收依据 |\n|--|--|--|\n| 资料梳理 | 来源目录 | 每项指标对应原始来源 |\n| 试点验证 | 核对记录 | 能追溯差异与修订 |\n\n## 投资与风险\n未提供真实预算，不编造投资金额。主要风险为口径变化，需保留版本记录。'
  },
  {
    id: 'task-assessment',
    format: 'xlsx',
    template_id: 'excel-assessment',
    title: '重点工作考核｜合成测试资料',
    content:
      '## 任务明细\n| 任务 | 权重 | 完成率 | 加权得分 | 依据 |\n|--|--|--|--|--|\n| 核对资料 | 60% | 100% | =B2*C2*100 | 合成测试资料 |\n| 汇总差异 | 40% | 50% | =B3*C3*100 | 合成测试资料 |\n| 合计 | =SUM(B2:B3) |  | =SUM(D2:D3) | 示例总分80 |\n\n## 考核说明\n| 项目 | 说明 |\n|--|--|\n| 用途 | 全部数字为合成测试数据 |\n| 得分口径 | 权重乘完成率乘100 |'
  }
];
try {
  for (const item of cases) {
    const result = await run('create_document', { ...item, path: `样例/${item.id}.${item.format}` });
    const reportPath = `样例/文档检查/${item.id}-${item.format}.json`;
    const report = JSON.parse(await (await ws.readBlob(reportPath)).text());
    assert.equal(report.structure, 'passed', item.id + '结构读回');
    assert.equal(report.readback, 'passed', item.id + '有效内容');
    assert.equal(report.render, 'converted_not_visual_reviewed', item.id + '真实转PDF');
    assert.equal(report.pdfCheck, 'pdf_pages_checked_not_visual_reviewed', item.id + '真实PDF逐页检查');
    assert.equal(report.errors, 0, item.id + JSON.stringify(report.issues));
    assert.equal(report.visual, 'not_checked', '不能冒充视觉模型审稿');
    assert.ok(result.includes('检查报告'));
    console.log('✓ ' + item.id + '：真实生成、读回、PDF逐页检查通过，' + report.pages + '页；视觉需人工核对');
  }
  const original = await ws.readBlob('样例/cold-chain-review.pptx');
  const before = await openOfficePackage(original);
  const pages = await orderedSlidePaths(before);
  await run('edit_office_document', {
    path: '样例/cold-chain-review.pptx',
    slides: [2],
    expected_count: 1,
    replacements: [{ find: '本期收入达到目标的90%', replace: '本期收入完成率为90%' }],
    save_as: '样例/局部修改.pptx'
  });
  const after = await openOfficePackage(await ws.readBlob('样例/局部修改.pptx'));
  for (const slidePath of pages.filter((_, index) => index !== 1))
    assert.equal(await after.file(slidePath).async('string'), await before.file(slidePath).async('string'), '未选页面原样保留');
  await run('edit_spreadsheet', {
    path: '样例/task-assessment.xlsx',
    save_as: '样例/考核修改.xlsx',
    edits: [{ sheet: '任务明细', cell: 'C3', expected: 0.5, value: 0.75 }]
  });
  const changed = await inspectWorkbook(await ws.readBlob('样例/考核修改.xlsx'));
  assert.equal(changed.book.Sheets['任务明细'].C3.v, 0.75);
  assert.equal(changed.book.Sheets['任务明细'].D3.f, 'B3*C3*100');
  // 重新渲染后，PDF中总分应由80变90，证明原有公式随输入真实重算。
  const { parseFile } = await import('../src/agent/docs.js');
  const pdf = await parseFile(await ws.readBlob('样例/考核修改.预览.pdf'), 'test.pdf');
  assert.match(pdf.text, /90/, 'LibreOffice实际重算后显示新分值');
  console.log('✓ PPT指定页保留其他页；Excel定点修改和Office实际重算通过');
  for (const file of await ws.list()) {
    const target = path.join(output, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, new Uint8Array(await (await ws.readBlob(file.path)).arrayBuffer()));
  }
  await fs.writeFile(
    path.join(output, 'README.txt'),
    '本目录全部文件为合成测试样例；静态检查、实际PDF转换和公式重算已执行，不代表用户真实资料正确或视觉模型审稿。\n'
  );
} finally {
  useBackend(null);
  await fs.rm(directory, { recursive: true, force: true });
}

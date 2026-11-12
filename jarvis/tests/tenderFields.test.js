import { it, expect } from 'vitest';
import fs from 'node:fs';
import { parseTenderFields } from '../src/agent/tenderFields.js';
const row = { title: '医院设备采购项目', url: 'https://www.ggzy.gov.cn/information/deal/html/a/test.html', type: 'unknown' };
it('真实2026-11-12官方聚合公告：压平表格仍区分预算和限价，编号截止不夹带后续段落', () => {
  const html = fs.readFileSync(new URL('./fixtures/business-ggzy-table-20261112.html', import.meta.url), 'utf8');
  expect(parseTenderFields(html, row, 0)).toMatchObject({ projectNumber: 'CGXM2026430422000078', budgetText: '1776000.00元', ceilingText: '1776000.00元',
    deadlineText: '2026年12月03日 10点00分（北京时间）', type: 'tender' });
});
it('结构化表格单包预算和最高限价各读各的，多包不把其中一个当总价', () => {
  const header = '<table><tr><td>标的</td><td>预算金额（万元）</td><td>最高限价（元）</td></tr>';
  const item = '<tr><td>采购服务</td><td>200</td><td>1,500,000.00</td></tr>';
  expect(parseTenderFields(header + item + '</table>', row, 0)).toMatchObject({ budgetText: '200万元', ceilingText: '1500000.00元' });
  expect(parseTenderFields(header + item + item + '</table>', row, 0).budgetText).toBeNull();
});
it('纯文本预算正常解析，压平表格缺列/多包不猜金额，截止不包含开标地点', () => {
  expect(parseTenderFields('项目编号：JS-2026-01 2、项目名称：采购\n预算金额：30.5万元\n投标截止时间：2026/11/30 09:00 2、开标地点：江苏', row, 0)).toMatchObject({ projectNumber: 'JS-2026-01', budgetText: '30.5万元', deadlineText: '2026/11/30 09:00' });
  const header = '预算金额（元） 最高限价（元） 标的名称 简要技术需求或服务要求 数量 ';
  expect(parseTenderFields(header + '设备 200.00 150.00 1 设备2 100.00 90.00 1 三、资格要求', row, 0).budgetText).toBeNull();
  expect(parseTenderFields('预算金额（元） 名称 200.00 其他100.00', row, 0).budgetText).toBeNull();
});

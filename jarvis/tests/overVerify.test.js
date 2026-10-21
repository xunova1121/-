/** Excel 重复行、文档任务过度核实：重新生成表格不留重复行；文件验过可用就交付，不反复读、不把“待查”当失败 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dedupeRows, makeXlsx, makeCsv } from '../src/agent/xlsxWriter.js';
import { lint } from '../src/agent/selfCheck.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';
import { THEMES } from '../src/agent/themes.js';

beforeAll(() => import('exceljs'), 60_000);

const TRIP = [
  ['序号', '时间', '安排', '门票'],
  ['1', '09:00-11:30', '游览西湖', '免费'],
  ['2', '12:00-13:00', '午餐', ''],
  ['3', '18:00-19:30', '晚餐', '待查'],
  ['4', '18:00-19:30', '晚餐', '待查']
];

describe('Excel 去掉重复行', () => {
  it('最后两行完全一样（序号不同也算）：只留一行，序号重新连上', () => {
    const { rows, removed } = dedupeRows(TRIP.map((r) => [...r]));
    expect(removed).toBe(1);
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)).toEqual(['3', '18:00-19:30', '晚餐', '待查']);
  });
  it('同一时段一行备注空着：留填得更全的那行', () => {
    const { rows, removed } = dedupeRows([
      ['时间', '安排', '备注'],
      ['18:00-19:30', '晚餐', ''],
      ['18:00-19:30', '晚餐', '楼外楼，需预约']
    ]);
    expect(removed).toBe(1);
    expect(rows).toEqual([
      ['时间', '安排', '备注'],
      ['18:00-19:30', '晚餐', '楼外楼，需预约']
    ]);
  });
  it('同一时间不同内容、同一天多笔流水不是重复，不删', () => {
    const rows = [
      ['时间', '安排'],
      ['14:00', '参观博物馆'],
      ['14:00', '自由活动（二选一）']
    ];
    expect(dedupeRows(rows).removed).toBe(0);
    const sales = [
      ['日期', '商品', '金额'],
      ['10-01', '苹果', '10'],
      ['10-01', '香蕉', '10']
    ];
    expect(dedupeRows(sales).removed).toBe(0);
  });
  it('表里有公式：不删行（删了引用会错位），只报告重复了几行', () => {
    const r = dedupeRows([
      ['项目', '金额'],
      ['甲', '10'],
      ['甲', '10'],
      ['合计', '=SUM(B2:B3)']
    ]);
    expect(r.removed).toBe(0);
    expect(r.duplicates).toBe(1);
    expect(r.rows).toHaveLength(4);
  });
  it('生成 Excel 时真的去掉了，读回只剩一行晚餐；CSV 也一样', async () => {
    const md = TRIP.map((r, i) => `| ${r.join(' | ')} |` + (i === 0 ? '\n|--|--|--|--|' : '')).join('\n');
    const out = await makeXlsx(md, { theme: THEMES.business });
    expect(out.info.duplicatesRemoved).toBe(1);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await out.blob.arrayBuffer());
    const values = [];
    wb.worksheets[0].eachRow((row) => values.push(row.values.slice(1).join('|')));
    expect(values.filter((v) => v.includes('晚餐'))).toHaveLength(1);
    const csv = await makeCsv(md).text();
    expect(csv.match(/晚餐/g)).toHaveLength(1);
  });
});

describe('“待查”是提醒，不是错误', () => {
  it('门票待查、价格待确认只给一条提醒；XXX、TODO 这种真占位仍是错误', () => {
    const ok = lint('xlsx', '| 时间 | 安排 | 门票 |\n|--|--|--|\n| 09:00 | 西湖 | 免费 |\n| 14:00 | 灵隐寺 | 待查 |\n| 16:00 | 河坊街 | 待确认 |');
    expect(ok.filter((x) => x.level === 'error')).toEqual([]);
    expect(ok.map((x) => x.text).join()).toContain('2 处');
    expect(lint('xlsx', '| 时间 | 安排 |\n|--|--|\n| 09:00 | XXX |').some((x) => x.level === 'error')).toBe(true);
  });
});

describe('执行验收不过度核实', () => {
  const passed = (path) => ({ path, validation: { format: 'xlsx', readback: 'passed', structure: 'passed', errors: 0 } });

  it('查资料没查到（门票没搜到）不算失败回执，文件交付了就没有要补的', () => {
    const review = createExecutionReview('做一份杭州行程 Excel');
    review.record({ name: 'web_search', args: { query: '灵隐寺门票' }, ok: false });
    review.artifact(passed('行程.xlsx'));
    review.record({ name: 'create_document', args: { path: '行程.xlsx' }, ok: true });
    expect(review.report().failures).toEqual([]);
    expect(review.guidance()).toBe('');
  });
  it('生成失败后换个文件名又成功了：算已解决；改文件失败没补救：仍要核对', () => {
    const review = createExecutionReview('做一份行程 Excel');
    review.record({ name: 'create_document', args: { path: 'a.xlsx' }, ok: false });
    review.artifact(passed('b.xlsx'));
    review.record({ name: 'create_document', args: { path: 'b.xlsx' }, ok: true });
    expect(review.report().failures).toEqual([]);
    review.record({ name: 'edit_spreadsheet', args: { path: 'b.xlsx' }, ok: false });
    expect(review.report().failures).toEqual(['edit_spreadsheet']);
  });
  it('同一文件验过可用后只再放行一次读取；改过文件后重新放行', () => {
    const review = createExecutionReview('做一份行程 Excel');
    review.artifact(passed('行程.xlsx'));
    review.record({ name: 'create_document', args: { path: '行程.xlsx' }, ok: true });
    expect(review.verified('行程.xlsx')).toBe(true);
    expect(review.rereadBlocked('read_file', { path: '行程.xlsx' })).toBe(false);
    review.record({ name: 'read_file', args: { path: '行程.xlsx' }, ok: true });
    expect(review.rereadBlocked('read_file', { path: '行程.xlsx' })).toBe(true);
    expect(review.rereadBlocked('check_document', { path: '行程.xlsx' })).toBe(true);
    // 用别的方式改了文件（没有新的验收结果）：之前的“已验过”作废
    review.record({ name: 'write_file', args: { path: '行程.xlsx' }, ok: true });
    expect(review.verified('行程.xlsx')).toBe(false);
    expect(review.rereadBlocked('read_file', { path: '行程.xlsx' })).toBe(false);
  });
  it('生成器报了错的文件不算验过，读多少次都放行', () => {
    const review = createExecutionReview('做一份行程 Excel');
    review.artifact({ path: 'x.xlsx', validation: { format: 'xlsx', readback: 'passed', errors: 2 } });
    review.record({ name: 'create_document', args: { path: 'x.xlsx' }, ok: true });
    review.record({ name: 'read_file', args: { path: 'x.xlsx' }, ok: true });
    expect(review.rereadBlocked('read_file', { path: 'x.xlsx' })).toBe(false);
  });
  it('工具层：第二次以后读同一个已验过的文件不再执行', async () => {
    const review = createExecutionReview('做一份行程 Excel');
    review.artifact(passed('行程.xlsx'));
    review.record({ name: 'create_document', args: { path: '行程.xlsx' }, ok: true });
    let reads = 0;
    const tool = { name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, run: async () => { reads++; return '内容'; } };
    const opts = { loader: { get: () => tool }, emit: () => {}, seen: new Map(), closing: false, retrieval: { extensive: false }, review, webTools: new Set(), parallelSafe: new Set() };
    const call = (id) => ({ id, name: 'read_file', args: { path: '行程.xlsx' } });
    const [first] = await executeToolCalls([call('1')], opts);
    const [second] = await executeToolCalls([call('2')], opts);
    expect(reads).toBe(1);
    expect(first.output).toBe('内容');
    expect(second.ok).toBe(true);
    expect(second.output).toContain('已经核实过');
  });
});

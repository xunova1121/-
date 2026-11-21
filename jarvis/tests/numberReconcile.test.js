/** 数字定案（用户 2026-11-05：南京地铁 611 / 757 / 556.8 公里，正文和表格各用一个） */
import { describe, it, expect } from 'vitest';
import { sourceTier, dateRank, reconcileNumbers, reconcileAnswerIssues, conflictingNumbers, createNumberReconcileTool } from '../src/agent/numberReconcile.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { rewriteRule, PARALLEL_SAFE } from '../src/agent/agent.js';
import { CORE } from '../src/agent/toolLoader.js';
import { dialoguePolicy } from '../src/agent/dialoguePolicy.js';

const claims = [
  { subject: '南京', metric: '运营里程', value: 556.8, unit: '公里', as_of: '2024年末', scope: '地铁', source: '百度百科', url: 'https://baike.baidu.com/x' },
  { subject: '南京', metric: '运营里程', value: 757, unit: '公里', as_of: '2026年9月', scope: '城市轨道交通（含市域线、有轨电车）', source: '南京地铁官网运营数据速报', url: 'https://www.njmetro.com.cn' },
  { subject: '南京', metric: '运营里程', value: 611, unit: '公里', as_of: '2026年6月', scope: '地铁', source: '新华网', url: 'https://www.news.cn/x' }
];

describe('数字定案', () => {
  it('来源等级与截至日期', () => {
    expect(sourceTier('交通运输部', 'https://www.mot.gov.cn')).toBe(1);
    expect(sourceTier('新华网', '')).toBe(2);
    expect(sourceTier('某门户', 'https://news.sina.com.cn')).toBe(3);
    expect(sourceTier('百度百科', '')).toBe(4);
    expect(dateRank('2026年9月')).toBeGreaterThan(dateRank('2026年6月'));
    expect(dateRank('2025年末')).toBeGreaterThan(dateRank('2025年6月'));
    expect(dateRank('无日期')).toBe(0);
  });
  it('口径先对上问题：问地铁就选地铁口径，哪怕官网口径更大', () => {
    const [d] = reconcileNumbers(claims, { question: '南京一共几条地铁，地铁里程多少' });
    expect(d.conflict).toBe(true);
    expect(d.chosen.value).toBe(611);
    expect(d.others.find(o => o.value === 556.8).why).toMatch(/时间较早|来源等级较低/);
  });
  it('口径相同时：等级高的优先，同等级取最新，再看多源一致', () => {
    const same = claims.map(c => ({ ...c, scope: '' }));
    expect(reconcileNumbers(same)[0].chosen.value).toBe(757);
    const portal = [
      { subject: 'A市', metric: '人口', value: 100, unit: '万人', as_of: '2025年', source: '门户甲' },
      { subject: 'A市', metric: '人口', value: 120, unit: '万人', as_of: '2026年', source: '门户乙' },
      { subject: 'A市', metric: '人口', value: 90, unit: '万人', as_of: '2026年', source: '门户丙' },
      { subject: 'A市', metric: '人口', value: 90.2, unit: '万人', as_of: '2026年', source: '门户丁' }
    ];
    const d = reconcileNumbers(portal)[0];
    expect(d.chosen.value).toBe(90);
    expect(d.chosen.reason).toContain('2个来源一致');
    expect(d.others.find(o => o.value === 100).why).toContain('时间较早');
  });
  it('交付核对：没用主数字、或另一个数没说明差别就报出来；写清口径就放行', () => {
    const decisions = reconcileNumbers(claims, { question: '南京地铁里程' });
    expect(reconcileAnswerIssues('南京运营里程约556.8公里。', decisions)[0]).toContain('数字定案');
    expect(reconcileAnswerIssues('南京运营里程611公里。表格里写的是757公里。', decisions)[0]).toContain('757');
    expect(reconcileAnswerIssues('南京地铁运营里程611公里；按城市轨道交通口径（含市域线）为757公里。', decisions)).toEqual([]);
  });
  it('兜底：正文和表格给同一城市两个里程数就报', () => {
    const text = '南京应为757公里，排第二。\n\n| 排名 | 城市 | 里程 |\n|---|---|---|\n| 7 | 南京 | 556.8 公里 |';
    expect(conflictingNumbers(text)[0]).toContain('数字前后不一致');
    expect(conflictingNumbers('南京为611公里。\n\n| 7 | 南京 | 611 公里 |')).toEqual([]);
    expect(conflictingNumbers('南京为611公里；截至2024年末统计为556.8公里。')).toEqual([]);
  });
  it('工具：输入为空报参数错；正常返回定案 JSON', async () => {
    const tool = createNumberReconcileTool();
    await expect(tool.run({ claims: [] })).rejects.toMatchObject({ code: 'INVALID_RECONCILE_INPUT' });
    const out = JSON.parse(await tool.run({ question: '南京地铁', claims }));
    expect(out.kind).toBe('number_reconcile');
    expect(out.decisions[0].chosen.value).toBe(611);
  });
  it('接入：核心工具、可并行、写法类软规则、数字类问题有提示', () => {
    expect(CORE).toContain('reconcile_numbers');
    expect(PARALLEL_SAFE.has('reconcile_numbers')).toBe(true);
    expect(rewriteRule('同一回答里「南京」的数字前后不一致')).toBe('number_consistency');
    expect(rewriteRule('数字定案选的是「南京运营里程」611公里')).toBe('number_consistency');
    expect(dialoguePolicy('南京一共几条地铁')).toContain('reconcile_numbers');
  });
});

describe('数字定案接入回答核对', () => {
  it('调用过定案工具后，回答用了别的数会被拦下核对', () => {
    const review = createExecutionReview('南京地铁里程多少');
    const output = JSON.stringify({ kind: 'number_reconcile', decisions: reconcileNumbers(claims, { question: '南京地铁' }) });
    review.record({ name: 'reconcile_numbers', ok: true, output });
    expect(review.guardsAnswer()).toBe(true);
    review.checkAnswer('南京运营里程约556.8公里。');
    expect(review.report().answerIssues.join('')).toContain('数字定案');
  });
});

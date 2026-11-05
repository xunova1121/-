/** 天气数字前后矛盾、学术规范、合同检查：确定性规则，宁可漏报不误报 */
import { it, expect } from 'vitest';
import { weatherConflicts } from '../src/agent/numberReconcile.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { rewriteRule, PARALLEL_SAFE } from '../src/agent/agent.js';
import { CORE } from '../src/agent/toolLoader.js';
import { checkAcademic, checkContract, upperAmount, isAcademic, isContract, writingIssueNote, createWritingCheckTool } from '../src/agent/writingChecks.js';

it('天气：同一段“最高22℃”又写“18～29℃”报出来；一致或分属不同天不报', () => {
  expect(weatherConflicts('北京明天晴，最高22℃，全天18～29℃。')[0]).toMatch(/天气数字前后不一致/);
  expect(weatherConflicts('北京明天晴，18～29℃，最高29℃，最低18℃。')).toEqual([]);
  expect(weatherConflicts('明天：最高22℃\n\n后天：18～29℃')).toEqual([]);
  expect(weatherConflicts('今天没有温度信息')).toEqual([]);
  expect(rewriteRule(weatherConflicts('最高22℃，18～29℃')[0])).toBe('number_consistency');
});

it('天气：问天气时回答被拦下核对，矛盾进入回答问题清单', () => {
  const review = createExecutionReview('北京明天天气怎么样');
  expect(review.guardsAnswer()).toBe(true);
  review.checkAnswer('北京明天晴，最高22℃，全天18～29℃。');
  expect(review.report().answerIssues.join('')).toContain('天气数字前后不一致');
});

it('学术：引用和参考文献对不上、编号不连续、缺类型标识和年份、论文缺摘要关键词', () => {
  const text = '正文观点[1]，另有研究[3]。\n\n参考文献\n[1] 张三. 城市更新研究[J]. 规划学刊, 2024.\n[2] 李四. 无标识的文献';
  const r = checkAcademic(text, { title: '城市更新论文' });
  const rules = r.issues.map((x) => x.rule);
  expect(rules).toContain('引用对不上');
  expect(rules).toContain('未引用');
  expect(rules).toContain('著录格式');
  expect(rules).toContain('结构');
  const good = '摘要\n本文研究……\n关键词：城市更新；规划\n\n正文[1-2]。\n\n参考文献\n[1] 张三. 城市更新研究[J]. 规划学刊, 2024.\n[2] 李四. 城市规划原理[M]. 北京: 中国建筑工业出版社, 2010.';
  expect(checkAcademic(good, { title: '城市更新论文' }).issues).toEqual([]);
  expect(checkAcademic('有引用[1]但没清单').issues[0].rule).toBe('参考文献');
  expect(isAcademic('开题报告')).toBe(true);
  expect(isAcademic('工作总结', '正文')).toBe(false);
});

it('合同：缺必备条款、金额大小写不一致；大写换算正确', () => {
  expect(upperAmount('人民币壹拾贰万叁仟元整')).toBe(123000);
  expect(upperAmount('人民币伍仟元伍角')).toBe(5000.5);
  expect(upperAmount('一百元')).toBeNull();
  const bad = checkContract('甲方：A公司 乙方：B公司\n服务内容：网站开发\n价款：人民币壹拾贰万元整（¥120,500）');
  expect(bad.issues.some((x) => x.rule === '金额')).toBe(true);
  expect(bad.issues.some((x) => /违约/.test(x.message))).toBe(true);
  const good = checkContract('甲方：A公司 乙方：B公司\n服务内容：网站开发\n价款：人民币壹拾贰万元整（¥120,000）\n期限：自2026年11月1日起一年\n违约责任：……\n争议解决：提交甲方所在地人民法院诉讼\n双方签字盖章后生效。本合同仅供参考，签署前请律师审核。');
  expect(good.issues).toEqual([]);
  expect(isContract('技术服务合同')).toBe(true);
  expect(isContract('合同管理办法')).toBe(false);
  expect(writingIssueNote(bad)).toContain('合同检查');
});

it('check_writing 工具：核心工具、可并行，返回 issues', async () => {
  expect(CORE).toContain('check_writing');
  expect(CORE).toContain('check_gongwen');
  expect(PARALLEL_SAFE.has('check_writing')).toBe(true);
  const out = JSON.parse(await createWritingCheckTool().run({ kind: 'contract', text: '甲方乙方' }));
  expect(out.kind).toBe('writing_check');
  expect(out.issues.length).toBeGreaterThan(0);
});

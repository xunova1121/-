import { it, expect } from 'vitest';
import { verifyNumbers, createVerificationTool } from '../src/agent/verifyNumbers.js';
it.each([['斤', '公斤', 100, 50], ['两', '克', 1, 50], ['磅', '公斤', 1, 0.45359237], ['英里', '米', 1, 1609.344], ['英尺', '英寸', 1, 12], ['里', '公里', 2, 1], ['亩', '平方米', 3, 2000], ['公顷', '平方公里', 100, 1], ['升', '毫升', 1, 1000], ['加仑', '升', 1, 3.785411784], ['英制加仑', '升', 1, 4.54609], ['摄氏', '华氏', 0, 32], ['华氏', '摄氏', -40, -40]])('%s到%s换算', (from, to, value, expected) => expect(verifyNumbers('unit_convert', { value, from, to }).result).toBeCloseTo(expected, 8));
it('异量纲、无穷和混杂数字不猜', () => {
  for (const data of [{ value: 1, from: '斤', to: '米' }, { value: Infinity, from: '克', to: '公斤' }, { value: '100斤', from: '斤', to: '公斤' }]) expect(() => verifyNumbers('unit_convert', data)).toThrow();
});
it('变化率支持上涨、下跌、同比口径，零基数报错', () => {
  expect(verifyNumbers('change_rate', { oldValue: 80, newValue: 100 }).percent).toBe(25);
  expect(verifyNumbers('change_rate', { oldValue: 100, newValue: 80 }).percent).toBe(-20);
  expect(() => verifyNumbers('change_rate', { oldValue: 0, newValue: 80 })).toThrow('0');
});
it('平均数中位数奇偶、排序不修改原数组、空集拒绝', () => {
  const values = [9, 1, 2, 4];
  expect(verifyNumbers('average', { values })).toMatchObject({ average: 4, median: 3, min: 1, max: 9 });
  expect(values).toEqual([9, 1, 2, 4]);
  expect(verifyNumbers('average', { values: [1, 8, 3] }).median).toBe(3);
  expect(() => verifyNumbers('average', { values: [] })).toThrow();
});
it('等额本息100万30年3.1%，以及零利率按本金平分', () => {
  // 独立用Python Decimal 50位精度复核：月供4270.163989...，不先截断月供再算总额。
  expect(verifyNumbers('loan', { principal: 1000000, years: 30, annualRate: 3.1 })).toMatchObject({ monthlyPayment: 4270.16, totalInterest: 537259.04, totalPayment: 1537259.04 });
  expect(verifyNumbers('loan', { principal: 120000, months: 120, annualRate: 0 })).toMatchObject({ monthlyPayment: 1000, totalInterest: 0, totalPayment: 120000 });
});
it('等额本金首月末月递减与总息，百分比字符串语义明确', () => {
  expect(verifyNumbers('loan', { principal: '1,000,000', years: 30, annualRate: '3.1%', method: '等额本金' })).toMatchObject({ firstPayment: 5361.11, lastPayment: 2784.95, monthlyDecrease: 7.18, totalInterest: 466291.67 });
  expect(() => verifyNumbers('loan', { principal: 1000, months: 0, annualRate: 3 })).toThrow();
  expect(() => verifyNumbers('loan', { principal: 1000, months: 12, years: 30, annualRate: 3 })).toThrow('不一致');
});
it('工具边界认数字字符串，业务层原有严校验和错误测试保留', async () => {
  const tool = createVerificationTool();
  expect(JSON.parse(await tool.run({ action: 'weighing', data: { gross: '10', tare: '2' } })).net).toBe(8);
  expect(() => verifyNumbers('weighing', { gross: '10', tare: 2 })).toThrow();
});

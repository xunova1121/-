/** 数字校验不等于核实行情；市场价格、涨跌停范围须由可靠来源提供。 */
import { commonCalculation, decimal } from './commonCalculations.js';
import { parseMoment, timeCalc } from './timeCalc.js';
import { momentInfo } from './timeMoment.js';
const invalid = (message) => Object.assign(new Error(message), { name: 'ValidationError', code: 'INVALID_FACT_INPUT' });
const number = (value, label, minimum = 0) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw invalid(`${label}必须是大于等于${minimum}的有限数字`);
  return value;
};
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const dateValue = (value, now) => parseMoment(value, now);

export function verifyNumbers(action, data = {}, now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('输入需为对象');
  const common = commonCalculation(action, data);
  if (common) return common;
  const note = '仅校验给定输入的运算和适用规则，不代表行情实时、输入属实或保证成交。';
  if (action === 'weighing') {
    const gross = number(data.gross, '毛重');
    const tare = number(data.tare, '筐重');
    const count = data.count === undefined ? 1 : number(data.count, '箱数');
    if (tare > gross || !Number.isSafeInteger(count) || count > 1e7 || gross > 1e10) throw invalid('毛重不能小于筐重，箱数需为安全范围内的非负整数');
    const netPerUnit = Math.round((gross - tare) * 1e6) / 1e6;
    const net = Math.round(netPerUnit * count * 1e6) / 1e6;
    const price = data.unitPrice === undefined ? null : number(data.unitPrice, '单价');
    if (price !== null && (!Number.isFinite(net * price) || net * price > 1e12)) throw invalid('货款超过安全计算范围');
    return { gross, tare, count, netPerUnit, net, ...(price !== null && { unitPrice: price, amount: round(net * price) }), note: '重量单位须一致，单价须与输入重量单位对应；净重保留6位小数，货款保留两位小数。' };
  }
  if (action === 'date_difference') {
    const result = timeCalc('diff', { start: data.startDate, end: data.endDate }, now);
    return { startDate: data.startDate, endDate: data.endDate, days: result.days, totalMinutes: result.totalMinutes, calendarDays: result.calendarDays, duration: result.duration, note: '按北京时间计算，days为经过天数；纯日期与原自然日差一致，不代表交易日或工作日' };
  }
  if (action === 'date_add') {
    const days = decimal(data.days ?? 0, '天数');
    if (!Number.isSafeInteger(days) || Math.abs(days) > 365000) throw invalid('天数需为合理范围的整数');
    const result = timeCalc('add', { ...data, days }, now);
    return { ...result, note: '自然日，不自动排除节假日；钟点按北京时间，支持hours/minutes。' };
  }
  if (action === 'percentage') {
    if (!Number.isFinite(data.part) || !Number.isFinite(data.total) || data.total === 0) throw invalid('分子分母需有限且分母非零');
    return { percent: round(data.part / data.total * 100), note };
  }
  if (action === 'money_total') {
    if (!Array.isArray(data.amounts) || !data.amounts.length || data.amounts.length > 200) throw invalid('金额需1至200项');
    const cents = data.amounts.map(value => {
      if (!Number.isFinite(value) || Math.abs(value) > 1e10 || Math.abs(value * 100 - Math.round(value * 100)) > 0.0001) throw invalid('金额最多两位小数且需在安全范围');
      return Math.round(value * 100);
    });
    return { total: cents.reduce((sum, value) => sum + value, 0) / 100, note: '按分求和，币种必须相同' };
  }
  if (action === 'pnl') {
    const cost = number(data.cost, '成本', 0.000001);
    const price = number(data.price, '价格');
    const shares = data.shares === undefined ? null : number(data.shares, '份额');
    const fees = data.fees === undefined ? 0 : number(data.fees, '费用');
    return { cost, price, pnlPercent: round(((price - cost) / cost) * 100), ...(shares !== null && { pnlAmount: round((price - cost) * shares - fees), shares, fees }), note };
  }
  if (action === 'gestational_age') {
    const weeks = number(data.weeks, '基准孕周');
    const days = number(data.days, '基准天数');
    if (!Number.isInteger(weeks) || !Number.isInteger(days) || weeks > 45 || days > 6) throw invalid('孕周需为整数，天数为0至6');
    const base = dateValue(momentInfo(dateValue(data.baseDate, now)).date, now);
    const target = dateValue(momentInfo(dateValue(data.targetDate, now)).date, now);
    const total = weeks * 7 + days + (target - base) / 86400000;
    if (total < 0 || total > 315) throw invalid('计算结果超出合理日期范围，请核对基准');
    return {
      weeks: Math.floor(total / 7),
      days: total % 7,
      baseDate: data.baseDate,
      targetDate: data.targetDate,
      estimatedDueDate: momentInfo(base + (280 - weeks * 7 - days) * 86400000).date,
      note: '按用户给定基准推算，不能替代产科核定孕周。'
    };
  }
  if (action === 'a_share_order') {
    const total = number(data.totalShares, '总持仓');
    const today = number(data.todayBuyShares, '当天新买份额');
    const sell = number(data.sellShares, '拟卖份额');
    const price = number(data.orderPrice, '委托价');
    const lower = number(data.lowerLimit, '当日有效下限');
    const upper = number(data.upperLimit, '当日有效上限');
    if (![total, today, sell].every(Number.isInteger) || today > total || upper < lower) throw invalid('份额或价格范围不合法');
    const maximum = total - today;
    const issues = [];
    if (sell > maximum) issues.push('普通A股通常T+1，拟卖数量超过按给定信息计算的可卖底仓；当天新买份额不可直接当可卖份额');
    if (price < lower || price > upper) issues.push('委托价超出给定的当日有效价格范围');
    return { applicableMarket: '普通A股T+1；特殊证券和交易安排须另核对', maxSellShares: maximum, valid: issues.length === 0, issues, note };
  }
  throw invalid('不支持的校验类型');
}

export function createVerificationTool(ctx = {}) {
  return {
    name: 'verify_numbers',
    description: '确定性计算称重货款、北京时间日期差/加减、金额合计、百分比、盈亏、孕周、A股T+1规则，以及单位换算、涨跌幅/同比/环比、平均数/中位数、贷款月供。时间时区工作日优先time_calc。先提供有来源的输入，不能把缓存价格变成已核实行情。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['weighing', 'pnl', 'gestational_age', 'a_share_order', 'date_difference', 'date_add', 'percentage', 'money_total', 'unit_convert', 'change_rate', 'average', 'loan'] },
        data: {
          type: 'object',
          description:
            'weighing:gross毛重,tare筐重,count箱数可选(默认1),unitPrice单价可选；date_difference:startDate,endDate；date_add:date,days/hours/minutes（例date:"现在",hours:23）；percentage:part,total；money_total:amounts；pnl:cost,price,shares可选,fees可选；gestational_age:weeks,days,baseDate,targetDate；a_share_order:totalShares,todayBuyShares,sellShares,orderPrice,lowerLimit,upperLimit；unit_convert:value,from,to（例100,斤,公斤）；change_rate:oldValue,newValue；average:values数字数组；loan:principal本金,annualRate年利率百分数（3.1表示3.1%）,months或years,method等额本息equal_payment/等额本金equal_principal。日期接受2026/11/3、11月3日、明天。',
          additionalProperties: true
        }
      },
      required: ['action', 'data'],
      additionalProperties: false
    },
    run: async ({ action, data }) => {
      // 工具边界允许模型传无歧义的数字字符串；纯业务函数仍保持旧的严格输入契约。
      const normalized = data && !Array.isArray(data) && typeof data === 'object' ? { ...data } : data;
      for (const key of ['gross', 'tare', 'count', 'unitPrice', 'cost', 'price', 'shares', 'fees', 'weeks', 'days', 'part', 'total', 'totalShares', 'todayBuyShares', 'sellShares', 'orderPrice', 'lowerLimit', 'upperLimit']) {
        if (typeof normalized?.[key] === 'string') normalized[key] = decimal(normalized[key], key);
      }
      return JSON.stringify(verifyNumbers(action, normalized, typeof ctx.now === 'function' ? ctx.now() : Date.now()));
    }
  };
}

export function currentTime(at = new Date()) {
  return { beijing: at.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }), iso: at.toISOString(), timeZone: 'Asia/Shanghai' };
}

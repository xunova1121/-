const invalid = message => Object.assign(new Error(message), { name: 'ValidationError', code: 'INVALID_FACT_INPUT' });
export const decimal = (value, label = '数值') => {
  let parsed = value;
  if (typeof value === 'string') {
    const text = value.trim().normalize('NFKC');
    if (/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) parsed = Number(text.replace(/,/g, ''));
  }
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw invalid(`${label}需为有限数字，例如1000或"1,000"，不接受混入文字的数字`);
  return parsed;
};
const roundMoney = n => Math.round((n + Number.EPSILON) * 100) / 100;
const GROUPS = [
  { 公斤: 1, 千克: 1, kg: 1, 斤: 0.5, 两: 0.05, 克: 0.001, g: 0.001, 磅: 0.45359237, lb: 0.45359237, 吨: 1000 },
  { 米: 1, m: 1, 厘米: 0.01, cm: 0.01, 毫米: 0.001, mm: 0.001, 公里: 1000, 千米: 1000, km: 1000, 英里: 1609.344, mile: 1609.344, 英尺: 0.3048, ft: 0.3048, 英寸: 0.0254, inch: 0.0254, 里: 500 },
  { 平方米: 1, 'm²': 1, m2: 1, 亩: 2000 / 3, 公顷: 10000, 平方公里: 1000000 },
  { 升: 1, l: 1, 毫升: 0.001, ml: 0.001, 加仑: 3.785411784, 美制加仑: 3.785411784, 英制加仑: 4.54609 },
  { 秒: 1, 分钟: 60, 小时: 3600, 天: 86400 }
];
const unitName = value => String(value ?? '').trim().replace(/Ｋ|℃|℉/g, char => ({ 'Ｋ': 'K', '℃': '摄氏', '℉': '华氏' })[char]).toLowerCase();

export function commonCalculation(action, data) {
  if (action === 'unit_convert') {
    const value = decimal(data.value);
    const from = unitName(data.from ?? data.fromUnit), to = unitName(data.to ?? data.toUnit);
    const temp = { 摄氏: 'c', 摄氏度: 'c', '°c': 'c', c: 'c', 华氏: 'f', 华氏度: 'f', '°f': 'f', f: 'f' };
    let result;
    if (temp[from] && temp[to]) result = temp[from] === temp[to] ? value : temp[from] === 'c' ? value * 9 / 5 + 32 : (value - 32) * 5 / 9;
    else {
      const group = GROUPS.find(row => Object.hasOwn(row, from) && Object.hasOwn(row, to));
      if (!group) throw invalid('单位不认识或量纲不同；例value:100,from:"斤",to:"公斤"。斤/两按中国大陆市制，加仑默认美制液量。');
      result = value * group[from] / group[to];
    }
    if (!Number.isFinite(result)) throw invalid('换算超出安全范围');
    return { value, from, to, result: Number(result.toPrecision(12)), note: '斤/两按大陆市制：1斤=500克、1两=50克；里=500米；未注明的加仑按美制液量，支持英制加仑。结果最多12位有效数字。' };
  }
  if (action === 'change_rate') {
    const oldValue = decimal(data.oldValue ?? data.old ?? data.previous, '旧值');
    const newValue = decimal(data.newValue ?? data.new ?? data.current, '新值');
    if (oldValue === 0) throw invalid('旧值为0，涨跌幅/同比/环比无定义，不能除以0');
    const percent = (newValue - oldValue) / oldValue * 100;
    if (!Number.isFinite(percent)) throw invalid('变化率超出安全计算范围');
    return { oldValue, newValue, difference: roundMoney(newValue - oldValue), percent: roundMoney(percent), note: '涨跌幅/同比/环比均按（新值−旧值）÷旧值×100%；保留两位小数，负基数照公式计算，跨正负时不能当通常增长率解读。' };
  }
  if (action === 'average') {
    if (!Array.isArray(data.values) || !data.values.length || data.values.length > 10000) throw invalid('values需为1～10000项数字数组，例如[1,2,3]');
    const values = data.values.map(value => decimal(value)).sort((a, b) => a - b);
    const average = values.reduce((sum, value) => sum + value / values.length, 0);
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[mid] : values[mid - 1] / 2 + values[mid] / 2;
    if (!Number.isFinite(average)) throw invalid('平均数超出安全计算范围');
    return { count: values.length, average, median, min: values[0], max: values.at(-1), note: '算术平均数；偶数个数的中位数为中间两数的平均，不改变输入顺序，不自动当成金额。' };
  }
  if (action === 'loan') return loan(data);
  return null;
}

function loan(data) {
  const principal = decimal(data.principal, '本金');
  const rateInput = typeof data.annualRate === 'string' ? data.annualRate.trim().normalize('NFKC').replace(/%$/, '') : data.annualRate;
  const annualRate = decimal(rateInput, '年利率（百分数）');
  const months = data.months === undefined ? decimal(data.years, '年数') * 12 : decimal(data.months, '月数');
  if (!(principal > 0) || principal > 1e12 || annualRate < 0 || annualRate > 100 || !Number.isSafeInteger(months) || months < 1 || months > 1200) throw invalid('本金需0～1万亿以内正数，年利率0～100%，月数1～1200的整数；3.1表示3.1%，不是0.031');
  if (data.years !== undefined && data.months !== undefined && decimal(data.years) * 12 !== months) throw invalid('年数与月数不一致，请核对');
  const method = data.method ?? 'equal_payment';
  const rate = annualRate / 1200;
  const note = '按固定年利率、整月等期还款测算；annualRate=3.1表示3.1%，不含手续费/提前还款。金额保留两位小数，总额按未逐期舍入值计算，银行尾期调整可能有分差。';
  if (['equal_payment', '等额本息'].includes(method)) {
    const monthlyPayment = rate === 0 ? principal / months : principal * rate / (-Math.expm1(-months * Math.log1p(rate)));
    return { method: 'equal_payment', principal, annualRate, months, monthlyPayment: roundMoney(monthlyPayment), totalInterest: roundMoney(monthlyPayment * months - principal), totalPayment: roundMoney(monthlyPayment * months), note };
  }
  if (['equal_principal', '等额本金'].includes(method)) {
    const monthlyPrincipal = principal / months;
    const interest = principal * rate * (months + 1) / 2;
    return { method: 'equal_principal', principal, annualRate, months, monthlyPrincipal: roundMoney(monthlyPrincipal), firstPayment: roundMoney(monthlyPrincipal + principal * rate), lastPayment: roundMoney(monthlyPrincipal * (1 + rate)), monthlyDecrease: roundMoney(monthlyPrincipal * rate), totalInterest: roundMoney(interest), totalPayment: roundMoney(principal + interest), note };
  }
  throw invalid('method用equal_payment（等额本息）或equal_principal（等额本金）');
}

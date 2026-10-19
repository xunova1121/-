/** 数字校验不等于核实行情；市场价格、涨跌停范围须由可靠来源提供。 */
const invalid = message => Object.assign(new Error(message), {name:'ValidationError',code:'INVALID_FACT_INPUT'});
const number = (value, label, minimum = 0) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw invalid(`${label}必须是大于等于${minimum}的有限数字`);
  return value;
};
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
const dateValue = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw invalid('日期必须为YYYY-MM-DD');
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0,10) !== value) throw invalid('日期不存在');
  return stamp;
};

export function verifyNumbers(action, data = {}) {
  const note = '仅校验给定输入的运算和适用规则，不代表行情实时、输入属实或保证成交。';
  if (action === 'pnl') {
    const cost = number(data.cost,'成本',0.000001);
    const price = number(data.price,'价格');
    return {cost,price,pnlPercent:round((price-cost)/cost*100),note};
  }
  if (action === 'gestational_age') {
    const weeks = number(data.weeks,'基准孕周');
    const days = number(data.days,'基准天数');
    if (!Number.isInteger(weeks) || !Number.isInteger(days) || weeks>45 || days>6) throw invalid('孕周需为整数，天数为0至6');
    const base = dateValue(data.baseDate);
    const target = dateValue(data.targetDate);
    const total = weeks*7+days+(target-base)/86400000;
    if (total<0 || total>315) throw invalid('计算结果超出合理日期范围，请核对基准');
    return {weeks:Math.floor(total/7),days:total%7,baseDate:data.baseDate,targetDate:data.targetDate,estimatedDueDate:new Date(base+(280-weeks*7-days)*86400000).toISOString().slice(0,10),note:'按用户给定基准推算，不能替代产科核定孕周。'};
  }
  if (action === 'a_share_order') {
    const total = number(data.totalShares,'总持仓');
    const today = number(data.todayBuyShares,'当天新买份额');
    const sell = number(data.sellShares,'拟卖份额');
    const price = number(data.orderPrice,'委托价');
    const lower = number(data.lowerLimit,'当日有效下限');
    const upper = number(data.upperLimit,'当日有效上限');
    if (![total,today,sell].every(Number.isInteger) || today>total || upper<lower) throw invalid('份额或价格范围不合法');
    const maximum = total-today;
    const issues = [];
    if (sell>maximum) issues.push('普通A股通常T+1，拟卖数量超过按给定信息计算的可卖底仓；当天新买份额不可直接当可卖份额');
    if (price<lower || price>upper) issues.push('委托价超出给定的当日有效价格范围');
    return {applicableMarket:'普通A股T+1；特殊证券和交易安排须另核对',maxSellShares:maximum,valid:issues.length===0,issues,note};
  }
  throw invalid('不支持的校验类型');
}

export function createVerificationTool() {
  return {
    name:'verify_numbers',
    description:'校验盈亏、孕周日期、普通A股T+1可卖数量和委托价范围。先提供有来源的输入，不能用此工具把缓存价格变成已核实行情。',
    input_schema:{type:'object',properties:{action:{type:'string',enum:['pnl','gestational_age','a_share_order']},data:{type:'object',description:'pnl:cost,price；gestational_age:weeks,days,baseDate,targetDate；a_share_order:totalShares,todayBuyShares,sellShares,orderPrice,lowerLimit,upperLimit',additionalProperties:true}},required:['action','data'],additionalProperties:false},
    run:async ({action,data})=>JSON.stringify(verifyNumbers(action,data))
  };
}

export function currentTime(at = new Date()) {
  return {beijing:at.toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}),iso:at.toISOString(),timeZone:'Asia/Shanghai'};
}

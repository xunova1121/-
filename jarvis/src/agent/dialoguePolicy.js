/** 根据本轮实际工具建立能力边界，不让旧摘要或技能说明替工具回执作担保。 */
export function needsActionTools(userText, messages = []) {
  const accepted = /^(可以|好|好的|行|嗯|确认|继续|就这样)[啊呀吧。！!\s]*$/.test(String(userText).trim());
  const lastReply = [...messages].reverse().find((message) => message.role === 'assistant');
  return accepted && /提醒|定时|闹钟|写.{0,8}文件|保存|创建|打开|执行/.test(lastReply?.content || '');
}

export function capabilityBlock(tools = []) {
  const names = new Set(tools.map(tool => tool.name));
  const states = [['提醒', 'schedule_task'], ['电脑', 'computer_capabilities'], ['搜索', 'web_search']];
  return '本轮实际能力：' + states.map(([label, toolName]) => label + '：' + (names.has(toolName) ? '可调用' : '本轮未开放')).join('；') + '。先按工具取得真实回执再说已执行；工具尚未加载不等于能力不存在；本轮未开放不代表其他运行模式也没有。';
}

export const DIALOGUE_POLICY = `当前要求优先；故障反馈先排查，不当成告别，不反复提旧话题。区分用户事实、原文证据与推测；已否定的数据和依赖结论一起作废。诊断无堆栈或对照实验不宣布根因；不输出内部推理草稿。`;

const DOMAIN_RULES = [
  [/等了.{0,12}(?:秒|分钟)|回答.{0,6}太慢|响应.{0,6}慢|等待.{0,6}长|发.{0,8}时间.{0,4}长/, '用户在反馈等待耗时，不等于要求缩短篇幅；应区分排队、模型、搜索和工具计时，没有分段证据不宣布供应商是根因。'],
  [/股票|持仓|证券|股价|行情|盈亏|涨停|跌停|日K|K线|A股|买入|卖出/i, 'A股：先核对证券、市场规则、行情时点和可卖份额；普通沪市通常T+1，当天新买不能直接卖。委托在有效价格范围内，不低于跌停价，不保证排队成交；行情不可靠不给确定买卖价/股数。'],
  [/孕|产检|体检|化验|糖耐|医疗|诊断|病|药|症状|法律|诉讼|合同|律师/, '医疗/法律：区分已知事实、一般规则和个案判断，关键依据未核实不作确定结论。'],
  [/时间|今天|明天|昨天|星期|日期|孕周|盈亏|合计|相差|多少天|收益率|百分比/, '日期先用本轮上下文的北京时间，普通今日查询直接检索；缺少时间、跨日或需要精确时刻时再用get_current_time。确定性日期/孕周/盈亏计算用verify_numbers，说明基准日期和算式，凌晨不混用昨今明。'],
  [/天气|降雨|下雨|新闻|股价|行情|最新|实时/, '实时资料标来源和数据时点，缓存不是实况；降雨概率不等于所在地正在下雨，旧记忆不能证明今天的天气。'],
  [/崩溃|闪退|重启|lowMemory|GPU|渲染|内存|WebView/i, '故障诊断：lowMemory=false、可用内存多不能排除渲染/GPU资源问题；虚拟显示器失败也不能排除代码问题。']
];

/** 仅按本轮目标选规则；继续任务的目标由主循环保留，不用旧持仓画像强行关联新问题。 */
export function dialoguePolicy(text = '') {
  return [DIALOGUE_POLICY, ...DOMAIN_RULES.filter(([pattern]) => pattern.test(String(text))).map(([, rule]) => rule)].join('\n');
}


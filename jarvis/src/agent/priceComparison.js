/** 价格比较的辅助汇率不能替代比较本身，尤其是“对比官方便宜多少”这种追问。 */
export function priceComparisonRequest(request) {
  const text = String(request || '').slice(-4000);
  return /便宜多少|贵多少|贵几倍|便宜几倍|节省多少|差价|(?:价格|费用|成本|单价|计费).{0,20}(?:对比|比较)|(?:对比|比较).{0,20}(?:官方|价格|费用|成本|单价|计费)/.test(text);
}

export const PRICE_COMPARISON_NOTE = '价格比较先回答相差多少，再列两边来源、币种、单位和算式。比较模型API费用必须用同一输入/输出token量和同一缓存命中比例；缓存未命中、缓存命中、输出单价分别计算。没有实际缓存比例时分别列同口径场景，不能把一方实际账单和另一方假设80%缓存比较后称实际贵几倍。汇率只是换算依据，不能单独当比较结论。缺价目或用量就明确缺什么，给已知项和计算方法，不猜倍数。';

export function priceComparisonIssues(request, answer) {
  if (!priceComparisonRequest(request)) return [];
  const text = String(answer);
  if (/便宜|更贵|贵了|贵约|节省|差价|相差|差额|对比|比较|成本|单价|缺少|无法.{0,8}(?:计算|判断)|尚未.{0,8}(?:比较|核实)/.test(text)) return [];
  return ['本轮要求价格比较；当前答复没有比较结论或具体缺项。汇率等辅助数据不能替代原问题，按相同币种、单位、用量与缓存比例比较。'];
}

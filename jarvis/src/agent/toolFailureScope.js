/** 只根据当前工具的结构化错误解释影响范围，不从一次失败推断整个网络或供应商故障。 */
export function toolFailureScope(tool, error) {
  if (tool !== 'fetch_json') return '';
  if (error?.code === 'PUBLIC_JSON_BLOCKED') return '本次仅fetch_json的公开JSON地址策略拒绝了此URL，尚未据此验证该接口能否连通。此名单不控制get_weather或fetch_url；不能说免费天气整体被禁用，也不能承诺加域名能修复超时。天气优先get_weather，其他网页按各工具的实际回执判断。';
  if (error?.code === 'LOOKUP_SOURCE_COOLING') return '本次fetch_json没有执行；此冷却记录只代表该工具记录的连接失败，不是域名白名单拒绝，也不代表天气、网页或搜索入口全部停用。可用专用工具按各自回执判断。';
  return '';
}

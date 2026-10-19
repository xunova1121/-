import { errorKind } from './suggest.js';
/** 不从429或网络中断推断欠费，也不虚构已经重试。 */
export function friendlyError(error) {
  const msg = String(error?.message ?? error ?? '');
  const code = Number(error?.status ?? msg.match(/(?:模型接口返回|HTTP|返回) (\d{3})/)?.[1]);
  const kind = errorKind(error);
  if (kind === 'budget') return '本轮检索预算已用完，已保留取得的内容；这不代表服务账户余额用完';
  if (['insufficient_quota', 'INSUFFICIENT_CREDIT', 'CREDIT_EXHAUSTED'].includes(error?.code)) return '服务商明确返回余额或账户额度不足，请检查该服务账户';
  if (kind === 'timeout' || [524, 504, 522, 408].includes(code)) return '请求等待超时，已保留已有内容。可以继续原任务或切换可用模型';
  if (kind === 'network') return '网络连接异常，已保留已有内容。请检查网络后继续';
  if (code === 429) return '请求过于频繁或服务商限流（429），稍后再试；仅凭429无法判断账户余额';
  if (code === 401 || code === 403) return 'API密钥或权限校验失败（' + code + '），请检查模型设置';
  if (code >= 500) return '服务商临时故障（' + code + '），可以稍后再试或换一个模型';
  if (/图片模型|image model|images\/generations/i.test(msg)) return '当前选的是画图模型，不能用来聊天：请换一个聊天模型';
  return msg;
}

/** 只限制屏幕上的消息数量；原会话、模型上下文和导出内容不受影响。 */
export function transcriptWindow(total, { mobile = false, safe = false, end = total } = {}) {
  total = Math.max(0, Math.floor(total));
  end = Math.max(0, Math.min(total, Math.floor(end)));
  const limit = mobile ? safe ? 12 : 24 : total;
  return { start: Math.max(0, end - limit), end, limit, older: Math.max(0, end - limit), newer: total - end };
}

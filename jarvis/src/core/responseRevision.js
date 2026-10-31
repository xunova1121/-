/** 只识别重述已有内容；带新检索/执行要求的句子仍走原任务规则。 */
export function isResponseRevision(text = '') {
  const value = String(text).trim();
  const actions = value.replace(/(?:不要|不用|不必|无需|别)(?:再)?(?:联网|搜索|检索|查资料|查询|查|核实)[^，,。；;]*/g, '');
  if (value.length > 300 || /查|搜|最新|实时|核实|运行|文件|代码|编程|开发|安装|提醒|定时|支付|Word|PPT|Excel|发送|删除/.test(actions)) return false;
  return /^(?:请|麻烦)?(?:重新说|重新讲|重说|再说一遍|重新回答|换(?:个|一种)说法|重写一下|重新解释|说得(?:通俗|温柔|自然|简洁|深入)一点)(?:[一下遍吧些点得\s，,。！!：:].*)?$/.test(
    value
  );
}
export const STYLE_DIRECTIVE =
  /(?:以后|下次|请记住|记住|希望你|回答时|解读.{0,12}时).{0,180}(?:语气|口吻|风格|安抚|共情|感受|通俗|温柔|贴心|冷冰冰|简洁|简短|深入|论证|分析|陪诊|不要安慰)/;
/** 仅用同段最近12条定位指代，不复制整篇旧回答进系统提示。 */
export function conversationFocus(text, messages = []) {
  const revision = isResponseRevision(text);
  const recent = messages.slice(-12);
  let target = null;
  if (revision) {
    for (let i = recent.length - 1; i >= 0; i--) {
      const item = recent[i];
      if (item.role !== 'assistant' || !String(item.content || '').trim()) continue;
      const value = String(item.content);
      if (/^(?:记住了|已记住|好的[，,。]?我记住|已记录|已更新记忆|收到[。！!]?\s*$)/.test(value.trim()) && value.length < 600) continue;
      if (/^（.*(?:超时|未完成|中断)/.test(value.trim())) continue;
      target = item;
      break;
    }
  }
  const lastQuestion = [...recent]
    .reverse()
    .find((item) => item.role === 'user' && !isResponseRevision(item.content) && !STYLE_DIRECTIVE.test(String(item.content || '')));
  // 普通新问题不自动继承旧话题；短追问才用最近问题定位，不重新注入旧事实。
  const followup =
    revision ||
    /^(?:那(?:么)?(?:后面|接下来|呢|这个|有什么|[？?，,\s]|$)|然后(?:呢|[？?，,\s]|$)|后面(?:是|还有|呢)|接下来(?:是|做|怎么|呢)|这个(?:呢|是|怎么)|那个(?:呢|是|怎么)|还有(?:呢|什么|哪些))/.test(
      String(text)
    );
  const topic = followup ? [lastQuestion?.content, target?.content].filter(Boolean).join('\n').slice(0, 1000) : '';
  return {
    revision,
    targetTs: target?.ts ?? null,
    hasTarget: Boolean(target),
    memoryQuery: [String(text).slice(0, 1000), topic].filter(Boolean).join('\n').slice(0, 1800),
    topic
  };
}

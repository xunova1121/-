/** 短追问常省略“海报”，仍需加载本轮真实构图说明；只查看最近主题，不把旧任务带到新问题。 */
export function posterFollowupRequirement(text = '', history = []) {
  const value = String(text);
  if (/先不|不做|不用做|不要做|别做|只(?:解释|分析|讨论)|为什么|什么原因|能不能|怎么实现/.test(value)) return value;
  if (/海报|\.poster\.json|\.design\.json/.test(value)) return value;
  const refinement = /(?:换|改|重新|再做|另做|做个|做一|加上|增加|放大|缩小|合成)[^。！？\n]{0,32}(?:风格|结构|布局|版式|配色|颜色|字号|图标|类似|这种|一版|一个)|(?:没合成|合成一下|合到一起)|^(?:做吧|做啊|就这样做|按这个做)[。！ ]*$/;
  if (!refinement.test(value)) return value;
  const recent = history.filter(m => ['user', 'assistant'].includes(m.role)).slice(-4).reverse();
  for (const message of recent) {
    const content = typeof message.content === 'string' ? message.content.slice(0, 6000) : '';
    if (!/海报/.test(content) && /Demo|大屏|驾驶舱|网页/.test(content)) return value;
    if (/海报|\.poster\.json|\.design\.json/.test(content)) return value + '\n【本轮承接最近的图文海报，按现有原稿修改或重新制作海报；保留原文与已确认要求，使用当前make_poster的自由图层能力，不沿用旧回答对工具能力的猜测。】';
    if (message.role === 'user' && !refinement.test(content)) return value;
  }
  return value;
}

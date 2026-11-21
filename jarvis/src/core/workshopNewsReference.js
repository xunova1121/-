// 这几行在用户消息里可见，也随排队和云端历史保存。路由只依据问题，不把报道标题或 .shtml 地址认成编程需求。
const marker = '\n\n〔工作台新闻〕\n';
const reference = /(?:这条|这则|该条|该则|本条|本则|这篇|这份)(?:新闻|报道|消息|资讯)|(?:屏幕|显示器)(?:上|里)(?:的|那条|这条)?(?:新闻|报道|消息|资讯)|这条(?=对|有何|有什|会|怎么|说|讲|意味|影响|为什|整理|做成|生成|做个|做一|写成|解读|分析|[，,。？?\s]|$)/u;

export function refersToWorkshopNews(text) {
  return reference.test(text) && !text.includes(marker);
}

export function workshopNewsInstruction(text) {
  const at = text.indexOf(marker);
  if (at < 0) return text;
  const tail = text.slice(at + marker.length);
  // 用户明确写在引用后面的补充仍参与路由。
  const match = /^[^\n]+\n来源：[^\n]+\n(?:发布时间：[^\n]+\n)?原文：https?:\/\/[^\s]+(?:\n|$)/u.exec(tail);
  return match ? (text.slice(0, at) + '\n' + tail.slice(match[0].length)).trim() : text;
}

export function withWorkshopNews(text, article) {
  if (!article || text.includes(marker)) return text;
  const time = article.publishedAt ? '\n发布时间：' + article.publishedAt : '';
  return text + marker + article.title + '\n来源：' + article.source + time + '\n原文：' + article.url;
}

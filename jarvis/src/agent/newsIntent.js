/** 只识别当前新闻请求；抱怨不能从“新闻”二字推导成重新检索。 */
export function lookupComplaint(text = '') {
  const value = String(text).trim().replace(/[，,。！？!?\s]+/g, '');
  return value.length <= 45 && /^(?:(?:发个|查个|查|发|这个|这|你的|你|未央|今日|今天|新闻|发个新闻|查个新闻))*?(?:(?:怎么|为什么)(?:这么|那么)?慢|咋(?:这么|那么)?慢|那么慢|这么慢|还没好|还没查完|还没结束|在干嘛|在做什么|到底在干什么|谁让你这么做的|谁让你查的|谁让你搜的)$/.test(value);
}
export function todayNewsIntent(text = '') {
  const value = String(text).replace(/^【这是定时任务[\s\S]*?】\s*/, '').trim();
  return value.length <= 1500 && !lookupComplaint(value) && !/修复|开发|实现|代码|工具说明|功能设计|接口设计/.test(value) && !/^(?:不要|不用|别|取消|停止)(?:查|搜|再查|再搜|发|看|给我|今天|今日|的)*(?:新闻|资讯)/.test(value) && /新闻|资讯|早报|晚报/.test(value)
    && /今日|今天|每日|重点新闻|新闻简报|新闻早报|新闻晚报/.test(value)
    && !/昨天|昨日|前天|去年|上周|历史新闻|20\d{2}[年/-]/.test(value);
}
export const NEWS_LOOKUP_NOTE = '今日新闻优先使用get_today_news，结果已按北京时间筛选当天。区分汇总页已读取和报道原文已核实；用户明确要求逐条打开原文时，仍须fetch_url读取对应报道。拿到多少先给多少，不只交链接，不把标题扩写成未取得的事实。';
export const WEB_LOOKUP_NOTE = '查几个方面或几个对象时，同一轮一起调用web_search/fetch_url，或使用web_search.queries并发；次数照常计预算。先给已查到的具体内容并附来源，来源矛盾分别说明；只见搜索摘要或汇总页时明确尚未读报道原文，不冒充核实。够用就答，不为凑次数重复搜索。公开JSON数据可用fetch_json，只有设置里信任的域名可读，不猜数据单位、复权口径或日期。';

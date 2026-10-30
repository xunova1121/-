/** 只识别当前新闻请求；抱怨不能从“新闻”二字推导成重新检索。 */
export function lookupComplaint(text = '') {
  const value = String(text).trim().replace(/[，,。！？!?\s]+/g, '');
  return value.length <= 45 && /^(?:(?:发个|查个|查|发|这个|这|你的|你|未央|今日|今天|新闻|发个新闻|查个新闻|体育资讯|体育新闻|体坛动态))*?(?:(?:怎么|为什么)(?:这么|那么)?慢|咋(?:这么|那么)?慢|那么慢|这么慢|还没好|还没查完|还没结束|在干嘛|在做什么|到底在干什么|谁让你这么做的|谁让你查的|谁让你搜的)$/.test(value);
}
/** 体育新闻与比分是不同目标；不因历史里刚问过赛程就把资讯换成比分。 */
export function sportsNewsTopic(text = '') {
  const value = String(text).replace(/^【这是定时任务[\s\S]*?】\s*/, '').trim();
  return value.length <= 1500 && !lookupComplaint(value)
    && /体育|体坛|足坛|篮坛|足球|篮球|网球|排球|羽毛球|乒乓球|奥运|世界杯|比赛|赛事|英超|欧冠|中超|NBA|CBA|F1/i.test(value)
    && /新闻|资讯|动态|消息|转会/.test(value)
    && !/修复|开发|实现|代码|写一?|生成|制作|新闻稿|文档|PPT/i.test(value)
    && !/^(?:不要|不用|别|取消|停止)(?:再|查|搜|看|发|给我|今天|今日|的|体育|足球|篮球)*(?:新闻|资讯|动态|消息)/.test(value);
}
export function sportsNewsIntent(text = '') {
  if (!sportsNewsTopic(text)) return false;
  const positive = String(text).replace(/(?:不要|不用|别|无需|不想看|不需要)(?:再|给我|推荐|推|提供|看|查|报|的|\s)*(?:(?:比分|赛程|赛果|对阵|比赛结果)(?:和|、|与|及|\/|\s)*)+/g, '');
  return !/比分|赛程|赛果|对阵|开球时间|比赛结果|几比几|谁赢/.test(positive);
}
export const SPORTS_NEWS_NOTE = '用户要的是体育资讯：搜索体育新闻、转会、伤病及赛事动态，给出报道内容和实际来源，不能用赛程表、对阵或比分卡替代。当前get_today_news综合汇总没有体育栏目，体育资讯请用web_search，必要时fetch_url读报道；找不到就说明实际检索结果，不改答比分。历史中的赛程话题不能覆盖本次资讯要求。';
export function todayNewsIntent(text = '') {
  const value = String(text).replace(/^【这是定时任务[\s\S]*?】\s*/, '').trim();
  return value.length <= 1500 && !sportsNewsTopic(value) && !lookupComplaint(value) && !/修复|开发|实现|代码|工具说明|功能设计|接口设计/.test(value) && !/^(?:不要|不用|别|取消|停止)(?:查|搜|再查|再搜|发|看|给我|今天|今日|的)*(?:新闻|资讯)/.test(value) && /新闻|资讯|早报|晚报/.test(value)
    && /今日|今天|每日|重点新闻|新闻简报|新闻早报|新闻晚报/.test(value)
    && !/昨天|昨日|前天|去年|上周|历史新闻|20\d{2}[年/-]/.test(value);
}
export const NEWS_LOOKUP_NOTE = '今日新闻优先使用get_today_news，结果已按北京时间筛选当天。区分汇总页已读取和报道原文已核实；用户明确要求逐条打开原文时，仍须fetch_url读取对应报道。拿到多少先给多少，不只交链接，不把标题扩写成未取得的事实。';
export const WEB_LOOKUP_NOTE = '查几个方面或几个对象时，同一轮一起调用web_search/fetch_url，或使用web_search.queries并发；次数照常计预算。先给已查到的具体内容并附来源，来源矛盾分别说明；只见搜索摘要或汇总页时明确尚未读报道原文，不冒充核实。够用就答，不为凑次数重复搜索。公开JSON数据可用fetch_json，只有设置里信任的域名可读，不猜数据单位、复权口径或日期。';

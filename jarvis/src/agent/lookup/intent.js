/** 查询意图的单一规则表。第1步只接新闻/体育；其他类别供迁移测试，不改变旧工具行为。 */
export const LOOKUP_KINDS = ['weather', 'sports_live', 'sports_news', 'news', 'market', 'general', 'meta'];
const META = /^(?:(?:未央|你|你的|这个|这|查个|发个|发|查|今日|今天|新闻|体育资讯|体育新闻|体坛动态|天气|行情|汇率|比分|赛程|查询))*?(?:(?:怎么|为什么|咋)(?:这么|那么)?慢|(?:这么|那么|太)慢|还没好|还没查完|还没结束|在干嘛|在做什么|到底在干什么|谁让你这么做的|谁让你查的|谁让你搜的|好了吗|做完了吗|进展如何|什么进度)$/;
const ACTION = /(?:修复|重构|开发|实现|安装|部署|删除|移动|重命名|生成|制作|创作|写一?|画一?|唱一?|翻译|总结|改写|朗读|记住|设置|定时|提醒|架构图|流程图|PPT|Word|Excel|文档|论文|方案|代码|工具说明|功能设计|接口设计|新闻稿)/i;
const SPORT = /体育|体坛|足坛|篮坛|足球|篮球|网球|乒乓|羽毛球|排球|世界杯|奥运|NBA|CBA|F1|英超|欧冠|中超|比赛|赛事/i;
const NEWS = /资讯|新闻|消息|动态|转会|伤病|早报|晚报|头条/;
const withoutNegativeScores = text => text.replace(/(?:不要|不用|不需要|别|无需|不想看)(?:再|给我|推|推荐|看|查|提供|报|写|显示|的|\s)*(?:(?:比分|赛程|赛果|对阵|比赛结果)(?:和|、|与|及|\/|\s)*)+/g, '');
const LIVE = /比分|赛程|赛果|对阵|比赛结果|几比几|谁赢|开球|(?:什么|哪些|有没有|剩余|剩下|未开赛|正在进行).{0,5}(?:比赛|球赛)|现在有什么球/;
const dateMode = text => /昨天|昨日|前天|上周|去年|历史新闻|20\d{2}[年/-]/.test(text) ? 'specified' : /今天|今日/.test(text) ? 'today' : /最近|近期|体育|体坛|转会|伤病/.test(text) ? 'recent24h' : 'today';
function newsParams(text, sports = false) {
  const categories = sports ? ['体育'] : [];
  if (!sports) {
    if (/国内/.test(text)) categories.push('国内');
    if (/国际|全球|世界新闻|路透|BBC|卫报|半岛/i.test(text)) categories.push('国际');
    if (/财经|经济|金融/.test(text)) categories.push('财经');
    if (/科技/.test(text)) categories.push('科技');
  }
  return { categories, dateMode: dateMode(text) };
}
function sportsParams(text) {
  const football = /足球|足彩|竞彩|英超|欧冠|中超|球赛|现在有什么球/.test(text);
  const params = { sport: /NBA|CBA|篮球/i.test(text) ? 'basketball' : /网球/.test(text) ? 'tennis' : football ? 'football' : 'all' };
  if (/全天|整天/.test(text)) params.period = 'all';
  else if (/下午/.test(text)) params.period = 'afternoon';
  else if (/剩余|剩下/.test(text)) params.period = 'remaining';
  else if (/前后/.test(text)) Object.assign(params, { period: 'around', window_minutes: 120 });
  else if (/^(?:今天|今日)?(?:足球|足彩|竞彩足球|比赛)赛程[？?。\s]*$/.test(text)) Object.assign(params, { sport: 'football', period: 'forward_live', window_minutes: 120, states: ['in', 'pre'], policy: 'user_football_forward_two_hours' });
  else if (/接下来|未来/.test(text)) Object.assign(params, { period: 'upcoming', window_minutes: /两小时|二小时|2小时/.test(text) ? 120 : 60 });
  return params;
}
export const LOOKUP_RULES = [
  { id: 'weather', kind: 'weather', test: t => /天气|气温|下雨|下雪|空气质量|带伞|集团年天气/.test(t), params: t => ({ ...(t === '集团年天气' ? { city: '南京', alias: 'user_confirmed_typo' } : {}), dateMode: dateMode(t) }) },
  { id: 'sports_news', kind: 'sports_news', test: t => SPORT.test(t) && NEWS.test(t), params: t => ({ ...newsParams(t, true), includeScores: LIVE.test(withoutNegativeScores(t)) }) },
  { id: 'sports_live', kind: 'sports_live', test: t => LIVE.test(t), params: sportsParams },
  { id: 'news', kind: 'news', test: t => NEWS.test(t), params: t => newsParams(t) },
  { id: 'market', kind: 'market', test: t => /股价|行情|大盘|收盘价|汇率|油价|金价|币价|上证|深证|股票|持仓盈亏/.test(t), params: () => ({}) }
];
export function lookupIntent(text = '', { history = [], preferences = [] } = {}) {
  const original = String(text).trim();
  const value = original.replace(/^【这是定时任务[\s\S]*?】\s*/, '').trim();
  const compact = value.replace(/[，,。！？!?\s]+/g, '');
  if (compact.length <= 80 && META.test(compact)) return { kind: 'meta', params: { metaType: 'status' }, sure: true, lookup: false, rule: 'meta' };
  if (/^(?:你好|早上好|晚上好|谢谢|晚安|在吗|我(?:最近)?好累|陪我聊聊)[。！!\s]*$/.test(value)) return { kind: 'meta', params: { metaType: 'smalltalk' }, sure: true, lookup: false, rule: 'meta' };
  if (/^(?:各[一二两三四五六七八九十\d]+条|继续|再查|再查一会儿)[。！!\s]*$/.test(value)) {
    const previous = [...history].reverse().find(m => m.role === 'user' && !/^(?:继续|再查|各.{0,3}条)/.test(String(m.content || '')));
    if (previous) {
      const inherited = lookupIntent(previous.content, { preferences });
      if (inherited.lookup) return { ...inherited, params: { ...inherited.params, continuation: true, ...(/^各/.test(value) ? { perCategory: Number(value.match(/\d+/)?.[0] || ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 }[value[1]] || 3)) } : {}) }, rule: 'continuation' };
    }
    return { kind: 'general', params: { continuation: true }, sure: false, lookup: true, rule: 'missing_context' };
  }
  const preference = preferences.slice(0, 20).find(p => p.phrases?.slice(0, 12).includes(value) && LOOKUP_KINDS.includes(p.kind));
  if (preference) return { kind: preference.kind, params: { ...preference.params }, sure: true, lookup: true, rule: 'user_preference' };
  const intentText = value.replace(/(?:不要|不用|无需|别)(?:再|给我|写|提到|出现|输出|显示|包含|任何|具体的?|的|\s)*(?:时间|日期|比分|赛程|免责声明|引言)/g, '');
  if (!value || value.length > 1500 || ACTION.test(intentText) || /^(?:不要|不用|不需要|别|取消|停止)(?:再|查|搜|看|发|给我|今天|今日|的|体育|足球|篮球)*(?:新闻|资讯|动态|消息)/.test(value)) return { kind: 'general', params: {}, sure: false, lookup: false, rule: 'non_lookup' };
  const rule = LOOKUP_RULES.find(r => r.test(value));
  return rule ? { kind: rule.kind, params: rule.params(value), sure: true, lookup: true, rule: rule.id } : { kind: 'general', params: {}, sure: false, lookup: true, rule: 'general' };
}

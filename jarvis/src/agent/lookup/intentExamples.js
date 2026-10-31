/** 用户真实问法与容易混淆的反例；同表供单元测试和国内只读实测分类部分使用。 */
export const LOOKUP_INTENT_EXAMPLES = [
  ['体育资讯', 'sports_news'], ['最近体育资讯', 'sports_news'], ['今天体育新闻', 'sports_news'], ['NBA转会消息', 'sports_news'], ['足球伤病动态', 'sports_news'], ['体坛动态', 'sports_news'],
  ['给我体育资讯，不要比分', 'sports_news'], ['看看比赛有什么新闻', 'sports_news'], ['体育新闻和NBA比分', 'sports_news'],
  ['足彩赛程', 'sports_live'], ['今天足球赛程', 'sports_live'], ['足球赛程', 'sports_live'], ['今天比赛赛程', 'sports_live'], ['今天有什么比赛', 'sports_live'], ['NBA比分多少', 'sports_live'],
  ['昨晚欧冠赛果', 'sports_live'], ['明天中超赛程', 'sports_live'], ['下午足球赛程', 'sports_live'], ['今天剩余比赛', 'sports_live'], ['前后两小时足球赛程', 'sports_live'],
  ['今日新闻', 'news'], ['今天重点新闻', 'news'], ['国际新闻', 'news'], ['财经早报', 'news'], ['科技资讯', 'news'], ['每日重点新闻', 'news'],
  ['今天天气', 'weather'], ['南京天气', 'weather'], ['集团年天气', 'weather'], ['明天下雨吗', 'weather'], ['今天出门要带伞吗', 'weather'],
  ['今天大盘怎么样', 'market'], ['人民币汇率', 'market'], ['黄金价格', 'market'], ['查一下收盘价', 'market'], ['我的持仓盈亏', 'market'],
  ['gpt-sol 最便宜的中转平台', 'general'], ['怎么申请公共服务资格', 'general'], ['最近有什么好看的电视剧', 'general'],
  ['发个新闻那么慢', 'meta'], ['你在干嘛', 'meta'], ['体育资讯怎么这么慢', 'meta'], ['好了吗', 'meta'], ['你好', 'meta'], ['我好累', 'meta']
].map(([text, kind]) => ({ text, kind }));

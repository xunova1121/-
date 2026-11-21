/** 固定公开RSS入口。路透使用CNA明确署名的转载，不冒充Reuters官方免费RSS。 */
const bbc = (section, category) => ({ id: 'bbc', label: 'BBC', format: 'rss', family: 'bbc', category, hosts: ['www.bbc.com', 'www.bbc.co.uk', 'bbc.com', 'bbc.co.uk'], url: `https://feeds.bbci.co.uk/${section}/rss.xml` });
const guardian = sport => ({ id: 'guardian', label: '卫报', format: 'rss', family: 'guardian', category: sport ? '体育' : '国际', hosts: ['www.theguardian.com'], url: `https://www.theguardian.com/${sport ? 'sport' : 'world'}/rss` });
const reuters = category => ({ id: 'reuters', label: '路透（CNA转载）', format: 'rss', family: 'reuters', category, reprint: true, hosts: ['www.channelnewsasia.com'], url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=' + ({ 体育: '10296', 财经: '6936' }[category] || '6311') });
const aljazeera = { id: 'aljazeera', label: '半岛电视台', format: 'rss', family: 'aljazeera', category: '国际', hosts: ['www.aljazeera.com', 'aljazeera.com'], url: 'https://www.aljazeera.com/xml/rss/all.xml' };
export const NEWS_PUBLISHERS = ['新华财经', '央广网', '中新网', 'BBC', '路透', '卫报', '半岛电视台'];
export function internationalNewsFeeds(categories = [], publishers = []) {
  const sport = categories.length === 1 && categories[0] === '体育';
  const business = categories.length === 1 && categories[0] === '财经';
  const tech = categories.length === 1 && categories[0] === '科技';
  const feeds = [bbc(sport ? 'sport' : business ? 'news/business' : tech ? 'news/technology' : 'news/world', sport ? '体育' : business ? '财经' : tech ? '科技' : '国际'), reuters(sport ? '体育' : business ? '财经' : '国际')];
  if (tech) feeds.splice(1, 1);
  // 国际/体育专题读取多个视角；普通综合简报留出最多三次真实转载页核对预算。
  if (sport || categories.includes('国际') || publishers.length) feeds.push(guardian(sport), ...(!sport ? [aljazeera] : []));
  return feeds.filter(feed => !publishers.length || publishers.some(p => feed.label.startsWith(p)));
}

import { htmlToText } from './docs.js';
import { businessDate, businessDay, businessSource, cleanBusinessText, noticeType } from './businessSources.js';

/** 解析实际公开的CCGP列表；不使用未公开API，也不把导航当公告。 */
export function parseTenderListing(html, base = 'https://www.ccgp.gov.cn/cggg/') {
  const rows = [];
  for (const block of String(html).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const a = block[1].match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let url; try { url = new URL(a[1].replace(/&amp;/g, '&'), base).href; } catch { continue; }
    if (!businessSource(url) || !/\/cggg\/.+\.html?$/i.test(new URL(url).pathname)) continue;
    const snippet = cleanBusinessText(htmlToText(block[1]), 500);
    const publishedAt = businessDate(snippet.match(/发布时间\s*[:：]?\s*([^地]+?)(?:地域|采购人|$)/)?.[1]);
    const title = cleanBusinessText(htmlToText(a[2]), 180);
    if (!title || !publishedAt) continue;
    rows.push({ title, url, publishedAt, region: snippet.match(/地域\s*[:：]\s*(.*?)\s*采购人/)?.[1] || '', snippet, type: noticeType(title), evidence: 'official_listing' });
    if (rows.length >= 80) break;
  }
  return rows;
}

/** 全国公共资源平台首页的公开交易公告，日期来自可见span，不从URL日期猜测。 */
export function parseGgzyListing(html) {
  const provinces = { '11': '北京', '12': '天津', '13': '河北', '14': '山西', '15': '内蒙古', '21': '辽宁', '22': '吉林', '23': '黑龙江', '31': '上海', '32': '江苏', '33': '浙江', '34': '安徽', '35': '福建', '36': '江西', '37': '山东', '41': '河南', '42': '湖北', '43': '湖南', '44': '广东', '45': '广西', '46': '海南', '50': '重庆', '51': '四川', '52': '贵州', '53': '云南', '54': '西藏', '61': '陕西', '62': '甘肃', '63': '青海', '64': '宁夏', '65': '新疆' };
  const rows = [];
  for (const block of String(html).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const link = block[1].match(/<a\b[^>]*href=["'](\/information\/deal\/html\/a\/(\d+)\/(\d+)\/[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const publishedAt = businessDate(block[1].match(/<span\b[^>]*>\s*(20\d{2}-\d{2}-\d{2})\s*<\/span>/)?.[1]);
    const title = cleanBusinessText(htmlToText(link[4]), 180);
    if (!title || !publishedAt) continue;
    const explicitType = noticeType(title);
    rows.push({ title, url: new URL(link[1], 'https://www.ggzy.gov.cn').href, source: '全国公共资源交易平台',
      publishedAt, region: provinces[link[2].slice(0, 2)] || '', snippet: title,
      type: explicitType !== 'unknown' ? explicitType : ({ '0101': 'tender', '0104': 'award' }[link[3]] || 'unknown'),
      titleTruncated: /(?:\.\.\.|…)$/.test(title), evidence: 'official_listing' });
    if (rows.length >= 80) break;
  }
  return rows;
}

const labeled = (text, label, length = 180) => {
  const re = new RegExp(`(?:${label})[：:\\s]*([^\\n]{1,${length}})`, 'u');
  return cleanBusinessText((re.exec(text)?.[1] || '').split(/(?:信息来源|发布时间|发布日期|预算金额|最高限价|采购人|项目名称)\s*[:：]/)[0], length);
};
/** 官方聚合页用公开的firstLastUrl装载正文，只取同站、同公告ID的固定路径；不执行JS。 */
export function ggzyBodyUrl(html, page) {
  const outer = new URL(page);
  const found = String(html).match(/\bvar\s+firstLastUrl\s*=\s*['"]([^'"]+)['"]/);
  if (!found) return null;
  const inner = new URL(found[1], outer);
  return outer.hostname === 'www.ggzy.gov.cn' && inner.origin === outer.origin && inner.pathname === outer.pathname.replace('/html/a/', '/html/b/') && !inner.search && !inner.hash ? inner.href : null;
}
export function tenderExcerpt(text, max = 1800) {
  const lines = String(text).split(/\n+/).map(row => row.trim()).filter(Boolean);
  const chosen = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!/项目名称|项目编号|预算|最高限价|招标范围|招标内容|招标方式|投资额|投资总额|工期|投标报名|采购需求|资格|截止|开标|更正|变更|中标|成交|公告日期|发布时间|发布日期|采购人|合同履行/.test(lines[i])) continue;
    for (const index of [i, i + 1]) if (lines[index] && !seen.has(index)) { seen.add(index); chosen.push(lines[index]); }
  }
  return (chosen.length ? chosen.join('\n') : lines.join('\n')).slice(0, max);
}
/** 字段保留原文字面，预算与中标金额不互换，未知截止时间不能标记“可投标”。 */
export function parseTenderNotice(text, { url, title = '', now = Date.now() } = {}) {
  const body = String(text || '').split('【页面链接')[0].slice(0, 60000);
  const publishedAt = businessDate(labeled(body, '发布时间|发布日期|公告时间|公告日期', 60));
  const deadlineText = cleanBusinessText(body.match(/(?:提交投标文件截止时间|投标截止时间|响应文件提交截止时间|响应文件截止时间)\s*[:：]\s*([^\n]{1,100})/)?.[1] || '', 100);
  const deadlineDay = businessDate(deadlineText);
  const clock = deadlineText.match(/(?:日|\d{1,2})(?:\s+|T)(\d{1,2})[:：时点](\d{2})(?:分)?/);
  const deadlineAt = deadlineDay && clock ? Date.parse(`${deadlineDay}T${clock[1].padStart(2, '0')}:${clock[2]}:00+08:00`) : NaN;
  const actualTitle = cleanBusinessText(title || labeled(body, '项目名称', 150), 180);
  const type = noticeType(actualTitle);
  const closed = ['award', 'terminated'].includes(type) || (Number.isFinite(deadlineAt) ? deadlineAt <= now : deadlineDay && deadlineDay < businessDay(now));
  return {
    title: actualTitle, url, source: businessSource(url)?.label || '原网页', type,
    publishedAt: publishedAt || null,
    region: labeled(body, '项目所在地|项目地点|工程地点|项目地址|服务地点', 80) || null,
    projectNumber: labeled(body, '项目编号', 100) || null,
    budgetText: labeled(body, '预算金额', 100) || null,
    ceilingText: labeled(body, '最高限价', 100) || null,
    deadlineText: deadlineText || null,
    status: closed ? 'closed' : 'needs_verification',
    statusNote: closed ? '已截止或属于结果/终止公告' : '须核对报名条件、最新更正和截止时间，不能据此承诺仍可投标',
    excerpt: tenderExcerpt(body), retrievedAt: new Date(now).toISOString(), evidence: 'original_page'
  };
}

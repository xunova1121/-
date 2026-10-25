/** 只检查可确定的输出约束；不把关键词匹配冒充事实核验。 */
export function answerConstraints(request = '') {
  const value = String(request).slice(-8000);
  const unquoted = value.replace(/[“「"'][^”」"'\n]*[”」"']/g, '');
  const noTime = /(?:不要|别提|不提|不写|不包含|不涉及|不带)(?:任何|具体的?)?(?:时间|日期)/.test(unquoted);
  const literals = [...value.matchAll(/(?:不要|不得|禁止)(?:出现|使用|写|包含|提到)?\s*[“"「]([^”"」]{1,40})[”"」]/g)].map(match => match[1]).slice(0, 8);
  const todayNews = /今天|今日/.test(unquoted) && /新闻|资讯/.test(unquoted);
  return { noTime, literals, todayNews };
}

export function answerConstraintIssues(request, answer, now = Date.now()) {
  const rules = answerConstraints(request);
  const text = String(answer);
  const issues = [];
  if (rules.noTime && /时间|日期|今天|明天|后天|上午|下午|晚上|今晚|周[一二三四五六日天末]|星期[一二三四五六日天]|\d{1,2}[:：]\d{2}|\d{1,2}月\d{1,2}日/.test(text)) issues.push('用户要求不提时间或日期，正文仍有相关表述；只重写这段内容，不增加新安排');
  if (rules.literals.some(word => text.includes(word))) issues.push('正文出现了用户明确禁止输出的引号内文字；移除这些文字后重写，不复述禁用词');
  if (rules.todayNews) {
    const day = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const [, month, date] = day.split('-').map(Number);
    const stamps = [...text.matchAll(/(?:发布时间|报道时间|(?<!发生|事件)时间)[*：:\s]{0,10}(?:\d{4}年)?(\d{1,2})月(\d{1,2})日/g)];
    if (stamps.some(match => Number(match[1]) !== month || Number(match[2]) !== date)) issues.push('今日新闻里有明确标注的非今日发布时间；换成有今日发布证据的报道，不够数量就如实说明，不能改日期凑数');
  }
  return issues;
}

export function concreteSourceRequirement(request = '') {
  const text = String(request);
  if (/政府|政务|信息公开/.test(text) && /申请渠道|申请方式|申请入口|提交渠道|提交方式/.test(text)) return 'channel';
  return /(?:查|找|提供).{0,40}具体(?:的)?(?:链接|入口)/.test(text) ? 'link' : null;
}

const CHANNEL = /网上申请|在线申请|当面申请|现场申请|邮寄申请|传真申请|邮寄至|在线提交|受理地址/g;
export function channelKinds(text = '') {
  const chunks = String(text).slice(0, 24000).split(/[。；;，,\n]/);
  return [...new Set(chunks.filter(part => !/无法|不能|未能|未找到|未显示|未确认|不支持|不受理/.test(part)).flatMap(part => part.match(CHANNEL) || []))].slice(0, 8);
}

/** 只保留8个候选URL和有限标签，不把网页正文塞进验收记录。 */
export function sourceCandidates(request, toolName, output, args = {}) {
  const kind = concreteSourceRequirement(request);
  if (!kind || !/^(?:fetch_url|read_evidence|fact_check)$/.test(toolName)) return [];
  const text = String(output).split('【页面内链接（链接指向的内容尚未读取）】')[0].slice(0, 24000);
  if (toolName === 'fetch_url' && /^原网页读取失败/.test(text)) return [];
  if (kind === 'channel' && !channelKinds(text).length) return [];
  const urls = toolName === 'fetch_url' && args.url
    ? [String(args.url)]
    : [...text.matchAll(/https?:\/\/[^\s<>"'\)）\]，。]+/g)].map(match => match[0]);
  return [...new Set(urls.filter(value => {
    if (value.length > 1200) return false;
    try {
      const url = new URL(value);
      if (url.username || url.password) return false;
      return kind !== 'channel' || /(?:^|\.)gov\.cn$/.test(url.hostname);
    } catch {
      return false;
    }
  }))].slice(0, 8);
}

export function sourceAnswerIssue(request, answer, sources) {
  const kind = concreteSourceRequirement(request);
  if (!kind) return '';
  const urls = String(answer).match(/https?:\/\/[^\s)）\]，。]+/g) || [];
  if (!urls.some(url => sources.includes(url)) || kind === 'channel' && !channelKinds(answer).length) return '尚未取得匹配具体渠道/入口的有效候选证据；搜索次数和导航页不代表完成。继续在原任务范围核对具体提交方式及原文链接，预算不足则明确只完成部分，不能编造';
  return '';
}

import { answerConstraints, answerConstraintIssues } from './answerRequirements.js';

/** 只保留独立、带当日发布标注和网址的条目；不把旧报道改日期，不拼接未核实数字。 */
export function safeNewsPartial(request, answer, now = Date.now()) {
  if (!answerConstraints(request).todayNews) return '';
  const date = new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const [year, month, day] = date.split('-').map(Number);
  const blocks = String(answer).slice(0, 24000).split(/\n(?=(?:#{1,3}\s|(?:\*\*)?\d+[.、．]))/).slice(0, 16);
  const valid = blocks.filter(block => {
    if (!/https?:\/\/[^\s)]+/.test(block) || answerConstraintIssues(request, block, now).length) return false;
    // “时间：央视《新闻直播间》10月30日01:00节目”这种写法也认（第三轮 30 题：只认“发布时间”，三条一条没保住，退回成候选链接）
    const stamps = [...block.matchAll(/(?:发布时间|报道时间|时间)[*：:\s]{0,10}[^\d\n]{0,24}?(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})日?/g)];
    return stamps.length && stamps.every(match => (!match[1] || +match[1] === year) && +match[2] === month && +match[3] === day);
  }).slice(0, 3);
  return valid.length ? '只保留以下带今日发布时间标注的部分内容；本轮尚未完成全部原文核实。\n\n' + valid.join('\n\n') : '';
}

/** 检索候选只保留8条短标题/网址，不缓存摘要；候选不能冒充已读原文。 */
export function newsCandidates(output) {
  const lines = String(output).slice(0, 24000).split('\n');
  const items = new Map();
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].trim().match(/^https?:\/\/[^\s]+$/);
    if (!match) continue;
    try {
      const url = new URL(match[0]);
      if (url.username || url.password || url.href.length > 1200 || [...url.searchParams.keys()].some(key => /token|password|secret|key/i.test(key))) continue;
      const title = (lines[index - 1] || '候选来源').replace(/^[-#*\s]+/, '').replace(/[\[\]\r\n]/g, '').slice(0, 120);
      items.set(url.href, { title, url: url.href });
    } catch { /* 丢弃无效网址，不猜测或请求地址。 */ }
    if (items.size === 8) break;
  }
  return [...items.values()];
}

export function newsCandidateLinks(request, candidates) {
  if (!answerConstraints(request).todayNews || !candidates.length) return '';
  const text = '已找到以下候选来源，但尚未完成原文核实，不能当作新闻结论：\n' + candidates.slice(0, 8).map(item => `- [${item.title}](${item.url.replace(/[()]/g, character => '%' + character.charCodeAt(0).toString(16))})`).join('\n');
  return answerConstraintIssues(request, text).length ? '' : text;
}

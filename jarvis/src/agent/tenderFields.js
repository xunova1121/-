import { htmlToText } from './docs.js';
import { parseTenderNotice } from './tenderNotices.js';

const amount = value => {
  const text = String(value || '').trim().replace(/[,，]/g, '');
  const match = text.match(/^(?:人民币\s*|[￥¥]\s*)?(\d+(?:\.\d+)?)\s*([亿万]?元)/);
  return match ? `${match[1]}${match[2]}` : null;
};
const cellText = text => htmlToText(text).replace(/\s+/g, ' ').trim();
/** 只取单包、明确列头的表格金额；多个包件不猜合计，不混入中标/最高限价。 */
function tableAmounts(html, text) {
  for (const table of String(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => cellText(cell[1])));
    const index = rows.findIndex(row => row.some(cell => /^预算金额/.test(cell)));
    if (index < 0) continue;
    const header = rows[index], values = rows.slice(index + 1).filter(row => row.length === header.length);
    if (values.length !== 1) return {};
    const out = {};
    for (const [label, key] of [['预算金额', 'budgetText'], ['最高限价', 'ceilingText']]) {
      const column = header.findIndex(cell => cell.startsWith(label));
      if (column < 0) continue;
      const unit = header[column].match(/[（(]([亿万]?元)[）)]/)?.[1];
      const value = values[0][column].replace(/[,，\s]/g, '');
      out[key] = amount(value) || (unit && /^\d+(?:\.\d+)?$/.test(value) ? value + unit : null);
    }
    return out;
  }
  // 官方聚合正文有时已把表格压成纯文本：只认明确的相邻预算/限价列，
  // 同一采购需求段恰有一对两位小数金额才读取；多行、缺列或单位不明保留未知。
  const header = text.match(/预算金额[（(]([亿万]?元)[）)]\s+最高限价[（(]([亿万]?元)[）)]\s+标的名称\s+简要技术需求或服务要求\s+数量/);
  if (!header) return {};
  const section = text.slice(header.index + header[0].length).split(/\s[一二三四五六七八九十]+、/)[0];
  const pairs = [...section.matchAll(/(?:^|\s)(\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})(?=\s|$)/g)];
  if (pairs.length !== 1) return {};
  return { budgetText: pairs[0][1].replaceAll(',', '') + header[1], ceilingText: pairs[0][2].replaceAll(',', '') + header[2] };
}

export function parseTenderFields(html, row, now) {
  const text = htmlToText(html), original = parseTenderNotice(text, { url: row.url, title: row.title, now });
  const table = tableAmounts(html, text);
  const project = text.match(/(?:采购项目编号|项目编号)\s*[:：]\s*([^\s，,；;]{3,100})/)?.[1] || null;
  const deadline = original.deadlineText?.match(/^(20\d{2}[年/.-]\d{1,2}[月/.-]\d{1,2}日?(?:\s+\d{1,2}[:：点时]\d{1,2}(?:[:：]\d{1,2}|分)?(?:\s*[（(]北京时间[）)])?)?)/)?.[1] || null;
  const inferred = row.type === 'unknown' && /进行公开招标采购|现邀请合格投标人参加投标/.test(text) ? 'tender' : row.type;
  return { projectNumber: project, budgetText: table.budgetText || amount(original.budgetText), ceilingText: table.ceilingText || amount(original.ceilingText),
    deadlineText: deadline, excerpt: original.excerpt, status: original.status, type: inferred, detailAt: now };
}

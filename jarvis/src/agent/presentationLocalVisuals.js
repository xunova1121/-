import { plain } from './docModel.js';
/** 只统计明确列；时间按小时汇总，不根据时间猜比赛状态，不处理不完整时间值。 */
export function summarizeTable(table) {
  if (!table || table.rows.length < 2 || table.rows.length > 200) return null;
  const headers = table.header.map(plain);
  const timeColumn = headers.findIndex(value => /^(?:开赛(?:时间)?|时间|开始时间|开球时间)$/.test(value.trim()));
  const categoryColumn = headers.findIndex(value => /^(?:状态|类别|分类)$/.test(value.trim()));
  const column = timeColumn >= 0 ? timeColumn : categoryColumn;
  if (column < 0) return null;
  const counts = new Map();
  for (const row of table.rows) {
    const value = plain(row[column] || []).trim();
    const match = /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+)?([01]?\d|2[0-3])[:：]([0-5]\d)$/.exec(value);
    if (timeColumn >= 0 && !match || !value || value.length > 16) return null;
    const key = timeColumn >= 0 ? `${match[1].padStart(2,'0')}:00` : value;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size > 6) return null;
  const entries = [...counts].sort((a,b)=>timeColumn >= 0 ? a[0].localeCompare(b[0]) : 0);
  return { title: timeColumn >= 0 ? '按开赛小时统计' : `按${headers[column]}统计`, labels: entries.map(item=>item[0]), values: entries.map(item=>item[1]), total: table.rows.length, sourceColumn: headers[column] };
}
/** 本地固定矢量零件：只有主题色及枚举，无任意SVG/外链，不调用画图模型。 */
export function decorationSvg(topic, color = '087E8B') {
  const ink = /^[0-9a-f]{6}$/i.test(color) ? color : '087E8B';
  const field = /足球|球场|赛程|比赛/.test(topic);
  const drawing = field
    ? '<rect x="50" y="70" width="460" height="820" rx="8"/><path d="M50 480H510"/><circle cx="280" cy="480" r="75"/><rect x="155" y="70" width="250" height="140"/><rect x="155" y="750" width="250" height="140"/>'
    : '<circle cx="280" cy="280" r="190"/><circle cx="380" cy="650" r="120"/><path d="M50 820L500 370M50 870L500 420M60 80H500"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="960" viewBox="0 0 560 960"><rect width="560" height="960" fill="#${ink}"/><g fill="none" stroke="#FFFFFF" stroke-width="6" opacity="0.75">${drawing}</g></svg>`;
}
export async function decorationData(topic, color, render, signal) {
  if (!render) return null;
  const blob = await render(decorationSvg(topic, color), { signal });
  signal?.throwIfAborted();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > 2e6 || bytes[0] !== 137 || bytes[1] !== 80) throw new Error('本地装饰未得到有效PNG');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return 'image/png;base64,' + btoa(binary);
}

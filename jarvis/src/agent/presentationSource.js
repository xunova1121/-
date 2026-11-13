import { openOfficePackage, orderedSlidePaths, xmlUnescape } from './officePackage.js';
import { documentError } from './documentPlan.js';
const clean = text => String(text).replace(/\s/g, '').replace(/[—–－]/g, '-');
const rowKey = row => JSON.stringify(row.map(clean));
function rowsFromXml(xml, ns) {
  return [...xml.matchAll(new RegExp(`<${ns}:tr\\b[^>]*>([\\s\\S]*?)</${ns}:tr>`, 'g'))].filter(row => ns !== 'w' || !/<w:tblHeader\b/.test(row[1])).map(row =>
    [...row[1].matchAll(new RegExp(`<${ns}:tc\\b[^>]*>([\\s\\S]*?)</${ns}:tc>`, 'g'))].map(cell =>
      [...cell[1].matchAll(new RegExp(`<${ns}:t\\b[^>]*>([^<]*)</${ns}:t>`, 'g'))].map(m => xmlUnescape(m[1])).join('')));
}
export async function wordTableSource(blob) {
  const zip = await openOfficePackage(blob);
  const part = zip.file('word/document.xml');
  if (!part) throw documentError('原材料不是有效DOCX', 'DOCUMENT_SOURCE');
  return rowsFromXml(await part.async('string'), 'w');
}
/** 其余列完全相同且来源唯一时恢复原编号，不猜测相似记录，不填造缺失行。 */
export function restoreTableIdentifiers(content, sourceRows) {
  const lookup = new Map();
  for (const row of sourceRows.filter(row => row.length > 1)) {
    const key = rowKey(row.slice(1));
    lookup.set(key, lookup.has(key) ? null : row[0]);
  }
  return String(content).split('\n').map(line => {
    if (!/^\s*\|.*\|\s*$/.test(line)) return line;
    const cells = line.trim().slice(1, -1).split('|').map(text => text.trim());
    const id = lookup.get(rowKey(cells.slice(1)));
    if (id == null || cells[0] === id) return line;
    cells[0] = id;
    return '| ' + cells.join(' | ') + ' |';
  }).join('\n');
}
export async function verifyPresentationTables(blob, sourceRows) {
  const zip = await openOfficePackage(blob);
  const target = new Map();
  for (const part of await orderedSlidePaths(zip)) {
    for (const row of rowsFromXml(await zip.file(part).async('string'), 'a')) {
      const key = rowKey(row); target.set(key, (target.get(key) || 0) + 1);
    }
  }
  const missing = [];
  for (const row of sourceRows) {
    const key = rowKey(row), count = target.get(key) || 0;
    if (count) target.set(key, count - 1); else missing.push(row[0]);
  }
  if (missing.length) throw documentError(`原表有${missing.length}行尚未完整保留（含原编号/字段）：${missing.slice(0, 8).join('、')}；请用原表格，不缩写编号或删行`, 'DOCUMENT_SOURCE');
  return { rows: sourceRows.length, state: 'passed' };
}

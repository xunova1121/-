import { xmlUnescape } from './officePackage.js';

/** 明确字数范围才验收；统计Word主文档可见文字（含标题/表格/标点，不含空白及页眉页脚）。 */
export function requestedLength(task = '') {
  const text = String(task).slice(0, 16000);
  const range = text.match(/(\d{1,6})\s*(?:至|到|[-—~～])\s*(\d{1,6})\s*字/);
  if (range && +range[1] <= +range[2]) return { min: +range[1], max: +range[2] };
  const maximum = text.match(/(\d{1,6})\s*字(?:以内|以下|内)/);
  return maximum ? { min: 0, max: +maximum[1] } : null;
}

export async function inspectLength(zip, task) {
  const range = requestedLength(task);
  if (!range || !zip?.file('word/document.xml')) return null;
  const xml = await zip.file('word/document.xml').async('string');
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(match => xmlUnescape(match[1])).join('');
  const count = Array.from(text.replace(/\s/g, '')).length;
  return { ...range, count, passed: count >= range.min && count <= range.max, scope: 'Word主文档可见非空白字符，含标题/表格/标点，不含页眉页脚' };
}

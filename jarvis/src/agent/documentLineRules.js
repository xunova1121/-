import { parseXml, serialize } from './documentXml.js';
import { editWord } from './wordStructuredEdit.js';
import { openOfficePackage } from './officePackage.js';
/** 只改段落横线和下划线，不删表格边框、文字、图片、链接关系。 */
export async function stripDocumentLines(blob, { noRules = false, noUnderline = false, noTitleLines = false, signal } = {}) {
  const zip = await openOfficePackage(blob);
  if (noTitleLines) {
    const doc = parseXml(await zip.file('word/document.xml').async('string'));
    const styles = parseXml(await zip.file('word/styles.xml').async('string'));
    const { wordObjects } = await import('./wordStructuredEdit.js');
    const objects = wordObjects(doc, styles);
    const operations = ['title','heading'].filter(role => objects.paragraphs.some(p => p.role === role)).map(role => ({action:'format',target:{role},properties:{remove_lines:true,underline:false}}));
    if (operations.length) editWord(doc, styles, operations);
    zip.file('word/document.xml', serialize(doc));
  }
  for (const name of Object.keys(zip.files).filter(name => /^word\/(?:document|styles|header\d+|footer\d+)\.xml$/.test(name))) {
    signal?.throwIfAborted();
    let xml = await zip.file(name).async('string');
    if (noRules) xml = xml.replace(/<w:pBdr\b[^>]*>[\s\S]*?<\/w:pBdr>/g, bdr => {
      const kept = bdr.replace(/<w:(?:top|bottom)\b[^>]*\/>/g, '').replace(/<w:(?:top|bottom)\b[^>]*>[\s\S]*?<\/w:(?:top|bottom)>/g, '');
      return /<w:(?:left|right|between|bar)\b/.test(kept) ? kept : '';
    });
    if (noUnderline) xml = xml.replace(/<w:u\b[^>]*?(?:\/>|>[\s\S]*?<\/w:u>)/g, '');
    zip.file(name, xml);
  }
  signal?.throwIfAborted();
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return new Blob([bytes], { type: blob.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
function requestedLines(text) {
  const result = {};
  for (const clause of String(text).split(/[。；;\n]/)) {
    if (/标题/.test(clause) && /(?:不要|去掉|删除|取消|不加|不用).{0,8}下划线/.test(clause)) { result.noTitleLines = true; continue; }
    for (const [key, noun] of [['noRules', '横线|分割线|分隔线'], ['noUnderline', '下划线']]) {
      if (new RegExp(`(?:不要|不加|不用|去掉|删除|取消|别).{0,8}(?:${noun})`).test(clause)) result[key] = true;
      else if (new RegExp(`(?:保留|需要|加上|恢复|使用).{0,8}(?:${noun})`).test(clause)) result[key] = false;
    }
  }
  return result;
}
/** 历史偏好仅取all/docx，最新同范围优先；本次明确要求覆盖历史。 */
export async function documentLinePreferences(ctx, request, signal) {
  signal?.throwIfAborted();
  const history = ctx.documentStylePreferences ? await ctx.documentStylePreferences(signal) : '';
  signal?.throwIfAborted();
  const entries = String(history).slice(0, 24000).split('\n').filter(line => /^- (?:all|docx) · /.test(line)).reverse();
  return Object.assign({}, ...entries.filter(line => line.startsWith('- all · ')).map(requestedLines), ...entries.filter(line => line.startsWith('- docx · ')).map(requestedLines), requestedLines(request));
}

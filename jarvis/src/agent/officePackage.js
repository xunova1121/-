import { documentError } from './documentPlan.js';

/** 外来Office限20MB压缩/80MB展开、3000个部件，避免模板/检查解压无限增长。 */
export async function openOfficePackage(input) {
  const data = input instanceof Blob ? await input.arrayBuffer() : input;
  if (!data || data.byteLength > 20e6) throw documentError('Office文件超过20MB限制', 'DOCUMENT_SIZE');
  const JSZip = (await import('jszip')).default;
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch (error) {
    throw Object.assign(documentError('Office压缩包无法读取', 'DOCUMENT_PACKAGE'), { cause: error });
  }
  const entries = Object.values(zip.files);
  const expanded = entries.reduce((total, item) => total + (item._data?.uncompressedSize || 0), 0);
  if (entries.length > 3000 || expanded > 80e6) throw documentError('Office展开内容超过安全限制', 'DOCUMENT_SIZE');
  return zip;
}

export const xmlEscape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
export const xmlUnescape = (text) =>
  String(text).replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]);

/** 幻灯片按presentation关系的真实顺序，不能拿slide文件编号当页码。 */
export async function orderedSlidePaths(zip) {
  const presentation = await zip.file('ppt/presentation.xml')?.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (!presentation || !rels) throw documentError('PPT缺少页面关系', 'DOCUMENT_PACKAGE');
  const relationships = new Map();
  for (const match of rels.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const attr = (key) => match[0].match(new RegExp(`\\b${key}="([^"]*)"`))?.[1];
    if (attr('TargetMode') === 'External' || !/\/slide$/.test(attr('Type') || '')) continue;
    const target = attr('Target') || '';
    const resolved = target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\//, '')}`;
    if (resolved.split('/').includes('..') || !/^ppt\/slides\/[^/]+\.xml$/.test(resolved)) continue;
    relationships.set(attr('Id'), resolved);
  }
  const slides = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/?\s*>/g)].map((match) => relationships.get(match[1]));
  if (!slides.length || slides.some((item) => !item || !zip.file(item))) throw documentError('PPT页码关系不完整', 'DOCUMENT_PACKAGE');
  return slides;
}

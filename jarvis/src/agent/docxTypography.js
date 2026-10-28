import { openOfficePackage } from './officePackage.js';
import { normalizeTypography, typographyFont } from './documentTypography.js';
import { documentError } from './documentPlan.js';
const invalid = message => documentError(message, 'DOCUMENT_TYPOGRAPHY');
const property = (xml, tag) => xml.match(new RegExp(`<w:${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</w:${tag}>)`))?.[0] || '';
const fontXml = value => `<w:rFonts w:ascii="${value.ascii}" w:hAnsi="${value.hAnsi}" w:eastAsia="${value.eastAsia}" w:cs="${value.cs}"/>`;
function updateProps(xml, type, changes) {
  if (!changes.length) return xml;
  let props = property(xml, type) || `<w:${type}></w:${type}>`;
  if (props.endsWith('/>')) props = props.replace(/\/>$/, `></w:${type}>`);
  for (const [tag, replacement] of changes) {
    const old = property(props, tag);
    props = old ? props.replace(old, replacement) : props.replace(`</w:${type}>`, replacement + `</w:${type}>`);
  }
  const old = property(xml, type);
  return old ? xml.replace(old, props) : xml.replace(/<\/w:[^>]+>$/, ending => props + ending);
}
function patchTypography(xml, rule) {
  if (!rule) return xml;
  const runs = [], paragraphs = [];
  if (rule.font || rule.excludedFonts?.length) {
    const current = property(xml, 'rFonts').match(/w:eastAsia="([^"]+)"/)?.[1] || '宋体';
    const fallback = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: current, cs: 'Times New Roman' };
    runs.push(['rFonts', fontXml(typographyFont(rule, fallback))]);
  }
  if (rule.size) { runs.push(['sz', `<w:sz w:val="${Math.round(rule.size * 2)}"/>`], ['szCs', `<w:szCs w:val="${Math.round(rule.size * 2)}"/>`]); }
  if (rule.line || rule.before !== undefined || rule.after !== undefined) {
    let spacing = property(xml, 'spacing') || '<w:spacing/>';
    const set = (key, value) => { spacing = spacing.replace(new RegExp(`\\s+w:${key}="[^"]*"`, 'g'), '').replace(/\/>$/, ` w:${key}="${value}"/>`); };
    if (rule.line) { set('line', Math.round(rule.line.value * (rule.line.rule === 'auto' ? 240 : 20))); set('lineRule', rule.line.rule); }
    if (rule.before !== undefined) { set('before', Math.round(rule.before * 20)); spacing = spacing.replace(/\s+w:beforeLines="[^"]*"/g, ''); }
    if (rule.after !== undefined) { set('after', Math.round(rule.after * 20)); spacing = spacing.replace(/\s+w:afterLines="[^"]*"/g, ''); }
    paragraphs.push(['spacing', spacing]);
  }
  // 将段落属性暂存，避免模板内的段落标记rPr冒充样式自身的run属性。
  const para = property(xml, 'pPr');
  let next = para ? xml.replace(para, '<!--paragraph-properties-->') : xml;
  next = updateProps(next, 'rPr', runs);
  if (para) next = next.replace('<!--paragraph-properties-->', para);
  return updateProps(next, 'pPr', paragraphs);
}
export function styleTypographyRole(xml) {
  if (/w:type="paragraph"/.test(xml) && /w:default="(?:1|true)"/.test(xml)) return 'body';
  const name = (xml.match(/<w:name\b[^>]*w:val="([^"]+)"/)?.[1] || '').replace(/\s/g, '').toLowerCase();
  if (/^(normal|正文|标准)$/.test(name)) return 'body';
  if (/^(title|标题)$/.test(name)) return 'title';
  const heading = /^(?:heading|标题)([1-6])$/.exec(name);
  return heading ? 'heading' + heading[1] : null;
}
/** 仅修改styles.xml；模板后应用当前明确样式，所有非样式部件逐字节保持。 */
export async function applyDocxTypography(blob, profile, { signal } = {}) {
  const rules = normalizeTypography(profile);
  if (!Object.keys(rules).length) return { blob, changed: 0 };
  signal?.throwIfAborted();
  const zip = await openOfficePackage(blob);
  const styles = await zip.file('word/styles.xml')?.async('string');
  if (!styles || styles.length > 2000000) throw invalid('Word样式缺失或超过处理上限');
  let changed = 0;
  let next = styles.replace(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g, item => {
    const role = styleTypographyRole(item);
    const value = role && rules[role] ? patchTypography(item, rules[role]) : item;
    if (value !== item) changed++;
    return value;
  });
  if (rules.body) {
    const defaults = property(next, 'docDefaults');
    if (defaults) {
      let replacement = defaults;
      const run = property(defaults, 'rPrDefault');
      const para = property(defaults, 'pPrDefault');
      if (run) replacement = replacement.replace(run, patchTypography(run, { font: rules.body.font, size: rules.body.size, excludedFonts: rules.body.excludedFonts }));
      if (para) replacement = replacement.replace(para, patchTypography(para, { line: rules.body.line, before: rules.body.before, after: rules.body.after }));
      if (replacement !== defaults) { next = next.replace(defaults, replacement); changed++; }
    }
  }
  zip.file('word/styles.xml', next);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }, () => signal?.throwIfAborted());
  signal?.throwIfAborted();
  return { blob: new Blob([bytes], { type: blob.type }), changed, profile: rules, scope: '正文/标题样式；模板和原文件的直接格式、代码/页眉页脚独立格式保留' };
}

/** 不破坏原件直接格式；明确指出直接字号/字体覆盖了用户要求，而不是声称全篇已生效。 */
export async function directTypographyConflicts(blob, profile, { signal } = {}) {
  const rules = normalizeTypography(profile);
  if (!Object.keys(rules).length) return [];
  signal?.throwIfAborted();
  const zip = await openOfficePackage(blob);
  const styles = await zip.file('word/styles.xml')?.async('string') || '';
  const document = await zip.file('word/document.xml')?.async('string') || '';
  if (styles.length > 2000000 || document.length > 4000000) throw invalid('Word超过字体直接格式检查上限');
  const roles = new Map([...styles.matchAll(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g)].map(match => [match[0].match(/w:styleId="([^"]+)"/)?.[1], styleTypographyRole(match[0])]));
  const conflicts = new Set();
  for (const paragraph of document.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    signal?.throwIfAborted();
    const styleId = property(property(paragraph[0], 'pPr'), 'pStyle').match(/w:val="([^"]+)"/)?.[1];
    const role = styleId ? roles.get(styleId) : 'body', rule = rules[role];
    if (!rule) continue;
    for (const run of paragraph[0].matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g)) {
      if (!/<w:t\b/.test(run[0])) continue;
      const props = property(run[0], 'rPr');
      if (/Consolas/.test(property(props, 'rFonts'))) continue; // 代码字体独立保留，不能把代码误当正文。
      const eastAsia = property(props, 'rFonts').match(/w:eastAsia="([^"]+)"/)?.[1];
      const size = property(props, 'sz').match(/w:val="([^"]+)"/)?.[1];
      if (eastAsia && (rule.font && eastAsia !== typographyFont(rule, {}).eastAsia || rule.excludedFonts?.some(font => typographyFont({ font }, {}).eastAsia === eastAsia)))
        conflicts.add(role + '的直接字体覆盖了要求');
      if (size && rule.size && Number(size) !== Math.round(rule.size * 2)) conflicts.add(role + '的直接字号覆盖了要求');
    }
  }
  return [...conflicts].slice(0, 10).map(text => ({ level: 'error', text: text + '；原件直接格式已保留，未宣称字体字号全部生效' }));
}

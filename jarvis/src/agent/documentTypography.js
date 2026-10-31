import { documentError } from './documentPlan.js';
export const TYPOGRAPHY_FONTS = Object.freeze({
  '微软雅黑': { ascii: 'Microsoft YaHei', hAnsi: 'Microsoft YaHei', eastAsia: '微软雅黑', cs: 'Microsoft YaHei' },
  '宋体': { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '宋体', cs: 'Times New Roman' },
  '黑体': { ascii: 'Arial', hAnsi: 'Arial', eastAsia: '黑体', cs: 'Arial' },
  '仿宋': { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '仿宋', cs: 'Times New Roman' },
  '楷体': { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '楷体', cs: 'Times New Roman' },
  '思源黑体': { ascii: 'Source Han Sans SC', hAnsi: 'Source Han Sans SC', eastAsia: 'Source Han Sans SC', cs: 'Source Han Sans SC' },
  'Noto Sans CJK SC': { ascii: 'Noto Sans CJK SC', hAnsi: 'Noto Sans CJK SC', eastAsia: 'Noto Sans CJK SC', cs: 'Noto Sans CJK SC' }
});
export const TYPOGRAPHY_ROLES = ['body', 'title', ...Array.from({ length: 6 }, (_, i) => 'heading' + (i + 1))];
const sizeNames = { 小初:36, 初号:42, 小一:24, 一号:26, 小二:18, 二号:22, 小三:15, 三号:16, 小四:12, 四号:14, 小五:9, 五号:10.5, 小六:6.5, 六号:7.5 };
const fontPattern = /Noto Sans CJK SC|思源黑体|微软雅黑|仿宋|宋体|黑体|楷体/;
const invalid = message => documentError(message, 'DOCUMENT_TYPOGRAPHY');
export function normalizeTypography(profile = {}) {
  const result = {};
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw invalid('字体样式需为对象');
  for (const [role, value] of Object.entries(profile)) {
    if (!TYPOGRAPHY_ROLES.includes(role) || !value || typeof value !== 'object' || Array.isArray(value)) throw invalid('字体角色无效');
    const item = {};
    for (const [key, field] of Object.entries(value)) {
      if (key === 'font' && typeof field === 'string' && Object.hasOwn(TYPOGRAPHY_FONTS, field)) item.font = field;
      else if (['size', 'before', 'after'].includes(key) && Number.isFinite(field) && field >= (key === 'size' ? 6 : 0) && field <= (key === 'size' ? 72 : 72)) item[key] = field;
      else if (key === 'line' && field && ['auto', 'exact'].includes(field.rule) && Number.isFinite(field.value) && field.value >= (field.rule === 'auto' ? 1 : 6) && field.value <= (field.rule === 'auto' ? 3 : 100)) item.line = { rule: field.rule, value: field.value };
      else if (key === 'excludedFonts' && Array.isArray(field) && field.length <= 8 && field.every(font => typeof font === 'string' && Object.hasOwn(TYPOGRAPHY_FONTS, font))) item.excludedFonts = [...new Set(field)];
      else throw invalid('字体/字号/行距参数超出支持范围');
    }
    if (Object.keys(item).length) result[role] = item;
  }
  return result;
}
function targets(clause, previous) {
  const heading = /([一二三四五六1-6])级标题/.exec(clause);
  if (heading) return ['heading' + ('一二三四五六'.indexOf(heading[1]) >= 0 ? '一二三四五六'.indexOf(heading[1]) + 1 : heading[1])];
  if (/主标题|大标题|文档标题/.test(clause)) return ['title'];
  if (/标题/.test(clause)) return TYPOGRAPHY_ROLES.filter(role => role !== 'body');
  if (/正文|内文/.test(clause)) return ['body'];
  if (/全篇|全文|全部|所有字体|整体字体/.test(clause)) return TYPOGRAPHY_ROLES;
  if (/行距|段前|段后/.test(clause)) return ['body'];
  return previous;
}
/** 只读要求头部/偏好条目，不从正文里的字体名或引用示例推断版式。 */
export function typographyFromText(text = '') {
  const profile = {};
  let previous = TYPOGRAPHY_ROLES;
  const header = String(text).slice(0, 12000).split(/^#\s/m)[0];
  for (const clause of header.split(/[，,。；;\n、]/)) {
    if (/PPT|pptx|Excel|xlsx|幻灯片/i.test(clause)) continue;
    const roles = targets(clause, previous); previous = roles;
    const font = clause.match(fontPattern)?.[0];
    const negative = font && /不要|不用|别用|禁止|勿用|不采用/.test(clause.slice(0, clause.indexOf(font)));
    const numeric = clause.replace(/(?:段前|段后|固定(?:行距)?|行距)[^\d，,。；;]{0,4}\d+(?:\.\d+)?\s*(?:pt|磅)/gi, '');
    const named = numeric.match(/小初|初号|小[一二三四五六](?:号)?(?!点|些)|[一二三四五六]号/)?.[0]?.replace(/^(小[一二三四五六])号$/, '$1');
    const size = named ? sizeNames[named] : Number(numeric.match(/(\d{1,2}(?:\.\d+)?)\s*(?:pt|磅)/i)?.[1]) || undefined;
    const multiple = /([1-3](?:\.\d+)?)\s*倍(?:行距)?/.exec(clause);
    const exact = /固定(?:行距)?(?:为|[:：])?\s*(\d+(?:\.\d+)?)\s*(?:pt|磅)/i.exec(clause);
    const after = /段后(?:间距)?(?:为|[:：])?\s*(\d+(?:\.\d+)?)\s*(?:pt|磅)/i.exec(clause);
    const before = /段前(?:间距)?(?:为|[:：])?\s*(\d+(?:\.\d+)?)\s*(?:pt|磅)/i.exec(clause);
    if (!font && !size && !multiple && !exact && !after && !before) continue;
    for (const role of roles) {
      const item = profile[role] ||= {};
      if (font && negative) { item.excludedFonts = [...new Set([...(item.excludedFonts || []), font])]; if (item.font === font) delete item.font; }
      else if (font) { item.font = font; item.excludedFonts = (item.excludedFonts || []).filter(value => value !== font); }
      if (size) item.size = size;
      if (multiple) item.line = { rule: 'auto', value: Number(multiple[1]) };
      if (exact) item.line = { rule: 'exact', value: Number(exact[1]) };
      if (after) item.after = Number(after[1]);
      if (before) item.before = Number(before[1]);
    }
  }
  return normalizeTypography(profile);
}
function mergeRule(old = {}, next) {
  const excludedFonts = [...new Set([...(old.excludedFonts || []).filter(font => font !== next.font), ...(next.excludedFonts || [])])];
  const result = { ...old, ...next, excludedFonts };
  if (excludedFonts.includes(result.font)) delete result.font;
  return result;
}
export async function documentTypography(ctx, request, signal) {
  signal?.throwIfAborted();
  const history = ctx.documentStylePreferences ? await ctx.documentStylePreferences(signal) : '';
  signal?.throwIfAborted();
  // 历史列表按新到旧；先通用再Word专用，且同范围最新的最后覆盖。PPT/Excel偏好不污染Word。
  const entries = String(history).split('\n').filter(line => /^- (?:all|docx) · /.test(line)).reverse();
  const previous = {};
  for (const entry of [...entries.filter(line => line.startsWith('- all · ')), ...entries.filter(line => line.startsWith('- docx · '))]) {
    // 每条独立解析，上一条末尾的“标题”不能使下一条通用字体只作用于标题。
    for (const [role, rule] of Object.entries(typographyFromText(entry))) previous[role] = mergeRule(previous[role], rule);
  }
  const current = typographyFromText(request);
  for (const role of TYPOGRAPHY_ROLES) if (current[role]) {
    previous[role] = mergeRule(previous[role], current[role]);
  }
  return normalizeTypography(previous);
}
export function typographyFont(rule, fallback) {
  const selected = rule?.font ? TYPOGRAPHY_FONTS[rule.font] : fallback;
  if (!rule?.excludedFonts?.some(font => TYPOGRAPHY_FONTS[font].eastAsia === selected.eastAsia)) return selected;
  const name = Object.keys(TYPOGRAPHY_FONTS).find(font => !rule.excludedFonts.includes(font));
  if (!name) throw invalid('所有支持字体均被排除');
  return TYPOGRAPHY_FONTS[name];
}

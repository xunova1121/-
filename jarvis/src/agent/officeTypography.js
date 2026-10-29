import { normalizeTypography, typographyFromText } from './documentTypography.js';
/** Office专用字号解析；不让Word解析器原来的PPT/Excel排除规则吞掉本格式要求。 */
export function officeTypography(request, { body, title } = {}) {
  for (const n of [body, title]) if (n !== undefined && (!Number.isFinite(n) || n < 8 || n > 72)) throw new Error('字号需要8到72磅');
  const direct = typographyFromText(String(request || '').replace(/PPT|pptx|Excel|xlsx|幻灯片/gi, ''));
  return normalizeTypography({ ...direct, body: { ...(body && { size: body }), ...direct.body }, title: { ...(title && { size: title }), ...direct.title } });
}
/** 在原生文字入口应用字号，再交原记录器做溢出检查；不栅格化、不改页数约束。 */
export function applyPresentationTypography(slide, profile, slideTitle) {
  if (!Object.keys(profile || {}).length) return;
  const add = slide.addText.bind(slide),
    table = slide.addTable.bind(slide);
  slide.addText = (text, options = {}) => {
    const plain = Array.isArray(text) ? text.map((t) => t.text || '').join('') : String(text);
    const role = plain.trim() === String(slideTitle).trim() || (Number(options.y || 0) < 2.2 && Number(options.fontSize || 0) >= 28) ? 'title' : 'body';
    const rule = profile[role];
    if (!rule?.size || (Number(options.y || 0) > 6.6 && Number(options.fontSize || 0) <= 10)) return add(text, options);
    const content = Array.isArray(text) ? text.map((t) => ({ ...t, options: { ...t.options, fontSize: rule.size } })) : text;
    return add(content, { ...options, fontSize: rule.size, ...(rule.font && { fontFace: rule.font }), objectName: 'wy-' + role });
  };
  slide.addTable = (rows, options = {}) => table(rows, { ...options, ...(profile.body?.size && { fontSize: profile.body.size }) });
}
const attr = (xml, name) => xml.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"'))?.[1];
const pick = (histogram) => [...histogram.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] || null;
export async function measureOtherOffice(zip) {
  const histogram = new Map(),
    bodySizes = new Map(),
    titleSizes = [];
  const add = (size, weight, body = true) => {
    if (Number.isFinite(size) && size > 0 && size <= 200) {
      histogram.set(size, (histogram.get(size) || 0) + weight);
      if (body) bodySizes.set(size, (bodySizes.get(size) || 0) + weight);
    }
  };
  if (zip.file('ppt/presentation.xml')) {
    let bytes = 0,
      underlines = 0;
    const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    if (names.length > 300) return null;
    for (const name of names) {
      const xml = await zip.file(name).async('string');
      bytes += xml.length;
      if (bytes > 8e6) return null;
      for (const [shape] of xml.matchAll(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)) {
        const markedTitle = /name="wy-title"/.test(shape),
          markedBody = /name="wy-body"/.test(shape);
        for (const [run] of shape.matchAll(/<a:r\b[^>]*>[\s\S]*?<\/a:r>/g)) {
          const text = run.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/)?.[1] || '',
            props = run.match(/<a:rPr\b[^>]*>/)?.[0] || '',
            size = Number(attr(props, 'sz')) / 100;
          add(size, text.length, !markedTitle);
          if (markedTitle && size) titleSizes.push(size);
          if (/\bu="(?!none)[^"]+"/.test(props)) underlines++;
          if (markedBody && size) bodySizes.set(size, (bodySizes.get(size) || 0) + text.length);
        }
      }
    }
    if (!histogram.size) return null;
    return {
      format: 'pptx',
      body: pick(bodySizes) || pick(histogram),
      title: titleSizes.length ? Math.max(...titleSizes) : Math.max(...histogram.keys()),
      rules: null,
      underlines,
      scope: '原生幻灯片文字，不含图片内文字或图表内部样式'
    };
  }
  if (zip.file('xl/workbook.xml')) {
    const styles = await zip.file('xl/styles.xml')?.async('string');
    if (!styles || styles.length > 2e6) return null;
    const fonts = [...(styles.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/)?.[1] || '').matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>/g)].map((m) => ({
      size: Number(m[1].match(/<sz\b[^>]*val="([\d.]+)"/)?.[1]) || 11,
      bold: /<b\b/.test(m[1]),
      u: /<u\b/.test(m[1])
    }));
    const xfs = [...(styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '').matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(
      (m) => Number(attr(m[0], 'fontId')) || 0
    );
    let bytes = 0,
      underlines = 0;
    const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    if (sheets.length > 100) return null;
    for (const name of sheets) {
      const xml = await zip.file(name).async('string');
      bytes += xml.length;
      if (bytes > 8e6) return null;
      for (const m of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        if (!/<v>|<t[ >]/.test(m[2])) continue;
        const f = fonts[xfs[Number(attr(m[1], 's')) || 0]] || fonts[0];
        if (!f) continue;
        add(f.size, 1, !f.bold);
        if (f.u) underlines++;
      }
    }
    if (!histogram.size) return null;
    return {
      format: 'xlsx',
      body: pick(bodySizes) || pick(histogram),
      title: Math.max(...histogram.keys()),
      rules: null,
      underlines,
      scope: '有内容的单元格字号，不含图片内文字'
    };
  }
  return null;
}

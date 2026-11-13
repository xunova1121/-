import { openOfficePackage } from './officePackage.js';
import { documentError } from './documentPlan.js';

const fault = (message) => documentError(message, 'DOCUMENT_STYLES');
const property = (xml, tag) => xml.match(new RegExp(`<w:${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</w:${tag}>)`))?.[0] || '';
const role = (xml) => {
  if (/w:type="paragraph"/.test(xml) && /w:default="(?:1|true)"/.test(xml)) return 'normal';
  const label = (xml.match(/<w:name\b[^>]*w:val="([^"]+)"/)?.[1] || '').replace(/\s/g, '').toLowerCase();
  if (/^(normal|正文|标准)$/.test(label)) return 'normal';
  if (/^(title|标题)$/.test(label)) return 'title';
  return label.replace(/^标题([1-6])$/, 'heading$1');
};

function restyledXml(original, profile) {
  if (original.length > 2_000_000 || profile.length > 2_000_000) throw fault('Word样式超过2百万字符处理上限');
  const stylePattern = /<w:style\b[^>]*>[\s\S]*?<\/w:style>/g;
  const profiles = new Map([...profile.matchAll(stylePattern)].map((match) => [role(match[0]), match[0]]));
  const defaults = property(profile, 'docDefaults');
  const normal = profiles.get('normal') || '';
  const defaultRun = property(property(defaults, 'rPrDefault'), 'rPr');
  const defaultPara = property(property(defaults, 'pPrDefault'), 'pPr');
  let changed = 0;
  let xml = original.replace(stylePattern, (style) => {
    const kind = role(style);
    if (!/^(normal|title|heading[1-6]|hyperlink)$/.test(kind)) return style;
    const selected = profiles.get(kind) || (kind === 'normal' ? normal : '');
    if (!selected && kind !== 'normal') return style;
    let next = style;
    for (const tag of ['pPr', 'rPr']) {
      const replacement = property(selected, tag) || (kind === 'normal' ? (tag === 'pPr' ? defaultPara : defaultRun) : '');
      const old = property(next, tag);
      if (old) next = next.replace(old, '');
      if (replacement) next = next.replace('</w:style>', `${replacement}</w:style>`);
    }
    if (next !== style) changed++;
    return next;
  });
  if (defaults) {
    const old = property(xml, 'docDefaults');
    if (old) xml = xml.replace(old, defaults);
    else xml = xml.replace(/<w:styles\b[^>]*>/, (start) => start + defaults);
    if (old !== defaults) changed++;
  }
  // 模板的样式属性可能使用额外命名空间；只合并声明，不修改原文的样式编号或关联。
  const originalRoot = xml.match(/<w:styles\b[^>]*>/)?.[0];
  const profileRoot = profile.match(/<w:styles\b[^>]*>/)?.[0];
  if (!originalRoot || !profileRoot) throw fault('Word缺少可识别的样式根节点');
  let root = originalRoot;
  const namespaces = (value) => new Map([...value.matchAll(/\b(xmlns(?::[\w.-]+)?)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
  const known = namespaces(originalRoot);
  for (const [key, value] of namespaces(profileRoot)) {
    if (known.has(key) && known.get(key) !== value) throw fault('Word与样式模板命名空间冲突，未改写原文件');
    if (!known.has(key)) root = root.replace(/>$/, ` ${key}="${value}">`);
  }
  return { xml: xml.replace(originalRoot, root), changed };
}

/** 仅替换样式部件；正文、表格、图片、页眉页脚和全部关系部件逐字节保持。 */
export async function restyleDocx(original, profile, { signal } = {}) {
  signal?.throwIfAborted();
  const source = await openOfficePackage(original);
  const styles = await source.file('word/styles.xml')?.async('string');
  const sample = await openOfficePackage(profile);
  const profileStyles = await sample.file('word/styles.xml')?.async('string');
  if (!styles || !profileStyles) throw fault('Word或模板没有样式部件');
  const result = restyledXml(styles, profileStyles);
  source.file('word/styles.xml', result.xml);
  const bytes = await source.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }, () => signal?.throwIfAborted());
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const before = await openOfficePackage(original);
  const after = await openOfficePackage(blob);
  const paths = Object.keys(before.files)
    .filter((key) => !before.files[key].dir)
    .sort();
  const actualPaths = Object.keys(after.files)
    .filter((key) => !after.files[key].dir)
    .sort();
  if (JSON.stringify(paths) !== JSON.stringify(actualPaths)) throw fault('排版后Word部件清单发生变化，未写入目标');
  let preserved = 0;
  for (const key of paths) {
    signal?.throwIfAborted();
    if (key === 'word/styles.xml') continue;
    const old = await before.file(key).async('uint8array');
    const current = await after.file(key).async('uint8array');
    if (old.length !== current.length || !old.every((value, index) => value === current[index])) throw fault('排版后Word非样式部件发生变化，未写入目标');
    preserved++;
  }
  signal?.throwIfAborted();
  return {
    blob,
    changed: result.changed,
    preservation: { state: 'passed', parts: preserved, scope: '除样式部件外全部Word部件逐字节保持，含正文/表格/图片/关联；不等于视觉验收' }
  };
}

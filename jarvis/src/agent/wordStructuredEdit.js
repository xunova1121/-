import { children, descendants, attr, setAttr, element, wordText, ancestor, number, NS, parseXml, sameText } from './documentXml.js';
import { documentError } from './documentPlan.js';

export function wordObjects(doc, styles) {
  const defs = new Map(descendants(styles, 'w', 'style').map((s) => [attr(s, 'styleId', 'w'), s]));
  const role = (p) => {
    const control = ancestor(p, 'sdt');
    if (control && hasToc(control)) return 'toc';
    // 分节、分页和空白占位段不属于正文，正文批量排版不能改变其布局控制。
    if (!wordText(p).trim()) return 'layout';
    const outline = attr(children(children(p, 'pPr')[0] || {}, 'outlineLvl')[0], 'val', 'w');
    if (outline !== null && outline !== undefined && outline !== '' && Number(outline) < 9) return 'heading';
    let id = attr(children(children(p, 'pPr')[0] || {}, 'pStyle')[0], 'val', 'w');
    for (let i = 0; id && i < 12; i++) {
      const s = defs.get(id),
        label = attr(s && children(s, 'name')[0], 'val', 'w') || id;
      if (/^(title|标题)$/i.test(label)) return 'title';
      if (/^(heading\s*[1-9]|标题\s*[1-9])$/i.test(label)) return 'heading';
      if (/^(toc|目录)\s*\d/i.test(label)) return 'toc';
      id = attr(s && children(s, 'basedOn')[0], 'val', 'w');
    }
    if (ancestor(p, 'tbl')) return 'table';
    return 'body';
  };
  const level = (p) => {
    const pp = children(p, 'pPr')[0];
    const direct = attr(children(pp || {}, 'outlineLvl')[0], 'val', 'w');
    if (direct !== null && direct !== undefined && direct !== '') return Number(direct) + 1;
    let id = attr(children(pp || {}, 'pStyle')[0], 'val', 'w');
    for (let i = 0; id && i < 12; i++) {
      const st = defs.get(id);
      const label = attr(st && children(st, 'name')[0], 'val', 'w') || id;
      const m = /^(?:heading|标题)\s*([1-9])$/i.exec(label);
      if (m) return Number(m[1]);
      id = attr(st && children(st, 'basedOn')[0], 'val', 'w');
    }
    return null;
  };
  const paragraphs = descendants(doc, 'w', 'p').map((node, i) => ({ id: `p${i + 1}`, role: role(node), level: level(node), text: wordText(node), node }));
  const tables = descendants(doc, 'w', 'tbl').map((node, i) => ({
    id: `table${i + 1}`,
    role: 'table',
    rows: children(node, 'tr').length,
    text: wordText(node),
    node
  }));
  return { paragraphs, tables };
}
function selected(objects, target) {
  if (!target || typeof target !== 'object') throw documentError('必须指定编辑对象', 'DOCUMENT_SCOPE');
  const hits = objects.filter((o) =>
    target.id ? o.id === target.id : target.role ? o.role === target.role : target.text !== undefined ? o.text === target.text : false
  );
  if (!hits.length || (target.text !== undefined && hits.length !== 1)) throw documentError('对象不存在或同名有歧义；先读结构并使用id', 'DOCUMENT_SCOPE');
  return hits;
}
function boolean(node, name, value) {
  if (typeof value !== 'boolean') throw documentError(`${name}必须为布尔值`);
  setAttr(element(node, 'w', name), 'val', value ? '1' : '0', 'w');
}
function formatParagraph(p, props) {
  const allowed = [
    'heading_level',
    'font_size',
    'font_family',
    'bold',
    'alignment',
    'space_before',
    'space_after',
    'line_spacing',
    'keep_next',
    'page_break_before',
    'remove_lines',
    'underline'
  ];
  for (const k of Object.keys(props)) if (!allowed.includes(k)) throw documentError('不支持的段落属性：' + k);
  const pp = element(p, 'w', 'pPr', true);
  if (props.heading_level !== undefined) {
    const v = number(props.heading_level, 1, 9, '标题层级');
    if (!Number.isInteger(v)) throw documentError('标题层级须为整数');
    setAttr(element(pp, 'w', 'outlineLvl'), 'val', v - 1, 'w');
  }
  if (props.alignment !== undefined) {
    if (!['left', 'center', 'right', 'both'].includes(props.alignment)) throw documentError('对齐方式无效');
    setAttr(element(pp, 'w', 'jc'), 'val', props.alignment, 'w');
  }
  for (const [key, name] of [
    ['space_before', 'before'],
    ['space_after', 'after'],
    ['line_spacing', 'line']
  ])
    if (props[key] !== undefined) {
      const v = number(props[key], key === 'line_spacing' ? 0.8 : 0, key === 'line_spacing' ? 3 : 120, key);
      const spacing = element(pp, 'w', 'spacing');
      setAttr(spacing, name, Math.round(v * (key === 'line_spacing' ? 240 : 20)), 'w');
      if (key === 'line_spacing') setAttr(spacing, 'lineRule', 'auto', 'w');
    }
  for (const [key, name] of [
    ['keep_next', 'keepNext'],
    ['page_break_before', 'pageBreakBefore']
  ])
    if (props[key] !== undefined) boolean(pp, name, props[key]);
  if (props.remove_lines === true) {
    const b = element(pp, 'w', 'pBdr');
    for (const side of ['top', 'bottom']) setAttr(element(b, 'w', side), 'val', 'nil', 'w');
  }
  for (const r of descendants(p, 'w', 'r')) {
    const rp = element(r, 'w', 'rPr', true);
    if (props.font_size !== undefined)
      for (const tag of ['sz', 'szCs']) setAttr(element(rp, 'w', tag), 'val', Math.round(number(props.font_size, 6, 96, '字号') * 2), 'w');
    if (props.font_family !== undefined) {
      if (typeof props.font_family !== 'string' || !props.font_family.trim() || props.font_family.length > 80) throw documentError('字体名无效');
      const f = element(rp, 'w', 'rFonts');
      for (const key of ['ascii', 'hAnsi', 'eastAsia', 'cs']) {
        setAttr(f, key, props.font_family, 'w');
        f.removeAttributeNS(NS.w, key + 'Theme');
      }
    }
    if (props.bold !== undefined) {
      boolean(rp, 'b', props.bold);
      boolean(rp, 'bCs', props.bold);
    }
    if (props.underline !== undefined) {
      if (typeof props.underline !== 'boolean') throw documentError('underline须为布尔值');
      setAttr(element(rp, 'w', 'u'), 'val', props.underline ? 'single' : 'none', 'w');
    }
  }
}
export function editWord(doc, styles, operations) {
  const before = wordText(doc),
    objects = wordObjects(doc, styles),
    changes = [];
  let updateToc = false;
  for (const op of operations) {
    const props = op.properties || {};
    if (op.action === 'format') {
      const hits = selected(objects.paragraphs, op.target);
      for (const hit of hits) {
        formatParagraph(hit.node, props);
        // 主标题后的独立空段落装饰线也属于标题，不能只清文字或标题样式。
        if (props.remove_lines && ['title', 'heading'].includes(hit.role)) {
          let next = hit.node.nextSibling;
          while (next?.nodeType !== 1 && next) next = next.nextSibling;
          if (next?.localName === 'p' && !wordText(next) && !descendants(next, 'w', 'drawing').length && descendants(next, 'w', 'pBdr').length)
            formatParagraph(next, { remove_lines: true });
        }
      }
      changes.push({ action: op.action, matched: hits.length });
    } else if (op.action === 'table_layout') {
      const hits = selected(objects.tables, op.target);
      for (const { node } of hits) {
        const rows = children(node, 'tr');
        if (Object.keys(props).some((k) => !['repeat_header', 'keep_rows', 'keep_table'].includes(k))) throw documentError('表格排版属性无效');
        rows.forEach((row, index) => {
          const trp = element(row, 'w', 'trPr', true);
          if (props.keep_rows !== undefined) boolean(trp, 'cantSplit', props.keep_rows);
          if (props.repeat_header !== undefined && index === 0) boolean(trp, 'tblHeader', props.repeat_header);
          if (props.keep_table !== undefined)
            for (const p of descendants(row, 'w', 'p')) formatParagraph(p, { keep_next: Boolean(props.keep_table) && index < rows.length - 1 });
        });
      }
      changes.push({ action: op.action, matched: hits.length, note: '已设置分页属性；过长表格仍须实际分页核对，不保证强行放进一页' });
    } else if (op.action === 'page_layout') {
      if (Object.keys(props).some((k) => !['top', 'bottom', 'left', 'right'].includes(k))) throw documentError('页边距只支持top/bottom/left/right，单位毫米');
      const sections = descendants(doc, 'w', 'sectPr');
      if (!sections.length) throw documentError('未找到页面分节');
      for (const section of sections)
        for (const [k, v] of Object.entries(props)) setAttr(element(section, 'w', 'pgMar'), k, Math.round((number(v, 5, 60, k) * 1440) / 25.4), 'w');
      changes.push({ action: op.action, matched: sections.length });
    } else if (op.action === 'update_toc') {
      updateToc = true;
    } else throw documentError('Word不支持操作：' + op.action, 'DOCUMENT_OPERATION');
  }
  sameText(before, wordText(doc));
  if (updateToc && !hasToc(doc)) {
    if (!objects.paragraphs.some((p) => p.role === 'heading')) throw documentError('文档没有标题层级，先用明确的标题结构生成目录', 'DOCUMENT_TOC');
    const fragment = parseXml(
      `<w:p xmlns:w="${NS.w}"><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>目录待排版更新</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
    );
    const body = descendants(doc, 'w', 'body')[0];
    const firstHeading = objects.paragraphs.find((p) => p.role === 'heading' && p.node.parentNode === body)?.node || body.firstChild;
    body.insertBefore(doc.importNode(fragment.documentElement, true), firstHeading);
    changes.push({ action: 'update_toc', matched: 1 });
  }
  return { changes, updateToc: updateToc || hasToc(doc) };
}
export function hasToc(doc) {
  return (
    descendants(doc, 'w', 'instrText').some((n) => /\bTOC\b/.test(n.textContent)) ||
    descendants(doc, 'w', 'fldSimple').some((n) => /\bTOC\b/.test(attr(n, 'instr', 'w') || ''))
  );
}

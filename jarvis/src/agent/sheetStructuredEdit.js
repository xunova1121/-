import { children, descendants, attr, setAttr, element, number, serialize } from './documentXml.js';
import { documentError } from './documentPlan.js';
export function workbookSheets(workbook, rels) {
  const relationships = new Map(
    Array.from(rels.documentElement.childNodes)
      .filter((n) => n.nodeType === 1 && n.getAttribute('TargetMode') !== 'External')
      .map((n) => [n.getAttribute('Id'), n.getAttribute('Target')])
  );
  return descendants(workbook, 'x', 'sheet').map((n) => {
    const target = relationships.get(n.getAttribute('r:id')) || '';
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path) || path.includes('..')) throw documentError('工作表关系无效');
    return { name: attr(n, 'name'), path };
  });
}
const cellPos = (value) => {
  const m = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  if (!m) throw documentError('无效单元格范围');
  const col = [...m[1]].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
  const row = +m[2];
  if (col > 16384 || row > 1048576) throw documentError('单元格越界');
  return [col, row];
};
export function editSheet(doc, styles, op) {
  const props = op.properties || {};
  if (op.action === 'page_layout') {
    if (Object.keys(props).some((k) => !['orientation', 'fit_width', 'fit_height'].includes(k))) throw documentError('Excel打印属性无效');
    const setup = element(doc.documentElement, 'x', 'pageSetup');
    if (props.orientation !== undefined) {
      if (!['portrait', 'landscape'].includes(props.orientation)) throw documentError('打印方向无效');
      setAttr(setup, 'orientation', props.orientation);
    }
    for (const [k, n] of [
      ['fit_width', 'fitToWidth'],
      ['fit_height', 'fitToHeight']
    ])
      if (props[k] !== undefined) setAttr(setup, n, number(props[k], 0, 100, k));
    setAttr(element(element(doc.documentElement, 'x', 'sheetPr', true), 'x', 'pageSetUpPr'), 'fitToPage', '1');
    return 1;
  }
  if (op.action !== 'format') throw documentError('Excel不支持操作：' + op.action);
  const parts = String(op.target?.range || '')
    .toUpperCase()
    .split(':');
  if (parts.length > 2) throw documentError('范围无效');
  const start = cellPos(parts[0]),
    end = cellPos(parts[1] || parts[0]);
  if (start[0] > end[0] || start[1] > end[1] || (end[0] - start[0] + 1) * (end[1] - start[1] + 1) > 2000) throw documentError('一次范围最多2000格，且须正序');
  if (Object.keys(props).some((k) => !['font_size', 'font_family', 'bold', 'color', 'alignment', 'wrap_text', 'number_format'].includes(k)))
    throw documentError('Excel格式属性无效');
  const root = styles.documentElement,
    fonts = element(root, 'x', 'fonts'),
    xfs = element(root, 'x', 'cellXfs');
  const sourceXfs = children(xfs, 'xf'),
    cache = new Map();
  let count = 0;
  for (const cell of descendants(doc, 'x', 'c')) {
    const [col, row] = cellPos(attr(cell, 'r'));
    if (col < start[0] || col > end[0] || row < start[1] || row > end[1]) continue;
    const id = Number(attr(cell, 's') || 0);
    if (!cache.has(id)) {
      if (!sourceXfs[id] || children(xfs).length > 10000) throw documentError('样式索引无效或超限');
      const xf = sourceXfs[id].cloneNode(true);
      const font = children(fonts, 'font')[Number(attr(xf, 'fontId') || 0)]?.cloneNode(true);
      if (!font) throw documentError('字体样式缺失');
      if (props.font_size !== undefined) setAttr(element(font, 'x', 'sz'), 'val', number(props.font_size, 6, 96, '字号'));
      if (props.font_family !== undefined) {
        if (typeof props.font_family !== 'string' || !props.font_family || props.font_family.length > 80) throw documentError('字体名无效');
        setAttr(element(font, 'x', 'name'), 'val', props.font_family);
      }
      if (props.bold !== undefined) {
        if (typeof props.bold !== 'boolean') throw documentError('bold须为布尔值');
        setAttr(element(font, 'x', 'b'), 'val', props.bold ? '1' : '0');
      }
      if (props.color !== undefined) {
        if (!/^[0-9a-f]{6}$/i.test(props.color)) throw documentError('颜色无效');
        for (const c of children(font, 'color')) font.removeChild(c);
        setAttr(element(font, 'x', 'color'), 'rgb', 'FF' + props.color);
      }
      setAttr(xf, 'fontId', children(fonts, 'font').length);
      setAttr(xf, 'applyFont', '1');
      fonts.appendChild(font);
      setAttr(fonts, 'count', children(fonts, 'font').length);
      if (props.alignment !== undefined) {
        if (!['left', 'center', 'right', 'justify'].includes(props.alignment)) throw documentError('对齐无效');
        setAttr(element(xf, 'x', 'alignment'), 'horizontal', props.alignment);
        setAttr(xf, 'applyAlignment', '1');
      }
      if (props.wrap_text !== undefined) {
        if (typeof props.wrap_text !== 'boolean') throw documentError('wrap_text须为布尔值');
        setAttr(element(xf, 'x', 'alignment'), 'wrapText', props.wrap_text ? '1' : '0');
        setAttr(xf, 'applyAlignment', '1');
      }
      if (props.number_format !== undefined) {
        if (typeof props.number_format !== 'string' || props.number_format.length > 120) throw documentError('数字格式无效');
        const formats = element(root, 'x', 'numFmts', true);
        const next = Math.max(163, ...children(formats, 'numFmt').map((f) => +attr(f, 'numFmtId'))) + 1;
        const f = styles.createElementNS(root.namespaceURI, 'numFmt');
        setAttr(f, 'numFmtId', next);
        setAttr(f, 'formatCode', props.number_format);
        formats.appendChild(f);
        setAttr(formats, 'count', children(formats).length);
        setAttr(xf, 'numFmtId', next);
        setAttr(xf, 'applyNumberFormat', '1');
      }
      cache.set(id, children(xfs, 'xf').length);
      xfs.appendChild(xf);
      setAttr(xfs, 'count', children(xfs, 'xf').length);
    }
    const before = children(cell).map(serialize).join('');
    setAttr(cell, 's', cache.get(id));
    if (before !== children(cell).map(serialize).join('')) throw documentError('格式修改改变了数据');
    count++;
  }
  return count;
}

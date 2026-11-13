import { children, descendants, attr, setAttr, element, number, sameText } from './documentXml.js';
import { documentError } from './documentPlan.js';
export function slideObjects(doc, page) {
  const tree = descendants(doc, 'p', 'spTree')[0];
  return children(tree || {})
    .filter((n) => ['sp', 'pic', 'graphicFrame', 'grpSp'].includes(n.localName))
    .map((node) => {
      const nv = descendants(node, 'p', 'cNvPr')[0];
      return {
        id: `slide${page}:shape${attr(nv, 'id')}`,
        page,
        name: attr(nv, 'name'),
        kind: node.localName,
        text: descendants(node, 'a', 't')
          .map((t) => t.textContent)
          .join(''),
        node
      };
    });
}
export function editSlide(doc, page, op) {
  const objects = slideObjects(doc, page);
  const hits = objects.filter((o) =>
    op.target?.id
      ? o.id === op.target.id
      : op.target?.page === page && (op.target?.text === undefined || o.text === op.target.text) && (op.action !== 'format' || (o.text && o.kind !== 'grpSp'))
  );
  if (op.target?.text !== undefined && hits.length > 1) throw documentError('PPT同页存在同名对象，请使用结构id', 'DOCUMENT_SCOPE');
  const before = descendants(doc, 'a', 't')
    .map((n) => n.textContent)
    .join('\n');
  for (const hit of hits) {
    if (hit.kind === 'grpSp') throw documentError('组合对象需先定位内部元素；不整体重建组合', 'DOCUMENT_SCOPE');
    const props = op.properties || {};
    if (op.action === 'format') {
      if (Object.keys(props).some((k) => !['font_size', 'font_family', 'bold', 'color', 'alignment'].includes(k))) throw documentError('PPT文字格式属性无效');
      if (!descendants(hit.node, 'a', 't').length) throw documentError('该对象没有可编辑文字');
      for (const p of descendants(hit.node, 'a', 'p')) {
        if (props.alignment !== undefined) {
          if (!['left', 'center', 'right', 'justify'].includes(props.alignment)) throw documentError('PPT对齐方式无效');
          setAttr(element(p, 'a', 'pPr', true), 'algn', { left: 'l', center: 'ctr', right: 'r', justify: 'just' }[props.alignment]);
        }
        for (const r of children(p).filter((n) => ['r', 'fld'].includes(n.localName))) {
          const rp = element(r, 'a', 'rPr', true);
          if (props.font_size !== undefined) setAttr(rp, 'sz', Math.round(number(props.font_size, 6, 96, '字号') * 100));
          if (props.bold !== undefined) {
            if (typeof props.bold !== 'boolean') throw documentError('bold须为布尔值');
            setAttr(rp, 'b', props.bold ? '1' : '0');
          }
          if (props.font_family !== undefined) {
            if (typeof props.font_family !== 'string' || !props.font_family || props.font_family.length > 80) throw documentError('字体名无效');
            for (const tag of ['latin', 'ea', 'cs']) setAttr(element(rp, 'a', tag), 'typeface', props.font_family);
          }
          if (props.color !== undefined) {
            if (!/^[0-9a-f]{6}$/i.test(props.color)) throw documentError('颜色应为六位HEX');
            for (const n of children(rp).filter((n) => /Fill$/.test(n.localName))) rp.removeChild(n);
            setAttr(element(element(rp, 'a', 'solidFill'), 'a', 'srgbClr'), 'val', props.color);
          }
        }
      }
    } else if (op.action === 'move_resize') {
      if (Object.keys(props).some((k) => !['x', 'y', 'width', 'height'].includes(k))) throw documentError('位置尺寸使用x/y/width/height，单位英寸');
      const xp = hit.kind === 'graphicFrame' ? children(hit.node, 'xfrm')[0] : children(children(hit.node, 'spPr')[0] || {}, 'xfrm')[0];
      if (!xp) throw documentError('该对象的位置继承自母版，当前不直接改写母版', 'DOCUMENT_SCOPE');
      for (const [key, tag, axis] of [
        ['x', 'off', 'x'],
        ['y', 'off', 'y'],
        ['width', 'ext', 'cx'],
        ['height', 'ext', 'cy']
      ])
        if (props[key] !== undefined)
          setAttr(element(xp, 'a', tag), axis, Math.round(number(props[key], key === 'width' || key === 'height' ? 0.05 : 0, 56, key) * 914400));
    } else throw documentError('PPT不支持操作：' + op.action);
  }
  sameText(
    before,
    descendants(doc, 'a', 't')
      .map((n) => n.textContent)
      .join('\n')
  );
  return hits.length;
}

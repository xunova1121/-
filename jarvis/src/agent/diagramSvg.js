const escape = value => String(value).replace(/[&<>"']/g, letter => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[letter]);
/** 按字符宽度换行，不用foreignObject；中文文字、框和路径均为原生可编辑SVG。 */
function lines(text, units, limit) {
  const result = [];
  let line = '';
  let size = 0;
  for (const letter of [...text]) {
    const step = /[\u0000-\u007f]/.test(letter) ? 0.58 : 1;
    if (letter === '\n' || size + step > units) {
      result.push(line);
      line = '';
      size = 0;
    }
    if (letter !== '\n') { line += letter; size += step; }
  }
  if (line) result.push(line);
  if (result.length > limit) throw Object.assign(new Error('节点文字超过当前版面容量，请精简或拆分节点，未生成截断文字的图'), { code: 'DIAGRAM_TEXT_OVERFLOW', kind: 'input' });
  return result;
}
function textBlock(text, x, y, width, size, maxLines, color, weight = 400) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${lines(text, width / size, maxLines).map((line, index) => `<tspan x="${x}" dy="${index ? size * 1.4 : 0}">${escape(line)}</tspan>`).join('')}</text>`;
}
export function diagramSvg(model) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}" role="img" aria-label="${escape(model.title)}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#8291ad"/></marker></defs><rect width="100%" height="100%" fill="#f5f7fc"/>`];
  parts.push(textBlock(model.title, 64, 68, 1312, 32, 1, '#172a49', 700));
  for (const layer of model.layers) {
    parts.push(`<g data-layer="${escape(layer.title)}"><rect x="64" y="${layer.y}" width="1312" height="${layer.height}" rx="20" fill="${layer.emphasis ? '#e9edff' : '#fff'}" stroke="${layer.emphasis ? '#7272d6' : '#dce3ef'}" stroke-width="${layer.emphasis ? 2 : 1}"/>`);
    parts.push(textBlock(layer.title, 88, layer.y + 34, 1240, 22, 1, '#334c72', 600));
    for (const node of layer.nodes) {
      parts.push(`<g id="node-${escape(node.id)}"><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="12" fill="${layer.emphasis ? '#655bc1' : '#f1f5fb'}"/>`);
      parts.push(textBlock(node.title, node.x + 18, node.y + 32, node.width - 36, 21, 2, layer.emphasis ? '#fff' : '#223754', 600));
      if (node.detail) parts.push(textBlock(node.detail, node.x + 18, node.y + 88, node.width - 36, 15, 3, layer.emphasis ? '#eeebff' : '#536781'));
      parts.push('</g>');
    }
    parts.push('</g>');
  }
  const index = new Map(model.nodes.map(node => [node.id, node]));
  for (const edge of model.edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    // 只走两端节点的边缘和层间空白，不穿过节点中心；同排节点走上方空白。
    let route;
    if (from.y === to.y) route = `M${from.x + from.width / 2},${from.y} V${from.y - 12} H${to.x + to.width / 2} V${to.y}`;
    else {
      const upward = from.y > to.y;
      const start = upward ? from.y : from.y + from.height;
      const end = upward ? to.y + to.height : to.y;
      const first = start + (upward ? -12 : 12);
      const last = end + (upward ? 12 : -12);
      route = `M${from.x + from.width / 2},${start} V${first} H44 V${last} H${to.x + to.width / 2} V${end}`;
    }
    parts.push(`<path d="${route}" fill="none" stroke="#8291ad" stroke-width="2" marker-end="url(#arrow)" data-from="${escape(edge.from)}" data-to="${escape(edge.to)}"/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

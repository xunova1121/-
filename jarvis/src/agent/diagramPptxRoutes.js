import { escapeSvg } from './diagramText.js';
/** Office会重算自定义几何连接线，折返线需分为有真实锚点的直线段；折点用1EMU透明锚点，不改变画面。 */
export function nativeOrthogonalRoute(item, source, target, shape, { nextId, emu, sourcePort, targetPort }) {
  const points = item.points;
  const joints = points.slice(1, -1).map(point => ({ point, id: nextId() }));
  const anchors = joints.map(({ point, id }) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="折点 ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(point.x)}" y="${emu(point.y)}"/><a:ext cx="1" cy="1"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`);
  const stroke = /<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/.exec(shape)?.[0];
  if (!stroke) throw Object.assign(new Error('折返连接线缺少线型'), { code: 'DIAGRAM_PPTX_STRUCTURE', kind: 'input' });
  const segments = points.slice(1).map((last, index) => {
    const first = points[index];
    const id = nextId();
    const from = index === 0 ? { id: source.id, port: sourcePort } : { id: joints[index - 1].id, port: 0 };
    const to = index === points.length - 2 ? { id: target.id, port: targetPort } : { id: joints[index].id, port: 0 };
    const line = index === points.length - 2 ? stroke : stroke.replace(/<a:(?:headEnd|tailEnd)\b[^>]*\/>/g, '');
    const x = emu(Math.min(first.x, last.x)), y = emu(Math.min(first.y, last.y));
    const cx = Math.max(1, emu(Math.abs(last.x - first.x))), cy = Math.max(1, emu(Math.abs(last.y - first.y)));
    return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${escapeSvg('连接 ' + item.from + '→' + item.to + ' 段' + index)}"/><p:cNvCxnSpPr><a:stCxn id="${from.id}" idx="${from.port}"/><a:endCxn id="${to.id}" idx="${to.port}"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm${last.x < first.x ? ' flipH="1"' : ''}${last.y < first.y ? ' flipV="1"' : ''}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom>${line}</p:spPr></p:cxnSp>`;
  });
  const group = nextId();
  const xs = points.map(point => emu(point.x)), ys = points.map(point => emu(point.y));
  const x = Math.min(...xs), y = Math.min(...ys), cx = Math.max(1, Math.max(...xs) - x), cy = Math.max(1, Math.max(...ys) - y);
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${group}" name="${escapeSvg('折返连接 ' + item.from + '→' + item.to)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="${x}" y="${y}"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></p:grpSpPr>${anchors.join('')}${segments.join('')}</p:grpSp>`;
}

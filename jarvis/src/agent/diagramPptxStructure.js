import { escapeSvg } from './diagramText.js';
const fail = (message) => Object.assign(new Error(message), { code: 'DIAGRAM_PPTX_STRUCTURE', kind: 'input' });
/** 保留scene分组树；输出对象最多8000个，不能把整图贴成一张图片冒充可编辑。 */
export function nativeTree(scene) {
  let serial = 0;
  const visit = (elements) =>
    elements.map((item) => {
      if (++serial > 8000) throw fail('原生对象超过8000，请拆图');
      const key = 'diagram-' + serial;
      return item.type === 'group' ? { key, item, children: visit(item.children) } : { key, item, keys: [] };
    });
  return visit(scene.elements);
}
export function nativeLeaves(tree) {
  return tree.flatMap((node) => (node.children ? nativeLeaves(node.children) : [node]));
}
function bounds(node) {
  if (node.item.bounds) return node.item.bounds;
  const children = node.children ? nativeLeaves(node.children).map((child) => child.item) : [node.item];
  const rectangles = children.filter((item) => item.type === 'rect');
  const points = [];
  for (const item of rectangles.length ? rectangles : children) {
    if (item.type === 'text')
      for (const line of item.lines) points.push({ x: line.x, y: line.y - item.fontSize }, { x: line.x + item.width, y: line.y + item.fontSize * 0.3 });
    else if (item.type === 'path') points.push(...item.points);
    else if (Number.isFinite(item.x)) points.push({ x: item.x, y: item.y }, { x: item.x + item.width, y: item.y + item.height });
  }
  if (!points.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  return { x, y, width: Math.max(1, Math.max(...points.map((p) => p.x)) - x), height: Math.max(1, Math.max(...points.map((p) => p.y)) - y) };
}
const port = (point, box) =>
  [
    { x: box.x + box.width / 2, y: box.y },
    { x: box.x, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2, y: box.y + box.height },
    { x: box.x + box.width, y: box.y + box.height / 2 }
  ]
    .map((p, index) => ({ index, distance: Math.abs(point.x - p.x) + Math.abs(point.y - p.y) }))
    .sort((a, b) => a.distance - b.distance)[0].index;

/** 仅处理本程序刚生成的单页包；连接到组内背景形状，移动整组时端点随形状联动。 */
export async function groupNativeDiagram(bytes, scene, tree) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file('ppt/slides/slide1.xml');
  if (!entry) throw fail('原生PPT缺少第一页');
  const xml = await entry.async('string');
  if (xml.length > 8e6) throw fail('原生页面XML超过8MB');
  const shapes = new Map();
  for (const match of xml.matchAll(/<p:(sp|pic|cxnSp)>[\s\S]*?<\/p:\1>/g)) {
    const key = /\bname="(diagram-[^" ]+)"/.exec(match[0])?.[1];
    if (key) shapes.set(key, match[0]);
  }
  let serial = Math.max(1, ...[...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((match) => Number(match[1])));
  const references = new Map();
  const assign = (nodes) => {
    for (const node of nodes)
      if (node.children) {
        node.nativeId = ++serial;
        const background = nativeLeaves(node.children)
          .filter((child) => child.item.type === 'rect')
          .sort((a, b) => b.item.width * b.item.height - a.item.width * a.item.height)[0];
        const first = background?.keys[0];
        const shapeId = first ? Number(/<p:cNvPr id="(\d+)"/.exec(shapes.get(first) || '')?.[1]) : node.nativeId;
        if (node.item.nodeId && references.has(node.item.nodeId)) throw fail('节点分组标识重复，不能确定连接端点');
        if (node.item.nodeId) references.set(node.item.nodeId, { id: shapeId, bounds: bounds(node) });
        assign(node.children);
      }
  };
  assign(tree);
  const emu = (value) => Math.round(((value * 13.333333) / scene.width) * 914400);
  const draw = (node) => {
    if (node.children) {
      const box = bounds(node);
      const x = emu(box.x),
        y = emu(box.y),
        cx = emu(box.width),
        cy = emu(box.height);
      const label = node.item.nodeId ? '节点 ' + node.item.nodeId : node.item.containerId || node.item.layer || node.key;
      return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${node.nativeId}" name="${escapeSvg(label)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="${x}" y="${y}"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></p:grpSpPr>${node.children.map(draw).join('')}</p:grpSp>`;
    }
    return node.keys
      .map((key) => {
        let shape = shapes.get(key);
        if (!shape) throw fail('原生对象缺失：' + key);
        const item = node.item;
        if (item.type === 'path' && item.from && item.to) {
          const source = references.get(item.from),
            target = references.get(item.to);
          if (!source || !target || !Number.isFinite(source.id) || !Number.isFinite(target.id)) throw fail('连接线缺少真实节点锚点');
          const nv = /<p:cNvPr\b[\s\S]*?<\/p:cNvPr>|<p:cNvPr\b[^>]*\/>/.exec(shape)?.[0];
          if (!nv) throw fail('原生连接线缺少标识');
          shape = shape.replace(/^<p:sp>/, '<p:cxnSp>').replace(/<\/p:sp>$/, '</p:cxnSp>');
          shape = shape.replace(
            /<p:nvSpPr>[\s\S]*?<\/p:nvSpPr>/,
            `<p:nvCxnSpPr>${nv}<p:cNvCxnSpPr><a:stCxn id="${source.id}" idx="${port(item.points[0], source.bounds)}"/><a:endCxn id="${target.id}" idx="${port(item.points.at(-1), target.bounds)}"/></p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr>`
          );
        }
        return shape;
      })
      .join('');
  };
  const first = xml.indexOf('<p:spTree>'),
    last = xml.indexOf('</p:spTree>');
  const header = xml.slice(first + '<p:spTree>'.length).match(/^<p:nvGrpSpPr>[\s\S]*?<\/p:nvGrpSpPr><p:grpSpPr>[\s\S]*?<\/p:grpSpPr>/)?.[0];
  if (first < 0 || last < 0 || !header) throw fail('页面对象树无效');
  zip.file('ppt/slides/slide1.xml', xml.slice(0, first) + '<p:spTree>' + header + tree.map(draw).join('') + xml.slice(last));
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

export async function inspectNativeDiagram(blob) {
  if (blob.size > 20e6) throw fail('原生PPT超过20MB');
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('ppt/slides/slide1.xml')?.async('string');
  if (!xml || xml.length > 8e6) throw fail('原生页面无效');
  const ids = new Set([...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((match) => match[1]));
  const anchors = [...xml.matchAll(/<a:(?:stCxn|endCxn) id="(\d+)"/g)].map((match) => match[1]);
  if (anchors.some((id) => !ids.has(id))) throw fail('连接线引用了不存在的形状');
  return {
    textBoxes: (xml.match(/<p:txBody>/g) || []).length,
    nodeGroups: (xml.match(/name="节点 /g) || []).length,
    connectors: (xml.match(/<p:cxnSp>/g) || []).length,
    anchoredEnds: anchors.length,
    smallImages: (xml.match(/<p:pic>/g) || []).length
  };
}

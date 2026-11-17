/** 离线Demo保留独立文字/图表；小屏改为语义卡片流，避免把4K整图缩成不可读缩略图。 */
import { composeLayeredSvg, designLayerMarkup, escapeDesignXml, designIconMarkup, designFont } from './layeredDesignSvg.js';
import { applyDesignState } from './layeredDesignQuality.js';
import { luminanceHex } from './posterContrast.js';
import { wrapParagraphs } from './posterComposition.js';

const esc = escapeDesignXml;
const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
/** 手机卡片里文字和底色对比不够时换成黑/白，网页和预览共用 */
export function readableOn(color, background) {
  const a = luminanceHex(color), b = luminanceHex(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5 ? color : b > 0.179 ? '#000000' : '#FFFFFF';
}
const mobileRole = node => node.id === 'title' ? 'title' : /-value$/.test(node.id) ? 'value' : /-title$/.test(node.id) ? 'heading' : 'body';
function mobileLayer(node, assets, background, font) {
  const readable = readableOn(node.color, background);
  const attrs = `data-node="${node.id}" data-category="${esc(node.category)}"`;
  if (node.type === 'text') {
    const role = mobileRole(node);
    return `<p ${attrs} class="mobile-${role}" style="color:${readable}">${esc(node.text)}</p>`;
  }
  if (node.type === 'image') return `<img ${attrs} class="mobile-image" src="${assets.get(node.asset).data}" alt="${esc(node.detail || '视觉素材')}"/>`;
  if (node.type === 'icon') return `<svg ${attrs} class="mobile-icon" viewBox="0 0 24 24" aria-hidden="true">${designIconMarkup(node.icon, node.color)}</svg>`;
  if (node.type === 'chart') return `<svg ${attrs} class="mobile-chart" viewBox="0 0 600 280" role="img" aria-label="${esc(node.detail || '趋势图')}">${designLayerMarkup({ ...node, x: 0, y: 0, w: 600, h: 280, color: readable }, assets, font)}</svg>`;
  return '';
}
/** 手机卡片分组：网页和手机预览共用同一分组，预览才能代表网页 */
export function mobileGroups(design) {
  const groups = new Map();
  for (const node of design.layers.filter(n => !n.decorative && n.type !== 'shape')) {
    const group = ['title', 'eyebrow', 'subtitle'].includes(node.id) ? 'design-intro' : node.group;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(node);
  }
  return [...groups.entries()].map(([group, nodes]) => {
    const card = design.layers.find(n => n.type === 'shape' && n.group === group);
    return { group, nodes, fill: card?.fill || design.palette.background };
  });
}
function mobileView(design, assets) {
  return mobileGroups(design).map(({ group, nodes, fill }) =>
    `<article class="mobile-group" data-group="${esc(group)}" style="background:${fill}">${nodes.map(n => mobileLayer(n, assets, fill, designFont(design.fontFamily))).join('')}</article>`).join('');
}
/**
 * Demo 手机卡片布局的预览图（2026-11-17：手机/电脑两个宽度都要自审）。按网页同样的分组、字号（CSS 像素×2）、
 * 卡片内边距排出来，用同一字体渲染；它是排版预览，不是真实浏览器截图。
 */
export function mobileCardsPreviewSvg(design, assets) {
  const k = 2, width = 390 * k, pad = 18 * k, inner = 20 * k, cardW = width - pad * 2, textW = cardW - inner * 2;
  const sizes = { title: 30, heading: 20, value: 48, body: 16 }, font = designFont(design.fontFamily);
  let y = pad;
  const parts = [];
  for (const { nodes, fill } of mobileGroups(design)) {
    const content = [];
    let cy = inner;
    for (const node of nodes) {
      if (node.type === 'text') {
        const size = sizes[mobileRole(node)] * k, rows = wrapParagraphs(node.text, size, textW) || [node.text];
        const color = readableOn(node.color, fill), weight = mobileRole(node) === 'body' ? 400 : 700;
        cy += size * 0.5;
        rows.forEach((row, i) => content.push(`<text x="${inner}" y="${cy + size * (1.05 + i * 1.45)}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${color}" xml:space="preserve">${esc(row)}</text>`));
        cy += rows.length * size * 1.45 + size * 0.5;
      } else if (node.type === 'image') {
        const asset = assets.get(node.asset), h = asset ? textW * asset.height / asset.width : textW * 0.56;
        if (asset) content.push(`<image x="${inner}" y="${cy}" width="${textW}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${asset.data}"/>`);
        cy += h + 8 * k;
      } else if (node.type === 'chart') {
        const h = textW * 280 / 600;
        content.push(`<g transform="translate(${inner} ${cy}) scale(${textW / 600})">${designLayerMarkup({ ...node, x: 0, y: 0, w: 600, h: 280, color: readableOn(node.color, fill) }, assets, font)}</g>`);
        cy += h + 8 * k;
      } else if (node.type === 'icon') {
        content.push(`<g transform="translate(${inner} ${cy}) scale(${28 * k / 24})">${designIconMarkup(node.icon, node.color)}</g>`);
        cy += 28 * k + 8 * k;
      }
    }
    const h = cy + inner;
    parts.push(`<g transform="translate(${pad} ${y})"><rect x="0" y="0" width="${cardW}" height="${h}" rx="${16 * k}" fill="${fill}"/>${content.join('')}</g>`);
    y += h + 14 * k;
  }
  const height = Math.ceil(y + pad);
  return { width, height, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="0" y="0" width="${width}" height="${height}" fill="${design.palette.background}"/>${parts.join('')}</svg>` };
}
async function pngData(blob) {
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return 'data:image/png;base64,' + btoa(binary);
}
export async function createLayeredHtml({ design, assets, png }) {
  const all = [design, ...design.states.map(s => applyDesignState(design, s))];
  const views = all.map((item, index) => ({ label: index ? design.states[index - 1].label : '初始视图', svg: composeLayeredSvg(item, assets), mobile: mobileView(item, assets), layers: item.layers }));
  const data = { design, views, png: await pngData(png) };
  const categories = [...new Set(design.layers.map(n => n.category).filter(Boolean))];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(design.title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:${design.palette.background};color:${design.palette.ink};font-family:${designFont(design.fontFamily)}}button,input,select{font:inherit;color:inherit;background:transparent;border:1px solid ${design.palette.muted};border-radius:10px;padding:10px 14px}button{cursor:pointer}button:focus-visible,[tabindex]:focus-visible{outline:3px solid ${design.palette.accent};outline-offset:3px}button:hover{opacity:.78}[hidden]{display:none!important}.demo-toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:16px 24px;border-bottom:1px solid ${design.palette.muted}55}.demo-toolbar strong{margin-right:auto}.demo-toolbar input{min-width:140px;flex:1;max-width:300px}.demo-meta{padding:12px 24px;font-size:13px;color:${design.palette.muted};line-height:1.6}.demo-meta p{margin:3px 0}#design-canvas{padding:24px;max-width:1920px;margin:auto}#design-canvas>svg{width:100%;height:auto;display:block}#design-canvas g[role=button]{cursor:pointer}#design-mobile{display:none}.mobile-group{margin:0 0 14px;padding:20px;border-radius:16px;overflow-wrap:anywhere}.mobile-group p{margin:8px 0;white-space:pre-wrap;line-height:1.6}.mobile-title{font-size:30px;font-weight:700}.mobile-heading{font-size:20px;font-weight:700}.mobile-value{font-size:48px;font-weight:700}.mobile-body{font-size:16px}.mobile-image{display:block;max-width:100%;width:100%;height:auto;border-radius:12px}.mobile-chart{width:100%;height:auto;display:block}.mobile-icon{width:28px;height:28px}dialog{color:${design.palette.ink};background:${design.palette.card};border:1px solid ${design.palette.muted};border-radius:20px;max-width:min(560px,92vw);max-height:82vh;padding:26px;overflow:auto}dialog::backdrop{background:#0008}dialog p,dialog dl{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8}dialog dd{margin:0 0 12px}dialog dt{font-weight:700}.demo-actions{display:flex;gap:8px;flex-wrap:wrap;padding:16px 24px 24px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}@media(max-width:700px){#design-canvas{display:none}#design-mobile{display:block;padding:18px}.demo-toolbar{padding:14px;gap:8px}.demo-toolbar strong{width:100%}.demo-toolbar button,.demo-toolbar select{font-size:14px}.demo-meta{padding:10px 18px}.demo-actions{padding:10px 18px 24px}.demo-actions button{font-size:14px}}
</style></head><body><nav class="demo-toolbar" aria-label="原型操作"><strong>${esc(design.title)}</strong><label class="sr-only" for="design-search">筛选内容</label><input id="design-search" type="search" placeholder="筛选内容"><label class="sr-only" for="design-category">分类</label><select id="design-category"><option value="">全部分类</option>${categories.map(c => `<option>${esc(c)}</option>`).join('')}</select><label class="sr-only" for="design-state">数据快照</label><select id="design-state">${views.map((v, i) => `<option value="${i}">${esc(v.label)}</option>`).join('')}</select><button id="design-images" aria-pressed="true">显示图片</button><button id="design-reset">重置</button></nav><div class="demo-meta"><p>${design.dataMode === 'provided' ? '用户提供数据；来源说明不代表已经联网核实。' : '演示数据；未连接实时业务或气象接口。'} ${esc(design.source)} 初始资料时间：${esc(design.asOf || "未提供")}</p><p id="design-current-state" aria-live="polite"></p><p>点击卡片或图表查看详情；可按分类、关键词和日期浏览。</p></div><main><div id="design-canvas"></div><div id="design-mobile"></div></main><p id="design-empty" class="demo-meta" hidden>没有匹配内容</p><div class="demo-actions"><button id="design-download-png"${png ? '' : ' disabled'}>下载初始PNG原图</button><button id="design-download-svg">下载当前SVG</button><button id="design-download-source">下载当前源稿</button></div><dialog id="design-detail"><h2 id="design-detail-title"></h2><div id="design-detail-copy"></div><button id="design-close">关闭</button></dialog><script type="application/json" id="design-data">${safeJson(data)}</script><script>(${layeredDemoRuntime.toString()})();</script></body></html>`;
}

/** 浏览器脚本只处理上述受控编译结果；用户内容通过textContent展示，不接入任意脚本。 */
function layeredDemoRuntime() {
  const data = JSON.parse(document.getElementById('design-data').textContent);
  const byId = id => document.getElementById(id), canvas = byId('design-canvas'), mobile = byId('design-mobile');
  const search = byId('design-search'), category = byId('design-category'), state = byId('design-state');
  let current = data.views[0], showImages = true;
  function detail(node) {
    byId('design-detail-title').textContent = node.type === 'text' ? node.text : node.detail || '设计图层';
    const copy = byId('design-detail-copy'); copy.replaceChildren();
    const paragraph = document.createElement('p'); paragraph.textContent = node.detail || (node.type === 'image' ? '保留工作区原始视觉素材；像素尺寸不证明细节质量。' : '此内容来自同一设计源稿。'); copy.append(paragraph);
    if (node.points) {
      const list = document.createElement('dl');
      for (const point of node.points) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = point.label; dd.textContent = String(point.value); list.append(dt, dd); }
      copy.append(list);
    }
    byId('design-detail').showModal();
  }
  function filter() {
    const query = search.value.trim().toLocaleLowerCase(), cat = category.value;
    const groups = new Map();
    for (const node of current.layers.filter(n => !n.decorative)) {
      if (!groups.has(node.group)) groups.set(node.group, { match: false, image: false });
      const row = groups.get(node.group);
      row.match ||= (!cat || node.category === cat) && (!query || [node.text, node.detail, node.category, ...(node.points || []).map(p => p.label)].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
      row.image ||= node.type === 'image';
    }
    for (const node of current.layers) {
      const row = groups.get(node.group);
      const visible = (!row || row.match) && (showImages || node.type !== 'image');
      const graphic = byId('layer-' + node.id); if (graphic) graphic.style.display = visible ? '' : 'none';
      for (const element of mobile.querySelectorAll('[data-node]')) if (element.dataset.node === node.id) element.hidden = !visible;
    }
    for (const article of mobile.querySelectorAll('[data-group]')) {
      const nodes = [...article.querySelectorAll('[data-node]')]; article.hidden = !nodes.some(n => !n.hidden);
    }
    byId('design-empty').hidden = [...groups.values()].some(g => g.match);
  }
  function render() {
    current = data.views[Number(state.value) || 0];
    byId('design-current-state').textContent = '当前显示：' + current.label;
    canvas.innerHTML = current.svg; mobile.innerHTML = current.mobile;
    for (const node of current.layers.filter(n => !n.decorative && n.type !== 'shape')) {
      const elements = [byId('layer-' + node.id), ...[...mobile.querySelectorAll('[data-node]')].filter(el => el.dataset.node === node.id)].filter(Boolean);
      for (const element of elements) {
        element.setAttribute('tabindex', '0'); element.setAttribute('role', 'button'); element.setAttribute('aria-label', '查看：' + (node.text || node.detail || node.type).slice(0, 100));
        element.addEventListener('click', () => detail(node));
        element.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); detail(node); } });
      }
    }
    filter();
  }
  function download(blob, filename) {
    const url = typeof blob === 'string' ? blob : URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click();
    if (typeof blob !== 'string') setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  search.addEventListener('input', filter); category.addEventListener('change', filter); state.addEventListener('change', render);
  byId('design-images').addEventListener('click', () => { showImages = !showImages; byId('design-images').setAttribute('aria-pressed', String(showImages)); filter(); });
  byId('design-reset').addEventListener('click', () => { state.value = '0'; search.value = ''; category.value = ''; showImages = true; byId('design-images').setAttribute('aria-pressed', 'true'); render(); });
  byId('design-close').addEventListener('click', () => byId('design-detail').close());
  byId('design-download-png').addEventListener('click', () => { if (data.png) download(data.png, 'design-initial.png'); });
  byId('design-download-svg').addEventListener('click', () => download(new Blob([new XMLSerializer().serializeToString(canvas.querySelector('svg'))], { type: 'image/svg+xml' }), 'design-current.svg'));
  byId('design-download-source').addEventListener('click', () => download(new Blob([JSON.stringify({ ...data.design, layers: current.layers, ...(Number(state.value) > 0 && { asOf: current.label }) })], { type: 'application/json' }), 'design-current.design.json'));
  render();
}

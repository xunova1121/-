import { validateVisualSceneSvg } from './visualSceneSvg.js';
import { readImageMetadata } from './imageMetadata.js';
import { rangeLabel } from './visualScene.js';

const MAX_METADATA = 128_000;
const MAX_PNG = 24e6;
const fail = message => Object.assign(new Error(message), { code: 'VISUAL_HTML_INPUT', kind: 'input' });
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function metadataJson(design) {
  let count = 0;
  const visit = (value, depth) => {
    if (++count > 4000 || depth > 8) throw fail('交互设计数据超出容量');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string' && value.length <= 16000) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value) && value.length <= 128) return value.forEach(item => visit(item, depth + 1));
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (key.length > 120 || !Object.hasOwn(descriptor, 'value')) throw fail('交互设计必须是纯 JSON 数据');
        visit(descriptor.value, depth + 1);
      }
      return;
    }
    throw fail('交互设计必须是有界纯 JSON 数据');
  };
  visit(design, 0);
  const json = JSON.stringify(design);
  if (json.length > MAX_METADATA) throw fail('交互设计数据过大');
  // JSON 数据也处于 HTML 的脚本元素中，必须防止闭合标签逃逸。
  return json.replace(/[<>&\u2028\u2029]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

async function embeddedPng(blob, design) {
  if (blob == null) return '';
  if (!(blob instanceof Blob) || blob.type !== 'image/png' || blob.size < 45 || blob.size > MAX_PNG) throw fail('初始图片必须是24MB以内的 PNG');
  const info = await readImageMetadata(blob);
  if (info.format !== 'png' || info.dimensions !== 'verified' || info.width !== design.width || info.height !== design.height) throw fail('初始 PNG 格式或原尺寸与设计稿不一致');
  return `data:image/png;base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
}

// 样式和脚本为固定程序；来源、标题和数值只能进入转义后的文本或 JSON 数据。
const CSS = `
:root{color-scheme:dark;--bg:#07121e;--panel:#0e1e2e;--text:#e6f1f8;--muted:#91a9ba;--border:#294051;--accent:#77dfd3;--soft:#173a40}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 12% 0,#123346 0,transparent 44%),var(--bg);color:var(--text);font:14px/1.6 "Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif}body[data-theme="light"]{color-scheme:light;--bg:#edf3f5;--panel:#fff;--text:#183343;--muted:#607785;--border:#ccdde3;--accent:#137f79;--soft:#e0f3ef;background:radial-gradient(ellipse at 12% 0,#d5ebec 0,transparent 44%),var(--bg)}
button,select,a{font:inherit}button,select,.download{min-height:42px;border:1px solid var(--border);border-radius:9px;background:var(--panel);color:var(--text);padding:8px 12px}button,.download{cursor:pointer}button:hover,.download:hover{border-color:var(--accent);background:var(--soft)}button:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.5;cursor:default}a{text-decoration:none}.download.primary{color:var(--bg);background:var(--accent);border-color:var(--accent)}[hidden]{display:none!important}
.shell{max-width:1920px;margin:auto;padding:28px clamp(16px,3vw,44px) 18px}.masthead{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:22px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:2.4px;color:var(--accent);margin:0 0 5px}.masthead h1{font-size:clamp(20px,2vw,28px);line-height:1.4;margin:0;font-weight:650}.subtitle{color:var(--muted);margin:6px 0 0}.badge{flex-shrink:0;border:1px solid var(--border);border-radius:999px;padding:6px 12px;color:var(--accent);font-size:12px}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px}.tools{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.control{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:12px}.layer{display:flex;align-items:center;gap:7px;min-height:42px;padding:8px 11px;border:1px solid var(--border);border-radius:9px;cursor:pointer}.layer input{accent-color:var(--accent);width:16px;height:16px;margin:0}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 286px;gap:18px;align-items:start}.canvas-card{min-width:0;border:1px solid var(--border);border-radius:15px;background:var(--panel);overflow:hidden;box-shadow:0 18px 50px #0002}.canvas-heading{display:flex;justify-content:space-between;gap:16px;padding:12px 16px;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}.canvas-heading strong{font-weight:500;color:var(--text)}#scene-stage{max-height:76vh;overflow:auto;overscroll-behavior:contain}#visual-scene{display:block;width:100%;height:auto;max-height:73vh;min-height:180px}#scene-stage[data-zoom="detail"] #visual-scene{width:200%;max-width:none;max-height:none}#visual-scene [role="button"]{cursor:pointer;outline:none}#visual-scene [role="button"]:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.canvas-foot{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:12px 16px;font-size:12px;color:var(--muted);border-top:1px solid var(--border)}.detail{padding:22px;border:1px solid var(--border);border-radius:15px;background:var(--panel)}.detail .eyebrow{margin-bottom:12px}.detail h2{font-size:19px;line-height:1.45;margin:0 0 18px;overflow-wrap:anywhere}.detail dl{margin:0}.detail dt{font-size:12px;color:var(--muted);margin:16px 0 4px}.detail dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.detail .note{margin:20px 0 0;padding-top:16px;border-top:1px solid var(--border);font-size:12px;color:var(--muted)}#scene-copy-text{margin-top:18px;width:100%}.footer{display:flex;justify-content:space-between;align-items:start;gap:18px;margin:17px 2px 0;color:var(--muted);font-size:12px}#scene-status{margin:0;min-height:20px}#scene-copy-buffer{position:fixed;left:-10000px;top:0;width:1px;height:1px}.offline{white-space:nowrap}.offline:before{content:"";display:inline-block;width:6px;height:6px;margin-right:7px;border-radius:50%;background:var(--accent)}
@media(min-width:1500px){.workspace{grid-template-columns:minmax(0,1fr) 320px}}@media(max-width:1000px){.workspace{grid-template-columns:minmax(0,1fr)}.detail{padding:20px}.detail dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px 16px}.detail dt{margin:0}.detail h2{margin-bottom:14px}.detail .note{margin-top:14px}.detail #scene-copy-text{width:auto}}@media(max-width:600px){.shell{padding:18px 12px}.masthead{align-items:flex-start;gap:10px}.badge{font-size:10px;padding:5px 8px}.toolbar{gap:12px}.tools{gap:8px}.tools.downloads{width:100%}.downloads>*{flex:1;text-align:center;font-size:12px}.control{gap:6px}.canvas-heading,.canvas-foot{padding:10px 12px}.canvas-heading span{display:none}.footer{flex-direction:column;gap:5px}.detail dl{grid-template-columns:88px minmax(0,1fr)}#scene-stage{max-height:65vh}#visual-scene{min-height:0;max-height:60vh}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}`;

/** 页头快照时间与趋势观测属于不同数据，不能用相同 index 混为一条读数。 */
export function visualSceneSelection(design, kind, index) {
  if (kind === 'time-label') return { label: '数据时间', details: [['说明', '整份数据快照的时间，不代表某个趋势观测值']] };
  const collections = { metric: 'metrics', marker: 'markers', alert: 'alerts', 'series-point': 'series' };
  const item = design[collections[kind]]?.[index] || {};
  const label = item.label || item.name || item.title;
  if (kind === 'metric') return { label, details: [['数值', String(item.value ?? '—') + (item.unit || '')], ['说明', item.detail]] };
  if (kind === 'marker') return { label, details: [['读数', item.value], ['位置', item.lon + '° E / ' + item.lat + '° N']] };
  if (kind === 'alert') return { label, details: [['内容', item.detail], ['记录时间', item.time], ['级别', ({ info: '提示', warning: '关注', critical: '紧急' })[item.level]]] };
  if (kind === 'series-point') return { label, details: [['时段', item.label], ['观测值', item.value], ['显示范围', '仅选中已有趋势点，其他指标保留原始快照']], observation: String(index) };
  return { details: [] };
}

/** 固定离线程序，不捕获模块外变量；导出只序列化已验证 SVG 的受控 DOM 状态。 */
function sceneBootstrap(selectionFor) {
  const design = JSON.parse(document.getElementById('scene-data').textContent);
  const svg = document.getElementById('visual-scene');
  const byId = id => document.getElementById(id);
  const namespace = 'http://www.w3.org/2000/svg';
  const kindLabels = { metric: '指标', marker: '区域点位', alert: '动态详情', 'series-point': '趋势观测', 'time-label': '数据时间', text: '原稿文字' };
  const observation = byId('scene-date');
  let selected = null;
  let selectedText = '';
  const announce = message => { byId('scene-status').textContent = message; };
  const rows = values => {
    const list = document.createElement('dl');
    for (const [label, value] of values) {
      if (value === undefined || value === null || value === '') continue;
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = String(value);
      list.append(term, description);
    }
    byId('scene-detail-content').replaceChildren(list);
  };
  const provenance = () => [['数据说明', design.dataMode === 'demo' ? `演示数据，不用于${design.preset === 'weather' ? '气象' : '业务'}决策` : '提供的数据快照'], ['来源', design.source || '未提供'], ['数据时间', design.asOf || '未提供']];
  function clearSelection() {
    if (selected) {
      selected.removeAttribute('data-selected');
      selected.setAttribute('aria-pressed', 'false');
    }
    selected = null;
    selectedText = '';
    svg.querySelector('#visual-demo-selection')?.remove();
    byId('scene-copy-text').hidden = true;
  }
  function showOverview() {
    clearSelection();
    byId('scene-detail-kind').textContent = 'DESIGN INSPECTOR';
    byId('scene-detail-title').textContent = '探索这份设计';
    rows([['画布尺寸', design.width + ' × ' + design.height + ' px'], ...provenance()]);
  }
  function selectionFrame(node) {
    const box = node.getBBox();
    const matrix = svg.getScreenCTM().inverse().multiply(node.getScreenCTM());
    const points = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]].map(([x, y]) => {
      const point = svg.createSVGPoint();
      point.x = x;
      point.y = y;
      return point.matrixTransform(matrix);
    });
    const x = Math.min(...points.map(point => point.x));
    const y = Math.min(...points.map(point => point.y));
    const width = Math.max(...points.map(point => point.x)) - x;
    const height = Math.max(...points.map(point => point.y)) - y;
    const frame = document.createElementNS(namespace, 'rect');
    const attrs = { id: 'visual-demo-selection', x: x - 8, y: y - 8, width: width + 16, height: height + 16, rx: 8, fill: 'none', stroke: design.theme === 'light' ? '#168d87' : '#b7fff2', 'stroke-width': 3, 'stroke-dasharray': '9 5', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none', 'aria-hidden': 'true' };
    for (const [key, value] of Object.entries(attrs)) frame.setAttribute(key, String(value));
    svg.append(frame);
  }
  function selectNode(node) {
    if (!node || !svg.contains(node)) return;
    const kind = node.getAttribute('data-viz');
    const index = Number(node.getAttribute('data-index'));
    const information = selectionFor(design, kind, index);
    clearSelection();
    selected = node;
    node.setAttribute('data-selected', 'true');
    node.setAttribute('aria-pressed', 'true');
    const label = kind === 'text' ? '选中文字' : information.label || node.getAttribute('data-label') || kindLabels[kind];
    byId('scene-detail-kind').textContent = kindLabels[kind];
    byId('scene-detail-title').textContent = label;
    let details = information.details;
    if (information.observation !== undefined) observation.value = information.observation;
    if (kind === 'text') {
      selectedText = node.textContent;
      details = [['原文', selectedText]];
      byId('scene-copy-text').hidden = false;
    }
    rows([...details, ...provenance()]);
    selectionFrame(node);
    announce('已选中' + kindLabels[kind] + '：' + (kind === 'text' ? selectedText : label));
  }
  if (design.preset === 'poster') {
    svg.querySelectorAll('text').forEach((node, index) => {
      node.setAttribute('data-viz', 'text');
      node.setAttribute('data-index', String(index));
      node.setAttribute('data-label', node.textContent);
    });
  }
  const interactive = Array.from(svg.querySelectorAll('[data-viz]')).filter(node => Object.hasOwn(kindLabels, node.getAttribute('data-viz')));
  interactive.forEach(node => {
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-pressed', 'false');
    node.setAttribute('aria-label', kindLabels[node.getAttribute('data-viz')] + '：' + (node.getAttribute('data-label') || node.textContent));
    node.addEventListener('click', () => selectNode(node));
    node.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectNode(node);
      }
    });
  });
  const series = Array.isArray(design.series) ? design.series : [];
  series.forEach((point, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = point.label;
    observation.append(option);
  });
  byId('scene-date-control').hidden = !series.length;
  observation.addEventListener('change', () => {
    if (observation.value === '') {
      showOverview();
      announce('已恢复完整快照；数值保持原始数据。');
      return;
    }
    selectNode(interactive.find(node => node.getAttribute('data-viz') === 'series-point' && node.getAttribute('data-index') === observation.value));
  });
  for (const layer of ['radar', 'grid']) {
    const nodes = Array.from(svg.querySelectorAll('[data-viz="' + layer + '"]'));
    byId('layer-' + layer + '-control').hidden = !nodes.length;
    byId('layer-' + layer).addEventListener('change', event => {
      nodes.forEach(node => node.setAttribute('visibility', event.target.checked ? 'visible' : 'hidden'));
      announce((layer === 'radar' ? (design.preset === 'weather' ? '雷达' : '覆盖范围') : '网格') + '图层已' + (event.target.checked ? '显示' : '隐藏'));
    });
  }
  byId('scene-zoom').addEventListener('change', event => {
    byId('scene-stage').setAttribute('data-zoom', event.target.value);
    announce(event.target.value === 'detail' ? '已放大至两倍视图，可滚动查看细节。' : '已适应窗口。');
  });
  byId('scene-reset').addEventListener('click', () => {
    observation.value = '';
    byId('scene-zoom').value = 'fit';
    byId('scene-stage').setAttribute('data-zoom', 'fit');
    for (const layer of ['radar', 'grid']) {
      byId('layer-' + layer).checked = true;
      svg.querySelectorAll('[data-viz="' + layer + '"]').forEach(node => node.removeAttribute('visibility'));
    }
    showOverview();
    announce('已恢复初始视图。');
  });
  byId('scene-copy-text').addEventListener('click', async () => {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(selectedText); copied = true; } catch { /* 离线页面可能无剪贴板权限，继续尝试浏览器复制。 */ }
    }
    if (!copied) {
      const buffer = byId('scene-copy-buffer');
      buffer.value = selectedText;
      buffer.select();
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      buffer.value = '';
      byId('scene-copy-text').focus();
    }
    announce(copied ? '已复制选中文字。' : '浏览器未允许复制，请在详情中手动选中原文复制。');
  });
  byId('download-svg').addEventListener('click', () => {
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', namespace);
    clone.setAttribute('width', String(design.width));
    clone.setAttribute('height', String(design.height));
    const metadata = document.createElementNS(namespace, 'metadata');
    metadata.textContent = JSON.stringify({ source: design.source, asOf: design.asOf, dataMode: design.dataMode, observation: observation.value === '' ? null : series[Number(observation.value)]?.label, selection: selected?.getAttribute('data-label') || selectedText || null });
    clone.append(metadata);
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '当前视图.svg';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('已请求下载当前视图 SVG，包含图层与选中状态。');
  });
  showOverview();
}

/** 同一份设计的离线交互版；PNG 直接嵌入已渲染原件，不用截图冒充原尺寸导出。 */
export async function createVisualSceneHtml({ design, svg, pngBlob } = {}) {
  if (!design || typeof design !== 'object' || Array.isArray(design)) throw fail('缺少视觉设计数据');
  const data = metadataJson(design);
  if (!Number.isInteger(design.width) || !Number.isInteger(design.height) || design.width <= 0 || design.height <= 0 || design.width > 4096 || design.height > 4096 || design.width * design.height > 16e6) throw fail('交互画布尺寸超出允许范围');
  if (!['demo', 'provided'].includes(design.dataMode)) throw fail('须明确演示数据或提供的数据');
  const checked = validateVisualSceneSvg(svg);
  if (checked.width !== design.width || checked.height !== design.height) throw fail('SVG 原尺寸与设计稿不一致');
  if (/\sid\s*=\s*(["'])(?:scene-|layer-|download-|visual-demo-)[^"']*\1/.test(svg)) throw fail('SVG 使用了交互页面保留的元素编号');
  // 老海报的 SVG 没有根 id；只为根元素补入口，不重建或修改原有画面。
  const scene = svg.replace(/<svg\b[^>]*>/, tag => /\sid\s*=\s*(["'])visual-scene\1/.test(tag) ? tag : tag.replace(/\s+id\s*=\s*(["'])[^"']*\1/, '').replace('<svg', '<svg id="visual-scene"'));
  validateVisualSceneSvg(scene);
  const png = await embeddedPng(pngBlob, design);
  if (!globalThis.crypto?.subtle) throw fail('当前环境不支持安全的离线脚本摘要');
  const script = `(${sceneBootstrap.toString()})(${visualSceneSelection.toString()});`;
  const [scriptHash, styleHash] = await Promise.all([script, CSS].map(async value => base64(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))));
  const csp = `default-src 'none'; script-src 'sha256-${scriptHash}'; script-src-attr 'none'; style-src 'sha256-${styleHash}'; style-src-attr 'none'; img-src data: blob:; connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
  const isPoster = design.preset === 'poster';
  const badge = design.dataMode === 'demo' ? '演示数据 · 离线 Demo' : '提供的数据 · 离线快照';
  const instructions = isPoster ? '点选原稿文字查看详情，支持 Tab、Enter 与空格键。' : '点选城市、指标、趋势或动态查看详情，支持 Tab、Enter 与空格键。';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(design.title)} · 交互设计</title><style>${CSS}</style></head>
<body data-theme="${design.theme === 'light' ? 'light' : 'midnight'}"><div class="shell">
<header class="masthead"><div><p class="eyebrow">WEIYANG / VISUAL STUDIO</p><h1>${escapeHtml(design.title)}</h1><p class="subtitle">${escapeHtml(design.subtitle || '同一设计，自由探索')}</p></div><span class="badge">${badge}</span></header>
<div class="toolbar" aria-label="设计操作"><div class="tools"><label class="control" id="scene-date-control" hidden>时段观察<select id="scene-date" aria-label="选择已有趋势时段"><option value="">完整快照</option></select></label><label class="layer" id="layer-radar-control" hidden><input id="layer-radar" type="checkbox" checked>${rangeLabel(design)}</label><label class="layer" id="layer-grid-control" hidden><input id="layer-grid" type="checkbox" checked>网格</label><label class="control">视图<select id="scene-zoom" aria-label="视图缩放"><option value="fit">适应窗口</option><option value="detail">细节放大 2×</option></select></label><button id="scene-reset" type="button">重置视图</button></div><div class="tools downloads">${png ? `<a class="download primary" id="download-png" href="${png}" download="${escapeHtml(String(design.title || '设计稿').replace(/[\\/:*?"<>|]/g, '_'))}-初始视图.png">下载初始 PNG · ${design.width}×${design.height}</a>` : ''}<button id="download-svg" type="button">导出当前 SVG</button></div></div>
<main class="workspace"><section class="canvas-card" aria-label="设计画布"><div class="canvas-heading"><strong>${isPoster ? '原稿预览' : '态势总览'}</strong><span>中文矢量文字 · 可交互</span></div><div id="scene-stage" data-zoom="fit">${scene}</div><div class="canvas-foot"><span>${escapeHtml(design.asOf || '时间未提供')}</span><span>来源：${escapeHtml(design.source || '未提供')}</span></div></section><aside class="detail" id="scene-detail" aria-label="选中内容详情"><p class="eyebrow" id="scene-detail-kind">DESIGN INSPECTOR</p><h2 id="scene-detail-title">探索这份设计</h2><div id="scene-detail-content"></div><button type="button" id="scene-copy-text" hidden>复制选中文字</button><p class="note">${instructions}${isPoster ? '' : '时段观察仅选中已有趋势点，其他指标保持原始快照。'}${png ? 'PNG 保存初始视图，SVG 保存当前图层与选中状态。' : '未附初始 PNG，可导出当前 SVG。'}</p></aside></main>
<footer class="footer"><p id="scene-status" role="status" aria-live="polite">${design.dataMode === 'demo' ? `演示数据，不用于${design.preset === 'weather' ? '气象' : '业务'}决策。` : '离线数据快照，未连接实时数据接口。'}</p><span class="offline">离线可用</span></footer></div><textarea id="scene-copy-buffer" aria-hidden="true" tabindex="-1"></textarea><noscript>启用 JavaScript 后可点选详情和导出当前 SVG；原稿与初始 PNG 仍可查看。</noscript><script id="scene-data" type="application/json">${data}</script><script>${script}</script></body></html>`;
}

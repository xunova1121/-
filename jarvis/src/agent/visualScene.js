/** 设计稿与状态只生成一份静态 SVG，HTML 使用这一份图形，不再独立排版。 */
import { normalizeVisualDesign, visualError } from './visualSceneInput.js';
import { normalizePosterBackground } from './posterCompositionInput.js';
import { projectChina } from './visualChinaMap.js';

const FONT = 'Noto Sans CJK SC,Microsoft YaHei,PingFang SC,Noto Sans SC,Source Han Sans SC,Droid Sans Fallback';
const xml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
const n = value => Math.round(value * 1000) / 1000;
const THEMES = {
  midnight: { background: '#07131F', surface: '#102332', surface2: '#152D3E', line: '#284456', text: '#EFF8FF', muted: '#9FB8C8', accent: '#5AE2D3', accent2: '#70AAFF', warm: '#FFBA79', danger: '#FF8395', faint: '#19394C', map: '#173D51', mapLine: '#56889D' },
  light: { background: '#EDF2F5', surface: '#FFFFFF', surface2: '#F4F8FA', line: '#D4E0E7', text: '#152C3C', muted: '#536C7B', accent: '#087F8C', accent2: '#426DC9', warm: '#B96124', danger: '#B7364D', faint: '#E1EDF1', map: '#DCECF0', mapLine: '#85A8B4' }
};
const units = value => [...String(value)].reduce((sum, ch) => sum + (/^[\x20-\x7e]$/.test(ch) ? /[il.,: ]/.test(ch) ? 0.35 : 0.65 : 1.05), 0);
const fit = (value, maximum, width, minimum = 10) => {
  const size = Math.min(maximum, width / Math.max(1, units(value)));
  if (size < minimum) throw visualError('文字不能完整放入视觉区块，请减少该字段长度或调整设计', 'VISUAL_TEXT_OVERFLOW');
  return n(size);
};

function rows(value, size, width) {
  const result = [];
  let current = '';
  for (const ch of String(value)) {
    if (current && units(current + ch) * size > width) { result.push(current); current = ''; }
    current += ch;
  }
  if (current) result.push(current);
  return result;
}

function painter(colors, texts) {
  const parts = [];
  const add = value => parts.push(value);
  const rect = (x, y, w, h, fill, extra = '') => add(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}" ${extra}/>`);
  const line = (x1, y1, x2, y2, stroke, extra = '') => add(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" ${extra}/>`);
  const circle = (x, y, r, fill, extra = '') => add(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${fill}" ${extra}/>`);
  const text = (value, x, y, size = 18, fill = colors.text, extra = '') => {
    if (value === '') return;
    texts.push(String(value));
    add(`<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" font-family="${FONT}" font-weight="400" fill="${fill}" xml:space="preserve" ${extra}>${xml(value)}</text>`);
  };
  const panel = (x, y, w, h) => rect(x, y, w, h, colors.surface, `rx="18" stroke="${colors.line}" stroke-width="1"`);
  const heading = (title, sub, x, y, width) => {
    rect(x, y - 18, 4, 22, colors.accent, 'rx="2"');
    text(title, x + 16, y, 22);
    if (sub) text(sub, x + width, y - 1, fit(sub, 14, width - 180), colors.muted, 'text-anchor="end"');
  };
  return { parts, add, rect, line, circle, text, panel, heading };
}

function header(p, design, c) {
  p.rect(40, 42, 44, 44, c.accent, 'rx="13" fill-opacity="0.12"');
  p.line(50, 72, 58, 57, c.accent, 'stroke-width="3" stroke-linecap="round"');
  p.line(58, 57, 67, 72, c.accent, 'stroke-width="3" stroke-linecap="round"');
  p.line(67, 72, 76, 53, c.accent, 'stroke-width="3" stroke-linecap="round"');
  p.text(design.title, 102, 76, fit(design.title, 36, 1120, 24));
  p.text(design.subtitle, 104, 112, fit(design.subtitle, 16, 1120), c.muted);
  p.text(design.preset === 'weather' ? 'WEATHER OBSERVATORY' : 'REGIONAL OPERATIONS', 1880, 48, 14, c.muted, 'text-anchor="end" letter-spacing="2"');
  const timeSize = units(design.asOf) * 14 > 500 ? 14 : fit(design.asOf, 21, 500);
  const timeRows = rows(design.asOf, timeSize, 500);
  p.add('<g data-viz="time-label" data-index="0">');
  timeRows.forEach((row, index) => p.text(row, 1880, (timeRows.length > 1 ? 69 : 83) + index * 20, timeSize, c.text, 'text-anchor="end"'));
  p.add('</g>');
  p.circle(1610, 109, 4, c.accent);
  p.text(design.dataMode === 'demo' ? '演示场景 · 非实时数据' : '提供数据 · 按来源时间展示', 1880, 114, 14, c.muted, 'text-anchor="end"');
}

function metrics(p, design, c) {
  if (!design.metrics.length) {
    p.panel(40, 145, 1840, 125);
    p.text('暂无指标数据', 70, 195, 24);
    p.text('提供的数据缺少指标，未用演示数值补齐。', 70, 231, 16, c.muted);
    return;
  }
  const width = (1840 - 20 * (design.metrics.length - 1)) / design.metrics.length;
  design.metrics.forEach((item, index) => {
    const x = 40 + index * (width + 20);
    p.add(`<g data-viz="metric" data-index="${index}" data-label="${xml(item.label)}">`);
    p.panel(x, 145, width, 125);
    p.rect(x + 24, 164, 3, 14, index % 2 ? c.accent2 : c.accent, 'rx="1"');
    p.text(item.label, x + 36, 178, fit(item.label, 17, width - 72), c.muted);
    const unitSize = fit(item.unit, 18, 120), unitWidth = units(item.unit) * unitSize;
    const size = fit(item.value, 43, width - 64 - unitWidth, 14);
    p.text(item.value, x + 24, 227, size);
    p.text(item.unit, x + 40 + units(item.value) * size, 226, unitSize, c.muted);
    const detailRows = rows(item.detail, 14, width - 48);
    detailRows.forEach((row, rowIndex) => p.text(row, x + 24, (detailRows.length > 1 ? 246 : 254) + rowIndex * 16, 14, c.muted));
    p.add('</g>');
  });
}

function markerLabels(p, design, c, map, state) {
  const occupied = [];
  design.markers.forEach((item, index) => {
    const point = projectChina(item.lon, item.lat);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw visualError('地图点位不能投影', 'VISUAL_MAP_POINT');
    const x = map.x + point.x * map.scale, y = map.y + point.y * map.scale;
    const selected = state.markerIndex === index;
    p.add(`<g data-viz="marker" data-index="${index}" data-label="${xml(item.name)}">`);
    p.circle(x, y, selected ? 17 : 13, c.accent, 'fill-opacity="0.1"');
    p.circle(x, y, selected ? 9 : 6, c.accent, 'fill-opacity="0.22"');
    p.circle(x, y, 3.5, c.accent, `stroke="${c.surface}" stroke-width="1.5"`);
    const size = units(item.name) * 15 <= 130 ? 15 : 13;
    const nameRows = rows(item.name, size, 130);
    const w = Math.max(38, ...nameRows.map(row => units(row) * size + 12)), h = nameRows.length * 18 + 6;
    const options = [[14, -12], [-w - 12, -12], [14, 20], [-w - 12, 20], [-w / 2, -30], [-w / 2, 40], [25, -46], [-w - 25, 56]];
    let selectedBox;
    for (const [dx, dy] of options) {
      const box = { x: Math.max(70, Math.min(1178 - w, x + dx)), y: Math.max(385, Math.min(858, y + dy - 17)), w, h };
      if (!occupied.some(other => box.x < other.x + other.w + 4 && box.x + box.w + 4 > other.x && box.y < other.y + other.h + 4 && box.y + box.h + 4 > other.y)) { selectedBox = box; break; }
    }
    // 密集站点以序号替代重叠标签，完整名称仍在交互数据与设计稿；不制造错误位置。
    if (selectedBox) {
      occupied.push(selectedBox);
      p.rect(selectedBox.x, selectedBox.y, w, h, c.surface, 'rx="5" fill-opacity="0.92"');
      nameRows.forEach((row, rowIndex) => p.text(row, selectedBox.x + 6, selectedBox.y + 17 + rowIndex * 18, size));
    } else p.text(String(index + 1), x + 9, y - 9, 14, c.accent);
    p.add('</g>');
  });
}

function mapPanel(p, design, c, state, art) {
  p.panel(40, 294, 1180, 688);
  p.heading('区域态势', design.preset === 'weather' ? 'REGIONAL WEATHER' : 'REGIONAL NETWORK', 68, 336, 1124);
  p.line(68, 358, 1192, 358, c.line);
  const map = { x: 250, y: 370, scale: 0.76 };
  if (art) {
    p.add(`<image x="68" y="380" width="1124" height="500" href="${art.data}" preserveAspectRatio="xMidYMid slice"/>`);
    p.rect(68, 380, 1124, 500, c.background, `fill-opacity="${design.theme === 'light' ? 0.2 : 0.28}"`);
  }
  p.add('<g data-viz="grid">');
  for (let x = 98; x < 1190; x += 58) p.line(x, 380, x, 880, c.faint, 'stroke-width="1"');
  for (let y = 390; y < 890; y += 50) p.line(68, y, 1192, y, c.faint, 'stroke-width="1"');
  p.add('</g>');
  p.add('<g data-viz="radar">');
  for (const radius of [115, 185, 255]) p.add(`<ellipse cx="720" cy="625" rx="${radius * 1.36}" ry="${radius}" fill="none" stroke="${c.accent}" stroke-opacity="0.14" stroke-width="1"/>`);
  p.add(`<ellipse cx="720" cy="625" rx="345" ry="254" fill="url(#visual-radar)"/>`);
  p.line(720, 372, 720, 878, c.accent, 'stroke-opacity="0.12"');
  p.line(374, 625, 1066, 625, c.accent, 'stroke-opacity="0.12"');
  p.add('</g>');
  // 2026-11-12 复审：不画国界轮廓。Natural Earth 按实际控制线画国界、本视图又截掉南海诸岛，
  // 按国内地图管理规定属于不合规的全国地图；点位仍按经纬度投影，只作位置示意。需要地图底图时用带审图号的标准地图。
  if (art) p.rect(68, 386, 166, 206, c.surface, 'rx="9" fill-opacity="0.94"');
  p.text(design.preset === 'weather' ? '观测视野' : '协同视野', 76, 408, 17, c.muted);
  p.text('点位示意', 76, 445, 26, c.text);
  p.text('按经纬度定位', 76, 473, 14, c.muted);
  p.line(76, 493, 196, 493, c.line);
  p.text('图层示意', 76, 518, 14, c.muted);
  p.circle(82, 543, 4, c.accent);
  p.text('数据点位', 96, 548, 14, c.muted);
  p.circle(82, 572, 4, c.accent2);
  p.text(rangeLabel(design), 96, 577, 14, c.muted);
  markerLabels(p, design, c, map, state);
  if (!design.markers.length) p.text('暂无提供的点位数据', 720, 640, 22, c.muted, 'text-anchor="middle"');
  p.rect(68, 899, 1124, 57, c.surface2, 'rx="10"');
  p.text(`${design.markers.length} 个${design.dataMode === 'demo' ? '演示' : '提供'}点位`, 88, 933, 17);
  p.text(art ? '背景：视觉素材 · 非实况影像' : MAP_NOTE, 1172, 932, 14, c.muted, 'text-anchor="end"');
  if (art) p.text(MAP_NOTE, 600, 932, 14, c.muted, 'text-anchor="middle"');
}

/** 大屏最小字号：设计稿按1920×1080，4K放大2倍；小于14会在远看时读不清（2026-11-12 复审） */
export const VISUAL_MIN_FONT = 14;
/** 地图说明：只示意点位，不画国界。 */
const MAP_NOTE = '点位按经纬度示意 · 未绘制国界';
/** 范围图层：气象叫雷达，其他场景叫覆盖范围（不把气象专用词带进别的大屏） */
export const rangeLabel = design => design.preset === 'weather' ? '雷达' : '覆盖范围';

function trendPanel(p, design, c, state) {
  p.panel(1240, 294, 640, 340);
  const seriesCaption = [design.seriesLabel, design.seriesUnit].filter(Boolean).join(' / ');
  p.heading('趋势观察', seriesCaption || '未提供指标单位', 1268, 336, 584);
  if (!design.series.length) {
    p.text('暂无趋势数据', 1560, 472, 22, c.muted, 'text-anchor="middle"');
    return;
  }
  const chart = { x: 1300, y: 390, w: 544, h: 164 };
  const values = design.series.map(item => item.value);
  const bottom = Math.min(...values), top = Math.max(...values);
  const pad = Math.max(1, (top - bottom) * 0.18), low = bottom - pad, high = top + pad;
  const valueLabel = value => Math.abs(value) >= 1e6 ? (value / 1e6).toFixed(1) + 'M' : Math.abs(value) >= 1e3 ? (value / 1e3).toFixed(1) + 'k' : String(n(value));
  for (let i = 0; i < 4; i++) {
    const y = chart.y + i * chart.h / 3;
    p.line(chart.x, y, chart.x + chart.w, y, c.line, 'stroke-dasharray="3 7"');
    p.text(valueLabel(high - (high - low) * i / 3), chart.x - 14, y + 4, 14, c.muted, 'text-anchor="end"');
  }
  const points = values.map((value, index) => ({ x: chart.x + (values.length === 1 ? chart.w / 2 : chart.w * index / (values.length - 1)), y: chart.y + chart.h * (high - value) / (high - low) }));
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${n(point.x)} ${n(point.y)}`).join(' ');
  if (points.length > 1) {
    p.add(`<path d="${line} L${n(points.at(-1).x)} ${chart.y + chart.h} L${n(points[0].x)} ${chart.y + chart.h} Z" fill="url(#visual-chart)"/>`);
    p.add(`<path d="${line}" fill="none" stroke="${c.accent}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  const labelWidth = Math.max(...design.series.map(item => units(item.label))) * 13;
  const ticks = Math.max(2, Math.min(6, Math.floor(chart.w / Math.max(70, labelWidth + 16))));
  const every = Math.max(1, Math.ceil((points.length - 1) / (ticks - 1)));
  points.forEach((point, index) => {
    const item = design.series[index], selected = state.seriesIndex === index;
    p.add(`<g data-viz="series-point" data-index="${index}" data-label="${xml(item.label)}">`);
    p.circle(point.x, point.y, selected ? 11 : 8, c.accent, 'fill-opacity="0.12"');
    p.circle(point.x, point.y, selected ? 5 : 3.5, c.surface, `stroke="${c.accent}" stroke-width="2"`);
    if (index % every === 0 || index === points.length - 1 && (index - 1) % every !== 0) {
      const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
      p.text(item.label, point.x, chart.y + chart.h + 28, 14, c.muted, `text-anchor="${anchor}"`);
    }
    p.add('</g>');
  });
  p.text(design.dataMode === 'demo' ? '示例序列 · 选择时段查看对应数值' : '来源序列 · 不推算缺失时段', 1268, 612, 14, c.muted);
}

function alertsPanel(p, design, c) {
  p.panel(1240, 654, 640, 328);
  p.heading(design.preset === 'weather' ? '关注与动态' : '协同动态', 'ACTIVITY', 1268, 696, 584);
  if (!design.alerts.length) {
    p.text('暂无提供的动态信息', 1560, 824, 20, c.muted, 'text-anchor="middle"');
    return;
  }
  design.alerts.forEach((item, index) => {
    const y = 724 + index * 80, color = item.level === 'critical' ? c.danger : item.level === 'info' ? c.accent : c.warm;
    p.add(`<g data-viz="alert" data-index="${index}" data-label="${xml(item.title)}">`);
    p.rect(1268, y, 584, 67, c.surface2, 'rx="9"');
    p.rect(1268, y + 14, 3, 38, color, 'rx="1"');
    p.text(item.title, 1286, y + 27, fit(item.title, 17, 365, 14));
    rows(item.time, 14, 160).forEach((row, rowIndex) => p.text(row, 1836, y + 17 + rowIndex * 16, 14, c.muted, 'text-anchor="end"'));
    const detailRows = rows(item.detail, 14, 548);
    detailRows.forEach((row, rowIndex) => p.text(row, 1286, y + (detailRows.length > 1 ? 44 : 51) + rowIndex * 16, 14, c.muted));
    p.add('</g>');
  });
}

/** 保留背景原始字节，只在SVG中cover显示；背景永远不承载程序数据或文字。 */
export function composeVisualScene(input, { background = null, state = {} } = {}) {
  const design = normalizeVisualDesign(input), c = THEMES[design.theme], texts = [];
  const p = painter(c, texts);
  const art = background ? normalizePosterBackground(background) : null;
  const scale = Math.min(design.width / 1920, design.height / 1080);
  const dx = (design.width - 1920 * scale) / 2, dy = (design.height - 1080 * scale) / 2;
  p.add(`<svg xmlns="http://www.w3.org/2000/svg" id="visual-scene" width="${design.width}" height="${design.height}" viewBox="0 0 ${design.width} ${design.height}">`);
  p.add(`<defs><radialGradient id="visual-ambient"><stop offset="0" stop-color="${c.accent}" stop-opacity="0.12"/><stop offset="1" stop-color="${c.background}" stop-opacity="0"/></radialGradient><radialGradient id="visual-radar"><stop offset="0" stop-color="${c.accent}" stop-opacity="0.09"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></radialGradient><linearGradient id="visual-chart" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.accent}" stop-opacity="0.2"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></linearGradient></defs>`);
  p.rect(0, 0, design.width, design.height, c.background);
  p.add(`<g transform="translate(${n(dx)} ${n(dy)}) scale(${n(scale)})">`);
  p.add('<ellipse cx="1170" cy="80" rx="790" ry="590" fill="url(#visual-ambient)"/>');
  header(p, design, c);
  metrics(p, design, c);
  mapPanel(p, design, c, state, art);
  trendPanel(p, design, c, state);
  alertsPanel(p, design, c);
  p.line(40, 1006, 1880, 1006, c.line);
  p.text(design.dataMode === 'demo' ? `演示数据 · 非实时${design.preset === 'weather' ? '气象' : '业务'}信息 · 不用于决策` : '提供数据 · 按来源记录展示 · 未独立核验', 40, 1035, 15, c.muted);
  const sourceRows = rows(`来源：${design.source}`, 14, 950);
  sourceRows.forEach((row, rowIndex) => p.text(row, 1880, (sourceRows.length > 1 ? 1027 : 1035) + rowIndex * 17, 14, c.muted, 'text-anchor="end"'));
  p.text('WEIYANG  /  VISUAL STUDIO', 40, 1066, 14, c.muted, 'letter-spacing="1.5"');
  p.text(`点位按经纬度示意、未绘制国界，${rangeLabel(design)}图层为视觉示意，均非实况影像`, 1880, 1066, 14, c.muted, 'text-anchor="end"');
  p.add('</g></svg>');
  return { svg: p.parts.join(''), width: design.width, height: design.height, texts,
    backgroundPlacement: art ? { mode: 'map', fit: 'cover', x: n(dx + 68 * scale), y: n(dy + 380 * scale), width: n(1124 * scale), height: n(500 * scale), sourceWidth: art.width, sourceHeight: art.height, overlayOpacity: design.theme === 'light' ? 0.2 : 0.28, label: '视觉素材，非实况或真实地图影像' } : null };
}

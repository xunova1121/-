/**
 * 版式模板海报（2026-11-18 用户：海报还是不达标，别人做的好看；一块做然后发版）。
 *
 * 以前文字多的海报靠模型临场给每块文字坐标，设计感上限低、来回返工。这里先做好六套设计过的版式：
 * 新闻速览、人物事件、赛程日程、活动宣传、数据播报、要点清单。模型只选模板、填内容（可配一张主视觉图），
 * 程序按真实字宽算每段高度、排间距、定配色，再走原来的分层交付（PNG/SVG/可编辑PPT、对比度与手机可读检查）。
 * 字号按“整张缩到手机 390 宽仍能读”定：正文≥34px、标题≥80px（1080宽画布）。文字多了画布自动加高，不缩字、不截字。
 */
import { wrapParagraphs } from './posterComposition.js';
import { designError } from './layeredDesignInput.js';

const W = 1080, M = 72, CW = W - M * 2;
export const TEMPLATE_STYLES = {
  blue: { background: '#F2F5FA', ink: '#0F1B2D', muted: '#55657D', accent: '#1F5BD8', card: '#FFFFFF', deep: '#0B1F45', tint: '#E3ECFB', onDeep: '#FFFFFF', onDeepMuted: '#C9D6EE' },
  red: { background: '#FBF5F3', ink: '#1F1414', muted: '#6B5555', accent: '#C8102E', card: '#FFFFFF', deep: '#5E0C18', tint: '#F8E1E4', onDeep: '#FFFFFF', onDeepMuted: '#F1CDD2' },
  green: { background: '#F2F8F4', ink: '#10241A', muted: '#4D6457', accent: '#138A55', card: '#FFFFFF', deep: '#0C3727', tint: '#DDF1E6', onDeep: '#FFFFFF', onDeepMuted: '#C8E6D5' },
  dark: { background: '#0D1320', ink: '#EAF0FA', muted: '#9AA8BF', accent: '#4CC3FF', card: '#172235', deep: '#060A12', tint: '#13324A', onDeep: '#FFFFFF', onDeepMuted: '#A9B7CC' },
  warm: { background: '#FFF6EC', ink: '#2A1A0D', muted: '#6E5A48', accent: '#E0631A', card: '#FFFFFF', deep: '#4E2408', tint: '#FCE3D0', onDeep: '#FFFFFF', onDeepMuted: '#F5D3B8' }
};
const fail = message => designError(message, 'POSTER_TEMPLATE_INPUT');
const str = (v, what, max, required = false) => {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  if (required && !s) throw fail(`模板缺少${what}`);
  if ([...s].length > max) throw fail(`${what}超过${max}字，请精简（模板不截字）`);
  return s;
};
const arr = (v, what, min, max) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw fail(`${what}需要${min}–${max}项`);
  return v;
};

/** 排版器：从上往下放图层，记录当前高度 */
const mix = (a, b, t) => '#' + [0, 2, 4].map(i => Math.round(parseInt(a.slice(1 + i, 3 + i), 16) * (1 - t) + parseInt(b.slice(1 + i, 3 + i), 16) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
/**
 * immersive（沉浸式，图文融合，2026-11-18 用户：模板都是图文分开的）：一张图铺满整张海报并由上到下压暗，
 * 标题直接压在图上，卡片做成半透明“毛玻璃”透出画面；配色整体换成深底浅字。
 */
function layout(style, immersive = false) {
  const base = TEMPLATE_STYLES[style] || TEMPLATE_STYLES.blue;
  const c = immersive ? { ...base, background: base.deep, ink: base.onDeep, muted: base.onDeepMuted, card: base.deep, tint: mix(base.deep, base.accent, 0.38) } : base;
  // 沉浸式深底上，强调色做文字时提亮（原色做底块、圆点不变），保证压在画面和半透明卡片上也看得清
  const accentText = immersive ? mix(base.accent, '#FFFFFF', 0.6) : base.accent;
  const layers = [];
  let n = 0;
  const id = p => `${p}-${++n}`;
  const text = (key, value, x, y, w, size, o = {}) => {
    const rows = wrapParagraphs(value, size, w, { wordWrap: true });
    if (!rows) throw fail(`“${value.slice(0, 10)}…”在模板宽度内放不下`);
    const h = Math.ceil(rows.length * size * 1.4) + 2;
    layers.push({ id: key, type: 'text', text: value, x, y, w, h, fontSize: size, minFontSize: size, weight: o.bold ? 700 : 400, color: immersive && o.color === c.accent ? accentText : o.color || c.ink, align: o.align || 'left', ...(o.role && { role: o.role }), ...(o.group && { group: o.group }) });
    return h;
  };
  // 沉浸式：卡片底（card/tint）做成半透明，透出后面的画面
  const glass = immersive ? { stops: [[0, 0.74], [1, 0.74]] } : null;
  const rect = (x, y, w, h, fill, o = {}) => { const fade = o.fade || (glass && (fill === c.card || fill === c.tint) ? glass : null); layers.push({ id: o.id || id('shape'), type: 'shape', x, y, w, h, fill, radius: o.radius || 0, decorative: o.decorative !== false, ...(o.group && { group: o.group }), ...(fade && { fade }) }); };
  return { layers, c, id, text, rect, immersive, zones: [] };
}

/** 页头：有主视觉图就铺图并压暗底部，没有就用深色块加装饰光斑；返回页头高度 */
function header(L, { image, eyebrow, date, title, summary, minH = 560, align = 'left' }) {
  const { c, text, rect, layers } = L;
  // 先量标题和导语占多高，页头至少容下它们
  const titleRows = wrapParagraphs(title, 84, CW, { wordWrap: true }) || [];
  const summaryRows = summary ? wrapParagraphs(summary, 36, CW, { wordWrap: true }) || [] : [];
  const textH = 64 + 26 * 1.4 + 40 + titleRows.length * 84 * 1.4 + (summary ? 24 + summaryRows.length * 36 * 1.4 : 0) + 64;
  const H = Math.ceil(Math.max(L.immersive ? Math.max(minH, 820) : minH, image || L.immersive ? textH + 260 : textH));
  if (L.immersive) {
    // 沉浸式：页头不单独铺底，整张图在最底层（templateDesignInput 里补），这里只记下标题区给生图留位
    L.zones.push({ id: 'title', x: 0, y: H - textH, w: W, h: textH, tone: 'dark' });
  } else rect(0, 0, W, H, c.deep, { id: 'header-bg' });
  if (L.immersive) { /* 画面与压暗层统一在最底层补 */ } else if (image) {
    layers.push({ id: 'hero', type: 'image', asset: 'hero', x: 0, y: 0, w: W, h: H, fit: 'cover', detail: '主视觉' });
    rect(0, 0, W, H, c.deep, { id: 'hero-shade', fade: { stops: [[0, 0.15], [0.45, 0.45], [1, 0.94]] } });
  } else {
    // 无图时页头：整宽竖向渐变，顶部透出一点强调色，避免纯色块显得单调（不画硬边装饰块）
    rect(0, 0, W, H, c.accent, { id: 'header-glow', fade: { stops: [[0, 0.28], [0.6, 0.06], [1, 0]] } });
  }
  let y = H - (textH - 64);
  // 眉题在左、日期在右，各占半宽，文字框不重叠
  if (eyebrow) {
    // 字宽按真实字形量（中文约等于字号，留余量），不让眉题折成两行
    const w = Math.min(CW / 2 - 16, [...eyebrow].length * 32 + 64);
    // 沉浸式：标签底块压深一档，白字在任何画面上都够清楚
    rect(M, y, w, 50, L.immersive ? mix(c.accent, '#000000', 0.3) : c.accent, { id: 'eyebrow-bg', radius: 25 });
    text('eyebrow', eyebrow, M + 24, y + 6, w - 40, 26, { bold: true, color: '#FFFFFF', role: 'label' });
  }
  if (date) text('date', date, M + CW / 2, y + 6, CW / 2, 26, { color: c.onDeepMuted, align: 'right', role: 'label' });
  y += 26 * 1.4 + 40;
  y += text('title', title, M, y, CW, 84, { bold: true, color: c.onDeep, align, role: 'heading' });
  if (summary) { y += 24; text('summary-body', summary, M, y, CW, 36, { color: c.onDeepMuted, align }); }
  return H;
}
function footer(L, value, y) {
  const { c, text, rect } = L;
  rect(M, y, CW, 2, c.muted, { id: 'footer-rule' });
  return y + 22 + text('footer', value, M, y + 22, CW, 24, { color: c.muted, role: 'caption' }) + 56;
}
/** 带序号的卡片列表 */
function numberedCards(L, items, y, { numbered = true } = {}) {
  const { c, text, rect, layers } = L;
  items.forEach((it, i) => {
    const x = M + (numbered ? 112 : 40), w = CW - (numbered ? 112 : 40) - 40, top = y;
    const start = layers.length;
    rect(M, top, CW, 10, c.card, { id: `item-${i + 1}-card`, radius: 20, group: `item-${i + 1}` });
    let cy = top + 36;
    if (numbered) {
      rect(M + 32, top + 34, 60, 60, i === 0 ? c.accent : c.tint, { id: `item-${i + 1}-dot`, radius: 30, group: `item-${i + 1}` });
      text(`item-${i + 1}-no`, String(i + 1), M + 32, top + 42, 60, 30, { bold: true, color: i === 0 ? '#FFFFFF' : c.accent, align: 'center', role: 'label', group: `item-${i + 1}` });
    }
    cy += text(`item-${i + 1}-title`, it.title, x, cy, w, 40, { bold: true, group: `item-${i + 1}` });
    if (it.detail) { cy += 10; cy += text(`item-${i + 1}-body`, it.detail, x, cy, w, 34, { color: c.muted, group: `item-${i + 1}` }); }
    if (it.source) { cy += 10; cy += text(`item-${i + 1}-label`, it.source, x, cy, w, 26, { color: c.accent, role: 'label', group: `item-${i + 1}` }); }
    const h = Math.max(128, cy - top + 32);
    layers[start].h = h;
    y = top + h + 24;
  });
  return y;
}

const TEMPLATES = {
  /** 新闻速览：页头大标题 + 带序号的新闻卡 + 来源页脚 */
  news_brief(content, L, image) {
    const items = arr(content.items, '新闻条目items', 2, 6).map((it, i) => ({ title: str(it?.title, `第${i + 1}条标题`, 30, true), detail: str(it?.detail, `第${i + 1}条说明`, 70), source: str(it?.source, `第${i + 1}条来源`, 30) }));
    let y = header(L, { image, eyebrow: str(content.eyebrow, '栏目', 10) || '新闻速览', date: str(content.date, '日期', 20), title: str(content.headline, '大标题', 30, true), summary: str(content.summary, '导语', 60) }) + 48;
    y = numberedCards(L, items, y);
    return footer(L, str(content.footer, '页脚（来源/时间）', 60) || '内容整理自公开报道', y + 16);
  },
  /** 人物事件：页头（人名+标题）+ 引言 + 竖向时间线 + 关键数字 */
  person_event(content, L, image) {
    const { c, text, rect } = L;
    const events = arr(content.events, '时间线events', 2, 7).map((e, i) => ({ date: str(e?.date, `第${i + 1}个时间`, 12, true), text: str(e?.text, `第${i + 1}个事件`, 50, true), focus: e?.focus === true }));
    const facts = (Array.isArray(content.facts) ? content.facts : []).slice(0, 4).map((f, i) => ({ label: str(f?.label, `第${i + 1}个数字说明`, 10, true), value: str(f?.value, `第${i + 1}个数字`, 10, true) }));
    let y = header(L, { image, eyebrow: str(content.name, '人物', 12, true), date: str(content.role, '身份', 20), title: str(content.headline, '大标题', 30, true), summary: str(content.summary, '导语', 60) }) + 48;
    const quote = str(content.quote, '引言', 80);
    if (quote) {
      rect(M, y, CW, 10, c.tint, { id: 'quote-card', radius: 20 });
      rect(M, y, 10, 10, c.accent, { id: 'quote-bar' });
      text('quote-mark', '“', M + 36, y + 10, 300, 72, { bold: true, color: c.accent, role: 'label' });
      const h = text('quote-body', quote, M + 48, y + 118, CW - 96, 36, { bold: true });
      L.layers.find(n => n.id === 'quote-card').h = h + 150; L.layers.find(n => n.id === 'quote-bar').h = h + 150;
      y += h + 150 + 48;
    }
    text('timeline-title', '事件时间线', M, y, CW, 40, { bold: true }); y += 76;
    const lineTop = y;
    events.forEach((e, i) => {
      rect(M + 14, y + 10, 32, 32, e.focus ? c.accent : c.card, { id: `event-${i + 1}-dot`, radius: 16, group: `event-${i + 1}` });
      const dh = text(`event-${i + 1}-label`, e.date, M + 72, y, 250, 30, { bold: true, color: c.accent, role: 'label', group: `event-${i + 1}` });
      const h = Math.max(dh, text(`event-${i + 1}-body`, e.text, M + 340, y, CW - 340, 34, { bold: e.focus, group: `event-${i + 1}` }));
      y += Math.max(h, 52) + 36;
    });
    L.layers.splice(L.layers.findIndex(n => n.id === 'event-1-dot'), 0, { id: 'timeline-line', type: 'shape', x: M + 28, y: lineTop + 26, w: 4, h: Math.max(4, y - lineTop - 70), fill: c.tint, radius: 0, decorative: true });
    if (facts.length) {
      y += 16;
      const w = (CW - 24 * (facts.length - 1)) / facts.length;
      facts.forEach((f, i) => {
        rect(M + i * (w + 24), y, w, 190, c.card, { id: `fact-${i + 1}-card`, radius: 20, group: `fact-${i + 1}` });
        text(`fact-${i + 1}-value`, f.value, M + i * (w + 24) + 24, y + 30, w - 48, 52, { bold: true, color: c.accent, group: `fact-${i + 1}` });
        text(`fact-${i + 1}-label`, f.label, M + i * (w + 24) + 24, y + 116, w - 48, 26, { color: c.muted, role: 'label', group: `fact-${i + 1}` });
      });
      y += 190 + 48;
    }
    return footer(L, str(content.footer, '页脚（来源/时间）', 60) || '内容整理自公开报道', y + 16);
  },
  /** 赛程/日程：页头 + 分组表格（时间 | 内容 | 备注），重点行高亮 */
  schedule(content, L, image) {
    const { c, text, rect } = L;
    const groups = arr(content.groups, '分组groups', 1, 5).map((g, i) => ({ name: str(g?.name, `第${i + 1}组名`, 12, true), rows: arr(g?.rows, `第${i + 1}组rows`, 1, 14).map((r, j) => ({ time: str(r?.time, `第${j + 1}行时间`, 8, true), text: str(r?.text, `第${j + 1}行内容`, 24, true), note: str(r?.note, `第${j + 1}行备注`, 10), focus: r?.focus === true })) }));
    let y = header(L, { image, eyebrow: str(content.eyebrow, '栏目', 10) || '赛程', date: str(content.date, '日期', 20), title: str(content.headline, '大标题', 30, true), summary: str(content.summary, '导语', 60) }) + 40;
    groups.forEach((g, gi) => {
      rect(M, y + 8, 10, 40, c.accent, { id: `group-${gi + 1}-bar` });
      text(`group-${gi + 1}-title`, g.name, M + 28, y, CW - 28, 40, { bold: true }); y += 76;
      g.rows.forEach((r, ri) => {
        const key = `row-${gi + 1}-${ri + 1}`;
        const noteW = r.note ? 220 : 0;
        const rows = wrapParagraphs(r.text, 34, CW - 220 - noteW - 48, { wordWrap: true }) || [r.text];
        const h = Math.max(88, rows.length * 34 * 1.4 + 40);
        rect(M, y, CW, h, r.focus ? c.tint : ri % 2 ? c.background : c.card, { id: `${key}-bg`, radius: 14, group: key });
        if (r.focus) rect(M, y, 8, h, c.accent, { id: `${key}-mark`, group: key });
        text(`${key}-label`, r.time, M + 32, y + (h - 34 * 1.4) / 2, 170, 34, { bold: true, color: c.accent, group: key });
        text(`${key}-body`, r.text, M + 220, y + 20, CW - 220 - noteW - 48, 34, { bold: r.focus, group: key });
        if (r.note) text(`${key}-note`, r.note, W - M - noteW - 24, y + (h - 26 * 1.4) / 2, noteW, 26, { color: c.muted, align: 'right', role: 'label', group: key });
        y += h + 10;
      });
      y += 36;
    });
    return footer(L, str(content.footer, '页脚（来源/时间）', 60) || '以官方发布为准', y);
  },
  /** 活动宣传：大主视觉 + 信息卡（时间/地点/费用）+ 亮点 + 行动号召 */
  event_promo(content, L, image) {
    const { c, text, rect } = L;
    const info = arr(content.info, '活动信息info（时间/地点等）', 1, 4).map((f, i) => ({ label: str(f?.label, `第${i + 1}项名称`, 6, true), value: str(f?.value, `第${i + 1}项内容`, 30, true) }));
    const highlights = (Array.isArray(content.highlights) ? content.highlights : []).slice(0, 4).map((h, i) => str(h, `第${i + 1}个亮点`, 30, true));
    let y = header(L, { image, eyebrow: str(content.eyebrow, '栏目', 10), title: str(content.headline, '大标题', 24, true), summary: str(content.subtitle, '副标题', 40), minH: image ? 980 : 720, align: 'left' }) + 48;
    info.forEach((f, i) => {
      const key = `info-${i + 1}`;
      rect(M, y, CW, 10, c.card, { id: `${key}-card`, radius: 20, group: key });
      text(`${key}-label`, f.label, M + 36, y + 30, 180, 30, { bold: true, color: c.accent, role: 'label', group: key });
      const h = text(`${key}-body`, f.value, M + 220, y + 26, CW - 256, 36, { bold: true, group: key });
      L.layers.find(n => n.id === `${key}-card`).h = h + 52;
      y += h + 52 + 18;
    });
    if (highlights.length) {
      y += 24; text('highlights-title', '活动亮点', M, y, CW, 40, { bold: true }); y += 76;
      highlights.forEach((h, i) => {
        rect(M, y + 16, 16, 16, c.accent, { id: `hl-${i + 1}-dot`, radius: 8 });
        y += text(`hl-${i + 1}-body`, h, M + 40, y, CW - 40, 34) + 18;
      });
    }
    const cta = str(content.cta, '行动号召', 24);
    if (cta) { y += 24; rect(M, y, CW, 120, c.accent, { id: 'cta-bg', radius: 60 }); text('cta-body', cta, M, y + 34, CW, 36, { bold: true, color: '#FFFFFF', align: 'center' }); y += 168; }
    return footer(L, str(content.footer, '页脚', 60) || '最终安排以主办方通知为准', y + 16);
  },
  /** 数据播报：页头 + 关键数字卡 + 柱状图 + 解读要点 */
  data_report(content, L, image) {
    const { c, text, rect, layers } = L;
    const kpis = arr(content.kpis, '关键数字kpis', 2, 4).map((k, i) => ({ label: str(k?.label, `第${i + 1}个指标名`, 12, true), value: str(k?.value, `第${i + 1}个数值`, 10, true), change: str(k?.change, `第${i + 1}个变化`, 12) }));
    const notes = (Array.isArray(content.notes) ? content.notes : []).slice(0, 4).map((n, i) => str(n, `第${i + 1}条解读`, 50, true));
    let y = header(L, { image, eyebrow: str(content.eyebrow, '栏目', 10) || '数据播报', date: str(content.period, '统计期', 20), title: str(content.headline, '大标题', 30, true), summary: str(content.summary, '导语', 60) }) + 48;
    // 3 个关键数字排一行，2 或 4 个排两列，不留落单的格子
    const cols = kpis.length === 3 ? 3 : 2, w = (CW - 24 * (cols - 1)) / cols;
    kpis.forEach((k, i) => {
      const x = M + (i % cols) * (w + 24), top = y + Math.floor(i / cols) * 234, key = `kpi-${i + 1}`, valueSize = cols === 3 ? 48 : 60;
      rect(x, top, w, 210, c.card, { id: `${key}-card`, radius: 20, group: key });
      text(`${key}-label`, k.label, x + 32, top + 28, w - 64, 26, { color: c.muted, role: 'label', group: key });
      text(`${key}-value`, k.value, x + 32, top + 70, w - 64, valueSize, { bold: true, color: c.accent, group: key });
      if (k.change) text(`${key}-note`, k.change, x + 32, top + 158, w - 64, 26, { color: k.change.startsWith('-') || k.change.includes('降') || k.change.includes('跌') ? '#C0392B' : '#178A4C', role: 'label', group: key });
    });
    y += Math.ceil(kpis.length / cols) * 234 + 32;
    const chart = content.chart;
    if (chart) {
      const points = arr(chart.points, '图表points', 2, 10).map((p, i) => ({ label: str(p?.label, `第${i + 1}个分类`, 8, true), value: Number(p?.value) }));
      if (points.some(p => !Number.isFinite(p.value))) throw fail('图表数值必须是数字');
      if (chart.title) { text('chart-title', str(chart.title, '图表标题', 20), M, y, CW, 40, { bold: true }); y += 76; }
      rect(M, y, CW, 600, c.card, { id: 'chart-card', radius: 20, group: 'chart' });
      layers.push({ id: 'chart', type: 'chart', chartType: 'bar', x: M + 32, y: y + 32, w: CW - 64, h: 536, color: c.accent, unit: str(chart.unit, '单位', 6), points, group: 'chart', detail: str(chart.title, '图表标题', 20) || '数据图表' });
      y += 600 + 40;
    }
    notes.forEach((n, i) => { rect(M, y + 16, 16, 16, c.accent, { id: `note-${i + 1}-dot`, radius: 8 }); y += text(`note-${i + 1}-body`, n, M + 40, y, CW - 40, 34) + 18; });
    return footer(L, str(content.footer, '页脚（来源/时间）', 60) || '数据来源以官方发布为准', y + 32);
  },
  /** 要点清单：页头 + 编号卡片 */
  tips(content, L, image) {
    const items = arr(content.items, '要点items', 3, 8).map((it, i) => ({ title: str(it?.title, `第${i + 1}条要点`, 24, true), detail: str(it?.detail, `第${i + 1}条说明`, 60) }));
    let y = header(L, { image, eyebrow: str(content.eyebrow, '栏目', 10), date: str(content.date, '日期', 20), title: str(content.headline, '大标题', 30, true), summary: str(content.intro, '导语', 60) }) + 48;
    y = numberedCards(L, items, y);
    return footer(L, str(content.footer, '页脚', 60) || '仅供参考', y + 16);
  }
};
export const TEMPLATE_IDS = Object.keys(TEMPLATES);
export const TEMPLATE_GUIDE = 'news_brief新闻速览{date?,eyebrow?,headline,summary?,items[2–6]{title,detail?,source?},footer}；person_event人物事件{name,role?,headline,summary?,quote?,events[2–7]{date,text,focus?},facts?[≤4]{label,value},footer}；schedule赛程日程{date?,headline,summary?,groups[1–5]{name,rows[1–14]{time,text,note?,focus?}},footer}；event_promo活动宣传{headline,subtitle?,info[1–4]{label,value},highlights?[≤4],cta?,footer}；data_report数据播报{period?,headline,summary?,kpis[2–4]{label,value,change?},chart?{title,unit,points[{label,value}]},notes?[≤4],footer}；tips要点清单{headline,intro?,items[3–8]{title,detail?},footer}';

/** 模板 → 分层设计稿输入（走 deliverLayeredDesign） */
export function templateDesignInput(input) {
  const spec = input.template || {};
  const build = TEMPLATES[spec.id];
  if (!build) throw fail(`请选择模板id：${TEMPLATE_IDS.join('/')}`);
  const style = TEMPLATE_STYLES[spec.style] ? spec.style : spec.id === 'event_promo' ? 'warm' : spec.id === 'data_report' ? 'dark' : spec.id === 'person_event' ? 'red' : 'blue';
  const immersive = spec.layout === 'immersive';
  const L = layout(style, immersive), content = spec.content || {};
  const image = typeof spec.image === 'string' && spec.image.trim() ? spec.image.trim() : null;
  const height = Math.max(1350, Math.ceil(build(content, L, image)));
  if (height > 4096) throw fail('内容太多，画布超过4096像素高；请减少条目或拆成两张');
  if (immersive) {
    // 满版画面在最底层，上面一层由上到下压暗（标题区和卡片区都落在暗部），再往上才是文字和半透明卡片
    const contentTop = L.zones[0] ? L.zones[0].y + L.zones[0].h : 0;
    const under = [
      { id: 'immersive-bg', type: 'shape', x: 0, y: 0, w: W, h: height, fill: L.c.deep, radius: 0, decorative: true },
      ...(image ? [{ id: 'hero', type: 'image', asset: 'hero', x: 0, y: 0, w: W, h: height, fit: 'cover', detail: '主视觉' }]
        : [{ id: 'immersive-glow', type: 'shape', x: 0, y: 0, w: W, h: height, fill: L.c.accent, radius: 0, decorative: true, fade: { stops: [[0, 0.32], [0.45, 0.08], [1, 0]] } }]),
      { id: 'immersive-shade', type: 'shape', x: 0, y: 0, w: W, h: height, fill: L.c.deep, radius: 0, decorative: true, fade: { stops: [[0, 0.1], [0.3, 0.42], [0.6, 0.72], [1, 0.9]] } }
    ];
    L.layers.unshift(...under);
    L.zones.push({ id: 'content', x: 0, y: contentTop, w: W, h: height - contentTop, tone: 'dark' });
  }
  const c = L.c, title = str(content.headline, '大标题', 30, true);
  return {
    title: input.title || title, width: W, height, font_family: 'sans', ...(input.path && { path: input.path }),
    design: {
      layout: 'free', text_fit: 'strict', reading: 'phone',
      concept: { idea: `版式模板「${spec.id}」${immersive ? '（沉浸式图文融合）' : ''}：${title}`, relation: image || immersive ? 'overlay' : 'type-led', focus: '标题', mood: style },
      palette: { background: c.background, ink: c.ink, muted: c.muted, accent: c.accent, card: c.card },
      ...(image && { assets: [{ id: 'hero', path: image }] }),
      layers: L.layers
    },
    // 生图留位：画布比例的文字区（先排版后生图用）
    zones: L.zones.map(z => ({ id: z.id, tone: z.tone, x: 0, y: Math.round(z.y / height * 1000) / 1000, w: 1, h: Math.round(Math.min(z.h, height - z.y) / height * 1000) / 1000 }))
  };
}

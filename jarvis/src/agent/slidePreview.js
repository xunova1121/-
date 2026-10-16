/**
 * PPT 生成后检查：排版时把每页放的每个框（文字、色块、图片、表格、图表）记下来，
 *   1. 估算每个文字框按设定字号要占多高：放不下、超出页面、两段字压在一起 → 报问题（不花钱，每次都做）。
 *      PptxGenJS 的“缩小字号以适应”要在 PowerPoint 里编辑一下才生效，打开时字是按原字号排的，所以放不下就是真放不下。
 *   2. 照着记下的位置画出每页的样子（SVG），浏览器里转成图片，交给能看图的模型检查（看图模型可选）。
 * 估算按中文字宽 1 个字号、英文数字约 0.55 个字号算，和实际排版会差一点，只用来发现明显的问题。
 */

export const SLIDE_W = 13.333;
export const SLIDE_H = 7.5;
const FONT_FAMILY = `'Microsoft YaHei','PingFang SC','Noto Sans CJK SC','Source Han Sans SC',sans-serif`;
const CJK = /[⺀-鿿豈-﫿︰-﹏＀-￯　-〿]/;

/** 一个字有多宽（以字号为 1） */
export const emOf = (ch) => (CJK.test(ch) ? 1 : /[A-Z0-9@%&#MWmw]/.test(ch) ? 0.62 : ch === ' ' ? 0.28 : 0.5);

/**
 * 记录一页上放的东西：替换 addText / addShape / addImage / addTable / addChart，记下参数后照常调用
 * @returns {{ items: object[], slide: object }}
 */
export function recordSlide(sl, { shrink = true } = {}) {
  const items = [];
  const wrap = (name, make) => {
    const orig = sl[name].bind(sl);
    sl[name] = (...args) => { try { items.push(make(...args)); } catch { /* 记录失败不影响生成 */ } return orig(...args); };
  };
  wrap('addText', (text, o = {}) => ({ kind: 'text', text, ...box(o), o }));
  wrap('addShape', (type, o = {}) => ({ kind: 'shape', type: String(type), ...box(o), fill: o.fill?.color, line: o.line?.color, lineWidth: o.line?.width ?? 0.75, radius: o.rectRadius }));
  wrap('addImage', (o = {}) => ({ kind: 'image', ...box(o), data: o.data }));
  wrap('addTable', (rows, o = {}) => ({ kind: 'table', rows, ...box(o), o }));
  wrap('addChart', (type, data, o = {}) => ({ kind: 'chart', data: JSON.parse(JSON.stringify(data ?? [])), ...box(o), colors: o.chartColors ?? [] })); // 库会改写传进去的数据，先拷一份
  // 套在记录外面：记下的是缩好之后的字号。“缩小字号以适应”（fit: 'shrink'）打开时不生效：生成时就按估算把字号调到放得下（最多缩到 60%）
  if (shrink) {
    const orig = sl.addText.bind(sl);
    sl.addText = (text, o = {}) => { const f = o.fit === 'shrink' ? fitText(text, o) : { text, o }; return orig(f.text, f.o); };
  }
  return { items, slide: sl };
}
/** 字号乘 k（文字框和每段的字号一起缩） */
function scaleText(text, o, k) {
  const sz = (v) => (v ? Math.max(8, Math.round(v * k * 2) / 2) : v);
  const t = Array.isArray(text) ? text.map((r) => (r?.options?.fontSize ? { ...r, options: { ...r.options, fontSize: sz(r.options.fontSize) } } : r)) : text;
  return { text: t, o: { ...o, fontSize: sz(Number(o.fontSize) || 18) } };
}
/** 放不下就一档档缩小字号，直到放得下或缩到 60% */
export function fitText(text, o) {
  const h = Number(o.h) || 0;
  if (!h || !Number(o.w)) return { text, o };
  for (let k = 1; k >= 0.6 - 1e-9; k -= 0.05) {
    const f = k === 1 ? { text, o } : scaleText(text, o, k);
    if (wrapText(f.text, f.o, Number(o.w)).height <= h * 1.02) return f;
  }
  return scaleText(text, o, 0.6);
}
const box = (o) => ({ x: Number(o.x) || 0, y: Number(o.y) || 0, w: Number(o.w) || 0, h: Number(o.h) || 0 });

/** 文字框 → 段落：[{ runs: [{ text, size, bold, color }], bullet, level, before }] */
export function paragraphsOf(text, o = {}) {
  const base = Number(o.fontSize) || 18;
  const paras = [];
  let cur = null;
  const start = (opt = {}) => { cur = { runs: [], bullet: Boolean(opt.bullet), indent: (opt.bullet?.indent ?? 27) / 72, level: Number(opt.indentLevel) || 0, before: (Number(opt.paraSpaceBefore) || 0) / 72, after: (Number(opt.paraSpaceAfter) || 0) / 72, size: Number(opt.fontSize) || base }; paras.push(cur); };
  const runs = Array.isArray(text) ? text : [{ text: String(text ?? ''), options: {} }];
  for (const r of runs) {
    const opt = r?.options ?? {};
    const parts = String(r?.text ?? '').split('\n');
    parts.forEach((t, k) => {
      if (!cur || k > 0) start(k > 0 ? {} : opt);
      cur.runs.push({ text: t, size: Number(opt.fontSize) || cur.size, bold: opt.bold ?? o.bold, color: opt.color ?? o.color });
    });
    if (opt.breakLine) cur = null;
  }
  return paras;
}

/** 按框宽把段落折成行：每行 [{ text, size, bold, color }]，带行高 */
export function wrapText(text, o = {}, w = Number(o.w) || 1) {
  const m = o.margin != null ? (Array.isArray(o.margin) ? o.margin : [o.margin, o.margin, o.margin, o.margin]).map((v) => Number(v) / 72) : null;
  const inset = m ? { l: m[3] ?? m[0], r: m[1] ?? m[0], t: m[0], b: m[2] ?? m[0] } : { l: 0.1, r: 0.1, t: 0.05, b: 0.05 };
  const spacing = Number(o.lineSpacingMultiple) || 1;
  const lines = [];
  for (const p of paragraphsOf(text, o)) {
    const indent = p.bullet ? p.indent * (p.level + 1) : p.level * 0.4;
    const room = Math.max(0.2, w - inset.l - inset.r - indent);
    let line = { runs: [], width: 0, size: p.size, indent, bullet: p.bullet, before: p.before };
    const push = () => { line.height = (line.size / 72) * 1.2 * spacing; lines.push(line); };
    for (const run of p.runs) {
      let seg = { ...run, text: '' };
      for (const ch of run.text) {
        const cw = (emOf(ch) * run.size) / 72;
        if (line.width + cw > room && (line.width > 0 || seg.text)) {
          if (seg.text) line.runs.push(seg);
          push();
          line = { runs: [], width: 0, size: run.size, indent, bullet: false, before: 0 };
          seg = { ...run, text: '' };
        }
        seg.text += ch;
        line.width += cw;
        line.size = Math.max(line.size, run.size);
      }
      if (seg.text) line.runs.push(seg);
    }
    push();
    if (p.after) lines.at(-1).after = p.after;
  }
  const height = lines.reduce((n, l) => n + l.before + l.height + (l.after || 0), 0) + inset.t + inset.b;
  return { lines, height, inset };
}

const near = (a, b) => Math.abs(a - b) < 1e-6;
const overlap = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0.1 && h > 0.08 ? { w, h } : null;
};
const textOf = (t) => (Array.isArray(t) ? t.map((r) => r?.text ?? '').join('') : String(t ?? ''));

/**
 * 排版问题：字放不下、超出页面、文字互相压住、文字压在图片上
 * @param {Array<{ n: number, title: string, items: object[] }>} slides
 * @returns {Array<{ level: 'error'|'warn', text: string, slide: number }>}
 */
export function layoutIssues(slides, { max = 12 } = {}) {
  const issues = [];
  const add = (level, s, text) => { if (issues.length < max) issues.push({ level, text: `第 ${s.n} 页「${s.title || '无标题'}」${text}`, slide: s.n }); };
  for (const s of slides) {
    const texts = s.items.filter((it) => it.kind === 'text' && textOf(it.text).trim());
    for (const it of s.items) {
      if (it.kind === 'text' || it.kind === 'image' || it.kind === 'chart') {
        if (it.x + it.w > SLIDE_W + 0.05 || it.y + it.h > SLIDE_H + 0.05 || it.x < -0.05 || it.y < -0.05) add('error', s, `有内容超出了页面边界（${it.kind === 'text' ? `“${textOf(it.text).slice(0, 12)}…”` : it.kind === 'image' ? '图片' : '图表'}）`);
      }
    }
    const placed = [];
    for (const it of texts) {
      const need = wrapText(it.text, it.o, it.w).height;
      const ratio = need / Math.max(0.1, it.h);
      const snippet = textOf(it.text).replace(/\s+/g, '').slice(0, 14);
      if (ratio > 1.12) {
        const lines = wrapText(it.text, it.o, it.w).lines.length;
        add(ratio > 1.3 ? 'error' : 'warn', s, `的文字放不下：“${snippet}…”按 ${it.o.fontSize ?? 18} 号字要排约 ${lines} 行，高度超出文本框约 ${Math.round((ratio - 1) * 100)}%，打开时会溢出或压到别的内容。应精简这段字或拆成两页`);
      }
      // 竖直方向：文字实际占的范围（放不下时向下溢出）
      const v = it.o.valign ?? 'top';
      const top = v === 'top' ? it.y : v === 'middle' ? it.y + (it.h - need) / 2 : it.y + it.h - need;
      placed.push({ it, rect: { x: it.x, y: top, w: it.w, h: need }, snippet });
    }
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]; const b = placed[j];
        // 同一个框的位置（比如色块上的标题文字）不算
        if (near(a.it.x, b.it.x) && near(a.it.y, b.it.y)) continue;
        if (overlap(a.rect, b.rect)) { add('error', s, `有两段文字压在一起：“${a.snippet}”和“${b.snippet}”。应精简文字，让每段都在自己的位置放得下`); }
      }
      for (const img of s.items.filter((x) => x.kind === 'image' || x.kind === 'chart')) {
        if (overlap(placed[i].rect, img)) add('error', s, `的文字“${placed[i].snippet}”压到了${img.kind === 'image' ? '图片' : '图表'}上`);
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------- 画出来

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const color = (c, fallback = 'none') => (c ? `#${String(c).replace(/^#/, '')}` : fallback);

function textSvg(text, o, x, y, w, h, P) {
  const { lines, height, inset } = wrapText(text, o, w);
  const align = o.align ?? 'left';
  const v = o.valign ?? 'top';
  let cy = y + (v === 'middle' ? (h - height) / 2 : v === 'bottom' ? h - height : 0) + inset.t;
  const out = [];
  for (const l of lines) {
    cy += l.before;
    const base = cy + l.height * 0.78;
    const left = x + inset.l + l.indent;
    const ax = align === 'center' ? x + w / 2 : align === 'right' ? x + w - inset.r : left;
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    if (l.bullet) out.push(`<rect x="${(left - 0.22) * P}" y="${(base - l.size / 72 * 0.42) * P}" width="${(l.size / 72) * 0.3 * P}" height="${(l.size / 72) * 0.3 * P}" fill="${color(o.color, '#333')}"/>`);
    const spans = l.runs.map((r) => `<tspan font-size="${(r.size / 72) * P}"${r.bold ? ' font-weight="bold"' : ''} fill="${color(r.color ?? o.color, '#333333')}">${esc(r.text)}</tspan>`).join('');
    out.push(`<text x="${ax * P}" y="${base * P}" text-anchor="${anchor}">${spans}</text>`);
    cy += l.height + (l.after || 0);
  }
  return out.join('');
}

function shapeSvg(it, P) {
  const x = it.x * P; const y = it.y * P; const w = it.w * P; const h = it.h * P;
  const fill = color(it.fill); const stroke = color(it.line);
  const sw = (it.lineWidth / 72) * P;
  switch (it.type) {
    case 'line': return `<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke="${stroke}" stroke-width="${sw}"/>`;
    case 'ellipse': return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}"/>`;
    case 'roundRect': return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${(it.radius ?? 0.08) * P}" fill="${fill}"/>`;
    case 'homePlate': return `<polygon points="${x},${y} ${x + w - h / 2},${y} ${x + w},${y + h / 2} ${x + w - h / 2},${y + h} ${x},${y + h}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
    case 'chevron': return `<polygon points="${x},${y} ${x + w - h / 2},${y} ${x + w},${y + h / 2} ${x + w - h / 2},${y + h} ${x},${y + h} ${x + h / 2},${y + h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
    default: return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  }
}

function tableSvg(it, P) {
  const rows = it.rows.map((r) => r.map((c) => (typeof c === 'object' && c ? c : { text: String(c ?? ''), options: {} })));
  const n = Math.max(...rows.map((r) => r.length));
  const colW = Array.isArray(it.o.colW) ? it.o.colW : Array(n).fill(it.w / n);
  const fs = Number(it.o.fontSize) || 14;
  const out = [];
  let y = it.y;
  for (const r of rows) {
    const cells = r.map((c, ci) => wrapText(c.text, { fontSize: c.options?.fontSize ?? fs, margin: 4 }, colW[ci] ?? 1));
    const h = Math.max(Number(it.o.rowH) || 0, ...cells.map((c) => c.height));
    if (y + h > SLIDE_H) { out.push(`<text x="${it.x * P}" y="${(SLIDE_H - 0.1) * P}" font-size="${0.16 * P}" fill="#999">（表格放不下，续到下一页）</text>`); break; }
    let x = it.x;
    r.forEach((c, ci) => {
      const w = colW[ci] ?? 1;
      out.push(`<rect x="${x * P}" y="${y * P}" width="${w * P}" height="${h * P}" fill="${color(c.options?.fill?.color, '#ffffff')}" stroke="#BFC7D1" stroke-width="${0.01 * P}"/>`);
      out.push(textSvg(c.text, { fontSize: c.options?.fontSize ?? fs, margin: 4, align: c.options?.align, valign: 'middle', bold: c.options?.bold, color: c.options?.color ?? it.o.color }, x, y, w, h, P));
      x += w;
    });
    y += h;
  }
  return out.join('');
}

function chartSvg(it, P) {
  const series = Array.isArray(it.data) ? it.data : [];
  const labels = series[0]?.labels ?? [];
  const values = series.flatMap((s) => s.values ?? []).filter((v) => typeof v === 'number');
  const max = Math.max(1, ...values);
  const left = it.x + 0.6; const bottom = it.y + it.h - 0.6; const top = it.y + 0.3;
  const plotW = it.w - 0.8; const plotH = bottom - top;
  const out = [`<line x1="${left * P}" y1="${bottom * P}" x2="${(left + plotW) * P}" y2="${bottom * P}" stroke="#999" stroke-width="${0.01 * P}"/>`];
  const group = plotW / Math.max(1, labels.length);
  const bw = (group * 0.62) / Math.max(1, series.length);
  labels.forEach((lab, i) => {
    series.forEach((s, k) => {
      const v = Number(s.values?.[i]) || 0;
      const h = (Math.max(0, v) / max) * plotH;
      const x = left + i * group + group * 0.19 + k * bw;
      out.push(`<rect x="${x * P}" y="${(bottom - h) * P}" width="${bw * P}" height="${h * P}" fill="${color(it.colors[k % Math.max(1, it.colors.length)], '#4472C4')}"/>`);
      out.push(`<text x="${(x + bw / 2) * P}" y="${(bottom - h - 0.05) * P}" font-size="${0.15 * P}" text-anchor="middle" fill="#404040">${esc(v)}</text>`);
    });
    out.push(`<text x="${(left + i * group + group / 2) * P}" y="${(bottom + 0.25) * P}" font-size="${0.16 * P}" text-anchor="middle" fill="#404040">${esc(String(lab).slice(0, 10))}</text>`);
  });
  return out.join('');
}

/** 一页的 SVG 片段（不含 <svg> 外壳），P = 每英寸多少像素 */
export function slideBody(s, P) {
  const out = [`<rect x="0" y="0" width="${SLIDE_W * P}" height="${SLIDE_H * P}" fill="${color(s.background, '#FFFFFF')}"/>`];
  for (const it of s.items) {
    if (it.kind === 'shape') out.push(shapeSvg(it, P));
    else if (it.kind === 'text') {
      if (it.o.fill?.color) out.push(`<rect x="${it.x * P}" y="${it.y * P}" width="${it.w * P}" height="${it.h * P}" fill="${color(it.o.fill.color)}"/>`);
      out.push(textSvg(it.text, it.o, it.x, it.y, it.w, it.h, P));
    } else if (it.kind === 'image' && it.data) out.push(`<image x="${it.x * P}" y="${it.y * P}" width="${it.w * P}" height="${it.h * P}" preserveAspectRatio="none" href="data:${esc(String(it.data).replace(/^data:/, ''))}"/>`);
    else if (it.kind === 'table') out.push(tableSvg(it, P));
    else if (it.kind === 'chart') out.push(chartSvg(it, P));
  }
  return out.join('');
}

/** 一页画成完整的 SVG（宽 width 像素） */
export function slideSvg(s, { width = 1280 } = {}) {
  const P = width / SLIDE_W;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(SLIDE_H * P)}" viewBox="0 0 ${width} ${Math.round(SLIDE_H * P)}" font-family="${esc(FONT_FAMILY)}">${slideBody(s, P)}</svg>`;
}

/** 几页拼成一张（两列），每页左上角标页码；给模型看图时省流量 */
export function sheetSvg(slides, { cols = 2, cell = 760 } = {}) {
  const P = cell / SLIDE_W;
  const ch = SLIDE_H * P;
  const gap = 16;
  const rows = Math.ceil(slides.length / cols);
  const W = cols * cell + (cols + 1) * gap;
  const H = rows * (ch + gap + 28) + gap;
  const parts = slides.map((s, i) => {
    const x = gap + (i % cols) * (cell + gap);
    const y = gap + Math.floor(i / cols) * (ch + gap + 28);
    return `<text x="${x}" y="${y + 20}" font-size="20" font-weight="bold" fill="#222">第 ${s.n} 页</text><g transform="translate(${x},${y + 28})"><rect x="-1" y="-1" width="${cell + 2}" height="${ch + 2}" fill="#888"/>${slideBody(s, P)}</g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Math.round(H)}" viewBox="0 0 ${W} ${Math.round(H)}" font-family="${esc(FONT_FAMILY)}"><rect width="100%" height="100%" fill="#EEF0F3"/>${parts.join('')}</svg>`;
}

/**
 * 浏览器里把 SVG 转成 JPEG（给模型看）；没有画布的环境（测试、Node）返回 null
 * @returns {Promise<{ mime: string, data: string }|null>}
 */
export async function rasterize(svg, { quality = 0.8 } = {}) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const img = new Image();
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await new Promise((ok, fail) => { img.onload = ok; img.onerror = () => fail(new Error('预览图画不出来')); img.src = url; });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  canvas.width = canvas.height = 0; // 手机上早点释放内存
  return { mime: 'image/jpeg', data: dataUrl.replace(/^data:image\/jpeg;base64,/, '') };
}

/** 挑要给模型看的页：有问题的先看，其余按顺序补满，最多 max 页；每 4 页拼一张 */
export function pickSheets(slides, issues, { max = 8, per = 4 } = {}) {
  const bad = new Set(issues.map((x) => x.slide));
  const order = [...slides.filter((s) => bad.has(s.n)), ...slides.filter((s) => !bad.has(s.n))].slice(0, max).sort((a, b) => a.n - b.n);
  const out = [];
  for (let i = 0; i < order.length; i += per) out.push(order.slice(i, i + per));
  return out;
}

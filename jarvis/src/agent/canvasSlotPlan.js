/**
 * 卡槽底图“先排版、后生图”（2026-11-17 用户讨论：GPT 生成卡槽的，文字怎么添加）。
 *
 * 以前：让 GPT 随手画一张带空卡片的底图，再从像素里找卡片。卡片的个数、大小、位置都不受控，字多时放不下。
 * 现在：先按真实文案估出每块要多高，算好标题区、每张卡片、底注和主体的位置，
 * 把这些位置写进生图要求；图片生成后把计划存成同名 .slots.json，填字时先按像素找卡片，
 * 找不齐再核对计划位置是否真的是平整的留白，都不行才请看图模型定位。
 * 坐标一律是原图 0–1 比例，与 canvas.regions 同一约定。
 */
const round = n => Math.round(n * 10000) / 10000;
const pct = n => `${Math.round(n * 1000) / 10}%`;
const slotError = message => Object.assign(new Error(message), { code: 'CANVAS_SLOT_PLAN', kind: 'input' });
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
/** 中文按一字一格，英文数字按半格估宽 */
const units = value => [...value].reduce((s, c) => s + (/[\x20-\x7e]/.test(c) ? 0.55 : 1), 0);

export function parseImageSize(size) {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(String(size || ''));
  return match ? [Number(match[1]), Number(match[2])] : [1024, 1536];
}

/** slots: { header?: {title, body?}, entries: [{title, body?}], footer? } */
export function planCanvasSlots(slots, width, height) {
  const entries = Array.isArray(slots?.entries) ? slots.entries.map(e => ({ title: text(e?.title, 120), body: text(e?.body, 600) })).filter(e => e.title) : [];
  if (!entries.length || entries.length > 12) throw slotError('卡槽计划需要1–12条正文（entries[].title）');
  const header = slots.header && text(slots.header.title, 80) ? { title: text(slots.header.title, 80), body: text(slots.header.body, 200) } : null;
  const footer = text(slots.footer, 160);
  const margin = 0.07, innerW = 1 - margin * 2, aspect = height / width;
  // 字号与填字引擎的手机阅读默认值同量级：正文约画面宽的3.4%，卡片标题略大
  const body = 0.034, title = 0.042, line = 1.45, pad = 0.022;
  const rows = (value, size) => (value ? Math.max(1, Math.ceil(units(value) * size / (innerW - pad * 2))) : 0);
  // 高度先按“画面宽”为单位算，再换成占画面高的比例
  const need = entries.map(e => (rows(e.title, title) * title + rows(e.body, body) * body) * line + pad * 2 + (e.body ? body * 0.4 : 0));
  const toH = v => v / aspect, gap = toH(0.024);
  const headerH = header ? toH((rows(header.title, 0.075) * 0.075 + rows(header.body, body) * body) * 1.3 + 0.03) : 0;
  const top = 0.045, headerEnd = header ? top + headerH : top;
  const footerH = footer ? toH(rows(footer, 0.026) * 0.026 * 1.4 + 0.02) : 0;
  const bottom = footer ? 1 - 0.035 - footerH - 0.015 : 0.96;
  const cards = need.reduce((s, v) => s + toH(v), 0) + gap * (entries.length - 1);
  // 主体至少留画面高的22%；放不下就如实报错，不缩字
  const subject = bottom - headerEnd - cards - 0.03;
  if (subject < 0.22) throw slotError(`文案约需画面${pct(cards)}高，留给主体的不足22%：请减少条目/精简文字，或改用更高的画幅`);
  const regions = [];
  if (header) regions.push({ id: 'header', role: 'header', x: margin, y: round(top), w: innerW, h: round(headerH) });
  let y = bottom - cards;
  entries.forEach((_, i) => {
    const h = toH(need[i]);
    regions.push({ id: `slot-${i + 1}`, role: 'slot', x: margin, y: round(y), w: innerW, h: round(h) });
    y += h + gap;
  });
  if (footer) regions.push({ id: 'footer', role: 'footer', x: margin, y: round(1 - 0.035 - footerH), w: innerW, h: round(footerH) });
  const subjectArea = { id: 'subject', x: margin, y: round(headerEnd + 0.015), w: innerW, h: round(bottom - cards - headerEnd - 0.03) };
  return { kind: 'canvas-slot-plan', version: 1, width, height, regions, subject: subjectArea, entries: entries.length, header: Boolean(header), footer: Boolean(footer) };
}

/** 写进生图要求的版式说明：位置用百分比，模型照着留白；不让它画任何字 */
export function slotImagePrompt(description, plan) {
  const where = r => `从上往下${pct(r.y)}到${pct(r.y + r.h)}、左右${pct(r.x)}到${pct(r.x + r.w)}`;
  const lines = plan.regions.map(r => r.role === 'header'
    ? `- 标题留白：${where(r)}，干净平整、偏浅的背景（如浅色天空、纸面），不放主体`
    : r.role === 'footer'
      ? `- 底注留白：${where(r)}，平整浅色窄条`
      : `- 第${r.id.slice(5)}张卡片：${where(r)}，一块平整的浅色圆角卡片底（纯色或极淡纹理），卡片里完全空白`);
  return `${description}\n\n版式要求（程序之后会在这些位置用真实字体写字，请严格按位置留白）：画面${plan.width}×${plan.height}。\n${lines.join('\n')}\n- 主体（人物、产品、场景）放在${where(plan.subject)}之间，不要伸进上面的留白和卡片\n所有卡片颜色、圆角、样式一致；卡片之间露出背景。留白和卡片里不要任何文字、字母、数字、图标、线条、二维码、水印。整张图任何地方都不要写字。`;
}

/** 填字时核对：读入的 .slots.json 是否可信、与这张图的比例一致 */
export function validSlotPlan(value, width, height) {
  if (value?.kind !== 'canvas-slot-plan' || value.version !== 1 || !Array.isArray(value.regions) || value.regions.length > 22) return null;
  if (!(value.width > 0 && value.height > 0) || Math.abs(value.width / value.height - width / height) > 0.02) return null;
  const ok = value.regions.every(r => ['header', 'slot', 'footer'].includes(r?.role) && typeof r.id === 'string' &&
    [r.x, r.y, r.w, r.h].every(n => Number.isFinite(n) && n >= 0 && n <= 1) && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001);
  return ok ? value : null;
}

/** 计划位置在实际像素里是否真是平整留白：区域内部（去掉一成边）亮度起伏小 */
export function flatRegion(frame, r) {
  const { width: w, height: h, data } = frame;
  const x0 = Math.floor((r.x + r.w * 0.1) * w), x1 = Math.ceil((r.x + r.w * 0.9) * w);
  const y0 = Math.floor((r.y + r.h * 0.15) * h), y1 = Math.ceil((r.y + r.h * 0.85) * h);
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 3000)));
  const values = [];
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * w + x) * 4;
    values.push((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255);
  }
  if (values.length < 4) return false;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
  return sd < 0.07;
}

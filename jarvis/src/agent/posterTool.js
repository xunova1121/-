/**
 * 海报（智能体专业化第 2 批）：图像模型只画不带字的底图（或用用户的图 / 未央原创插画），中文标题、时间地点等文字由程序排版叠加，
 * 保证没有错字乱码；交付一页可编辑的 PPTX（PowerPoint / WPS 里能直接改字、换图，导出图片用“另存为 PNG”）。
 * 排版规则：安全边距 6%；主标题最大（按字数和画幅自动定字号），副标题次之，要点和时间地点在下方；文字压在半透明色带上保证可读。
 */
import * as ws from './workspace.js';
import { themeById } from './themes.js';
import { artSvg } from './pptTemplateArt.js';
import { rasterize as browserRasterize } from './slidePreview.js';

/** 浏览器和服务器都能用的 base64 */
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 画幅（英寸，PPT 页面尺寸）与像素 */
export const POSTER_SIZES = {
  竖版: { w: 7.5, h: 13.333, px: [1080, 1920] },
  横版: { w: 13.333, h: 7.5, px: [1920, 1080] },
  方形: { w: 10, h: 10, px: [1440, 1440] },
  朋友圈封面: { w: 10, h: 7.5, px: [1440, 1080] }
};
const MOTIF_BY_THEME = { 'gov-red': 'ribbon', 'eco-green': 'leaves', 'sunset-boulevard': 'lanterns', 'midnight-galaxy': 'orbit', 'tech-innovation': 'circuit', 'violet-glass': 'glass' };

/** 中文按 1 个字宽、英文数字按 0.55 估算一行能放下的字号（磅） */
export function fitFont(text, widthIn, maxPt, minPt = 12, lines = 2) {
  const units = [...String(text)].reduce((n, ch) => n + (/[\u0000-ÿ]/.test(ch) ? 0.55 : 1), 0) || 1;
  const pt = Math.floor((widthIn * 72 * lines) / units / 1.08);
  return Math.max(minPt, Math.min(maxPt, pt));
}

/** 纯排版：给出每块文字的位置和字号（英寸 / 磅），不依赖 PPT 库，便于测试 */
export function posterLayout({ size = '竖版', title, subtitle = '', lines = [], footer = '' }) {
  const S = POSTER_SIZES[size] || POSTER_SIZES.竖版;
  const m = Math.min(S.w, S.h) * 0.06, w = S.w - 2 * m;
  const tall = S.h > S.w;
  const titlePt = fitFont(title, w, tall ? 66 : 60, 28, 2);
  const titleH = (titlePt / 72) * 1.25 * Math.min(2, Math.ceil((([...title].length * titlePt) / 72) / w));
  const band = { x: 0, y: tall ? S.h * 0.52 : S.h * 0.45, w: S.w, h: tall ? S.h * 0.48 : S.h * 0.55 };
  let y = band.y + m * 0.8;
  const blocks = [{ role: 'title', text: title, x: m, y, w, h: titleH, pt: titlePt, bold: true }];
  y += titleH + m * 0.25;
  if (subtitle) { const pt = Math.max(16, Math.round(titlePt * 0.42)); blocks.push({ role: 'subtitle', text: subtitle, x: m, y, w, h: (pt / 72) * 1.6, pt }); y += (pt / 72) * 1.6 + m * 0.3; }
  const items = lines.filter(Boolean).slice(0, 6);
  if (items.length) {
    const pt = Math.max(14, Math.min(24, Math.round(titlePt * 0.32)));
    const h = items.length * (pt / 72) * 1.5;
    blocks.push({ role: 'lines', text: items, x: m, y, w, h, pt });
    y += h + m * 0.2;
  }
  if (footer) { const pt = Math.max(12, Math.min(18, Math.round(titlePt * 0.26))); blocks.push({ role: 'footer', text: footer, x: m, y: S.h - m - (pt / 72) * 1.4, w, h: (pt / 72) * 1.4, pt }); }
  const overflow = y > S.h - m;
  return { size: S, margin: m, band, blocks, overflow };
}

/**
 * @param {{ size?: string, title: string, subtitle?: string, lines?: string[], footer?: string, background?: Uint8Array|null, theme?: string, rasterizeSvg?: Function }} o
 * @returns {Promise<{ pptx: Blob, png: Blob|null, layout: object }>}
 */
export async function makePoster({ size = '竖版', title, subtitle = '', lines = [], footer = '', background = null, theme = 'business', rasterizeSvg = null }) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  const layout = posterLayout({ size, title, subtitle, lines, footer });
  const { w, h } = layout.size;
  pptx.defineLayout({ name: 'POSTER', width: w, height: h });
  pptx.layout = 'POSTER';
  pptx.title = title;
  pptx.author = '未央';
  const T = themeById(theme) || themeById('business');
  const C = T.colors;
  const slide = pptx.addSlide();
  slide.background = { color: C.primary };
  if (background) {
    slide.addImage({ data: `data:image/png;base64,${toBase64(background)}`, x: 0, y: 0, w, h, sizing: { type: 'cover', w, h } });
  } else {
    // 没有底图：用未央原创插画铺满（矢量画好再转图片）
    const svg = artSvg(MOTIF_BY_THEME[T.id] || 'mountains', C).replace(/width="1600" height="900"/, `width="${layout.size.px[0]}" height="${layout.size.px[1]}" preserveAspectRatio="xMidYMid slice"`);
    const img = await (rasterizeSvg ? rasterizeSvg(svg) : browserRasterize(svg)).catch(() => null);
    if (img?.data) slide.addImage({ data: `data:${img.mime};base64,${img.data}`, x: 0, y: 0, w, h, sizing: { type: 'cover', w, h } });
  }
  const band = layout.band;
  slide.addShape(pptx.ShapeType.rect, { x: band.x, y: band.y, w: band.w, h: band.h, fill: { color: C.primary, transparency: background ? 22 : 12 }, line: { color: C.primary, transparency: 100 } });
  slide.addShape(pptx.ShapeType.rect, { x: layout.margin, y: band.y + layout.margin * 0.4, w: 0.9, h: 0.06, fill: { color: C.extra || C.accent }, line: { color: C.extra || C.accent } });
  for (const b of layout.blocks) {
    const opts = { x: b.x, y: b.y, w: b.w, h: b.h, fontSize: b.pt, fontFace: '微软雅黑', color: 'FFFFFF', bold: Boolean(b.bold), valign: 'top', margin: 0, fit: 'shrink', objectName: `poster-${b.role}` };
    if (b.role === 'lines') slide.addText(b.text.map((t) => ({ text: t, options: { bullet: { code: '25CF' }, breakLine: true } })), { ...opts, lineSpacingMultiple: 1.25 });
    else slide.addText(b.text, { ...opts, color: b.role === 'footer' ? 'EEEEEE' : 'FFFFFF' });
  }
  const pptxBlob = await pptx.write({ outputType: 'blob' });
  return { pptx: pptxBlob, layout };
}

export function createPosterTool(ctx = {}) {
  return {
    name: 'make_poster',
    description: '做海报：程序排版中文标题、副标题、要点和时间地点，叠在底图上，保证文字没有错字乱码；输出一页可编辑 PPTX（能直接改字换图）。底图可以用工作区里的图片（用户的图或 generate_image 画的不带字的底图），不给就用未央原创插画。先用 generate_image 画底图时，提示词写“不要任何文字”。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '主标题，建议 12 字以内' },
        subtitle: { type: 'string' },
        lines: { type: 'array', maxItems: 6, items: { type: 'string' }, description: '要点：时间、地点、亮点等，每条一句' },
        footer: { type: 'string', description: '底部一行：主办单位、联系方式等' },
        size: { type: 'string', enum: Object.keys(POSTER_SIZES) },
        background_path: { type: 'string', description: '工作区里的底图路径（PNG / JPEG），可选' },
        theme: { type: 'string', description: '配色 id，如 business、gov-red、sunset-boulevard、violet-glass' },
        path: { type: 'string', description: '保存路径，默认 海报/标题.pptx' }
      },
      required: ['title'],
      additionalProperties: false
    },
    run: async ({ title, subtitle = '', lines = [], footer = '', size = '竖版', background_path: bg = '', theme = 'business', path = '' } = {}) => {
      if (!String(title || '').trim()) throw Object.assign(new Error('海报要有主标题'), { name: 'ValidationError', code: 'INVALID_POSTER', kind: 'input' });
      let background = null;
      if (bg) {
        if (!/\.(png|jpe?g)$/i.test(bg)) throw Object.assign(new Error('底图需为 PNG 或 JPEG'), { name: 'ValidationError', code: 'INVALID_POSTER', kind: 'input' });
        background = new Uint8Array(await (await ws.readBlob(bg)).arrayBuffer());
      }
      const out = await makePoster({ title: String(title).trim(), subtitle, lines, footer, size, background, theme, rasterizeSvg: ctx.rasterizeSvg || null });
      const safe = String(title).replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 20) || '海报';
      const target = path && /\.pptx$/i.test(path) ? path : `海报/${safe}.pptx`;
      const saved = await ws.write(target, out.pptx);
      ctx.onFileChanged?.(saved.path);
      const notes = [`${size}海报（${POSTER_SIZES[size].px.join('×')}）已保存为可编辑 PPTX：${saved.path}`, background ? `底图：${bg}` : '底图：未央原创插画', '文字由程序排版，可在 PowerPoint / WPS 里直接改字、换图，导出图片用“另存为 PNG”'];
      if (out.layout.overflow) notes.push('文字偏多，下方可能拥挤：建议精简要点或改用横版');
      return notes.join('；');
    }
  };
}

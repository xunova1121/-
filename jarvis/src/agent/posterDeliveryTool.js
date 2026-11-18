/** 海报一次交付同版式 PNG、SVG、PPTX；文件读回和视觉验收分别记录。 */
import * as ws from './workspace.js';
import { imageFormat, assertImageExtension } from './imageFormat.js';
import { withPosterDelivery } from './posterDeliverySession.js';
import { composePoster } from './posterComposition.js';
import { posterPngInfo } from './posterCompositionInput.js';
import { renderPoster } from './posterRaster.js';
import { renderVisualScene } from './visualSceneRaster.js';
import { themeById } from './themes.js';
import { posterDesignInput, posterDesignBlob, checkPosterDesignBackground } from './posterDesignSource.js';
import { throwControl } from '../core/networkRequest.js';
import { imageCoverReceipt, readImageMetadata } from './imageMetadata.js';
import { decodePngRgba, measureTextContrast, withoutText } from './posterContrast.js';
import { LAYERED_PROPERTIES, usesLayeredDesign } from './layeredDesignSchema.js';
import { deliverLayeredDesign } from './layeredDesignDelivery.js';
import { CANVAS_TEXT_PROPERTIES, usesCanvasText } from './imageTextInput.js';
import { deliverCanvasText } from './imageTextDelivery.js';
import { sketchPosters } from './posterSketch.js';
import { deliverAiPoster, AI_POSTER_LIMITS } from './aiPoster.js';
import { templateDesignInput, TEMPLATE_IDS, TEMPLATE_GUIDE } from './posterTemplates.js';
import { CONCEPT_SCHEMA } from './layeredDesignSchema.js';

const SIZES = { 竖版: [1080, 1920], 横版: [1920, 1080], 方形: [1440, 1440], 朋友圈封面: [1440, 1080], 小红书: [1024, 1536] };
const inputError = message => Object.assign(new Error(message), { name: 'ValidationError', code: 'INVALID_POSTER', kind: 'input' });

function dimensions({ size = '竖版', width, height }) {
  if (width !== undefined || height !== undefined) {
    if (!Number.isInteger(width) || !Number.isInteger(height)) throw inputError('请同时提供整数像素宽度和高度');
    return [width, height];
  }
  if (SIZES[size]) return SIZES[size];
  const match = /^(\d{3,4})\s*[x×]\s*(\d{3,4})$/i.exec(String(size));
  if (!match) throw inputError('请选择竖版、横版、方形、小红书，或明确填写宽×高像素');
  return [Number(match[1]), Number(match[2])];
}

async function backgroundFile(path, signal) {
  if (!path) return null;
  if (typeof path !== 'string' || !/\.(png|jpe?g|webp)$/i.test(path)) throw inputError('底图需为工作区 PNG、JPEG 或 WebP 图片');
  throwControl(null, signal);
  const blob = await ws.readBlob(path);
  if (blob.size > 10e6) throw inputError('底图不能超过10MB');
  const format = await assertImageExtension(path, blob);
  if (!format || !['png', 'jpg', 'webp'].includes(format.ext)) throw inputError('底图内容不是支持的图片，不能只修改扩展名');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: format.mime };
}

function outputBase(path, title, backgroundPath) {
  const safe = [...String(title).replace(/[\\/:*?"<>|\s]+/g, '')].slice(0, 40).join('') || '海报';
  const target = path ? String(path) : `海报/${safe}.pptx`;
  if (target.length > 300) throw inputError('海报保存路径不能超过300字符');
  if (!/\.(png|svg|pptx)$/i.test(target)) throw inputError('保存路径请使用 .png、.svg 或 .pptx 扩展名');
  const base = ws.normalize(target).replace(/\.(png|svg|pptx)$/i, '');
  if (backgroundPath && ['png', 'svg', 'pptx'].some(ext => `${base}.${ext}` === ws.normalize(backgroundPath)))
    throw inputError('输出路径不能覆盖底图，请换一个成品文件名');
  return base;
}

async function saveReadback(path, blob, ctx, signal) {
  throwControl(null, signal);
  const saved = await ws.write(path, blob);
  const readback = await ws.readBlob(saved.path);
  const expected = new Uint8Array(await blob.arrayBuffer());
  const actual = new Uint8Array(await readback.arrayBuffer());
  if (expected.length !== actual.length || !expected.every((byte, index) => byte === actual[index]))
    throw Object.assign(new Error('海报文件写入后读回不一致'), { code: 'POSTER_READBACK', kind: 'validation' });
  throwControl(null, signal);
  ctx.onFileChanged?.(saved.path);
  return saved.path;
}

/** 只把经过字节与尺寸核验的 PNG 作为成品，避免低分辨率预览冒充原尺寸。 */
export async function assertPosterPng(blob, width, height) {
  if (!(blob instanceof Blob) || blob.size < 33 || blob.size > 24e6 || (await imageFormat(blob))?.ext !== 'png')
    throw Object.assign(new Error('海报渲染器未返回真实PNG'), { code: 'POSTER_RENDER_INVALID', kind: 'validation' });
  const bytes = new Uint8Array(await blob.slice(0, 33).arrayBuffer());
  const view = new DataView(bytes.buffer);
  if ([137, 80, 78, 71, 13, 10, 26, 10].some((byte, index) => bytes[index] !== byte) ||
      String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR' || view.getUint32(16) !== width || view.getUint32(20) !== height)
    throw Object.assign(new Error('海报PNG尺寸与指定画幅不一致'), { code: 'POSTER_RENDER_DIMENSIONS', kind: 'validation' });
  if (!posterPngInfo(new Uint8Array(await blob.arrayBuffer())))
    throw Object.assign(new Error('海报PNG数据不完整'), { code: 'POSTER_RENDER_INVALID', kind: 'validation' });
}

function safeFailure(error, phase) {
  // 不将渲染子进程、第三方接口原文或工作区文件内容拼进模型上下文。
  const codes = new Set(['POSTER_RENDER_DIMENSIONS', 'POSTER_RENDER_INVALID', 'POSTER_READBACK', 'POSTER_FONT_MISSING', 'POSTER_FONT_GLYPHS_MISSING', 'POSTER_FONT_CHECK_UNAVAILABLE', 'POSTER_RENDER_UNAVAILABLE', 'POSTER_RENDER_TIMEOUT', 'POSTER_RENDER_BUSY', 'POSTER_RENDER_SIZE']);
  const code = codes.has(error?.code) ? error.code : `POSTER_${phase.toUpperCase()}_FAILED`;
  const descriptions = {
    POSTER_RENDER_DIMENSIONS: 'PNG像素尺寸未达到要求，未作为成品交付',
    POSTER_RENDER_INVALID: '渲染结果未通过PNG格式检查',
    POSTER_READBACK: '文件写入后读回不一致',
    POSTER_FONT_MISSING: '当前环境缺少可用的中文字体',
    POSTER_FONT_GLYPHS_MISSING: '当前字体缺少文案中的部分字形',
    POSTER_FONT_CHECK_UNAVAILABLE: '当前环境无法检查字体，未将图片标为完成',
    POSTER_RENDER_UNAVAILABLE: '当前环境缺少海报渲染能力',
    POSTER_RENDER_TIMEOUT: '海报渲染超时',
    POSTER_RENDER_BUSY: '海报渲染器繁忙',
    POSTER_RENDER_SIZE: '渲染输出超过大小上限'
  };
  return { code, message: descriptions[code] || (phase === 'render' ? '成品图片未渲染成功；已保存的可编辑源文件仍可使用' : '该格式文件尚未成功保存并读回') };
}

async function rasterize(ctx, svg, options, textStyle) {
  // 只有本工具的受控渐变设计使用视觉渲染器；旧海报SVG白名单和实色路径保持不变。
  if (textStyle === 'gradient') return (ctx.renderVisualScene || renderVisualScene)(svg, options);
  if (ctx.renderPoster) return ctx.renderPoster(svg, options);
  // 兼容旧桌面扩展注入，但仍核验输出尺寸；旧接口无法证明字体检测，单独标为未检查。
  if (ctx.rasterizeSvg) {
    const image = await ctx.rasterizeSvg(svg, options);
    return { blob: new Blob([Uint8Array.from(atob(image.data), char => char.charCodeAt(0))], { type: image.mime }), fontCheck: { status: 'not_checked' } };
  }
  return renderPoster(svg, options);
}

/**
 * 渐变文字叠在底图上：按真实像素量文字背后的对比度（2026-11-12 复审）。不够就在标题高度加深遮罩，最多再试三档；
 * 只改遮罩，不改文字、不重新生图。解码不了时如实返回 not_checked。
 */
async function gradientContrast(ctx, compose, out, signal) {
  const measure = async (result) => {
    const rendered = await rasterize(ctx, withoutText(result.svg), { signal }, 'gradient');
    const blob = rendered instanceof Blob ? rendered : rendered.blob;
    const image = await decodePngRgba(new Uint8Array(await blob.arrayBuffer()));
    if (!image || image.width !== result.layout.width || image.height !== result.layout.height) return null;
    const boxes = result.layout.blocks.flatMap(block => block.rows.map(row => {
      const w = Math.min(row.w, [...row.text].length * block.fontSize);
      return { role: block.role, fontSize: block.fontSize, x: block.align === 'center' ? row.x + (row.w - w) / 2 : row.x, y: row.y, w, h: row.h };
    }));
    return measureTextContrast(image, boxes, result.layout.input.textColor);
  };
  let current = out, check = await measure(out);
  if (!check) return { out, contrast: 'not_checked' };
  const panel = out.layout.panel, first = out.layout.blocks[0];
  // 加深点放在标题上沿往下四分之一处，从轻到重逐档试：只加深到够用为止，过渡尽量缓（用户不喜欢硬色块）
  const offset = Math.min(0.9, Math.max(0.05, (first.y + first.h * 0.25 - panel.y) / panel.h));
  for (const opacity of [0.45, 0.65, 0.85]) {
    if (check.ok) break;
    throwControl(null, signal);
    const next = await compose({ gradient_mid: { offset: Math.round(offset * 1000) / 1000, opacity } });
    const nextCheck = await measure(next);
    if (!nextCheck) break;
    current = next; check = nextCheck;
  }
  return { out: current, contrast: check.ok ? 'passed' : 'failed', blocks: check.blocks, ...(current !== out && { boosted: current.layout.input.gradient_mid }) };
}

export function createPosterDeliveryTool(ctx = {}) {
  return withPosterDelivery({
    name: 'make_poster',
    posterLifecycle: true,
    description: '已有无字底图卡槽填字用canvas.entries，可配header/footer/regions/protected；保留全图只用Canvas真实字体，不经SVG、不加遮罩；交付PNG/原生文字PPTX/可拖动编辑HTML/ZIP/.canvas.json，改字或补Demo复用source_path。制作准确中文图文海报：新稿优先design按内容构图，sections组织主次新闻/图文/数值卡片，或layers自由安排文字、图片、矢量图标、形状与图表。已有图片放design.assets，GPT仅生成需要的无字视觉素材。交付同源PNG/SVG/可编辑PPTX和.design.json；改字用source_path+changes，补同稿Demo用create_visual_demo复用源稿，不重画。旧稿.poster.json及panel/gradient接口保持兼容；gradient为底部连续渐变。回执区分原文、字体、像素、对比、视觉，4K不等于素材原生细节，不能保证绝对无错字。',
    input_schema: {
      type: 'object',
      properties: {
        ...LAYERED_PROPERTIES, ...CANVAS_TEXT_PROPERTIES,
        title: { type: 'string', description: '准确主标题，保留用户给定文字，不自行改写' },
        subtitle: { type: 'string' },
        lines: { type: 'array', maxItems: 32, items: { type: 'string' }, description: '准确要点，每项一段；放不下会明确报错，不删字' },
        footer: { type: 'string' },
        size: { type: 'string', description: '竖版、横版、方形、朋友圈封面、小红书，或1024x1536等像素尺寸' },
        width: { type: 'integer', description: '精确宽度像素；与height一起提供时优先于size' },
        height: { type: 'integer', description: '精确高度像素' },
        background_path: { type: 'string', description: '工作区底图路径，PNG/JPEG/WebP；无需传给代码沙箱' },
        source_path: { type: 'string', description: '复用designPath：新稿.design.json用changes按id改字/版式；旧稿.poster.json保留原字段；原稿/原图保持，另存新版本' },
        text_position: { type: 'string', enum: ['top', 'bottom', 'left', 'right', 'center'] },
        text_fraction: { type: 'number', description: '文字面板占画幅比例；下方三分之一用0.333333' },
        text_style: { type: 'string', enum: ['panel', 'gradient'], description: 'panel实色文字区；gradient沉浸渐变，默认底部35%从透明过渡至文字区底色' },
        text_align: { type: 'string', enum: ['left', 'center'], description: '程序文字左对齐或居中；gradient默认center' },
        gradient_opacity: { type: 'number', minimum: 0, maximum: 1, description: '渐变底部不透明度，默认0.85；实际底图对比仍需视觉核对' },
        font_family: { type: 'string', enum: ['sans', 'serif'], description: 'sans黑体，serif宋体' },
        text_color: { type: 'string', description: '十六进制颜色，如黑色#111111' },
        panel_color: { type: 'string', description: '文字区底色，如浅米白#FFF8EC' },
        background_color: { type: 'string' },
        theme: { type: 'string', description: '兼容已有配色名称；明确颜色参数优先' },
        path: { type: 'string', description: '成品路径，三种文件共用名称，如海报/秋季养生汤.png' },
        template: { type: 'object', additionalProperties: false, description: '版式模板：文字多的海报（新闻速览、人物事件、赛程、活动、数据播报、要点清单）优先用它——模型只选模板、填内容，版式/字号/间距/配色由设计好的模板按字数算，比自己摆坐标好看、一次就能过检查。可配一张无字主视觉图（先generate_image生成，image填路径）。content字段：' + TEMPLATE_GUIDE,
          properties: { id: { type: 'string', enum: TEMPLATE_IDS }, style: { type: 'string', enum: ['blue', 'red', 'green', 'dark', 'warm'], description: '配色：blue新闻商务、red时政热点、green健康环保、dark科技数据、warm活动生活' }, image: { type: 'string', description: '可选：工作区无字主视觉图路径' }, content: { type: 'object', description: '按模板填写，字段见说明' } }, required: ['id', 'content'] },
        ai_full: { type: 'object', additionalProperties: false, description: `AI整图出稿：宣传类、字少的海报（标题+最多${AI_POSTER_LIMITS.lines}条短要点，全部文字≤${AI_POSTER_LIMITS.chars}字）优先用它——画面和文字由画图模型一次画出，图文一体更好看；程序把图里的字读回逐条核对，写错会重画一次，仍不对就标待核对、改用design程序排字。赛程、名单、数据表等信息多的不要用`,
          properties: { prompt: { type: 'string', description: '画面描述：主体、场景、风格、配色、构图（不要写文字内容，文字放texts）' }, size: { type: 'string', description: '如1024x1536竖版、1536x1024横版' },
            texts: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', description: '主标题≤16字' }, subtitle: { type: 'string', description: '≤24字' }, lines: { type: 'array', maxItems: 5, items: { type: 'string', description: '每条≤24字' } }, footer: { type: 'string', description: '≤30字' } }, required: ['title'] } }, required: ['texts'] },
        sketches: { type: 'array', maxItems: 3, description: '可选：正式出图前交2–3个不同构思的草图比较（每个含concept和layers，图片层先写位置和detail，不必先生图）。程序用真实字体渲染、图片位置画灰色占位，检查重叠和手机字号，再像设计师一样比较选优并给改法；不算试排、不是交付物。之后再生图并用design出正式稿',
          items: { type: 'object', additionalProperties: false, properties: { concept: CONCEPT_SCHEMA, palette: LAYERED_PROPERTIES.design.properties.palette, layers: LAYERED_PROPERTIES.design.properties.layers }, required: ['layers'] } }
      },
      required: [],
      additionalProperties: false
    },
    run: async (input = {}, { signal, progress, checkpoint, retrieval, requiresRichVisual, posterAttempt, beginPosterAttempt, designReviewBlocking } = {}) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw inputError('海报参数必须是对象');
      // 版式模板（posterTemplates.js）：模型只填内容，模板算版式，再走分层交付
      if (input.template !== undefined) input = templateDesignInput(input);
      // AI整图出稿 + 逐字核对（aiPoster.js）：宣传类、字少的海报
      if (input.ai_full !== undefined) return deliverAiPoster(input, ctx, { signal, progress, beginPosterAttempt });
      // 草图对比：不出正式稿、不算试排（posterSketch.js）
      if (input.sketches !== undefined) {
        const [width, height] = dimensions(input);
        return JSON.stringify(await sketchPosters(input, ctx, { signal, retrieval, width, height }));
      }
      if (usesCanvasText(input)) return deliverCanvasText(input.size !== undefined ? { ...input, ...Object.fromEntries(['width', 'height'].map((key, i) => [key, dimensions(input)[i]])) } : input, ctx, { signal, progress, checkpoint, retrieval, requiresRichVisual, beginPosterAttempt });
      if (usesLayeredDesign(input)) {
        const resize = !input.source_path || input.design && (input.size !== undefined || input.width !== undefined || input.height !== undefined);
        const [width, height] = resize ? dimensions(input) : [];
        const autoPosterHeight = !input.source_path && input.width === undefined && input.height === undefined && input.size === undefined;
        return deliverLayeredDesign(resize ? { ...input, width, height } : input, ctx, { signal, progress, checkpoint, retrieval, requiresRichVisual, posterAttempt, beginPosterAttempt, autoPosterHeight, designReviewBlocking });
      }
      input = await posterDesignInput(input, signal);
      if (typeof input.title !== 'string' || !input.title.trim()) throw inputError('海报要有主标题');
      throwControl(null, signal);
      const [width, height] = dimensions(input);
      const base = outputBase(input.path, input.title, input.background_path);
      const background = await backgroundFile(input.background_path, signal);
      await checkPosterDesignBackground(input, background, signal);
      progress?.('正在按指定尺寸用真实字体排版中文…');
      const palette = input.theme ? themeById(input.theme)?.colors : null;
      const defaults = palette ? { background_color: '#' + palette.primary, ...(!input.text_color && { panel_color: '#' + palette.primary }) } : {};
      const compose = (extra = {}) => composePoster({ ...defaults, ...input, ...extra, width, height, background });
      let out = await compose();
      throwControl(null, signal);
      beginPosterAttempt?.();
      let measured = null;
      if (out.layout.input.text_style === 'gradient') {
        progress?.('正在按底图真实像素检查文字对比度…');
        try { measured = await gradientContrast(ctx, compose, out, signal); out = measured.out; }
        catch (error) { throwControl(error, signal); measured = { contrast: 'not_checked' }; }
      }
      const receipt = { kind: 'poster', status: 'partial', width, height, files: [], textRendering: 'program', visual: 'not_checked', fontCheck: 'not_checked', notes: [background ? `底图：${input.background_path}` : '底图：未央原创插画', '文案由程序排版；尚未做视觉模型或人工验收，不能声称绝对无错字'], errors: [] };
      const normalized = out.layout.input;
      receipt.textStyle = normalized.text_style;
      receipt.textAlign = normalized.text_align;
      if (normalized.text_style === 'gradient') {
        receipt.gradient = { opacity: normalized.gradient_opacity, fraction: normalized.text_fraction, contrast: measured?.contrast || 'not_checked',
          ...(measured?.blocks && { measured: measured.blocks.slice(0, 12).map(({ role, contrast, minimum }) => ({ role, contrast, minimum })) }),
          ...(measured?.boosted && { boosted: measured.boosted }) };
        if (measured?.contrast === 'passed') receipt.notes.push(measured.boosted ? '底部使用真实透明渐变；按底图真实像素测得标题处对比不足，已在标题高度加深遮罩，复测通过' : '底部使用真实透明渐变；按底图真实像素复测，文字对比度达标');
        else if (measured?.contrast === 'failed') { receipt.notes.push('按底图真实像素测得部分文字对比度不足，加深遮罩后仍未达标；建议换更暗/更简洁的底图或改用实色文字区'); receipt.errors.push({ code: 'POSTER_CONTRAST_LOW', message: '部分文字在实际底图上对比度不足' }); }
        else receipt.notes.push('底部使用真实透明渐变，未用硬边色块覆盖底图；当前环境无法解码成品像素，渐变叠加实际底图后的对比度尚未视觉验收');
      }
      if (background) {
        const actual = await readImageMetadata(new Blob([background.bytes], { type: background.mime }), { signal });
        receipt.background = { path: input.background_path, ...imageCoverReceipt(actual, width, height) };
        receipt.notes.push(actual.dimensions === 'verified'
          ? `底图${actual.width}×${actual.height}，按cover缩放${Number(receipt.background.scale.toFixed(4))}倍；成品${width}×${height}是导出尺寸，不证明底图具有同等细节`
          : '底图实际像素尺寸未核实；不能把成品画布尺寸说成底图原生清晰度');
      }
      for (const [format, blob] of [['svg', new Blob([out.svg], { type: 'image/svg+xml' })], ['pptx', out.pptx]]) {
        try {
          const path = await saveReadback(`${base}.${format}`, blob, ctx, signal);
          receipt.files.push({ format, path, readback: 'passed', structure: 'passed', render: 'not_checked' });
        } catch (error) { throwControl(error, signal); receipt.errors.push(safeFailure(error, 'save')); }
      }
      try {
        const design = await posterDesignBlob({ ...input, text_style: normalized.text_style, text_align: normalized.text_align, gradient_opacity: normalized.gradient_opacity, text_position: normalized.text_position, text_fraction: normalized.text_fraction }, { width, height, background });
        receipt.designPath = await saveReadback(`${base}.poster.json`, design, ctx, signal);
      } catch (error) { throwControl(error, signal); receipt.errors.push(safeFailure(error, 'design_save')); }
      try {
        progress?.('正在检查字体并渲染最终PNG图片…');
        const rendered = await rasterize(ctx, out.svg, { signal }, normalized.text_style);
        const blob = rendered instanceof Blob ? rendered : rendered.blob;
        await assertPosterPng(blob, width, height);
        const path = await saveReadback(`${base}.png`, blob, ctx, signal);
        receipt.files.unshift({ format: 'png', path, readback: 'passed', structure: 'passed', render: 'passed' });
        receipt.fontCheck = rendered.fontCheck?.status === 'passed' ? 'passed' : 'not_checked';
        if (receipt.fontCheck !== 'passed') receipt.errors.push(safeFailure({ code: 'POSTER_FONT_CHECK_UNAVAILABLE' }, 'render'));
        if (ctx.onImage) ctx.onImage(URL.createObjectURL(blob), path);
      } catch (error) { throwControl(error, signal); receipt.errors.push(safeFailure(error, 'render')); }
      receipt.status = receipt.files.length === 3 && !receipt.errors.length ? 'complete' : 'partial';
      await checkpoint?.({ type: 'artifact_validation', path: receipt.files.find(file => file.format === 'svg')?.path || `${base}.svg`, validation: { kind: 'poster', format: 'svg', readback: receipt.files.some(file => file.format === 'svg') ? 'passed' : 'failed', render: receipt.files.some(file => file.format === 'png') ? 'passed' : 'failed', visual: 'not_checked', business: 'not_checked', errors: receipt.errors.length } });
      return JSON.stringify(receipt);
    }
  }, ctx, createPosterDeliveryTool);
}

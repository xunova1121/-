/**
 * 海报草图对比（2026-11-17 用户：希望未央有独立思考，自己排版，不按固定几种样式）。
 *
 * 正式出图前，模型可以一次交 2–3 个不同构思的草图（图层坐标 + 构思），图片位置先用灰色占位块代替，
 * 不需要先生成配图，也不算一次试排。程序按真实字体把每个草图渲染出来，做同样的几何检查
 * （文字重叠、手机上字够不够大），再用一次看图模型像设计师那样比较，选出最好的一个并给出改法。
 * 选定后再按草图里图片块的位置和比例去生图，最后 make_poster 出正式稿。
 */
import * as ws from './workspace.js';
import { normalizeLayerDesign } from './layeredDesignInput.js';
import { composeLayeredSvg } from './layeredDesignSvg.js';
import { checkLayerOverlap } from './layeredDesignQuality.js';
import { checkDesignPresentation } from './layeredDesignPresentation.js';
import { renderVisualScene } from './visualSceneRaster.js';
import { imageData } from './imageRegion.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';

const sketchError = message => Object.assign(new Error(message), { code: 'POSTER_SKETCH_INPUT', kind: 'input' });

/** 图片层换成灰色占位块 + 说明文字（写的是这块打算放什么图） */
export function sketchLayers(layers) {
  return layers.flatMap(node => {
    if (node?.type !== 'image') return [node];
    const size = Math.max(18, Math.min(40, Math.min(node.w, node.h) * 0.08));
    const label = String(node.detail || node.asset || '配图').slice(0, 40);
    return [
      { id: node.id, type: 'shape', x: node.x, y: node.y, w: node.w, h: node.h, fill: '#B9C3CC', decorative: true },
      ...(node.h >= size * 2 && node.w >= size * 4 ? [{ id: `${node.id}-label`, type: 'text', text: `图：${label}`, x: node.x + node.w * 0.06, y: node.y + node.h / 2 - size,
        w: node.w * 0.88, h: size * 2.2, fontSize: size, minFontSize: Math.min(size, 18), color: '#4A5560', align: 'center', role: 'caption', decorative: true }] : [])
    ];
  });
}

export async function sketchPosters(input, ctx = {}, { signal, retrieval, width, height } = {}) {
  const drafts = input.sketches;
  if (!Array.isArray(drafts) || drafts.length < 1 || drafts.length > 3) throw sketchError('草图需1–3个');
  const raster = ctx.renderVisualScene || renderVisualScene;
  const folder = `.workflows/sketches/${crypto.randomUUID()}/`;
  const sketches = [];
  const images = [];
  for (const [i, draft] of drafts.entries()) {
    throwControl(null, signal);
    const item = { index: i + 1, concept: draft?.concept || null };
    try {
      if (!draft || typeof draft !== 'object' || !Array.isArray(draft.layers)) throw sketchError('每个草图需要layers');
      const design = normalizeLayerDesign({ title: input.title || '草图', width, height, palette: draft.palette || input.design?.palette,
        fontFamily: input.font_family, concept: draft.concept, layers: sketchLayers(draft.layers) });
      const issues = [];
      const overlap = checkLayerOverlap(design);
      if (overlap.status !== 'passed') issues.push({ code: 'DESIGN_TEXT_OVERLAP', ids: overlap.failed });
      const presentation = checkDesignPresentation(design);
      if (presentation.status === 'failed') issues.push({ code: 'DESIGN_PRESENTATION_UNREADABLE', failed: presentation.failed });
      const rendered = await raster(composeLayeredSvg(design), { signal });
      const saved = await ws.write(`${folder}sketch-${i + 1}.png`, rendered.blob);
      Object.assign(item, { path: saved.path, issues });
      images.push({ index: i + 1, blob: rendered.blob });
    } catch (error) {
      throwControl(error, signal);
      // 草图本身排不下：如实报给模型，不算试排、不扣纠正次数
      Object.assign(item, { error: String(error.message || '草图无法排版').slice(0, 200), ...(Array.isArray(error.issues) && { issues: error.issues.slice(0, 12) }) });
    }
    sketches.push(item);
  }
  const review = await compareSketches(ctx, sketches, images, { signal, retrieval, title: input.title });
  return { kind: 'poster_sketch', status: images.length ? 'ready' : 'failed', sketches, review,
    next: '选定一个草图（可按review.suggestions再改），在design.concept写清构思；按草图里图片块的位置和比例用generate_image（purpose=poster_art）生成配图；再用make_poster的design.layers出正式稿。草图不算试排，也不是交付物。' };
}

async function compareSketches(ctx, sketches, images, { signal, retrieval, title }) {
  if (!ctx.visionLlm || !images.length) return { status: 'not_checked', reason: '未配置看图能力或没有可比较的草图' };
  try {
    const payload = [];
    for (const item of images) payload.push(await imageData(item.blob, { detail: 'low' }));
    throwControl(null, signal);
    retrieval?.consume?.('model');
    const answer = await withWebDeadline(activeSignal => ctx.visionLlm({
      system: '你是资深平面设计师，正在比较同一张海报的几个版式草图。灰色块是之后要放的配图位置。只看版式：第一眼主次、图文关系是否融合（不像上图下文硬拼）、留白和对齐、疏密节奏、是否符合构思和主题气质。不评判灰块本身的颜色。只返回JSON：{"choice":序号,"reasons":["…"],"suggestions":["对选中草图的具体改法：改哪个图层、往哪移、放大还是缩小"],"scores":[{"index":1,"score":1到10}]}。',
      prompt: `海报主题：${String(title || '').slice(0, 120)}\n` + sketches.map(s => `草图${s.index}${s.error ? '（排版失败：' + s.error + '）' : ''}：构思 ${JSON.stringify(s.concept || {})}`).join('\n') + '\n图片按草图序号依次给出（排版失败的没有图）。',
      images: payload, signal: activeSignal, allowWebSearch: false, maxWebSearches: 0, maxTransientRetries: 0, maxPartialRetries: 0
    }), { signal, timeoutMs: 30000 });
    if (typeof answer !== 'string' || answer.length > 6000) return { status: 'not_checked', reason: '看图回执无效' };
    const value = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const valid = images.map(item => item.index);
    if (!valid.includes(value?.choice)) return { status: 'not_checked', reason: '看图回执没有给出有效选择' };
    const list = v => (Array.isArray(v) ? v.filter(t => typeof t === 'string').slice(0, 4).map(t => t.slice(0, 160)) : []);
    return { status: 'checked', choice: value.choice, reasons: list(value.reasons), suggestions: list(value.suggestions),
      scores: (Array.isArray(value.scores) ? value.scores : []).filter(s => valid.includes(s?.index) && Number.isFinite(s?.score)).map(s => ({ index: s.index, score: Math.max(1, Math.min(10, s.score)) })) };
  } catch (error) {
    throwControl(error, signal);
    return { status: 'not_checked', reason: '草图比较未完成；草图文件已保留，可自行判断' };
  }
}

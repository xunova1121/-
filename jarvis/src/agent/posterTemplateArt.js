/**
 * 版式模板“先排版、后生图”（2026-11-18 用户：要图文融合的，A+B 一起做）。
 *
 * 沉浸式模板配图时：先用模板把字和卡片排好，算出标题区、卡片区在画布上的位置，
 * 把这些位置写进生图要求（保持干净、偏暗、主体别进来），生成满版无字配图；
 * 生成后用真实像素核对留白是否让够，再把这张图铺进同一个版式。
 * 留白没让够也不硬交：后面的逐行对比度检查会在字后补渐变遮罩，并把核对结果如实写进回执。
 * 生图失败时退回不带图的沉浸式版式（深色渐变底），不伪造配图。
 */
import * as ws from './workspace.js';
import { imageFormat } from './imageFormat.js';
import { readImageMetadata } from './imageMetadata.js';
import { imageCompositionPrompt } from './imageCompositionPrompt.js';
import { clearAreaPrompt, checkClearAreas } from './posterClearAreas.js';
import { templateDesignInput } from './posterTemplates.js';
import { throwControl } from '../core/networkRequest.js';

const IMAGE_W = 1024, IMAGE_H = 1536;
const round = n => Math.round(n * 1000) / 1000;

/**
 * 画布比例的留白区换成配图比例：配图按 cover 铺满画布（居中裁切），
 * 画布比配图更高时左右被裁，更矮时上下被裁。
 */
export function zonesOnImage(zones, canvasW, canvasH, imageW = IMAGE_W, imageH = IMAGE_H) {
  const canvasRatio = canvasH / canvasW, imageRatio = imageH / imageW;
  return zones.map(z => {
    if (canvasRatio >= imageRatio) {
      const visible = imageRatio / canvasRatio, off = (1 - visible) / 2;
      return { ...z, x: round(off + z.x * visible), w: round(z.w * visible) };
    }
    const visible = canvasRatio / imageRatio, off = (1 - visible) / 2;
    return { ...z, y: round(off + z.y * visible), h: round(z.h * visible) };
  }).filter(z => z.w >= 0.05 && z.h >= 0.03);
}

export function templateArtPrompt(prompt, areas) {
  return imageCompositionPrompt(String(prompt).trim() + '\n竖版满版海报背景：场景铺满整个画面、从上到下都有内容（如俯视整片球场、整条街景、整个会场），不要只画在上半截、下半截留空或渐变成纯色；整体偏暗、细节柔和，文字会直接压在画面上。', 'poster_art') + clearAreaPrompt(areas);
}

/** 返回 { input: 带配图的模板输入, art: 回执说明 }；input 已是 templateDesignInput 的结果 */
export async function templateWithArt(input, ctx, { signal, progress, raster } = {}) {
  const spec = input.template || {};
  const prompt = typeof spec.image_prompt === 'string' ? spec.image_prompt.trim() : '';
  const wantArt = prompt && !(typeof spec.image === 'string' && spec.image.trim());
  const template = { ...spec, layout: wantArt || spec.layout === 'immersive' ? 'immersive' : spec.layout };
  delete template.image_prompt;
  const first = templateDesignInput({ ...input, template });
  if (!wantArt) return { input: first, art: null };
  if (!ctx.imageGen) return { input: first, art: { status: 'skipped', note: '当前环境不能画图，按沉浸式版式出稿（深色渐变底，无配图）' } };
  const areas = zonesOnImage(first.zones, first.width, first.heroHeight || first.height);
  try {
    progress?.('版式已排好，正在按文字位置生成满版配图（文字区留暗、主体让开）…');
    const result = await ctx.imageGen({ prompt: templateArtPrompt(prompt, areas), size: `${IMAGE_W}x${IMAGE_H}`, outputFormat: 'png', signal });
    throwControl(null, signal);
    const format = result?.blob && await imageFormat(result.blob);
    if (!format || !['png', 'jpg', 'webp'].includes(format.ext)) throw new Error('画图服务返回的不是图片');
    const name = String(first.title || '海报').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 24) || '海报';
    const saved = await ws.write(`images/${name}-满版配图.${format.ext}`, result.blob);
    ctx.onFileChanged?.(saved.path);
    let check = null;
    try {
      const meta = await readImageMetadata(result.blob, { signal });
      check = await checkClearAreas(result.blob, areas, { width: meta.width, height: meta.height, raster, signal });
    } catch (error) { throwControl(error, signal); check = { status: 'not_checked', reason: '留白核对失败' }; }
    const input2 = templateDesignInput({ ...input, template: { ...template, image: saved.path } });
    return { input: input2, art: { status: 'generated', path: saved.path, clearAreas: check,
      note: '先排版后生图：' + (check?.status === 'failed' ? '配图有文字区没让够，已靠逐行对比度检查在字后补遮罩' : '配图按文字位置留了暗部') } };
  } catch (error) {
    throwControl(error, signal);
    return { input: first, art: { status: 'failed', note: `配图生成失败（${String(error?.message || error).slice(0, 80)}），按沉浸式版式出稿（深色渐变底，无配图）` } };
  }
}

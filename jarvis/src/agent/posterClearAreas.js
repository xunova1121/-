/**
 * 海报配图“先排版后生图”（2026-11-17 用户反馈：机器人占了画面上方 55%，文字只能压在机器人身上）。
 *
 * 自由排版的海报：先定好文字要放在哪，再生成配图。生图时把这些区域写进要求（保持干净、偏暗或偏亮、主体不进入），
 * 生成后用真实像素核对：区域平均亮度是否符合、细节起伏是否够小。不达标如实告诉模型，
 * 由模型决定换区域、加底块还是重画，不硬把字压上去。坐标一律是画面 0–1 比例。
 */
import { decodePngRgba } from './posterContrast.js';
import { DESIGN_FONT } from './layeredDesignSvg.js';
import { throwControl } from '../core/networkRequest.js';

const areaError = message => Object.assign(new Error(message), { code: 'IMAGE_CLEAR_AREA', kind: 'input' });
const pct = n => `${Math.round(n * 1000) / 10}%`;
const round = n => Math.round(n * 1000) / 1000;

export function normalizeClearAreas(areas) {
  if (areas === undefined) return [];
  if (!Array.isArray(areas) || areas.length > 4) throw areaError('keep_clear最多4块');
  return areas.map((raw, i) => {
    const area = { id: typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 24) : `text-${i + 1}`, tone: raw?.tone === 'light' ? 'light' : 'dark' };
    for (const key of ['x', 'y', 'w', 'h']) {
      const v = Number(raw?.[key]);
      if (!Number.isFinite(v) || v < 0 || v > 1) throw areaError('keep_clear坐标需为0–1的画面比例');
      area[key] = v;
    }
    if (area.w < 0.05 || area.h < 0.03 || area.x + area.w > 1.0001 || area.y + area.h > 1.0001) throw areaError('keep_clear区域需在画面内且不过小');
    return area;
  });
}

/** 写进生图要求：哪些地方之后要压字 */
export function clearAreaPrompt(areas) {
  if (!areas.length) return '';
  const lines = areas.map(a => `- 从上往下${pct(a.y)}到${pct(a.y + a.h)}、左右${pct(a.x)}到${pct(a.x + a.w)}：之后要压文字，保持干净、低细节、${a.tone === 'dark' ? '偏暗（深色天空/暗部/虚化背景）' : '偏亮（浅色天空/纸面/虚化亮部）'}，主体、建筑、光效、纹理都不要进入`);
  return `\n\n版式留白（程序之后用真实字体在这些位置排字，请严格让出）：\n${lines.join('\n')}\n主体放在这些区域之外；留白要和画面自然过渡（虚化、暗角、天空、地面），不要画成方框或卡片。`;
}

async function dataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

/** 生成后核对：把图缩小渲染一遍读像素，逐块量平均亮度和细节起伏 */
export async function checkClearAreas(blob, areas, { width, height, raster, signal } = {}) {
  if (!areas.length) return null;
  if (!(width > 0 && height > 0) || !raster) return { status: 'not_checked', reason: '无法读取图片尺寸或像素' };
  const w = 240, h = Math.max(1, Math.round(240 * height / width));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${await dataUrl(blob)}"/><g opacity="0"><text x="2" y="20" font-family="${DESIGN_FONT}" font-size="12" fill="#000000">字</text></g></svg>`;
  const rendered = await raster(svg, { signal });
  throwControl(null, signal);
  const image = await decodePngRgba(new Uint8Array(await rendered.blob.arrayBuffer()));
  if (!image) return { status: 'not_checked', reason: '像素解码失败' };
  const results = areas.map(area => {
    const values = [];
    const x0 = Math.floor(area.x * image.width), x1 = Math.ceil((area.x + area.w) * image.width);
    const y0 = Math.floor(area.y * image.height), y1 = Math.ceil((area.y + area.h) * image.height);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * image.width + x) * 4;
      values.push((0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]) / 255);
    }
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const detail = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
    const toneOk = area.tone === 'dark' ? mean <= 0.38 : mean >= 0.62;
    const ok = toneOk && detail <= 0.13;
    return { id: area.id, tone: area.tone, mean: round(mean), detail: round(detail), ok,
      ...(!ok && { problem: !toneOk ? (area.tone === 'dark' ? '这块不够暗' : '这块不够亮') : '这块细节太多，字会被干扰' }) };
  });
  return { status: results.every(r => r.ok) ? 'passed' : 'failed', areas: results,
    ...(results.some(r => !r.ok) && { advice: '留白没让够：可换到达标区域排字、在字后加底块/渐变，或带同样要求重画一次；不要把正文硬压在细节多的地方' }) };
}

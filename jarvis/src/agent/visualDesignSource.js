/** 共用设计的文件边界：仅读授权工作区，复用同一份底图字节，修改另存。 */
import * as ws from './workspace.js';
import { normalizeVisualDesign } from './visualSceneInput.js';
import { normalizePosterBackground } from './posterCompositionInput.js';
import { posterDesignInput, checkPosterDesignBackground, mergePosterDesignOptions } from './posterDesignSource.js';
import { assertImageExtension } from './imageFormat.js';
import { imageFingerprint } from './visualEvidence.js';
import { throwControl } from '../core/networkRequest.js';

export const visualInputError = (message, code = 'VISUAL_DESIGN_INPUT') => Object.assign(new Error(message), { code, kind: 'input' });
const FIELDS = ['preset', 'title', 'subtitle', 'width', 'height', 'theme', 'dataMode', 'source', 'asOf', 'metrics', 'series', 'seriesLabel', 'seriesUnit', 'alerts', 'markers'];
const pick = value => Object.fromEntries(FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const POSTER_FIELDS = ['title', 'subtitle', 'lines', 'footer', 'width', 'height', 'text_position', 'text_fraction', 'font_family', 'text_color', 'panel_color', 'background_color', 'theme', 'background_path', 'text_style', 'text_align', 'gradient_opacity'];
const posterPick = value => Object.fromEntries(POSTER_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const posterOverrides = input => Object.fromEntries(['title', 'subtitle', 'text_style', 'text_position', 'text_fraction', 'text_align', 'gradient_opacity'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));

async function readDesign(path) {
  if (typeof path !== 'string' || path.length > 300 || !/\.(visual|poster)\.json$/i.test(path)) throw visualInputError('请提供.visual.json或.poster.json设计文件');
  const blob = await ws.readBlob(path);
  if (blob.size > 80000) throw visualInputError('设计文件不能超过80KB');
  try { return JSON.parse(await blob.text()); } catch { throw visualInputError('设计文件不是有效JSON'); }
}

async function readBackground(path, signal) {
  if (!path) return null;
  if (typeof path !== 'string' || path.length > 300 || !/\.(png|jpe?g|webp)$/i.test(path)) throw visualInputError('底图需为工作区PNG、JPEG或WebP');
  throwControl(null, signal);
  const blob = await ws.readBlob(path);
  if (blob.size > 10e6) throw visualInputError('底图不能超过10MB');
  const format = await assertImageExtension(path, blob);
  const background = { bytes: new Uint8Array(await blob.arrayBuffer()), mime: format.mime };
  normalizePosterBackground(background);
  throwControl(null, signal);
  return background;
}

export async function loadVisualDesign(input, signal) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw visualInputError('视觉设计参数必须是对象');
  throwControl(null, signal);
  let options = pick(input), backgroundPath = input.background_path, expectedHash = null, posterOptions;
  if (input.source_path) {
    const saved = await readDesign(input.source_path);
    if (/\.poster\.json$/i.test(input.source_path)) {
      // 原海报仍由既有合成器负责，避免HTML移植时重新解释排版或重绘图片。
      posterOptions = await posterDesignInput({ source_path: input.source_path, ...posterOverrides(input) }, signal);
      backgroundPath = posterOptions.background_path;
    } else {
      if (saved?.kind !== 'visual-design' || saved.version !== 1 || !saved.options || typeof saved.options !== 'object' || Array.isArray(saved.options)) throw visualInputError('不是支持的视觉设计文件');
      if (saved.posterOptions) {
        if (typeof saved.posterOptions !== 'object' || Array.isArray(saved.posterOptions)) throw visualInputError('海报设计字段无效');
        posterOptions = mergePosterDesignOptions(posterPick(saved.posterOptions), posterOverrides(input));
      }
      options = { ...pick(saved.options), ...options };
      if (saved.options.dataMode === 'demo' && input.dataMode === 'provided') {
        for (const field of ['metrics', 'series', 'alerts', 'markers']) if (!Object.hasOwn(input, field)) options[field] = [];
        if (!Object.hasOwn(input, 'asOf')) delete options.asOf;
        for (const field of ['seriesLabel', 'seriesUnit']) if (!Object.hasOwn(input, field)) delete options[field];
      }
      backgroundPath ??= saved.backgroundPath;
      const sameBackground = backgroundPath && saved.backgroundPath && ws.normalize(backgroundPath) === ws.normalize(saved.backgroundPath);
      if (sameBackground) expectedHash = saved.backgroundHash;
      if (sameBackground && !/^[a-f0-9]{64}$/.test(expectedHash || '')) throw visualInputError('原设计缺少底图指纹，未复用未经核对的图片');
    }
  }
  const background = await readBackground(backgroundPath, signal);
  let backgroundHash = null;
  if (background) {
    backgroundHash = await imageFingerprint(new Blob([background.bytes], { type: background.mime }));
    if (!backgroundHash) throw visualInputError('无法生成底图指纹，未保存设计');
    if (expectedHash && backgroundHash !== expectedHash) throw visualInputError('原底图已变化，请确认后使用另一份底图路径', 'VISUAL_BACKGROUND_CHANGED');
  }
  if (posterOptions) await checkPosterDesignBackground(posterOptions, background, signal);
  const design = posterOptions ? {
    version: 1, kind: 'visual_scene', preset: 'poster', title: posterOptions.title, subtitle: posterOptions.subtitle || '',
    width: posterOptions.width, height: posterOptions.height, theme: 'light', dataMode: 'provided', source: '用户海报设计', asOf: '', metrics: [], series: [], alerts: [], markers: []
  } : normalizeVisualDesign(options);
  throwControl(null, signal);
  return { design, background, backgroundPath, backgroundHash, posterOptions };
}

export function visualOutputBase(input, design, backgroundPath) {
  const title = [...String(design.title).replace(/[\\/:*?"<>|\s]+/g, '')].slice(0, 36).join('') || '视觉作品';
  const target = input.path || `视觉作品/${title}-${Date.now().toString(36)}.html`;
  if (typeof target !== 'string' || target.length > 300 || !/\.(html|png|svg|zip)$/i.test(target)) throw visualInputError('保存路径需为300字符内的.html、.png、.svg或.zip');
  const base = ws.normalize(target).replace(/\.(html|png|svg|zip)$/i, '');
  const protectedPaths = [input.source_path, backgroundPath].filter(Boolean).map(ws.normalize);
  if (['png', 'svg', 'html', 'zip', 'visual.json', 'poster.json'].some(ext => protectedPaths.includes(`${base}.${ext}`))) throw visualInputError('输出不能覆盖设计源文件或底图，请另存名称');
  return base;
}

export function visualDesignBlob(loaded) {
  const { design: options, backgroundPath, backgroundHash, posterOptions } = loaded;
  // 海报设计仍通过原source_path引用；完整文案仅留在文件，不塞进工具回执。
  return new Blob([JSON.stringify({ kind: 'visual-design', version: 1, options, backgroundPath, backgroundHash, ...(posterOptions && { posterOptions: posterPick(posterOptions) }) })], { type: 'application/json' });
}

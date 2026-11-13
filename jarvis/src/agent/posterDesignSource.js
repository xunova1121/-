/** 小型设计参数独立保存，后续改字直接复用无字底图，不把图片或全文放进对话检查点。 */
import * as ws from './workspace.js';
import { imageFingerprint } from './visualEvidence.js';
import { throwControl } from '../core/networkRequest.js';

const FIELDS = ['title', 'subtitle', 'lines', 'footer', 'width', 'height', 'text_position', 'text_fraction', 'text_style', 'text_align', 'gradient_opacity', 'font_family', 'text_color', 'panel_color', 'background_color', 'theme', 'background_path'];
const problem = (message, code = 'POSTER_DESIGN_INVALID') => Object.assign(new Error(message), { code, kind: 'input' });
const pick = value => Object.fromEntries(FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const EXPECTED_BACKGROUND = Symbol('posterBackgroundHash');

/** 明确从实色切换渐变时启用新样式默认；本轮显式给出的版式和已有渐变稿均保留。 */
export function mergePosterDesignOptions(previous, input) {
  const options = { ...previous, ...input };
  if (input.text_style === 'gradient' && (!previous.text_style || previous.text_style === 'panel')) {
    for (const key of ['text_position', 'text_fraction', 'text_align']) {
      if (!Object.hasOwn(input, key)) delete options[key];
    }
  }
  return options;
}

export async function posterDesignInput(input, signal) {
  if (!input?.source_path) return input;
  throwControl(null, signal);
  if (typeof input.source_path !== 'string' || !/\.poster\.json$/i.test(input.source_path)) throw problem('修改文字请提供本工具生成的.poster.json设计文件');
  const blob = await ws.readBlob(input.source_path);
  if (blob.size > 40000) throw problem('海报设计文件超过40KB');
  let design;
  try { design = JSON.parse(await blob.text()); } catch { throw problem('海报设计文件不是有效JSON'); }
  if (design?.kind !== 'poster-design' || design.version !== 1 || !design.options || typeof design.options !== 'object' || Array.isArray(design.options)) throw problem('不是支持的海报设计文件');
  const previous = pick(design.options);
  const backgroundPath = input.background_path ?? previous.background_path;
  const sameBackground = backgroundPath && previous.background_path && ws.normalize(backgroundPath) === ws.normalize(previous.background_path);
  if (design.backgroundHash != null && !/^[a-f0-9]{64}$/.test(design.backgroundHash)) throw problem('海报底图摘要无效');
  if (sameBackground && !design.backgroundHash) throw problem('原设计没有可核验的底图摘要；请明确指定另一份已确认的底图', 'POSTER_BACKGROUND_UNVERIFIED');
  throwControl(null, signal);
  const options = mergePosterDesignOptions(previous, input);
  if (sameBackground && design.backgroundHash)
    Object.defineProperty(options, EXPECTED_BACKGROUND, { value: design.backgroundHash });
  // 改画幅时，不能让上一版的width/height压过这次明确指定的size。
  if (Object.hasOwn(input, 'size') && input.width === undefined && input.height === undefined) {
    delete options.width;
    delete options.height;
  }
  if (!input.path) options.path = ws.normalize(input.source_path).replace(/\.poster\.json$/i, '') + '-修改-' + Date.now().toString(36) + '.png';
  return options;
}

/** 核验的正是将要排版的同一份受限字节，不再重复读取工作区造成检查与使用不一致。 */
export async function checkPosterDesignBackground(input, background, signal) {
  if (!input[EXPECTED_BACKGROUND]) return;
  throwControl(null, signal);
  const hash = background ? await imageFingerprint(new Blob([background.bytes], { type: background.mime })) : null;
  throwControl(null, signal);
  if (hash !== input[EXPECTED_BACKGROUND]) throw problem('原无字底图已经变化，未擅自用另一版图片覆盖；确认后明确指定新的底图路径', 'POSTER_BACKGROUND_CHANGED');
}

export async function posterDesignBlob(input, { width, height, background }) {
  const options = pick({ ...input, width, height });
  const backgroundHash = background ? await imageFingerprint(new Blob([background.bytes], { type: background.mime })) : null;
  if (background && !backgroundHash) throw problem('当前环境不能生成底图摘要，未保存可复用设计', 'POSTER_HASH_UNAVAILABLE');
  return new Blob([JSON.stringify({ kind: 'poster-design', version: 1, options, backgroundHash })], { type: 'application/json' });
}

import { validatePosterSvg, lockPosterFont, posterError, POSTER_LIMITS } from './posterSvg.js';
import { checkBrowserPosterFonts, posterWait } from './posterFonts.js';
import { imageInfo } from './imageInfo.js';
import { throwControl } from '../core/networkRequest.js';

let active = 0;

/** 浏览器/安卓本机合成最终PNG；仅内嵌位图，原尺寸输出，最长20秒、最多两并发。 */
export async function renderPoster(svg, { signal } = {}) {
  throwControl(null, signal);
  const checked = validatePosterSvg(svg);
  if (typeof document === 'undefined' || typeof Image === 'undefined') throw posterError('当前环境没有海报渲染器', 'POSTER_RENDER_UNAVAILABLE', 'capability');
  if (active >= 2) throw posterError('海报渲染繁忙，请稍后再试', 'POSTER_RENDER_BUSY', 'api');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(posterError('海报渲染超时', 'POSTER_RENDER_TIMEOUT', 'timeout')), 20000);
  const canvas = document.createElement('canvas'), img = new Image();
  let source;
  active++;
  try {
    const fontCheck = await checkBrowserPosterFonts(checked, { signal: controller.signal });
    throwControl(null, controller.signal);
    source = URL.createObjectURL(new Blob([lockPosterFont(checked.svg, fontCheck.family)], { type: 'image/svg+xml' }));
    await posterWait(new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(posterError('海报SVG无法解码', 'POSTER_RENDER', 'api'));
      img.src = source;
    }), controller.signal);
    canvas.width = checked.width;
    canvas.height = checked.height;
    const context = canvas.getContext('2d');
    if (!context) throw posterError('Canvas不可用，未输出最终海报PNG', 'POSTER_RENDER_UNAVAILABLE', 'capability');
    context.drawImage(img, 0, 0, checked.width, checked.height);
    const blob = await posterWait(new Promise(resolve => canvas.toBlob(resolve, 'image/png')), controller.signal);
    throwControl(null, controller.signal);
    if (!blob || blob.size > POSTER_LIMITS.outputBytes) throw posterError('海报PNG为空或超过24MB', 'POSTER_RENDER_SIZE', 'api');
    const actual = imageInfo(new Uint8Array(await posterWait(blob.slice(0, 64).arrayBuffer(), controller.signal)));
    if (actual?.type !== 'png' || actual.width !== checked.width || actual.height !== checked.height)
      throw posterError('海报PNG尺寸校验失败', 'POSTER_RENDER_INVALID', 'api');
    return { blob, fontCheck, width: checked.width, height: checked.height };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    img.src = '';
    if (source) URL.revokeObjectURL(source);
    canvas.width = canvas.height = 0;
    active--;
  }
}

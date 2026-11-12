import { lockPosterFont, posterError, POSTER_LIMITS } from './posterSvg.js';
import { checkBrowserPosterFonts, posterWait } from './posterFonts.js';
import { imageInfo } from './imageInfo.js';
import { throwControl } from '../core/networkRequest.js';
import { checkBrowserRasterImages } from './svgRasterImages.js';

let active = 0;

/** 校验器由内部入口固定绑定，调用参数不能替换；海报与场景共用两并发额度。 */
export const createBrowserSvgRaster = (validate, { decodeImages = false } = {}) => async function render(svg, { signal, fontProbe = checkBrowserPosterFonts } = {}) {
  throwControl(null, signal);
  const checked = validate(svg);
  if (typeof document === 'undefined' || typeof Image === 'undefined') throw posterError('当前环境没有海报渲染器', 'POSTER_RENDER_UNAVAILABLE', 'capability');
  if (active >= 2) throw posterError('海报渲染繁忙，请稍后再试', 'POSTER_RENDER_BUSY', 'api');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(posterError('海报渲染超时', 'POSTER_RENDER_TIMEOUT', 'timeout')), 20000);
  let canvas, img, source;
  active++;
  try {
    canvas = document.createElement('canvas');
    img = new Image();
    const fontCheck = await posterWait(fontProbe(checked, { signal: controller.signal }), controller.signal);
    if (decodeImages) await checkBrowserRasterImages(checked.svg, { signal: controller.signal });
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
    const end = new Uint8Array(await posterWait(blob.slice(-12).arrayBuffer(), controller.signal));
    const complete = blob.size >= 67 && end.join() === '0,0,0,0,73,69,78,68,174,66,96,130';
    if (!complete || actual?.type !== 'png' || actual.width !== checked.width || actual.height !== checked.height)
      throw posterError('海报PNG尺寸校验失败', 'POSTER_RENDER_INVALID', 'api');
    return { blob, fontCheck, width: checked.width, height: checked.height };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (img) img.src = '';
    if (source) URL.revokeObjectURL(source);
    if (canvas) canvas.width = canvas.height = 0;
    active--;
  }
};

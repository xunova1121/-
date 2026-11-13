import { posterError, posterGlyphs } from './posterSvg.js';
import { throwControl } from '../core/networkRequest.js';

// 原创三角形哨兵字体（TTF cmap13覆盖所有码点），只有一个轮廓，没有任何外部资源。
// 放到待测字体后，缺字必定显示该轮廓，避免浏览器自动回退别的字体让fonts.check误报通过。
const SENTINEL_FONT = 'AAEAAAAKAIAAAwAgT1MvMkThRksAAAEoAAAAYGNtYXAAIQA0AAABkAAAAChnbHlmrlXmHgAAAcAAAAAmaGVhZDE0L/YAAACsAAAANmhoZWEHbgPqAAAA5AAAACRobXR4BEwAAAAAAYgAAAAGbG9jYQATAAAAAAG4AAAABm1heHAABQAIAAABCAAAACBuYW1lFs9bwgAAAegAAAF3cG9zdNTZ6NwAAANgAAAALwABAAAAAQAAbYlQc18PPPUAAwPoAAAAAOca9bAAAAAA5xr1sABkAGQDhANSAAAAAwACAAAAAAAAAAEAAAOE/5wAAAPoAGQAZAOEAAEAAAAAAAAAAAAAAAAAAAABAAEAAAACAAYAAgAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwPoAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAAAD//wOE/5wAAAOEAGQAAAAAAAAAAAAAAAAAAAAgAAAD6AAAAGQAAAAAAAEAAwAKAAAADAANAAAAAAAcAAAAAAAAAAEAAAAAABD//wAAAAEAAAAAABMAAAACAGQAZAOEA1IAAgAFAAA3IQEDNxdkAyD+cGRkZGQC7v2oyMgAAAAAAAAKAH4AAQAAAAAAAQAbAAAAAQAAAAAAAgAHABsAAQAAAAAAAwAZACIAAQAAAAAABAAbAAAAAQAAAAAABgAYADsAAwABBAkAAQA2AFMAAwABBAkAAgAOAIkAAwABBAkAAwAyAJcAAwABBAkABAA2AFMAAwABBAkABgAwAMlKYXJ2aXMgUG9zdGVyIE1pc3NpbmcgR2x5cGhSZWd1bGFySmFydmlzUG9zdGVyTWlzc2luZ0dseXBoMUphcnZpc1Bvc3Rlck1pc3NpbmdHbHlwaABKAGEAcgB2AGkAcwAgAFAAbwBzAHQAZQByACAATQBpAHMAcwBpAG4AZwAgAEcAbAB5AHAAaABSAGUAZwB1AGwAYQByAEoAYQByAHYAaQBzAFAAbwBzAHQAZQByAE0AaQBzAHMAaQBuAGcARwBsAHkAcABoADEASgBhAHIAdgBpAHMAUABvAHMAdABlAHIATQBpAHMAcwBpAG4AZwBHAGwAeQBwAGgAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAQIIc2VudGluZWwA';

export function posterWait(promise, signal) {
  throwControl(null, signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    if (signal?.aborted) abort();
  });
}

function glyphPixels(context, ch, font) {
  context.clearRect(0, 0, 80, 80);
  context.font = font;
  context.fillStyle = '#000';
  context.fillText(ch, 8, 58);
  return context.getImageData(0, 0, 80, 80).data;
}
const equalPixels = (a, b) => a.every((value, i) => value === b[i]);

/** 真正加载本地字体，并用内部缺字哨兵逐字检查；检测结果不代替最终排版视觉验收。 */
export async function checkBrowserPosterFonts(checked, { signal } = {}) {
  if (typeof FontFace === 'undefined' || !document.fonts)
    throw posterError('当前浏览器不能核验中文字体，未输出最终海报PNG', 'POSTER_FONT_CHECK_UNAVAILABLE', 'capability');
  const glyphs = posterGlyphs(checked.text);
  const suffix = Math.random().toString(36).slice(2), sentinelName = `JarvisPosterMissing${suffix}`, probeName = `JarvisPosterProbe${suffix}`;
  const sentinel = new FontFace(sentinelName, Uint8Array.from(atob(SENTINEL_FONT), ch => ch.charCodeAt(0)));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 80;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw posterError('浏览器Canvas不可用，无法核验海报字体', 'POSTER_FONT_CHECK_UNAVAILABLE', 'capability');
  let found = false;
  try {
    await posterWait(sentinel.load(), signal);
    document.fonts.add(sentinel);
    const mark = glyphPixels(context, 'A', `48px "${sentinelName}"`);
    if (!mark.some(value => value) || !equalPixels(mark, glyphPixels(context, '中', `48px "${sentinelName}"`)))
      throw posterError('浏览器不支持逐字字体核验，未输出最终PNG', 'POSTER_FONT_CHECK_UNAVAILABLE', 'capability');
    for (const family of checked.families) {
      throwControl(null, signal);
      const probe = new FontFace(probeName, `local("${family}")`);
      try {
        try { await posterWait(probe.load(), signal); }
        catch (error) { throwControl(error, signal); continue; }
        document.fonts.add(probe);
        found = true;
        let covered = true;
        for (const weight of checked.weights) {
          const missing = glyphPixels(context, 'A', `${weight} 48px "${sentinelName}"`);
          for (let index = 0; index < glyphs.length; index++) {
            throwControl(null, signal);
            const pixels = glyphPixels(context, glyphs[index], `${weight} 48px "${family}", "${sentinelName}"`);
            if (!pixels.some(value => value) || equalPixels(pixels, missing)) { covered = false; break; }
            // 最多12000字符；定期让出事件循环，让用户停止和整段超时及时生效。
            if (index % 32 === 31) await posterWait(new Promise(resolve => setTimeout(resolve, 0)), signal);
          }
          if (!covered) break;
        }
        if (covered) return { status: 'passed', family, method: 'browser-glyph-render', glyphCount: glyphs.length };
      } finally { document.fonts.delete(probe); }
    }
  } finally {
    document.fonts.delete(sentinel);
    canvas.width = canvas.height = 0;
  }
  throw posterError(found ? '当前中文字体不能覆盖海报全文，未输出最终PNG' : '当前设备缺少海报所需中文字体，未输出最终PNG', found ? 'POSTER_FONT_GLYPHS_MISSING' : 'POSTER_FONT_MISSING', 'capability');
}

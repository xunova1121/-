import { validatePosterSvg } from './posterSvg.js';
import { createBrowserSvgRaster } from './svgRasterInternal.js';

// 海报始终使用原有严格白名单，视觉场景不能通过调用参数扩大此入口。
export const renderPoster = createBrowserSvgRaster(validatePosterSvg);

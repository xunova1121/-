import { validatePosterSvg } from '../src/agent/posterSvg.js';
import { createServerSvgRaster } from './svgRasterInternal.mjs';

export { checkPosterFonts, fontCharsetCovers } from './svgRasterInternal.mjs';

// 保留原入口和字体检查导出，场景渲染的白名单与海报完全隔离。
export const renderPoster = createServerSvgRaster(validatePosterSvg);

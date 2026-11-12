import { validateVisualSceneSvg } from './visualSceneSvg.js';
import { createBrowserSvgRaster } from './svgRasterInternal.js';

// 仅供内部视觉场景使用；全文字形检查、原尺寸PNG及停止/超时沿用同一机制。
export const renderVisualScene = createBrowserSvgRaster(validateVisualSceneSvg, { decodeImages: true });

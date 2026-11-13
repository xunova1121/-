import { validateVisualSceneSvg } from '../src/agent/visualSceneSvg.js';
import { createServerSvgRaster } from './svgRasterInternal.mjs';

// 只消费经专用白名单校验的自包含SVG；不接受命令、URL或输出路径。
export const renderVisualScene = createServerSvgRaster(validateVisualSceneSvg, { decodeImages: true });

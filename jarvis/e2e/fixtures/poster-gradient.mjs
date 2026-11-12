/** 原创合成底图：侧边及底部保持同色，便于真实像素检测渐变接缝；不是模型画质样例。 */
export const gradientBackgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440">
<rect width="1080" height="1440" fill="#CDAA7D"/>
<circle cx="540" cy="510" r="285" fill="#96714F"/>
<circle cx="540" cy="492" r="266" fill="#F9E9CC"/>
<circle cx="540" cy="492" r="228" fill="#AE6B36"/>
<circle cx="540" cy="492" r="207" fill="#D89E5C"/>
<ellipse cx="454" cy="427" rx="69" ry="43" fill="#F3D6A6"/>
<ellipse cx="613" cy="568" rx="74" ry="39" fill="#F3D6A6"/>
<ellipse cx="635" cy="410" rx="34" ry="30" fill="#934C35"/>
<ellipse cx="440" cy="580" rx="29" ry="26" fill="#934C35"/>
<ellipse cx="532" cy="511" rx="21" ry="69" fill="#607447"/>
</svg>`;

export const gradientSample = Object.freeze({
  title: '秋日暖汤', subtitle: '让温暖融入每个日常', lines: ['莲藕 · 山药 · 红枣'],
  footer: '原创合成底图 · 中文由程序排版', width: 1080, height: 1440,
  text_style: 'gradient', text_align: 'center', gradient_opacity: 0.85,
  font_family: 'sans', text_color: '#FFFFFF', panel_color: '#14202C', background_color: '#CDAA7D'
});

/** 在无文字、无装饰的固定列逐像素检查；硬色板或离散色带均不能通过。 */
export async function inspectGradient({ imageUrl, width, height, start, opacity, mid = null, base = [205, 170, 125], color = [20, 32, 44] }) {
  const img = new Image();
  img.src = imageUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(img, 0, 0);
  const pixels = context.getImageData(24, 0, 1, canvas.height).data;
  let maxStep = 0, maxBrightening = 0, maxFormulaError = 0, aboveChanges = 0;
  const colors = new Set();
  const rows = [];
  for (let y = 0; y < canvas.height; y++) {
    const rgb = [...pixels.slice(y * 4, y * 4 + 3)];
    if (y < start - 1 && rgb.some((value, channel) => Math.abs(value - base[channel]) > 2)) aboveChanges++;
    if (y >= start) {
      colors.add(rgb.join(','));
      // 2026-11-12 复审：实测对比不足时多一个中间色标，按两段直线插值（0→中间→终点）
      const t = Math.min(1, Math.max(0, (y + 0.5 - start) / (height - start)));
      const fraction = !mid ? t * opacity : t <= mid.offset ? (t / mid.offset) * mid.opacity : mid.opacity + ((t - mid.offset) / (1 - mid.offset)) * (opacity - mid.opacity);
      rgb.forEach((value, channel) => {
        maxFormulaError = Math.max(maxFormulaError, Math.abs(value - (base[channel] * (1 - fraction) + color[channel] * fraction)));
      });
    }
    if (y >= start - 2 && y > 0) rgb.forEach((value, channel) => {
      const difference = value - pixels[(y - 1) * 4 + channel];
      maxStep = Math.max(maxStep, Math.abs(difference));
      maxBrightening = Math.max(maxBrightening, difference);
    });
    if ([Math.floor(start) - 1, Math.floor(start), Math.floor(start) + 1, Math.floor((start + height) / 2), height - 1].includes(y)) rows.push({ y, rgb });
  }
  return { width: canvas.width, height: canvas.height, expectedWidth: width, expectedHeight: height, aboveChanges, maxStep, maxBrightening, maxFormulaError, colorLevels: colors.size, rows };
}

/** PDF原生文字独立抽取，且以成品像素尺寸渲染，避免用预览缩略图检查渐变。 */
export async function inspectGradientPdf({ bytes, width }) {
  const pdfjs = await import('/node_modules/pdfjs-dist/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';
  const documentPdf = await pdfjs.getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false }).promise;
  try {
    const pdfPage = await documentPdf.getPage(1);
    const natural = pdfPage.getViewport({ scale: 1 });
    const viewport = pdfPage.getViewport({ scale: width / natural.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const content = await pdfPage.getTextContent();
    return {
      pages: documentPdf.numPages, width: canvas.width, height: canvas.height,
      text: content.items.map(item => item.str).join(''), textItems: content.items.length,
      points: { width: natural.width, height: natural.height }, png: canvas.toDataURL('image/png')
    };
  } finally { await documentPdf.destroy(); }
}

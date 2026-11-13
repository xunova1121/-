/**
 * 海报文字按真实底图像素核对对比度（2026-11-12 复审）：原来只拿“声明的文字区底色”算，渐变叠在底图上时，
 * 标题位置的遮罩最淡，实测白字对比度只有约3:1。这里把不含文字的同版式成品解码成像素，逐块量文字区背景，
 * 取最差的一成像素算对比度（允许少量噪点，不让一块亮斑决定结果）。
 * 浏览器、电脑版、服务器通用：只用标准 DecompressionStream，不引入依赖；解码不了就如实标“未检查”。
 */

/** 解码本程序渲染器输出的 PNG（8位 RGB/RGBA、非隔行），返回 RGBA 像素；其他格式返回 null（未检查，不冒充通过）。 */
export async function decodePngRgba(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < 33 || data[0] !== 0x89 || data[1] !== 0x50) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const chunks = [];
  while (offset + 8 <= data.length) {
    const length = view.getUint32(offset), name = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (name === 'IHDR') { width = view.getUint32(offset + 8); height = view.getUint32(offset + 12); depth = data[offset + 16]; type = data[offset + 17]; interlace = data[offset + 20]; }
    else if (name === 'IDAT') chunks.push(body);
    else if (name === 'IEND') break;
    offset += 12 + length;
  }
  const channels = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (depth !== 8 || !channels || interlace || !width || !height || width * height > 40e6 || typeof DecompressionStream !== 'function') return null;
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
  const raw = new Uint8Array(await new Response(new Blob([joined]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const pixels = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), current = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels] : 0, up = previous[i], corner = i >= channels ? previous[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else if (filter !== 0) return null;
      current[i] = value & 255;
    }
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4, source = x * channels;
      pixels[target] = current[source]; pixels[target + 1] = current[source + 1]; pixels[target + 2] = current[source + 2];
      pixels[target + 3] = channels === 4 ? current[source + 3] : 255;
    }
    previous = current;
  }
  return { width, height, data: pixels };
}

const channel = value => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminanceRgb = (r, g, b) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
export const luminanceHex = hex => { const v = String(hex).replace('#', ''); return luminanceRgb(parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)); };
const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * 海报多在手机上看，只卡3:1及格线会“勉强能看”（复审实测标题3.0～3.2）。叠在图片上的文字一律按4.5:1；
 * 正文小于24像素时按7:1（WCAG AAA），留出余量。
 */
export const contrastMinimum = fontSize => (fontSize >= 24 ? 4.5 : 7);

/**
 * 逐块量文字背后的真实像素。blocks 来自同一版式（像素坐标），image 是不含文字的成品像素。
 * 返回每块最差一成像素的对比度；有任一块不达标 ok=false。
 */
export function measureTextContrast(image, blocks, textColor) {
  const text = luminanceHex(textColor);
  const results = blocks.map((block) => {
    const values = [];
    const x0 = Math.max(0, Math.floor(block.x)), x1 = Math.min(image.width, Math.ceil(block.x + block.w));
    const y0 = Math.max(0, Math.floor(block.y)), y1 = Math.min(image.height, Math.ceil(block.y + block.h));
    const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const i = (y * image.width + x) * 4;
      values.push(ratio(text, luminanceRgb(image.data[i], image.data[i + 1], image.data[i + 2])));
    }
    values.sort((a, b) => a - b);
    const contrast = values.length ? values[Math.floor(values.length * 0.1)] : Infinity;
    const minimum = contrastMinimum(block.fontSize || 0);
    return { role: block.role, contrast: Math.round(contrast * 100) / 100, minimum, ok: contrast >= minimum };
  });
  return { ok: results.every(item => item.ok), blocks: results };
}

/**
 * 文字设为全透明，只留底图和遮罩，用来量“文字背后”的真实底色（SVG 由本程序生成，结构固定）。
 * 不能直接删掉文字：正式渲染器要求视觉SVG必须含文字，删掉会被拒收，检查就永远落空。
 */
export const withoutText = svg => String(svg).replace(/<text\b[\s\S]*?<\/text>/g, match => `<g opacity="0">${match}</g>`);

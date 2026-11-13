const invalid = (text) => Object.assign(new Error(text), { code: 'DIAGRAM_PNG', kind: 'input' });

export async function streamBytes(bytes, mode, max = 20000000) {
  const transform = mode === 'inflate' ? new DecompressionStream('deflate') : new CompressionStream('deflate');
  const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > max) throw invalid('图片解压超过大小上限');
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** 只处理渲染器输出的8位RGB/RGBA PNG，最多420万像素，不依赖新增图片库。 */
export async function pngPixels(blob) {
  if (blob.size > 12e6) throw invalid('PNG超过12MB');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (Array.from(bytes.slice(0, 8)).join(',') !== '137,80,78,71,13,10,26,10') throw invalid('不是PNG');
  const view = new DataView(bytes.buffer);
  let width, height, channels;
  const data = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset);
    if (offset + size + 12 > bytes.length) throw invalid('PNG块长度无效');
    const type = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8));
    if (type === 'IHDR') {
      if (size !== 13 || channels != null) throw invalid('PNG头部无效');
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      channels = bytes[offset + 17] === 6 ? 4 : bytes[offset + 17] === 2 ? 3 : 0;
      if (
        bytes[offset + 16] !== 8 ||
        !channels ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] !== 0 ||
        !width ||
        !height ||
        width * height > 4200000
      )
        throw invalid('PNG位深/颜色/尺寸不支持');
    }
    if (type === 'IDAT') data.push(bytes.slice(offset + 8, offset + 8 + size));
    offset += size + 12;
    if (type === 'IEND') break;
  }
  if (!channels || !data.length) throw invalid('PNG缺少像素数据');
  const compressed = new Uint8Array(data.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of data) {
    compressed.set(part, position);
    position += part.length;
  }
  const rows = await streamBytes(compressed, 'inflate', (width * channels + 1) * height);
  const stride = width * channels;
  if (rows.length !== (stride + 1) * height) throw invalid('PNG扫描行长度不一致');
  const raw = new Uint8Array(stride * height);
  const rgb = new Uint8Array(width * height * 3);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let row = 0; row < height; row++) {
    const filter = rows[row * (stride + 1)];
    if (filter > 4) throw invalid('PNG过滤器无效');
    for (let col = 0; col < stride; col++) {
      const index = row * stride + col;
      const a = col >= channels ? raw[index - channels] : 0;
      const b = row ? raw[index - stride] : 0;
      const c = row && col >= channels ? raw[index - stride - channels] : 0;
      raw[index] = rows[row * (stride + 1) + 1 + col] + [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
    }
    for (let col = 0; col < width; col++) {
      const index = row * stride + col * channels;
      const alpha = channels === 4 ? raw[index + 3] / 255 : 1;
      for (let channel = 0; channel < 3; channel++) rgb[(row * width + col) * 3 + channel] = Math.round(raw[index + channel] * alpha + 255 * (1 - alpha));
    }
  }
  return { width, height, rgb };
}

export async function comparePng(reference, candidate) {
  const a = await pngPixels(reference);
  const b = await pngPixels(candidate);
  let delta = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const bx = Math.min(b.width - 1, Math.floor((x * b.width) / a.width));
      const by = Math.min(b.height - 1, Math.floor((y * b.height) / a.height));
      for (let c = 0; c < 3; c++) delta += Math.abs(a.rgb[(y * a.width + x) * 3 + c] - b.rgb[(by * b.width + bx) * 3 + c]);
    }
  const error = delta / a.rgb.length / 255;
  const aspectError = Math.abs(a.width / a.height - b.width / b.height);
  return { passed: error <= 0.012 && aspectError < 0.01, meanChannelError: error, aspectError };
}

/** 按内容辨认图片，不把SVG文本改个后缀当JPEG；读取头部最多64KB。 */
export async function imageFormat(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const text = new TextDecoder()
    .decode(bytes)
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (/^(?:<\?xml|<!DOCTYPE|<!--)/i.test(text) && /<svg(?:\s|>)/i.test(text)) return { ext: 'svg', mime: 'image/svg+xml' };
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text)) return { ext: 'svg', mime: 'image/svg+xml' };
  if (bytes[0] === 0x89 && String.fromCharCode(...bytes.slice(1, 4)) === 'PNG') return { ext: 'png', mime: 'image/png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (/^GIF8[79]a/.test(String.fromCharCode(...bytes.slice(0, 6)))) return { ext: 'gif', mime: 'image/gif' };
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return { ext: 'bmp', mime: 'image/bmp' };
  return null;
}

export async function assertImageExtension(path, blob) {
  const actual = await imageFormat(blob);
  const suffix = String(path).split('.').at(-1).toLowerCase().replace('jpeg', 'jpg');
  if (actual && /^(?:svg|png|jpg|webp)$/.test(suffix) && suffix !== actual.ext) {
    throw Object.assign(new Error(`文件内容是${actual.ext.toUpperCase()}，不能保存为.${suffix}；SVG转图片请用render_diagram，不能只改文件名`), {
      code: 'IMAGE_FORMAT_MISMATCH',
      kind: 'input'
    });
  }
  return actual;
}

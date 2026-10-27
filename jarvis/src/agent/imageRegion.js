/** 区域用0～1坐标；原图只在本次调用内处理，不写入对话和缓存。 */
export function visualRegion(value) {
  if (value == null) return null;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
    throw Object.assign(new Error('图片区域必须在0～1范围内且不能越界'), { code: 'IMAGE_REGION', kind: 'input' });
  }
  return { x, y, width, height };
}

export async function cropImageRegion(blob, value, { signal } = {}) {
  const region = visualRegion(value);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!region) return blob;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw Object.assign(new Error('当前环境不支持图片裁剪'), { code: 'IMAGE_CROP_UNAVAILABLE', kind: 'capability' });
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const sx = Math.floor(bitmap.width * region.x);
    const sy = Math.floor(bitmap.height * region.y);
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(bitmap.width * region.width)));
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(bitmap.height * region.height)));
    const scale = Math.min(3, 2048 / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const cropped = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!cropped) throw Object.assign(new Error('图片裁剪失败'), { code: 'IMAGE_CROP', kind: 'api' });
    return cropped;
  } finally {
    bitmap.close();
  }
}

export async function imageData(blob, { detail } = {}) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { mime: blob.type || 'image/png', data: btoa(text), ...(detail === 'high' && { detail: 'high' }) };
}

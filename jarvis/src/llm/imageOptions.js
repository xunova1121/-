const invalid = (text) => Object.assign(new Error(text), { code: 'IMAGE_OPTIONS', kind: 'input' });

/** GPT Image 2的尺寸与输出参数；不向其他服务商模型塞入未支持参数。 */
export function imageRequestOptions(model, options = {}) {
  const size = options.size || '1024x1024';
  const result = { size };
  if (!/^gpt-image-/i.test(model)) {
    if (options.quality || options.outputFormat || options.background) throw invalid('当前画图型号未声明GPT Image参数支持，请使用默认选项或切换型号');
    return result;
  }
  if (size !== 'auto') {
    const match = /^(\d{2,4})x(\d{2,4})$/.exec(size);
    if (!match) throw invalid('图片尺寸需为auto或宽x高');
    const [, w, h] = match.map(Number);
    if (/^gpt-image-2(?:[.\-]|$)/i.test(model)) {
      if (w % 16 || h % 16 || w / h < 1 / 3 || w / h > 3 || w * h > 3840 * 2160 || Math.max(w, h) > 3840)
        throw invalid('GPT Image 2尺寸需为16的倍数、宽高比1:3至3:1，且不超过约830万像素');
    } else if (!['1024x1024', '1536x1024', '1024x1536'].includes(size)) throw invalid('当前GPT Image型号仅使用标准尺寸或auto');
  }
  for (const [key, value, choices] of [
    ['quality', options.quality, ['auto', 'low', 'medium', 'high']],
    ['output_format', options.outputFormat, ['png', 'jpeg', 'webp']],
    ['background', options.background, ['auto', 'opaque', 'transparent']]
  ]) {
    if (value === undefined || value === '') continue;
    if (!choices.includes(value)) throw invalid('不支持的图片参数：' + key);
    result[key] = value;
  }
  if (result.background === 'transparent' && result.output_format === 'jpeg') throw invalid('透明背景不能导出JPEG，请选择PNG或WebP');
  return result;
}

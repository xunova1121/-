import { imageData } from '../agent/imageRegion.js';
import { throwControl } from '../core/networkRequest.js';
import { imageFormat } from '../agent/imageFormat.js';

/** 新版GPT图片线路使用官方JSON原片协议；旧线路保留multipart，也可按服务商契约明确选择。 */
export function imageEditFormat(model, choice = '') {
  if (!['', 'auto', 'json', 'multipart'].includes(choice))
    throw Object.assign(new Error('图片编辑格式需为自动、JSON原片或文件上传'), { code: 'IMAGE_EDIT_FORMAT', kind: 'input' });
  if (choice && choice !== 'auto') return choice;
  return /(?:^|\/)gpt-image-2\.(?:[5-9]|[1-9]\d+)(?:[.-]|$)/i.test(model) ? 'json' : 'multipart';
}

/** 只编码工作区原文件，不缩放/压缩，不上传到额外图床，构造完才允许扣费发出。 */
export async function imageEditRequest({ model, prompt: imagePrompt, images, parameters, format, headers, signal }) {
  throwControl(null, signal);
  if (format === 'json') {
    const references = [];
    for (const source of images) {
      throwControl(null, signal);
      const format = await imageFormat(source);
      if (!format || !['png', 'jpg', 'webp'].includes(format.ext))
        throw Object.assign(new Error('JSON原片编辑需有效PNG、JPEG或WebP文件'), { code: 'IMAGE_EDIT_INPUT', kind: 'input' });
      const image = await imageData(source);
      references.push({ image_url: `data:${format.mime};base64,${image.data}` });
    }
    throwControl(null, signal);
    return { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt: imagePrompt, ...parameters, n: 1, images: references }) };
  }
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', imagePrompt);
  for (const [key, value] of Object.entries(parameters)) form.append(key, value);
  form.append('n', '1');
  images.forEach((image, index) => form.append(images.length === 1 ? 'image' : 'image[]', image, `reference-${index + 1}.${/jpeg/.test(image.type) ? 'jpg' : /webp/.test(image.type) ? 'webp' : 'png'}`));
  return { method: 'POST', headers, body: form };
}

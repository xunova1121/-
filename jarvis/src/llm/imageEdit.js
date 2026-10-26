import { abilityLines, cfgForLine } from './abilities.js';
import { providerEndpoint, imageModelOf } from './images.js';
import { imageRequestOptions } from './imageOptions.js';
import { requestImage } from './imageResponse.js';
import { throwControl } from '../core/networkRequest.js';

/** 编辑必须把真实原图传给/images/edits；接口不支持时明确失败，不退化为凭文字重画。 */
export async function editImage(cfg, { prompt: imagePrompt, images, gateway = null, fetchImpl = globalThis.fetch, download = fetchImpl, signal, beforeRequest, ...options } = {}) {
  if (!Array.isArray(images) || !images.length || images.length > 3 || images.some(image => !(image instanceof Blob) || image.size > 10e6)) throw Object.assign(new Error('图片编辑需1～3张原图，每张不超过10MB'), { code: 'IMAGE_EDIT_INPUT', kind: 'input' });
  const { main } = abilityLines(cfg, 'image');
  const lines = main ? [main] : [{ provider: cfg.provider, model: imageModelOf(cfg) }];
  let failure;
  for (const line of lines) {
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { base, headers } = providerEndpoint(cfgForLine(cfg, line), gateway);
      const parameters = imageRequestOptions(line.model, { ...cfg.imageOptions, ...options });
      const form = new FormData();
      form.append('model', line.model);
      form.append('prompt', String(imagePrompt).slice(0, 12000));
      for (const [key, value] of Object.entries(parameters)) form.append(key, value);
      form.append('n', '1');
      images.forEach((image, index) => form.append(images.length === 1 ? 'image' : 'image[]', image, `reference-${index + 1}.${/jpeg/.test(image.type) ? 'jpg' : /webp/.test(image.type) ? 'webp' : 'png'}`));
      beforeRequest?.();
      return await requestImage(base + '/images/edits', { method: 'POST', headers, body: form }, { fetchImpl, download, signal, model: line.model, operation: '原图编辑' });
    } catch (error) {
      throwControl(error, signal);
      failure = error;
      // 编辑请求结果不明或下载失败均不自动重提，避免重复收费。只使用用户当前画图线路。
      throw error;
    }
  }
  throw failure;
}

import { abilityLines, cfgForLine } from './abilities.js';
import { providerEndpoint, imageModelOf } from './images.js';
import { imageRequestOptions } from './imageOptions.js';
import { requestImage } from './imageResponse.js';
import { throwControl } from '../core/networkRequest.js';
import { imageEditFormat, imageEditRequest } from './imageEditRequest.js';

/** 编辑必须把真实原图传给/images/edits；接口不支持时明确失败，不退化为凭文字重画。 */
export async function editImage(cfg, { prompt: imagePrompt, images, gateway = null, fetchImpl = globalThis.fetch, download = fetchImpl, signal, beforeRequest, editFormat, ...options } = {}) {
  if (!Array.isArray(images) || !images.length || images.length > 3 || images.some(image => !(image instanceof Blob) || image.size > 10e6)) throw Object.assign(new Error('图片编辑需1～3张原图，每张不超过10MB'), { code: 'IMAGE_EDIT_INPUT', kind: 'input' });
  const { main } = abilityLines(cfg, 'image');
  const lines = main ? [main] : [{ provider: cfg.provider, model: imageModelOf(cfg) }];
  let failure;
  for (const line of lines) {
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { base, headers } = providerEndpoint(cfgForLine(cfg, line), gateway);
      const parameters = imageRequestOptions(line.model, { ...cfg.imageOptions, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) });
      const format = imageEditFormat(line.model, editFormat ?? cfg.imageOptions?.editFormat);
      const request = await imageEditRequest({ model: line.model, prompt: String(imagePrompt).slice(0, 12000), images, parameters, format, headers, signal });
      throwControl(null, signal);
      beforeRequest?.();
      try {
        return await requestImage(base + '/images/edits', request, { fetchImpl, download, signal, model: line.model, parameters, operation: '原图编辑' });
      } catch (error) {
        // 格式失败只留短码，不把原片/data URL或密钥放进诊断；也不自动换协议重提收费操作。
        if (error.code === 'IMAGE_API') {
          error.requestFormat = format;
          const token = headers.Authorization?.replace(/^Bearer\s+/i, '');
          if (token) error.message = error.message.replaceAll(token, '[密钥已隐藏]');
          error.message = error.message.replace(/data:[^\s"')]+/gi, '[图片数据已隐藏]');
          error.message += `；编辑格式：${format === 'json' ? 'JSON原片' : '文件上传'}`;
          if (error.parameter) error.message += `；字段：${error.parameter}`;
        }
        throw error;
      }
    } catch (error) {
      throwControl(error, signal);
      failure = error;
      // 编辑请求结果不明或下载失败均不自动重提，避免重复收费。只使用用户当前画图线路。
      throw error;
    }
  }
  throw failure;
}

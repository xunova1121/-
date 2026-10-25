import { abilityLines, cfgForLine } from './abilities.js';
import { providerEndpoint, imageModelOf } from './images.js';
import { webBody } from '../agent/webBody.js';
import { throwControl } from '../core/networkRequest.js';

/** 编辑必须把真实原图传给/images/edits；接口不支持时明确失败，不退化为凭文字重画。 */
export async function editImage(cfg, { prompt: imagePrompt, images, size = '1024x1024', gateway = null, fetchImpl = globalThis.fetch, download = fetchImpl, signal } = {}) {
  if (!Array.isArray(images) || !images.length || images.length > 3 || images.some(image => !(image instanceof Blob) || image.size > 10e6)) throw Object.assign(new Error('图片编辑需1～3张原图，每张不超过10MB'), { code: 'IMAGE_EDIT_INPUT', kind: 'input' });
  const { main } = abilityLines(cfg, 'image');
  const lines = main ? [main] : [{ provider: cfg.provider, model: imageModelOf(cfg) }];
  let failure;
  for (const line of lines) {
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { base, headers } = providerEndpoint(cfgForLine(cfg, line), gateway);
      const form = new FormData();
      form.append('model', line.model);
      form.append('prompt', String(imagePrompt).slice(0, 12000));
      form.append('size', size);
      form.append('n', '1');
      images.forEach((image, index) => form.append(images.length === 1 ? 'image' : 'image[]', image, `reference-${index + 1}.${/jpeg/.test(image.type) ? 'jpg' : /webp/.test(image.type) ? 'webp' : 'png'}`));
      const response = await fetchImpl(base + '/images/edits', { method: 'POST', headers, body: form, signal });
      const raw = new TextDecoder().decode(await webBody(response, 40000000, signal));
      if (!response.ok) throw Object.assign(new Error('当前画图线路未完成图片编辑（HTTP ' + response.status + '），没有改用文字重画'), { status: response.status, code: 'IMAGE_EDIT_API', kind: 'api' });
      const data = JSON.parse(raw).data?.[0];
      if (data?.b64_json) return { blob: new Blob([Uint8Array.from(atob(data.b64_json), letter => letter.charCodeAt(0))], { type: 'image/png' }), model: line.model };
      if (data?.url) {
        const url = new URL(data.url);
        if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('返回图片地址不是HTTP地址'), { code: 'IMAGE_EDIT_URL', kind: 'api' });
        const result = await download(url.href, { signal, credentials: 'omit', redirect: 'error' });
        if (!result.ok) throw Object.assign(new Error('下载编辑图片失败'), { status: result.status, kind: 'api' });
        const bytes = await webBody(result, 20000000, signal);
        return { blob: new Blob([bytes], { type: result.headers.get('content-type') || 'image/png' }), model: line.model };
      }
      throw Object.assign(new Error('编辑接口没有返回图片'), { code: 'IMAGE_EDIT_EMPTY', kind: 'api' });
    } catch (error) {
      throwControl(error, signal);
      failure = error;
      // 编辑请求结果不明或下载失败均不自动重提，避免重复收费。只使用用户当前画图线路。
      throw error;
    }
  }
  throw failure;
}

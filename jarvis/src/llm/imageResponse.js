import { webBody } from '../agent/webBody.js';
import { imageFormat } from '../agent/imageFormat.js';

/** 一次收费请求及下载共限4分钟；超时只结束等待，不自动再生成。 */
export async function requestImage(url, init, { fetchImpl, download, signal, model, operation = '画图', timeoutMs = 240000 }) {
  const controller = new AbortController();
  let rejectStopped;
  const stopped = new Promise((_, reject) => {
    rejectStopped = reject;
  });
  const abort = () => {
    const error = signal?.aborted
      ? signal.reason || new DOMException('Aborted', 'AbortError')
      : Object.assign(new Error('图片请求超时，生成状态未知；未自动重新提交'), { name: 'TimeoutError', code: 'IMAGE_TIMEOUT', kind: 'timeout' });
    controller.abort(error);
    rejectStopped(error);
  };
  const timer = setTimeout(abort, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) abort();
    const work = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      return readImageResponse(response, { model, download: typeof download === 'function' ? download : fetchImpl, signal: controller.signal, operation });
    });
    return await Promise.race([work, stopped]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** 结果下载不携带服务商凭据；正文与图片分别限40MB/20MB。 */
export async function readImageResponse(response, { model, download, signal, operation = '画图' }) {
  let result;
  const raw = new TextDecoder().decode(await webBody(response, 40000000, signal));
  try {
    result = JSON.parse(raw);
  } catch {
    if (response.ok) throw Object.assign(new Error(operation + '接口未返回有效JSON'), { code: 'IMAGE_RESPONSE', kind: 'api' });
  }
  if (!response.ok)
    throw Object.assign(
      new Error(`${operation}失败（${model}，HTTP ${response.status}）：${String(result?.error?.message || result?.message || '接口拒绝请求').slice(0, 160)}`),
      { status: response.status, code: 'IMAGE_API', kind: 'api', rejected: [400, 401, 403, 404, 429].includes(response.status) }
    );
  const data = result.data?.[0];
  let blob;
  if (data?.b64_json) {
    if (data.b64_json.length > 28000000) throw Object.assign(new Error('图片超过20MB'), { code: 'IMAGE_SIZE', kind: 'api' });
    try {
      blob = new Blob([Uint8Array.from(atob(data.b64_json), (letter) => letter.charCodeAt(0))], {
        type: 'image/' + (result.output_format || data.output_format || 'png')
      });
    } catch {
      throw Object.assign(new Error('图片Base64无效'), { code: 'IMAGE_RESPONSE', kind: 'api' });
    }
  } else if (data?.url) {
    const url = new URL(data.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw Object.assign(new Error('图片地址无效'), { code: 'IMAGE_URL', kind: 'api' });
    const fetched = await download(url.href, { signal, credentials: 'omit', redirect: 'error' });
    if (!fetched.ok) throw Object.assign(new Error('下载生成图片失败'), { status: fetched.status, code: 'IMAGE_DOWNLOAD', kind: 'api' });
    blob = new Blob([await webBody(fetched, 20000000, signal)], { type: fetched.headers.get('content-type') || 'image/png' });
  } else throw Object.assign(new Error('服务商没有返回图片（' + model + '）'), { code: 'IMAGE_EMPTY', kind: 'api' });
  const format = await imageFormat(blob);
  if (format?.ext === 'svg' || /^text\/|application\/json/.test(blob.type))
    throw Object.assign(new Error('画图接口返回了文本或SVG，不能冒充位图'), { code: 'IMAGE_RESPONSE_FORMAT', kind: 'api' });
  if (format) blob = new Blob([blob], { type: format.mime });
  return { blob, model, revised: data.revised_prompt };
}

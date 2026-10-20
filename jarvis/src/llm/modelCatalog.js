/** 拉取模型不调用生成接口；超时/鉴权失败明确报错，不把内置建议伪装成拉取成功。 */
import { providerById, upstreamFor, customViaGateway } from '../../shared/providers.js';
import { boundedIds } from './modelLibrary.js';

export async function fetchModelCatalog(cfg, { gateway = null, signal, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('已停止拉取'), { name: 'AbortError' });
  const provider = providerById(cfg.provider);
  if (!provider || provider.kind === 'mock') throw Object.assign(new Error('请先配置真实服务商'), { code: 'INVALID_PROVIDER', kind: 'api' });
  const key = cfg.keys?.[provider.id] || '';
  const customBase = cfg.baseURLs?.[provider.id]?.trim();
  const root = provider.custom ? customBase : provider.baseURL;
  if (!root) throw Object.assign(new Error('请先保存接口地址'), { code: 'MISSING_BASE_URL', kind: 'api' });
  const useGateway = gateway && (upstreamFor(provider.id) || provider.custom && customViaGateway(gateway, root));
  let base = useGateway ? `${gateway.origin}/api/llm/${provider.id}` : root.replace(/\/+$/, '');
  const headers = {};
  if (provider.kind === 'multi' || provider.kind === 'anthropic') base = `${base.replace(/\/v1$/, '')}/v1`;
  if (key || useGateway) headers.Authorization = `Bearer ${key || 'use-gateway-key'}`;
  if (provider.kind === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  }
  if (useGateway && provider.custom) headers['x-jarvis-upstream'] = root.replace(/\/+$/, '').replace(/\/v1$/, '');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 10000);
  try {
    const response = await fetchImpl(`${base}/models`, { headers, signal: controller.signal });
    if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403 ? '服务商鉴权失败，请检查该位置的密钥' : `模型列表接口返回 ${response.status}`), { status: response.status, kind: 'api', code: 'CATALOG_API' });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2 * 1024 * 1024) throw Object.assign(new Error('模型列表超过2MB，请缩小服务商返回范围'), { kind: 'api', code: 'CATALOG_SIZE' });
        body += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let result;
    try { result = JSON.parse(body + decoder.decode()); }
    catch { throw Object.assign(new Error('服务商没有返回有效模型列表'), { kind: 'api', code: 'CATALOG_FORMAT' }); }
    const entries = result.data ?? result.models;
    if (!Array.isArray(entries)) throw Object.assign(new Error('服务商不支持模型列表，请手动添加型号'), { kind: 'api', code: 'CATALOG_UNSUPPORTED' });
    return { ids: boundedIds(entries.map((item) => typeof item === 'string' ? item : item?.id ?? item?.name)), at: Date.now() };
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('已停止拉取'), { name: 'AbortError' });
    if (timedOut) throw Object.assign(new Error('拉取模型超时，可稍后重试或手动添加'), { name: 'TimeoutError', kind: 'timeout', code: 'CATALOG_TIMEOUT' });
    if (error instanceof TypeError) throw Object.assign(new Error('无法连接模型列表接口，请检查网络和地址'), { name: 'NetworkError', kind: 'network', code: 'CATALOG_NETWORK' });
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

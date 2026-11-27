import { PROVIDERS, providerById } from '../../shared/providers.js';

// Symbol不进JSON：客户端不能伪造Key来源，也不会随配置写回磁盘。
export const CREDENTIAL_CONTEXT = Symbol('server model credentials');
export function usableModelKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return !key || key.startsWith('••••') || key === 'use-gateway-key' ? '' : key;
}
export const keySuffix = key => key.length > 4 ? key.slice(-4).replace(/[^\w-]/g, '?') : key ? '已隐藏' : '无';
export function credentialInfo(cfg) {
  const p = providerById(cfg.provider);
  let provider = `${p?.name || '未知服务商'}（${p?.id || 'unknown'}）`;
  // 自定义线路仍使用自己的Key，不能把另一条OpenRouter配置的Key偷换进来。
  try { if (p?.custom && new URL(cfg.baseURLs?.[p.id]).origin === 'https://openrouter.ai') provider += ' / OpenRouter'; } catch { /* 无效地址由原校验处理。 */ }
  const key = usableModelKey(cfg.keys?.[p?.id]);
  const source = cfg[CREDENTIAL_CONTEXT]?.[p?.id] || (key ? '本机模型设置' : '没有 Key');
  return { provider, source, suffix: keySuffix(key) };
}
export function credentialText(info) {
  return `服务商：${info.provider}；Key 来源：${info.source}；Key 末4位：${info.suffix}`;
}

/** 服务器任务经SSE只传错误文字；重建白名单说明，避免UI再次缩成泛泛的401。 */
export function credentialErrorText(error) {
  const msg = String(error?.message ?? error ?? '');
  const match = msg.match(/^(API Key密钥或权限校验失败|服务商限制此模型在当前地区使用)（(401|403)）；服务商：(.+?)；Key 来源：(云服务器设置|本机模型设置|环境变量 OPENROUTER_API_KEY|没有 Key)；Key 末4位：(无|已隐藏|[\w?-]{4})$/);
  if (!match) return '';
  const allowed = PROVIDERS.some(p => [ `${p.name}（${p.id}）`, `${p.name}（${p.id}） / OpenRouter` ].includes(match[3]));
  return allowed ? msg : '';
}

/** 鉴权错误只留受控说明，不把上游原文（可能含密钥）带入任务、日志或聊天。 */
export function withCredentialErrors(adapter, info) {
  return { ...adapter, async stream(input) {
    try { return await adapter.stream(input); }
    catch (error) {
      if (![401, 403].includes(Number(error?.status))) throw error;
      const region = /model_region_restricted/.test(String(error?.message || ''));
      const message = `${region ? '服务商限制此模型在当前地区使用' : 'API Key密钥或权限校验失败'}（${error.status}）；${credentialText(info)}`;
      throw Object.assign(new Error(message), { status: Number(error.status), kind: 'api', code: region ? 'MODEL_REGION_RESTRICTED' : 'MODEL_AUTH', credential: info });
    }
  } };
}

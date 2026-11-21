import { STOCK_PROVIDERS } from './stockImageSources.js';
import { errorKind } from '../core/suggest.js';
const phases = new Set(['configuration', 'api', 'image', 'vision', 'query', 'download_tracking']);
const messages = {
  STOCK_NOT_CONFIGURED: '云服务器没有已配置且检测通过的可用图库，请在设置中保存Key并检测',
  STOCK_VISION_FAILED: '看图模型请求失败，请检查云服务器的看图线路',
  STOCK_VISION_REJECTED: '看图模型没有选出适合的图片，未盲用候选图',
  STOCK_KEY_MISSING: '云服务器尚未保存这家图库的Key',
  STOCK_NOT_VERIFIED: 'Key已保存，但尚未通过云服务器中的连接检测；请先检测图库',
  STOCK_COOLING: '图库最近连续请求失败，暂处于冷却期；可在设置中重新检测',
  STOCK_AUTH: '图库API拒绝了此Key，请核对云服务器保存的Key',
  STOCK_FORBIDDEN: '访问被服务商或网络拒绝；仅凭403不能判断Key无效',
  STOCK_LOCAL_RATE: '本机每小时20次图库请求保护已触发，请稍后再试',
  STOCK_RATE: '请求频率或额度受到限制，请稍后再试',
  STOCK_HTTP: '服务商返回请求错误',
  STOCK_RESPONSE: 'API未返回合法JSON，可能返回了网页或拦截页',
  STOCK_DNS: '域名解析失败，请检查服务器网络',
  STOCK_TLS: 'TLS证书校验失败，请检查服务器网络与证书',
  STOCK_TIMEOUT: '请求超时，请检查服务器到图库的连接',
  STOCK_NETWORK: '连接失败，请检查服务器网络',
  STOCK_EMPTY: 'API没有返回许可完整且可下载的候选图片',
  STOCK_SIZE: '返回内容超过大小上限',
  STOCK_IMAGE_FORMAT: '下载的内容不是支持的PNG/JPEG，或图片尺寸超过上限',
  STOCK_DOMAIN: '图片地址不在受信图库域名内',
  STOCK_LICENSE: '下载回报地址或许可信息不完整',
  STOCK_VISION_MISSING: '云服务器没有可用的看图模型，不能完成图库图片筛选；请配置看图线路',
  STOCK_QUERY: '当前检索词未匹配支持的通用场景，请换成办公、球场、城市等场景',
  STOCK_TOPIC: '不使用图库照片冒充具体人物或真实新闻、赛事现场'
};
/** 只输出受控字段；不回显第三方响应、请求URL或可能夹带Key的异常原文。 */
export function stockDiagnostic(error = {}, context = {}) {
  const provider = STOCK_PROVIDERS.includes(error.provider) ? error.provider : STOCK_PROVIDERS.includes(context.provider) ? context.provider : null;
  const phase = phases.has(error.phase) ? error.phase : phases.has(context.phase) ? context.phase : 'api';
  const original = typeof error.code === 'string' ? error.code : typeof error.cause?.code === 'string' ? error.cause.code : '';
  const kind = errorKind(error);
  const code = Object.hasOwn(messages, original)
    ? original
    : /^(ENOTFOUND|EAI_AGAIN)$/.test(original || '')
      ? 'STOCK_DNS'
      : /^(CERT_|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED)/.test(original || '')
        ? 'STOCK_TLS'
        : kind === 'timeout'
          ? 'STOCK_TIMEOUT'
          : error instanceof SyntaxError
            ? 'STOCK_RESPONSE'
            : 'STOCK_NETWORK';
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : null;
  return {
    code,
    phase,
    ...(provider && { provider }),
    ...(status && { upstreamStatus: status }),
    note: `${provider || '图库'} ${phase === 'image' ? '图片下载' : phase === 'api' ? 'API' : ''}${status ? `（HTTP ${status}）` : ''}：${messages[code]}`
  };
}
export function stockError(error, context = {}) {
  const diagnostic = stockDiagnostic(error, context);
  return Object.assign(new Error(diagnostic.note), diagnostic, {
    kind:
      diagnostic.code === 'STOCK_TIMEOUT'
        ? 'timeout'
        : diagnostic.code === 'STOCK_NETWORK' || diagnostic.code === 'STOCK_DNS' || diagnostic.code === 'STOCK_TLS'
          ? 'network'
          : 'api',
    ...(diagnostic.upstreamStatus && { status: diagnostic.upstreamStatus })
  });
}
/** 非2xx响应最多读取4KB用于识别服务商明确的无效Key标志；原文始终不返回。 */
export async function stockHttpError(response, context) {
  let invalidKey = false;
  if (context.phase === 'api' && response.status === 400 && response.body) {
    const reader = response.body.getReader();
    let text = '',
      length = 0;
    try {
      while (length < 4096) {
        const r = await reader.read();
        if (r.done) break;
        const part = r.value.subarray(0, 4096 - length);
        length += part.length;
        text += new TextDecoder().decode(part);
      }
      invalidKey = /invalid\s+(?:api\s*)?key|api\s*key[^\n]{0,30}(?:invalid|not valid)/i.test(text);
    } catch (error) {
      if (error?.code === 'RETRIEVAL_BUDGET') throw error;
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const status = response.status,
    code =
      invalidKey || (context.phase === 'api' && status === 401)
        ? 'STOCK_AUTH'
        : status === 403
          ? 'STOCK_FORBIDDEN'
          : status === 429
            ? 'STOCK_RATE'
            : 'STOCK_HTTP';
  return stockError({ code, status }, context);
}

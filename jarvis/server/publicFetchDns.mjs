import { isIP } from 'node:net';
import { isPrivateHost } from '../shared/providers.js';
import { throwControl } from '../src/core/networkRequest.js';

const blocked = () => Object.assign(new Error('只允许访问公网 http(s) 地址'), {
  code: 'PRIVATE_NETWORK_BLOCKED', kind: 'api', status: 403
});
const dnsFailure = (code, message) => Object.assign(new Error(message), {
  name: 'NetworkError', kind: 'network', code
});

function privateTarget(host) {
  const address = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (isPrivateHost(address)) return true;
  if (isIP(address) !== 6) return false;
  // 同一 IPv6 有多种写法；mapped IPv4 也须按实际 IPv4 地址检查。
  const compact = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  if (compact === '::' || isPrivateHost(compact)) return true;
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(compact);
  if (!mapped) return false;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return isPrivateHost([high >>> 8, high & 255, low >>> 8, low & 255].join('.'));
}

async function resolveWithinSignal(host, lookup, signal) {
  let abort;
  const cancelled = new Promise((resolve, reject) => {
    abort = () => reject(signal.reason ?? Object.assign(new Error('已停止'), { name: 'AbortError' }));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const pending = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return lookup(host);
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** 解析失败不代表命中私网；失败时仍禁止直接出站，并让调用方按网络错误换源。 */
export async function assertPublicDns(url, lookup, signal) {
  signal.throwIfAborted();
  if (!/^https?:$/.test(url.protocol) || privateTarget(url.hostname)) throw blocked();
  let addresses;
  try {
    addresses = await resolveWithinSignal(url.hostname.replace(/^\[|\]$/g, ''), lookup, signal);
  } catch (error) {
    throwControl(error, signal);
    // 仅保留短错误码，不回显 resolver 原文里的地址、查询参数或凭据。
    const code = typeof error?.code === 'string' && /^E[A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'DNS_LOOKUP_FAILED';
    throw dnsFailure(code, '域名解析失败，未连接到目标网站；可稍后重试或换用其他来源');
  }
  signal.throwIfAborted();
  if (addresses == null || Array.isArray(addresses) && !addresses.length)
    throw dnsFailure('DNS_NO_RESULTS', '域名解析未返回可用地址，未连接到目标网站');
  if (!Array.isArray(addresses))
    throw dnsFailure('DNS_INVALID_RESULT', '域名解析返回格式异常，未连接到目标网站');
  // 混合结果只要包含私网就整体拒绝，不能挑一个公网地址后放行原域名。
  if (addresses.some(entry => typeof entry?.address === 'string' && privateTarget(entry.address))) throw blocked();
  if (addresses.some(entry => !isIP(entry?.address)))
    throw dnsFailure('DNS_INVALID_RESULT', '域名解析返回无效地址，未连接到目标网站');
}

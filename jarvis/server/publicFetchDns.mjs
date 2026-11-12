import { isIP } from 'node:net';
import { isPrivateHost } from '../shared/providers.js';
import { throwControl } from '../src/core/networkRequest.js';

const blocked = () => Object.assign(new Error('只允许访问公网 http(s) 地址'), {
  code: 'PRIVATE_NETWORK_BLOCKED', kind: 'api', status: 403
});
const dnsFailure = (code, message) => Object.assign(new Error(message), {
  name: 'NetworkError', kind: 'network', code
});

/**
 * 服务器联网专用的补充范围（2026-11-12 复审）：共享的 isPrivateHost 之外，再拦运营商级NAT、保留/组播地址，
 * 以及把 IPv4 藏在 IPv6 里的几种写法。只用于服务器替模型抓网页，不改其他地方（如 Tailscale 自建模型地址）的行为。
 */
const EXTRA_V4 = [/^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^192\.0\.0\./, /^198\.1[89]\./, /^(22[4-9]|2[3-5]\d)\./];
const privateV4 = address => isPrivateHost(address) || EXTRA_V4.some(pattern => pattern.test(address));
const v4From = (high, low) => [high >>> 8, high & 255, low >>> 8, low & 255].join('.');

/** 把压缩写法的 IPv6 展开成 8 组数字；格式不对返回 null */
function ipv6Groups(compact) {
  const [head, tail = null] = compact.split('::');
  const part = value => (value ? value.split(':') : []);
  const groups = tail === null ? part(head) : [...part(head), ...Array(8 - part(head).length - part(tail).length).fill('0'), ...part(tail)];
  if (groups.length !== 8 || groups.some(group => !/^[\da-f]{1,4}$/.test(group))) return null;
  return groups.map(group => parseInt(group, 16));
}

function privateTarget(host) {
  const address = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(address) === 4) return privateV4(address);
  if (isPrivateHost(address)) return true;
  if (isIP(address) !== 6) return false;
  // 同一 IPv6 有多种写法；先规范成URL里的压缩写法，再按实际含义检查。
  const compact = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  if (compact === '::' || isPrivateHost(compact)) return true;
  const g = ipv6Groups(compact);
  if (!g) return true; // 认不出的写法按不安全处理
  if (g[0] >= 0xfec0 && g[0] <= 0xfeff || g[0] >= 0xff00) return true; // 旧站点本地、组播
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo 隧道：真实地址被编码，无法可靠检查
  const zeros = n => g.slice(0, n).every(value => value === 0);
  // IPv4 映射(::ffff:a.b.c.d)、IPv4 兼容(::a.b.c.d)、NAT64(64:ff9b::a.b.c.d)：按里面真正的 IPv4 检查
  if (zeros(5) && (g[5] === 0xffff || g[5] === 0) || g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(value => value === 0)) return privateV4(v4From(g[6], g[7]));
  if (g[0] === 0x2002) return privateV4(v4From(g[1], g[2])); // 6to4：第2、3组是 IPv4
  return false;
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

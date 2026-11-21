import { createPublicReadCache } from './publicReadCache.js';

/** 跨轮次仅保留公开正文和来源耗时；账号、连接与完整配置摘要共同分区。 */
export function createLookupRuntime({ now = Date.now } = {}) {
  const scopes = new Map();
  return async (scope, config) => {
    // 非安全HTTP上下文可能没有WebCrypto，此时只用单轮缓存，不能让优化阻断正常对话。
    if (!globalThis.crypto?.subtle) return {};
    const bytes = new TextEncoder().encode(JSON.stringify(config));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const policy = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    let runtime = scopes.get(scope);
    if (!runtime || runtime.policy !== policy || now() - runtime.at > 30 * 60_000 || now() < runtime.at) {
      runtime = { policy, at: now(), publicReadCache: createPublicReadCache({ now, maxRows: 24, maxChars: 64_000 }), searchTimings: new Map() };
    }
    scopes.delete(scope);
    while (scopes.size >= 16) scopes.delete(scopes.keys().next().value);
    scopes.set(scope, runtime);
    return runtime;
  };
}

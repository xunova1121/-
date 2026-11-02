/** 服务端异步评测上下文：不切换全局后端，不让并行普通任务落入评测空间。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { createFileStore } from './fileStore.mjs';
import { requestUsesNativeSearch } from '../src/llm/nativeSearch.js';

const context = new AsyncLocalStorage();
export function chargeEvaluation(kind) {
  const current = context.getStore();
  if (current) return current.security.consume(current.id, kind);
}

/** 画图/视频/OCR的提交按实际POST计数，状态轮询和结果下载不冒充模型调用。 */
export function evaluationModelFetch(url, init) {
  if (init?.signal?.aborted) throw init.signal.reason ?? Object.assign(new Error('已停止'), { name: 'AbortError' });
  if (String(init?.method || 'GET').toUpperCase() === 'POST') chargeEvaluation('model');
  return globalThis.fetch(url, init);
}

/** 每一次实际搜索HTTP（包括同词换源及重试）在网络请求前计数。 */
export function chargeSearchRequest(address) {
  const url = new URL(address);
  const host = url.hostname;
  if ((/^(?:(?:cn|www)\.)?bing\.com$/.test(host) && url.pathname === '/search') ||
      (host === 'www.baidu.com' && url.pathname === '/s') ||
      (host === 'www.so.com' && url.pathname === '/s') ||
      host === 'html.duckduckgo.com' || (host === 'api.bochaai.com' && url.pathname === '/v1/web-search') || (host === 'api.tavily.com' && url.pathname === '/search') ||
      (host === 'api.deepseek.com' && url.pathname.endsWith('/tools/search')) ||
      (host === 'qianfan.baidubce.com' && url.pathname.endsWith('/ai_search/web_search'))) chargeEvaluation('search');
}

export function evaluationAdapter(adapter) {
  if (!adapter) return adapter;
  return {
    ...adapter,
    async stream(options) {
      if (options.signal?.aborted) throw options.signal.reason ?? Object.assign(new Error('已停止'), { name: 'AbortError' });
      const current = context.getStore();
      if (!current) return adapter.stream(options);
      const reservations = [];
      let actualSearches = 0, successful = false;
      const native = requestUsesNativeSearch(adapter, options);
      const reserve = () => {
        if (reservations.length && current.security.remaining(current.id) < 1 + maximum) throw Object.assign(new Error('评测令牌今日模型与搜索调用次数已达上限'), { status: 429, code: 'EVAL_QUOTA', kind: 'api' });
        current.security.consume(current.id, 'model');
        if (!native) return 0;
        const count = reservations.length ? maximum : Math.min(20, Math.max(0, Math.floor(options.maxWebSearches || 0)), current.security.remaining(current.id));
        if (count) reservations.push(current.security.consume(current.id, 'search', count));
        return count;
      };
      let maximum = reserve();
      try {
        const result = await adapter.stream({
          ...options,
          ...(native && { maxWebSearches: maximum, allowWebSearch: maximum > 0 }),
          onRetry: event => { maximum = reserve(); options.onRetry?.(event); },
          onText: (delta, metadata) => {
            if (/search/.test(metadata?.serverTool || '')) actualSearches++;
            options.onText?.(delta, metadata);
          }
        });
        successful = true;
        return result;
      } finally {
        // 完整响应才按真实事件释放未用额度；中断/重启后不猜服务商是否已经搜索。
        if (successful) for (const receipt of reservations) {
          const used = Math.min(receipt.quantity, actualSearches);
          current.security.settleReservation(receipt, used);
          actualSearches -= used;
        }
      }
    }
  };
}

export function createEvaluationAccess({ store, dataDir, security }) {
  const stores = new Map(); // 最多32份热缓存，淘汰不删除私有评测结果。
  const selected = name => {
    const current = context.getStore();
    if (!current || name === 'sessions' || name === 'packs') return store;
    if (!stores.has(current.scope)) {
      if (stores.size >= 32) stores.delete(stores.keys().next().value);
      stores.set(current.scope, createFileStore(path.join(dataDir, 'evaluations', current.scope, 'store')));
    }
    return stores.get(current.scope);
  };
  const scopedStore = {
    dir: store.dir,
    scoped: name => selected(name),
    async all(name) {
      const rows = await selected(name).all(name);
      return context.getStore() && name === 'packs' ? rows.filter(row => row.builtin === true) : rows;
    },
    async get(name, id) {
      const row = await selected(name).get(name, id);
      return context.getStore() && name === 'packs' && !row?.builtin ? undefined : row;
    },
    async put(name, row) {
      if (context.getStore() && name === 'packs') throw Object.assign(new Error('评测不能修改技能'), { status: 403 });
      return selected(name).put(name, row);
    },
    async delete(name, id) {
      if (context.getStore() && name === 'packs') throw Object.assign(new Error('评测不能删除技能'), { status: 403 });
      return selected(name).delete(name, id);
    },
    async clear(name) {
      if (context.getStore() && ['sessions', 'packs'].includes(name)) throw Object.assign(new Error('评测不能清空用户数据'), { status: 403 });
      return selected(name).clear(name);
    }
  };
  return {
    store: scopedStore,
    run: (task, work) => task.evaluationAuthorization ? context.run({ id: task.evaluationAuthorization.id, scope: task.evaluationId, security }, work) : context.run(null, work)
  };
}

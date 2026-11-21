/** 企业直查只走当前运行位置，不切回另一台机器或借用聊天密钥。 */
import { runCompanyLookup } from '../agent/companyQuery.js';
import { createOpenaiSearchFetch } from '../core/openaiSearchGateway.js';
import { userStorageSuffix } from '../core/userStorage.js';
import { nativeWebFetch } from '../mobile/nativeFetch.js';

export function createCompanyLookup(
  app,
  {
    scope = userStorageSuffix,
    query = runCompanyLookup,
    searchFetch = createOpenaiSearchFetch,
    nativeTransport = () => (globalThis.__jarvisNativeFetch ? nativeWebFetch(globalThis.__jarvisNativeFetch) : null)
  } = {}
) {
  return async (args, signal) => {
    signal?.throwIfAborted();
    const session = app.session;
    const server = app.server;
    const identity = scope();
    const current = () => {
      signal?.throwIfAborted();
      if (session !== app.session || server !== app.server || identity !== scope()) {
        throw Object.assign(new Error('账号、会话或运行位置已变化，请重新查询'), {
          name: 'AbortError',
          code: 'COMPANY_SCOPE_CHANGED'
        });
      }
    };
    current();
    let result;
    if (server) {
      if (!server.companyQuery) throw Object.assign(new Error('请更新客户端和云服务器后再查询企业'), { code: 'COMPANY_UPDATE_REQUIRED' });
      try {
        result = await server.companyQuery(args, signal);
      } catch (error) {
        current();
        if (error.status === 404) throw Object.assign(new Error('云服务器尚未支持企业直接查询，请先更新服务器'), { code: 'COMPANY_UPDATE_REQUIRED' });
        throw error;
      }
    } else {
      const native = nativeTransport();
      if (args.source === 'qibook' && app.gateway && !native) {
        throw Object.assign(new Error('本机网页网关不能携带企百科凭据，请在云服务器模式查询企百科'), {
          code: 'COMPANY_GATEWAY_UNSUPPORTED'
        });
      }
      result = await query(app.llmConfig || {}, args, {
        get: args.source === 'qibook' && native ? native : app.fetchViaGateway?.() || native || ((...params) => fetch(...params)),
        openaiSearchFetch: searchFetch(app),
        signal
      });
    }
    current();
    return result;
  };
}

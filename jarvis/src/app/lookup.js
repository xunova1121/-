import { createLookupService } from '../agent/lookup/service.js';

/** 本机工具和模型中心共用实例；运行位置切换时不把本机健康记录当成云服务器记录。 */
export function localLookup(app) {
  app.lookupService ||= createLookupService({
    get: (url, options) => {
      const read = app.fetchViaGateway?.();
      if (!read) throw Object.assign(new Error('当前没有可用的本机网页读取通道'), { code: 'LOOKUP_GATEWAY_MISSING' });
      return read(url, options);
    }
  });
  return app.lookupService;
}

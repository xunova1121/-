/** 只允许已登录用户主动检查固定来源；不接受地址/密钥，不提供模型工具入口。 */
export function createLookupRoutes({ service, getConfig, json }) {
  return async (req, res) => {
    const region = getConfig().lookupRegion || 'auto';
    if (req.method === 'GET') { json(res, 200, await service.status(region)); return true; }
    if (req.method !== 'POST') { json(res, 405, { error: '只支持读取状态或主动检查来源' }); return true; }
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try { json(res, 200, await service.probe(region, { signal: controller.signal })); }
    catch (error) {
      if (controller.signal.aborted) return true;
      json(res, error.code === 'LOOKUP_BUSY' ? 429 : 502, { error: error.message, code: error.code });
    } finally { res.off('close', cancel); }
    return true;
  };
}

/** 只处理已鉴权请求；身份来自服务端上下文，客户端不能指定订阅归属。 */
export function createTenderRoutes({ center, readJson, json }) {
  return async (req, res, pathname, url, principal) => {
    if (!pathname.startsWith('/api/tenders/')) return false;
    if (!['owner', 'member'].includes(principal.role)) { json(res, 403, { error: '此授权不能访问公告订阅' }); return true; }
    try {
      const route = pathname.slice('/api/tenders/'.length);
      if (route === 'catalog' && req.method === 'GET') {
        json(res, 200, { ...await center.list(Object.fromEntries(url.searchParams)), canManage: principal.role === 'owner' });
      } else if (route === 'mine' && req.method === 'GET') {
        json(res, 200, await center.mine());
      } else if (route === 'mine' && req.method === 'PATCH') {
        const body = await readJson(req, 8192);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('订阅参数无效'), { status: 400 });
        json(res, 200, await center.change(body));
      } else if (route === 'settings' && req.method === 'PATCH' && principal.role === 'owner') {
        const body = await readJson(req, 1024);
        if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('请指定是否自动更新'), { status: 400 });
        json(res, 200, await center.configure(body.enabled));
      } else if (route === 'refresh' && req.method === 'POST' && principal.role === 'owner') {
        const state = await center.list();
        if (!state.running && state.lastAttempt && Date.now() - state.lastAttempt < 60000) {
          json(res, 429, { error: '刚刚更新过，请一分钟后再试' });
        } else {
          center.refresh().catch(() => {}); // 周期有总超时；页面轮询读取状态，不挂住手机连接。
          json(res, 202, { ok: true });
        }
      } else json(res, 405, { error: '不支持此操作' });
    } catch (error) {
      json(res, error.status || 500, { error: error.status ? error.message : '公告数据暂时读取失败，请稍后重试' });
    }
    return true;
  };
}

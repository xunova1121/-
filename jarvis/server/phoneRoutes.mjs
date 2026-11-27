/** 注册/列表/移除用原账号鉴权；传输接口只认可限时、单设备凭据，不能访问任何其他API。 */
export function createPhoneRoutes({ broker, readJson, json, principal = () => null }) {
  return async (req, res, pathname) => {
    if (!pathname.startsWith('/api/phone/')) return false;
    try {
      if (pathname === '/api/phone/transport' && req.method === 'POST') {
        const body = await readJson(req, 1_100_000);
        json(res, 200, broker.transport(body.deviceId, String(req.headers.authorization || '').replace(/^Bearer /, ''), body)); return true;
      }
      if (pathname === '/api/phone/devices' && req.method === 'GET') { json(res, 200, broker.list()); return true; }
      if (pathname === '/api/phone/devices' && req.method === 'POST') { json(res, 200, broker.register(await readJson(req, 2048), principal(req)?.id)); return true; }
      const m = pathname.match(/^\/api\/phone\/devices\/([a-f0-9-]{36})$/);
      if (m && req.method === 'DELETE') { json(res, 200, broker.disconnect(m[1])); return true; }
      json(res, 404, { error: '手机接口不存在' });
    } catch (e) { json(res, e.status || 500, { error: e.code ? e.message : '手机控制请求未完成', code: e.code || 'PHONE_FAILED' }); }
    return true;
  };
}

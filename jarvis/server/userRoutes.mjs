/** 普通成员允许的接口；未知接口默认拒绝，避免新增管理接口绕过隔离。 */
export function memberRoute(method, pathname) {
  if (pathname === '/api/phone/devices') return ['GET', 'POST'].includes(method);
  if (/^\/api\/phone\/devices\/[a-f0-9-]{36}$/.test(pathname)) return method === 'DELETE';
  if (pathname === '/api/studio/preferences') return ['GET', 'PATCH'].includes(method);
  if (['/api/studio/works', '/api/studio/versions'].includes(pathname)) return method === 'GET';
  if (['/api/studio/copy', '/api/studio/edit', '/api/studio/inspect', '/api/studio/preview'].includes(pathname)) return method === 'POST';
  if (pathname === '/api/studio/team') return ['GET', 'POST'].includes(method);
  if (/^\/api\/studio\/team\/[a-f0-9-]{36}$/.test(pathname)) return method === 'DELETE';
  if (/^\/api\/studio\/team\/[a-f0-9-]{36}\/copy$/.test(pathname)) return method === 'POST';
  if (pathname === '/api/server/readiness') return ['GET', 'POST'].includes(method);
  if (pathname === '/api/agent-profiles') return ['GET', 'POST'].includes(method);
  if (/^\/api\/agent-profiles\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(pathname)) return ['GET', 'PUT', 'DELETE'].includes(method);
  if (pathname === '/api/server/config') return method === 'GET';
  if (pathname === '/api/server/security') return method === 'GET';
  if (/^\/api\/server\/security\/devices\/[\w-]+$/.test(pathname)) return method === 'DELETE';
  if (pathname === '/api/server/security/tickets') return method === 'POST';
  if (/^\/api\/(tasks|sessions|files|work-records)(\/|$)/.test(pathname)) return true;
  if (/^\/api\/server\/(schedules|document-styles|code-projects)(\/|$)/.test(pathname)) return true;
  if (['/api/server/status', '/api/server/notices', '/api/server/memory-status', '/api/server/skills', '/api/server/readiness', '/api/server/lookup-health'].includes(pathname)) return method === 'GET';
  if (['/api/server/pc-model', '/api/server/models'].includes(pathname)) return method === 'POST';
  return (/^\/api\/weather(?:\/|$)/.test(pathname) || ['/api/sports/scores', '/api/voice/qwen/voices'].includes(pathname)) && method === 'GET';
}

/** 成员只看可用模型与展示参数，不下发管理员密钥、地址、仓库账户或个人配置。 */
export function memberModelConfig(config) {
  const textMap = value => Object.fromEntries(Object.entries(value || {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v.slice(0, 200)]));
  const line = value => value && typeof value.provider === 'string' && typeof value.model === 'string' ? { provider: value.provider, model: value.model } : null;
  // 不透传完整嵌套对象：旧配置可能在型号缓存键中带地址，或在扩展字段中存凭据。
  return {
    provider: config.provider, models: textMap(config.models), providerNames: textMap(config.providerNames),
    abilities: Object.fromEntries(Object.entries(config.abilities || {}).map(([name, value]) => [name, { main: line(value?.main), backup: line(value?.backup) }])),
    routing: { enabled: config.routing?.enabled === true, provider: config.routing?.provider, routes: textMap(config.routing?.routes) },
    customProviders: (Array.isArray(config.customProviders) ? config.customProviders : []).map(({ id, name, kind }) => ({ id, name, kind })),
    keys: {}, readOnly: true, sharedModels: true
  };
}

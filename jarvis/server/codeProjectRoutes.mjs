/** serverMode鉴权后进入；每个写请求明确绑定会话、请求编号与确认内容。 */
export function codeProjectRoutes({ projects, readJson, json }) {
  return async (req, res, pathname, url) => {
    if (!pathname.startsWith('/api/server/code-projects')) return false;
    try {
      const session = url.searchParams.get('session') || '';
      if (pathname === '/api/server/code-projects' && req.method === 'GET') {
        json(res, 200, await projects.list(session));
        return true;
      }
      if (req.method !== 'POST' && req.method !== 'PUT') {
        json(res, 405, { error: '不支持的项目操作' });
        return true;
      }
      const body = await readJson(req, 8192),
        sid = String(body.sessionId || '');
      if (pathname === '/api/server/code-projects/account' && req.method === 'PUT') json(res, 200, await projects.saveAccount(body));
      else if (pathname === '/api/server/code-projects/prepare') json(res, 200, await projects.prepare(body, sid));
      else if (pathname === '/api/server/code-projects/connect') json(res, 200, await projects.connect(body, sid));
      else if (pathname === '/api/server/code-projects/bind') json(res, 200, await projects.bind(body.projectId, sid));
      else if (pathname === '/api/server/code-projects/workspace') json(res, 200, await projects.selectWorkspace(body.workspace_id, sid));
      else if (pathname === '/api/server/code-projects/save') json(res, 200, await projects.prepareSave(body, sid));
      else if (pathname === '/api/server/code-projects/confirm') {
        if (body.confirm !== true) {
          json(res, 400, { error: '需要确认具体项目操作', code: 'CODE_NOT_APPROVED' });
          return true;
        }
        json(res, 200, await projects.execute(body.requestId, sid));
      } else if (pathname === '/api/server/code-projects/preview') {
        const repos = await projects.reposFor(sid);
        json(res, 200, await repos.preview(body.workspace_id, sid, body.entry || 'index.html'));
      } else json(res, 404, { error: '项目接口不存在' });
    } catch (e) {
      json(res, 400, {
        code: /^CODE_[A-Z_]+$/.test(e.code || '') ? e.code : 'CODE_PROJECT_FAILED',
        error: /^CODE_[A-Z_]+$/.test(e.code || '') ? e.message : '项目操作未完成，请检查服务器',
        ...(e.upstreamStatus && { upstreamStatus: e.upstreamStatus })
      });
    }
    return true;
  };
}

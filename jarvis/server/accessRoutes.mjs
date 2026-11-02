/** 路由权限在任务读取之前核对，评测凭证不走主人管理接口。 */
import fs from 'node:fs';
import path from 'node:path';

export function createAccessRoutes({ security, runner, sessions, readJson, json, getConfig, appDir }) {
  const owned = (principal, row) => Boolean(row?.evaluationId?.startsWith(principal.scopePrefix));
  async function access(req) {
    const principal = security.authenticate(req);
    if (!principal) return { status: 401 };
    if (principal.role === 'owner') return { status: 200, principal };
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/api/tasks' && ['GET', 'POST'].includes(req.method)) return { status: 200, principal };
    if (pathname === '/api/sessions' && req.method === 'GET') return { status: 200, principal };
    const task = pathname.match(/^\/api\/tasks\/([\w-]+)(\/events|\/notes|\/stop)?$/);
    if (task && ((req.method === 'GET' && (!task[2] || task[2] === '/events')) || (req.method === 'POST' && ['/notes', '/stop'].includes(task[2]))) && owned(principal, runner.get(task[1]))) return { status: 200, principal };
    const session = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
    if (session && req.method === 'GET' && owned(principal, await sessions.get(session[1]))) return { status: 200, principal };
    return { status: 403, principal };
  }
  return {
    access,
    owned,
    async handle(req, res, pathname) {
      const principal = security.authenticate(req);
      // 仍属于“读自己的任务”：只给评测协议及真实运行型号，不开放设置或全局任务正文。
      if (pathname === '/api/tasks' && req.method === 'GET' && new URL(req.url, 'http://x').searchParams.get('evaluation') === 'info') {
        if (principal.role !== 'evaluation') { json(res, 403, { error: '请使用评测专用令牌' }); return true; }
        const cfg = getConfig();
        let version = null;
        try { const value = fs.readFileSync(path.join(appDir, 'VERSION'), 'utf8').trim(); if (/^\d+\.\d+\.\d+$/.test(value)) version = value; } catch { /* 开发目录没有已安装版本。 */ }
        json(res, 200, { protocol: 'evaluation-token-v1', tokenId: principal.id, version, provider: String(cfg.provider || '').slice(0, 80), model: String(cfg.models?.[cfg.provider] || '').slice(0, 200), routingEnabled: cfg.routing?.enabled === true, thirdPartySearch: Boolean(cfg.bochaKey || cfg.tavilyKey || cfg.qianfanSearchKey),
          busy: runner.list().some(row => ['running', 'queued'].includes(row.status)),
          tasks: runner.list().filter(row => owned(principal, row)),
          permissions: { tasks: true, sessions: true, events: true, settings: false, files: false, repo: false, browser: false, schedule: false } });
        return true;
      }
      if (pathname === '/api/server/auth/migrate' && req.method === 'POST') {
        json(res, 200, security.migrate(req));
        return true;
      }
      if (pathname === '/api/server/security' && req.method === 'GET') {
        json(res, 200, security.overview(principal));
        return true;
      }
      if (pathname === '/api/server/security/tickets' && req.method === 'POST') {
        const { resource } = await readJson(req, 4096);
        json(res, 200, security.ticket(principal, resource));
        return true;
      }
      const device = pathname.match(/^\/api\/server\/security\/devices\/([\w-]+)$/);
      if (device && req.method === 'DELETE') {
        security.revokeSession(principal, device[1]);
        json(res, 200, { ok: true });
        return true;
      }
      if (pathname === '/api/server/security/evaluations' && req.method === 'POST') {
        json(res, 200, security.issueEvaluation(principal, await readJson(req, 4096)));
        return true;
      }
      const evaluation = pathname.match(/^\/api\/server\/security\/evaluations\/([\w-]+)$/);
      if (evaluation && req.method === 'DELETE') {
        security.revokeEvaluation(principal, evaluation[1]);
        json(res, 200, { ok: true });
        return true;
      }
      return false;
    }
  };
}

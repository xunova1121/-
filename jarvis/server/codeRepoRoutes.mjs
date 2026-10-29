import { codeConnection, githubSettings } from './gitHosting.mjs';

/** 已通过服务器登录鉴权后才调用；不接受通用模型配置接口写入GitHub凭据。 */
export function createCodeRepoRoutes({ getConfig, saveConfig, hosting, repos, readJson, json }) {
  let saving = false;
  const state = (cfg) => ({ ...codeConnection(cfg), capabilities: { read: true, edit: repos.writable === true, runConfigured: repos.runConfigured === true } });
  return async (req, res, pathname) => {
    if (pathname !== '/api/server/code-repos') return false;
    try {
      if (req.method === 'GET') {
        json(res, 200, state(getConfig()));
        return true;
      }
      if (req.method === 'DELETE') {
        if (saving) {
          json(res, 409, { error: '仓库设置正在保存，请稍后再试', code: 'CODE_CONNECTION_BUSY' });
          return true;
        }
        repos.abortAll();
        const { codeRepos, ...next } = getConfig();
        saveConfig(next);
        json(res, 200, state(next));
        return true;
      }
      if (req.method !== 'PUT') {
        json(res, 405, { error: '此接口只用于读取、保存或断开连接' });
        return true;
      }
      if (saving) {
        json(res, 409, { error: '仓库设置正在保存，请稍后再试', code: 'CODE_CONNECTION_BUSY' });
        return true;
      }
      saving = true;
      try {
        const input = await readJson(req, 4096);
        const next = githubSettings(input, getConfig().codeRepos);
        const meta = await hosting.repository(next);
        repos.abortAll();
        // 验证期间模型设置可能已改变；只在新读出的配置上替换仓库字段。
        const cfg = { ...getConfig(), codeRepos: { ...next, defaultBranch: meta.defaultBranch, verifiedAt: new Date().toISOString() } };
        saveConfig(cfg);
        json(res, 200, state(cfg));
      } finally {
        saving = false;
      }
    } catch (error) {
      // 上游401不能冒充未央登录失效；错误消息不回显提交的令牌或HTTP响应正文。
      const known = typeof error.code === 'string' && error.code.startsWith('CODE_');
      json(res, 400, {
        error: known ? error.message : '仓库设置未能保存，请检查服务器配置文件或请求格式',
        code: known ? error.code : 'CODE_CONNECTION_SAVE',
        kind: error.kind || 'code_repository',
        ...(error.upstreamStatus && { upstreamStatus: error.upstreamStatus })
      });
    }
    return true;
  };
}

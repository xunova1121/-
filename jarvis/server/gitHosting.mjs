import { codeError, repositoryName } from './codeGit.mjs';

export function codeConnection(cfg) {
  const c = cfg.codeRepos || {};
  return {
    provider: 'github',
    repository: c.repository || '',
    connected: Boolean(c.repository && c.verifiedAt),
    tokenConfigured: Boolean(c.token),
    protectDefaultBranch: true,
    defaultBranch: c.defaultBranch || '',
    mode: c.token ? 'authenticated' : 'public-readonly'
  };
}
/** 模型配置、通用配置读取都不能附带GitHub凭据；专用接口也只回连接状态。 */
export function withoutCodeCredentials(cfg) {
  const { codeRepos, ...rest } = cfg;
  return rest;
}
export function githubSettings(input, previous = {}) {
  if (input.provider && input.provider !== 'github') throw codeError('CODE_PROVIDER', '本期只支持GitHub');
  const token = input.token === undefined || input.token === '' ? previous.token || '' : input.token;
  if (typeof token !== 'string' || token.length > 255 || (token && !/^[A-Za-z0-9_]{20,255}$/.test(token)))
    throw codeError('CODE_TOKEN', 'GitHub令牌格式无效；令牌只在设置中填写');
  if (input.protectDefaultBranch === false) throw codeError('CODE_BRANCH_PROTECTED', '本期默认分支保护始终开启');
  return { provider: 'github', repository: repositoryName(input.repository), token, protectDefaultBranch: true };
}
export function createGitHubHost({ fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  return {
    async repository(connection, { signal } = {}) {
      const repository = repositoryName(connection.repository);
      const ctrl = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, ctrl]) : ctrl;
      try {
        const response = await fetchImpl('https://api.github.com/repos/' + repository, {
          method: 'GET',
          redirect: 'manual',
          signal: combined,
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Weiyang-Code',
            ...(connection.token && { Authorization: 'Bearer ' + connection.token })
          }
        });
        combined.throwIfAborted();
        if (!response.ok) {
          await response.body?.cancel();
          const messages = {
            401: ['CODE_GITHUB_AUTH', 'GitHub令牌无效或已过期'],
            403: ['CODE_GITHUB_FORBIDDEN', 'GitHub拒绝访问，请检查仓库权限或请求额度'],
            404: ['CODE_GITHUB_NOT_FOUND', 'GitHub仓库不存在或当前令牌没有读取权限']
          };
          const [code, message] =
            messages[response.status] ||
            (response.status >= 300 && response.status < 400
              ? ['CODE_GITHUB_REDIRECT', '仓库地址已变更，请更新仓库名，不转发令牌到新地址']
              : ['CODE_GITHUB_HTTP', 'GitHub暂时无法验证仓库']);
          throw codeError(code, message, { upstreamStatus: response.status });
        }
        const reader = response.body?.getReader();
        if (!reader) throw codeError('CODE_GITHUB_RESPONSE', 'GitHub未返回仓库资料');
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            combined.throwIfAborted();
            if (part.done) break;
            size += part.value.length;
            if (size > 65536) throw codeError('CODE_GITHUB_SIZE', 'GitHub仓库资料超过64KB检查上限');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        let value;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw codeError('CODE_GITHUB_RESPONSE', 'GitHub仓库资料不是有效JSON');
        }
        const branch = value.default_branch;
        if (
          typeof value.full_name !== 'string' ||
          value.full_name.toLowerCase() !== repository ||
          typeof branch !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) ||
          /\.\.|\/\/|\/$|\.lock$/.test(branch)
        )
          throw codeError('CODE_GITHUB_RESPONSE', 'GitHub仓库名或默认分支无法核对');
        return { repository, defaultBranch: branch };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (typeof error.code === 'string' && error.code.startsWith('CODE_')) throw error;
        throw codeError(ctrl.aborted ? 'CODE_GITHUB_TIMEOUT' : 'CODE_GITHUB_NETWORK', ctrl.aborted ? 'GitHub连接验证超时' : '暂时连不上GitHub，请稍后重试', {
          kind: ctrl.aborted ? 'timeout' : 'network'
        });
      }
    }
  };
}

import { codeError, repositoryName } from './codeGit.mjs';
/** 仅固定GitHub API；写操作不自动重试，避免网络不明时重复创建。 */
export function createGitHubProjects({ fetchImpl = fetch } = {}) {
  async function request(token, method, relative, body, signal) {
    if (!/^[A-Za-z0-9_]{20,255}$/.test(token || '')) throw codeError('CODE_GITHUB_AUTH', '请在项目设置保存GitHub账号令牌；不要发到聊天');
    const timeout = AbortSignal.timeout(20000),
      combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const r = await fetchImpl('https://api.github.com' + relative, {
        method,
        redirect: 'manual',
        signal: combined,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Weiyang-Projects',
          Authorization: 'Bearer ' + token,
          ...(body && { 'Content-Type': 'application/json' })
        },
        ...(body && { body: JSON.stringify(body) })
      });
      if (!r.ok) {
        await r.body?.cancel();
        throw codeError(
          r.status === 401 ? 'CODE_GITHUB_AUTH' : r.status === 403 ? 'CODE_GITHUB_FORBIDDEN' : r.status === 422 ? 'CODE_PROJECT_EXISTS' : 'CODE_GITHUB_HTTP',
          r.status === 403
            ? 'GitHub拒绝此操作；只授权单个测试仓库的令牌通常不能新建仓库，请检查账号授权'
            : r.status === 422
              ? '仓库名称已存在或不符合GitHub要求，请核对后重试'
              : 'GitHub操作未成功，请检查账号、权限和网络',
          { upstreamStatus: r.status }
        );
      }
      const reader = r.body.getReader();
      let bytes = 0;
      const parts = [];
      try {
        for (;;) {
          const part = await reader.read();
          combined.throwIfAborted();
          if (part.done) break;
          bytes += part.value.length;
          if (bytes > 65536) throw codeError('CODE_GITHUB_SIZE', 'GitHub回执超过64KB');
          parts.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (e.code?.startsWith('CODE_')) throw e;
      throw codeError(timeout.aborted ? 'CODE_GITHUB_TIMEOUT' : 'CODE_GITHUB_NETWORK', 'GitHub响应未能核实；不要重复新建，请先查看账号仓库列表');
    }
  }
  return {
    async account(token, { signal } = {}) {
      const v = await request(token, 'GET', '/user', null, signal);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(v.login || '')) throw codeError('CODE_GITHUB_RESPONSE', 'GitHub账号回执无效');
      return { login: v.login };
    },
    async ensureBranch(token, repository, branch, defaultBranch, { signal } = {}) {
      repository = repositoryName(repository);
      if (!/^weiyang\/task-[a-f0-9]{24}$/.test(branch)) throw codeError('CODE_BRANCH', '只创建受管工作分支');
      const target = '/repos/' + repository + '/git/ref/heads/' + encodeURIComponent(branch);
      try {
        const found = await request(token, 'GET', target, null, signal);
        if (found.ref !== 'refs/heads/' + branch || !/^([a-f0-9]{40})$/.test(found.object?.sha || '')) throw codeError('CODE_GITHUB_RESPONSE', '分支回执无效');
        return { branch, sha: found.object.sha };
      } catch (e) {
        if (e.upstreamStatus !== 404) throw e;
      }
      const base = await request(token, 'GET', '/repos/' + repository + '/git/ref/heads/' + encodeURIComponent(defaultBranch), null, signal);
      if (!/^[a-f0-9]{40}$/.test(base.object?.sha || '')) throw codeError('CODE_GITHUB_RESPONSE', '默认分支尚未初始化，请稍后继续');
      const made = await request(token, 'POST', '/repos/' + repository + '/git/refs', { ref: 'refs/heads/' + branch, sha: base.object.sha }, signal);
      if (made.ref !== 'refs/heads/' + branch || made.object?.sha !== base.object.sha) throw codeError('CODE_GITHUB_RESPONSE', '新分支回执不一致');
      return { branch, sha: made.object.sha };
    },
    async create(token, input, { signal } = {}) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.name || '') || /\.git$/i.test(input.name))
        throw codeError('CODE_PROJECT_NAME', '仓库名称用80字内英文字母、数字、点、横线或下划线');
      const account = await this.account(token, { signal });
      const v = await request(
        token,
        'POST',
        '/user/repos',
        { name: input.name, description: String(input.description || '').slice(0, 240), private: input.private !== false, auto_init: true },
        signal
      );
      const repository = repositoryName(account.login + '/' + input.name);
      if (String(v.full_name).toLowerCase() !== repository || v.private !== (input.private !== false))
        throw codeError('CODE_GITHUB_RESPONSE', '仓库创建回执与确认信息不一致，请到GitHub核对');
      return { repository, private: v.private, defaultBranch: v.default_branch || 'main' };
    }
  };
}

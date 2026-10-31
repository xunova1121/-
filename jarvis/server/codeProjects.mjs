import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createCodeProjectStore } from './codeProjectStore.mjs';
import { createCodeRepos } from './codeRepos.mjs';
import { createGitHubProjects } from './githubProjects.mjs';
import { codeError, repositoryName } from './codeGit.mjs';
const idOf = () => randomBytes(12).toString('hex');
const projectId = (repo) => createHash('sha256').update(repo).digest('hex').slice(0, 24);
const nameOf = (value) =>
  String(value || '')
    .trim()
    .slice(0, 80);
/** 项目绑定按真实对话保存；当前项目改变不覆盖全局仓库设置，旧单仓库路径仍可用。 */
export function createCodeProjects({
  dataDir,
  getConfig,
  saveConfig,
  legacyRepos,
  hosting,
  git,
  sandbox,
  browser,
  github = createGitHubProjects(),
  onBind = async () => {},
  isBusy = () => false,
  validateSession = async () => {}
}) {
  const store = createCodeProjectStore(path.join(dataDir, 'code-projects')),
    managers = new Map(),
    busy = new Set();
  let accountBusy = false;
  const token = () => getConfig().codeAccount?.token || getConfig().codeRepos?.token || '';
  const account = () => ({ login: getConfig().codeAccount?.login || '', tokenConfigured: Boolean(token()) });
  const sessionKey = (value) => {
    if (typeof value !== 'string' || !value || value.length > 120 || /[\x00-\x20]/.test(value)) throw codeError('CODE_SCOPE', '需要真实对话编号');
    return value;
  };
  const current = async (sessionId) => {
    const d = await store.read(),
      binding = d.bindings.find((b) => b.sessionId === sessionId);
    return { data: d, binding, project: d.projects.find((p) => p.id === binding?.projectId) || null };
  };
  const reposFor = async (sessionId) => {
    const { project } = await current(sessionKey(sessionId));
    if (!project) return legacyRepos;
    if (!managers.has(project.id)) {
      if (managers.size >= 8) {
        const first = managers.keys().next().value;
        managers.get(first).abortAll();
        managers.delete(first);
      }
      managers.set(
        project.id,
        createCodeRepos({
          baseDir: path.join(dataDir, 'repos'),
          getConfig: () => ({
            ...getConfig(),
            codeRepos: {
              provider: 'github',
              repository: repositoryName(project.repository),
              defaultBranch: project.defaultBranch,
              verifiedAt: project.verifiedAt,
              token: token(),
              protectDefaultBranch: true
            }
          }),
          hosting,
          editing: true,
          sandbox,
          browser,
          ...(git && { git })
        })
      );
    }
    return managers.get(project.id);
  };
  const patchRequest = async (id, patch) =>
    store.update((d) => {
      const r = d.requests.find((r) => r.id === id);
      if (!r) throw codeError('CODE_PROJECT_REQUEST', '确认请求不存在');
      Object.assign(r, patch, { updatedAt: Date.now() });
      return { ...r };
    });
  async function bind(projectId, sessionId, workspaceId = null, internal = false) {
    sessionKey(sessionId);
    await validateSession(sessionId);
    if (isBusy(sessionId) || (!internal && busy.has(sessionId))) throw codeError('CODE_PROJECT_BUSY', '当前对话或项目操作仍在执行，请结束后切换项目');
    const d = await store.read(),
      project = d.projects.find((p) => p.id === projectId);
    if (!project) throw codeError('CODE_PROJECT_MISSING', '项目不存在');
    await onBind(sessionId, projectId, null);
    await store.update((data) => {
      data.bindings = data.bindings.filter((b) => b.sessionId !== sessionId);
      data.bindings.push({ sessionId, projectId, workspaceId, at: Date.now() });
    });
    return project;
  }
  async function createIntent(input, sessionId) {
    sessionKey(sessionId);
    await validateSession(sessionId);
    const name = nameOf(input.name);
    if (!getConfig().codeAccount?.verifiedAt) throw codeError('CODE_GITHUB_ACCOUNT_SETUP', '请先在右下角项目菜单的GitHub账号设置验证账号，再创建仓库');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || /\.git$/i.test(name))
      throw codeError('CODE_PROJECT_NAME', '请给出英文仓库名（如shijian-shop），展示名可用中文');
    return store.update((d) => {
      const old = d.requests.find(
        (r) => r.sessionId === sessionId && r.kind === 'create' && r.name === name && r.status === 'pending' && r.expiresAt > Date.now()
      );
      if (old) return old;
      d.requests = d.requests.filter((r) => r.expiresAt > Date.now() || r.status === 'created' || ['creating', 'uncertain'].includes(r.status) || r.commit);
      const request = {
        id: idOf(),
        kind: 'create',
        sessionId,
        name,
        title: nameOf(input.title) || name,
        description: String(input.description || '').slice(0, 240),
        private: input.private !== false,
        account: account().login,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 600000
      };
      d.requests.push(request);
      return request;
    });
  }
  async function saveIntent(input, sessionId, execution = {}) {
    sessionKey(sessionId);
    if (!/^[a-f0-9]{24}$/.test(input.workspace_id || '')) throw codeError('CODE_WORKTREE', '保存需要原工作副本编号');
    const repos = await reposFor(sessionId),
      plan = await repos.publishPlan(input.workspace_id, sessionId, execution);
    if (!plan.files.length) throw codeError('CODE_NOTHING_TO_SAVE', '当前副本没有待保存的修改');
    return store.update((d) => {
      d.requests = d.requests.filter((r) => r.expiresAt > Date.now() || r.status === 'created' || ['creating', 'uncertain'].includes(r.status) || r.commit);
      const request = {
        id: idOf(),
        kind: 'save',
        sessionId,
        workspaceId: input.workspace_id,
        repository: plan.repository,
        branch: plan.branch,
        digest: plan.digest,
        head: plan.head,
        files: plan.files,
        message: String(input.message || 'Update project').slice(0, 180),
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 600000
      };
      d.requests.push(request);
      return request;
    });
  }
  async function execute(id, sessionId) {
    sessionKey(sessionId);
    await validateSession(sessionId);
    const d = await store.read();
    let request = d.requests.find((r) => r.id === id && r.sessionId === sessionId);
    if (!request) throw codeError('CODE_PROJECT_REQUEST', '没有这个对话的确认请求');
    if (request.status === 'applied') return request.result;
    if (['creating', 'uncertain'].includes(request.status))
      throw codeError('CODE_PROJECT_UNCERTAIN', '上次创建的网络回执不明，请到GitHub核对是否已建仓；不要重复创建，可连接已有仓库继续');
    if (request.expiresAt < Date.now() && !request.projectId && !request.commit) throw codeError('CODE_APPROVAL_STALE', '确认已过期，请重新准备');
    if (accountBusy || busy.has(sessionId) || isBusy(sessionId)) throw codeError('CODE_PROJECT_BUSY', '操作或对话正在执行，请稍后再试');
    busy.add(sessionId);
    try {
      if (request.kind === 'create') {
        if (!request.projectId) {
          const identity = await github.account(token());
          if (request.account && request.account !== identity.login) throw codeError('CODE_APPROVAL_STALE', 'GitHub账号已改变，请重新确认');
          request = await patchRequest(id, { status: 'creating' });
          const made = await github.create(token(), request),
            project = {
              id: projectId(made.repository),
              name: request.title,
              repository: made.repository,
              private: made.private,
              defaultBranch: made.defaultBranch,
              verifiedAt: new Date().toISOString(),
              createdAt: Date.now()
            };
          await store.update((data) => {
            if (!data.projects.some((p) => p.id === project.id)) data.projects.push(project);
          });
          request = await patchRequest(id, { projectId: project.id, status: 'created' });
        }
        const project = await bind(request.projectId, sessionId, null, true),
          repos = await reposFor(sessionId);
        const workspace = await repos.clone({}, { sessionId, taskId: 'project-' + id });
        await patchRequest(id, { workspaceId: workspace.workspace_id, status: 'created' });
        await github.ensureBranch(token(), project.repository, workspace.branch, project.defaultBranch);
        await store.update((data) => {
          const b = data.bindings.find((b) => b.sessionId === sessionId);
          b.workspaceId = workspace.workspace_id;
        });
        await onBind(sessionId, project.id, 'project-' + id);
        const result = { project, workspace, remoteBranchCreated: true };
        await patchRequest(id, { status: 'applied', result });
        return result;
      }
      const repos = await reposFor(sessionId);
      if (!request.commit) {
        const committed = await repos.commit(request.workspaceId, sessionId, { digest: request.digest, message: request.message, head: request.head, files: request.files });
        request = await patchRequest(id, { commit: committed.commit, status: 'committed' });
      }
      const pushed = await repos.push(request.workspaceId, sessionId, { commit: request.commit });
      await patchRequest(id, { status: 'applied', result: pushed });
      return pushed;
    } catch (e) {
      // 创建的回执不明时不得重发POST；已有仓库/本地提交保留，可继续准备或重推原提交。
      if (request.kind === 'create' && !request.projectId && request.status === 'creating')
        await patchRequest(id, { status: [401, 403, 404, 422].includes(e.upstreamStatus) ? 'pending' : 'uncertain', failure: e.code || 'CODE_PROJECT_FAILED' });
      else await patchRequest(id, { failure: /^CODE_[A-Z_]+$/.test(e.code || '') ? e.code : 'CODE_PROJECT_FAILED' });
      throw e;
    } finally {
      busy.delete(sessionId);
    }
  }
  return {
    reposFor,
    prepare: createIntent,
    prepareSave: saveIntent,
    execute,
    bind,
    async selectWorkspace(workspaceId, sessionId) {
      const repos = await reposFor(sessionKey(sessionId));
      const workspaces = await repos.workspaces(sessionId),
        workspace = workspaces.items.find((w) => w.workspace_id === workspaceId);
      if (!workspace) throw codeError('CODE_WORKTREE', '原副本不属于当前对话或不在当前项目');
      if (accountBusy || busy.has(sessionId) || isBusy(sessionId)) throw codeError('CODE_PROJECT_BUSY', '当前对话或项目操作仍在执行，请结束后选择副本');
      const { project } = await current(sessionId);
      await onBind(sessionId, project?.id || 'legacy', workspace.task_id);
      return await repos.status(workspaceId, sessionId);
    },
    async saveAccount(input) {
      if (accountBusy || busy.size) throw codeError('CODE_PROJECT_BUSY', '项目操作执行中，请结束后切换账号');
      accountBusy = true;
      try {
        const next = input.token || token();
        const found = await github.account(next);
        legacyRepos.abortAll();
        for (const repos of managers.values()) repos.abortAll();
        saveConfig({ ...getConfig(), codeAccount: { token: next, login: found.login, verifiedAt: new Date().toISOString() } });
        return account();
      } finally {
        accountBusy = false;
      }
    },
    async connect(input, sessionId) {
      sessionKey(sessionId);
      await validateSession(sessionId);
      if (accountBusy || busy.has(sessionId) || isBusy(sessionId)) throw codeError('CODE_PROJECT_BUSY', '当前对话或项目操作仍在执行，请稍后连接');
      const repository = repositoryName(input.repository),
        meta = await hosting.repository({ repository, token: token() });
      const project = {
        id: projectId(repository),
        name: nameOf(input.title) || repository.split('/')[1],
        repository,
        private: null,
        defaultBranch: meta.defaultBranch,
        verifiedAt: new Date().toISOString(),
        createdAt: Date.now()
      };
      await store.update((d) => {
        d.projects = d.projects.filter((p) => p.id !== project.id);
        d.projects.push(project);
      });
      await bind(project.id, sessionId);
      return project;
    },
    async list(sessionId) {
      const { data, binding, project } = await current(sessionKey(sessionId));
      let workspaces = { items: [], truncated: false },
        error = null;
      try {
        const repos = await reposFor(sessionId);
        if (await repos.connected()) workspaces = await repos.workspaces(sessionId);
        workspaces.items = await Promise.all(workspaces.items.map(async (w) => ({ ...w, ...(await repos.status(w.workspace_id, sessionId)) })));
      } catch (e) {
        error = { code: e.code || 'CODE_PROJECT_INDEX', message: '原副本状态暂未核对，请保留原文件' };
      }
      const legacy = getConfig().codeRepos;
      return {
        account: account(),
        capabilities: { browser: Boolean((await reposFor(sessionId)).browserConfigured), checks: Boolean((await reposFor(sessionId)).runConfigured) },
        projects: data.projects,
        current:
          project ||
          (legacy?.verifiedAt && { id: 'legacy', name: legacy.repository, repository: legacy.repository, defaultBranch: legacy.defaultBranch }) ||
          null,
        binding: binding || null,
        workspaces,
        requests: data.requests.filter(
          (r) =>
            r.sessionId === sessionId &&
            r.status !== 'applied' &&
            (r.expiresAt > Date.now() || r.projectId || r.commit || ['creating', 'uncertain'].includes(r.status))
        ),
        error
      };
    }
  };
}

import '../ui/codeProjects.css';
/** 项目与分支以服务器持久记录为准，不把令牌或工作副本路径写入浏览器存储。 */
export function createCodeProjectsUI(app) {
  if (!document.querySelector('#model-chip')) return {};
  const chip = document.createElement('button');
  chip.id = 'project-chip';
  chip.type = 'button';
  chip.className = 'project-chip';
  chip.textContent = '代码项目';
  // 保留旧侧栏调用的目标，实际入口统一放导航，不占输入框。
  chip.hidden = true;
  chip.setAttribute('aria-label', '项目与GitHub仓库');
  chip.setAttribute('aria-haspopup', 'dialog');
  document.body.append(chip);
  const dialog = document.createElement('dialog');
  dialog.className = 'code-project-dialog';
  dialog.setAttribute('aria-label', '项目与GitHub仓库');
  dialog.innerHTML = `<header><div><small>WEIYANG WORKSPACE</small><h2>我的项目</h2></div><button type="button" data-close aria-label="关闭项目菜单">×</button></header>
    <p data-status role="status"></p><section data-current></section><section data-requests></section><section data-projects></section>
    <details open><summary>新建项目</summary><form data-create><label>仓库名<input name="name" required maxlength="80" placeholder="shijian-shop" pattern="[A-Za-z0-9][A-Za-z0-9._-]*"></label><label>项目展示名<input name="title" maxlength="80" placeholder="拾间商城"></label><label><input type="checkbox" name="private" checked> 私有仓库</label><button type="submit">准备创建</button></form></details>
    <details><summary>连接已有仓库</summary><form data-connect><label>GitHub仓库<input name="repository" required placeholder="owner/repository" maxlength="140"></label><button type="submit">验证并连接当前对话</button></form></details>
    <details><summary>GitHub账号设置</summary><form data-account><p>令牌只保存在服务器。创建仓库需要账号具有相应权限；单仓库令牌可能仅能连接已有仓库。</p><label>账号令牌<input name="token" type="password" autocomplete="off" maxlength="255" required></label><button type="submit">验证并保存</button></form></details>`;
  document.body.append(dialog);
  const statusLine = dialog.querySelector('[data-status]');
  let busy = false;
  const sessionId = () => app.session?.id;
  const client = () => {
    if (!app.server) throw new Error('请先连接未央服务器，再管理GitHub项目');
    if (!sessionId()) throw new Error('请先开始一个对话');
    return app.server;
  };
  const button = (label, action) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => run(action));
    return b;
  };
  async function run(action) {
    if (busy) return;
    busy = true;
    statusLine.textContent = '正在处理…';
    try {
      await action();
      await refresh();
    } catch (error) {
      statusLine.textContent = error.status === 404 ? '服务器尚不支持项目管理，请更新服务器' : error.message;
    } finally {
      busy = false;
    }
  }
  async function preview(workspaceId) {
    const result = await client().previewCodeProject({ sessionId: sessionId(), workspace_id: workspaceId, entry: 'index.html' });
    const view = document.createElement('dialog');
    view.className = 'code-project-preview';
    view.setAttribute('aria-label', '项目页面预览');
    const close = button('关闭预览', () => view.close());
    const frame = document.createElement('iframe');
    frame.title = result.title || '项目页面';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    frame.srcdoc = result.html;
    view.append(close, frame);
    view.addEventListener('close', () => view.remove(), { once: true });
    document.body.append(view);
    view.showModal();
  }
  async function refresh() {
    const state = await client().listCodeProjects(sessionId());
    statusLine.textContent = state.error?.message || (state.account.login ? `GitHub · ${state.account.login}` : '先连接已有仓库，或在账号设置授权后新建项目');
    const current = dialog.querySelector('[data-current]');
    current.replaceChildren();
    chip.title = state.current ? `当前项目：${state.current.name}` : '项目与GitHub仓库';
    if (state.current) {
      const title = document.createElement('h3');
      title.textContent = state.current.name;
      const remote = document.createElement('a');
      remote.textContent = state.current.repository;
      remote.href = 'https://github.com/' + state.current.repository;
      remote.target = '_blank';
      remote.rel = 'noopener noreferrer';
      current.append(title, remote);
      if (state.capabilities && (!state.capabilities.checks || !state.capabilities.browser)) {
        const note = document.createElement('p');
        note.textContent =
          '运行环境：' +
          (state.capabilities.checks ? '代码测试已配置' : '代码测试镜像待配置') +
          ' · ' +
          (state.capabilities.browser ? '网页检查已配置' : '网页检查镜像待配置');
        current.append(note);
      }
      chip.title = `当前项目：${state.current.name}`;
      for (const workspace of state.workspaces.items) {
        const row = document.createElement('div');
        row.className = 'code-project-workspace';
        const branch = document.createElement('small');
        branch.textContent = workspace.branch + ` · ${workspace.changes?.length || 0} 项未提交修改`;
        row.append(
          branch,
          button('继续此副本', async () => {
            await client().selectCodeWorkspace({ sessionId: sessionId(), workspace_id: workspace.workspace_id });
            app.toast?.('已绑定原工作副本');
          }),
          button('页面预览', () => preview(workspace.workspace_id)),
          button('保存到GitHub', async () => {
            await client().prepareCodeSave({ sessionId: sessionId(), workspace_id: workspace.workspace_id });
          })
        );
        current.append(row);
      }
    }
    const recent = dialog.querySelector('[data-projects]');
    recent.replaceChildren();
    if (state.projects.length) {
      const title = document.createElement('h3');
      title.textContent = '最近项目';
      recent.append(title);
      for (const project of state.projects)
        recent.append(
          button(project.name + ' · ' + project.repository, async () => {
            await client().bindCodeProject({ sessionId: sessionId(), projectId: project.id });
          })
        );
    }
    const requests = dialog.querySelector('[data-requests]');
    requests.replaceChildren();
    for (const request of state.requests) {
      const card = document.createElement('article');
      card.className = 'code-project-request';
      const title = document.createElement('h3');
      title.textContent =
        request.kind === 'create' ? `确认创建 ${request.title} · ${request.private ? '私有' : '公开'}` : `确认保存 ${request.files.length} 个文件`;
      const detail = document.createElement('p');
      detail.textContent = request.kind === 'create' ? `${request.account}/${request.name} · 将新建工作分支` : request.repository + ' / ' + request.branch;
      card.append(title, detail);
      if (request.kind === 'create' && request.description) {
        const description = document.createElement('p');
        description.textContent = request.description;
        card.append(description);
      }
      if (request.files) {
        const list = document.createElement('pre');
        list.textContent = request.files.map((f) => `${f.status} ${f.path} · ${f.sha256.slice(0, 12)}`).join('\n');
        card.append(list);
      }
      if (['creating', 'uncertain'].includes(request.status)) {
        const note = document.createElement('p');
        note.textContent = '上次建仓回执不明，请到GitHub核对后连接已有仓库。';
        card.append(note);
      } else
        card.append(
          button(request.kind === 'create' ? '确认创建并准备分支' : request.commit ? '重试推送原提交' : '确认保存工作分支', async () => {
            await client().confirmCodeProject({ sessionId: sessionId(), requestId: request.id, confirm: true });
            app.toast?.('项目操作已完成');
            if (request.kind === 'create' && typeof app.send === 'function') {
              dialog.close();
              app.send('继续刚才的GitHub项目需求，在新建项目的工作分支开发并检查页面。');
            }
          })
        );
      requests.append(card);
    }
  }
  let returnFocus = null;
  const openCodeProjects = () => {
    const fromDrawer = document.activeElement?.closest('#drawer');
    returnFocus = fromDrawer ? document.querySelector('#btn-menu') : document.activeElement;
    app.drawer?.close();
    if (!dialog.open) dialog.showModal();
    run(async () => {});
  };
  chip.addEventListener('click', openCodeProjects);
  dialog.addEventListener('close', () => {
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
  // App使用原生抽屉；PC沿用workbench已有的“代码项目”导航。
  const drawer = document.querySelector('#drawer');
  if (drawer && !drawer.querySelector('[data-destination="code-projects"]')) {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'drawer-project-entry';
    entry.dataset.destination = 'code-projects';
    entry.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h6l2 2h10v11H3zM3 7V4h7l2 3"/><path d="m10 12-3 3 3 3m4-6 3 3-3 3"/></svg><span><strong>代码项目</strong><small>GitHub · 项目与分支</small></span><i aria-hidden="true">›</i>';
    entry.addEventListener('click', openCodeProjects);
    drawer.querySelector('.drawer-new')?.after(entry);
  }
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  for (const [selector, action] of [
    [
      '[data-create]',
      (form) =>
        client().prepareCodeProject({
          sessionId: sessionId(),
          name: form.elements.name.value.trim(),
          title: form.elements.title.value.trim(),
          private: form.elements.private.checked
        })
    ],
    ['[data-connect]', (form) => client().connectCodeProject({ sessionId: sessionId(), repository: form.elements.repository.value.trim() })],
    [
      '[data-account]',
      async (form) => {
        await client().saveCodeAccount({ token: form.elements.token.value });
        form.reset();
      }
    ]
  ])
    dialog.querySelector(selector).addEventListener('submit', (event) => {
      event.preventDefault();
      run(() => action(event.currentTarget));
    });
  return { refreshCodeProjects: refresh, openCodeProjects };
}

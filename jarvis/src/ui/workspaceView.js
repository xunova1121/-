import * as workspace from '../agent/workspace.js';
import { fmtSize } from '../agent/tools.js';
import { loadCatalog, patchCatalog, catalogGroups, PROCESS_FILE } from './workspaceCatalog.js';
import './workspaceView.css';
const element = (tag, properties = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
};

/** 只渲染前50组，逐次追加50组；选择最多200组、管理标记最多2000路径，缓存一份30秒来源索引。 */
export function initWorkspaceView({ list, refresh, toast, openFile, getScope, getRecords, onOpenSession, onRenameWorkRecord, onRemoveWorkRecord }) {
  let view = 'recent';
  let showProcess = false;
  let project = '';
  let limit = 50;
  let hasMore = false;
  let previousFilter = '';
  let currentScope = '';
  let selected = new Set();
  let cachedSources = null;
  let sourceController = null;
  let managerGeneration = 0;
  const tabs = element('div', { className: 'ws-view-tabs', role: 'group', ariaLabel: '成果视图' });
  for (const [id, label] of [
    ['recent', '最近'],
    ['projects', '项目'],
    ['favorites', '收藏'],
    ['trash', '回收站']
  ]) {
    const button = element('button', { type: 'button', textContent: label });
    button.dataset.view = id;
    button.setAttribute('aria-pressed', String(view === id));
    button.onclick = () => {
      view = id;
      project = '';
      selected.clear();
      for (const item of tabs.children) item.setAttribute('aria-pressed', String(item === button));
      refresh();
    };
    tabs.append(button);
  }
  const projectSelect = element('select', { ariaLabel: '按项目筛选', className: 'ws-project-filter' });
  projectSelect.onchange = () => {
    project = projectSelect.value;
    refresh();
  };
  const processInput = element('input', { type: 'checkbox' });
  processInput.onchange = () => {
    showProcess = processInput.checked;
    refresh();
  };
  const processLabel = element('label', { className: 'ws-process-toggle' }, processInput, document.createTextNode('显示过程文件'));
  const batch = element('div', { className: 'ws-batch', hidden: true });
  const more = element('button', { type: 'button', className: 'ws-load-more', hidden: true, textContent: '加载更多成果' });
  more.onclick = () => {
    limit += 50;
    refresh();
  };
  const control = element(
    'div',
    { className: 'ws-organizer' },
    tabs,
    element('div', { className: 'ws-organizer-options' }, projectSelect, processLabel),
    batch
  );
  const manager = element('dialog', { className: 'ws-manager' });
  document.body.append(manager);
  manager.addEventListener('close', () => {
    managerGeneration++;
    sourceController?.abort();
  });
  list.after(more);

  async function sourceRecords(scope, path) {
    if (cachedSources?.scope === scope && cachedSources.path === path && Date.now() - cachedSources.at < 30000) return cachedSources.items;
    sourceController?.abort();
    const controller = (sourceController = new AbortController());
    const timer = setTimeout(() => controller.abort(), 1500);
    let result;
    try {
      result = await getRecords?.({ path, limit: 1, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (sourceController === controller) sourceController = null;
    }
    const records = (result?.items || []).slice(0, 200);
    cachedSources = { scope, path, at: Date.now(), items: records };
    return records;
  }
  const scopeNow = () => getScope() + ':' + workspace.mode() + ':' + (workspace.folderName() || '');
  function assertScope(scope) {
    if (scope !== scopeNow()) throw Object.assign(new Error('工作区来源已改变，请重新打开成果管理'), { code: 'WORKSPACE_CHANGED', kind: 'input' });
  }
  async function updateGroups(groups, patch, scope, items) {
    assertScope(scope);
    await patchCatalog(
      scope,
      groups.flatMap((group) => group.files.map((file) => file.path)),
      patch
    );
    selected.clear();
    refresh();
  }
  function action(label, run) {
    const button = element('button', { type: 'button', textContent: label });
    button.onclick = (event) => {
      event.stopPropagation();
      Promise.resolve()
        .then(run)
        .catch((error) => toast(error.message));
    };
    return button;
  }
  async function manage(group, scope, items) {
    assertScope(scope);
    const generation = ++managerGeneration;
    manager.replaceChildren(
      element('h3', { textContent: '管理成果' }),
      element('p', { textContent: '正在核对来源记录…' }),
      action('关闭', () => manager.close())
    );
    if (!manager.open) manager.showModal();
    cachedSources = null;
    try {
      const fresh = await sourceRecords(scope, group.files[0].path);
      group.source = fresh.find((record) => record.files?.some((path) => group.files.some((file) => file.path === path))) || null;
    } catch {
      group.source = null;
    }
    if (generation !== managerGeneration || !manager.open) return;
    if (scope !== scopeNow()) {
      manager.close();
      assertScope(scope);
    }
    const scopedAction = (label, run) =>
      action(label, async () => {
        assertScope(scope);
        await run();
      });
    manager.replaceChildren();
    const title = element('input', { value: group.title, maxLength: 160 });
    const projectInput = element('input', { value: group.project, maxLength: 80, placeholder: '如：禁捕项目' });
    const close = action('关闭', () => manager.close());
    manager.append(
      element('h3', { textContent: '管理成果' }),
      element('label', {}, document.createTextNode('显示名称'), title),
      element('label', {}, document.createTextNode('所属项目'), projectInput),
      element('p', {
        className: 'muted small',
        textContent: '显示名称、项目和收藏仅在当前设备保存，不移动原文件。回收站暂存仍保留原链接；永久删除需另行勾选确认。'
      })
    );
    for (const file of group.files) manager.append(element('p', { className: 'ws-source-path', textContent: file.path }));
    if (group.source) {
      manager.append(element('p', { className: 'muted small', textContent: '生成记录：' + group.source.id }));
      manager.append(
        scopedAction('查看来源对话', async () => {
          await onOpenSession?.(group.source.sessionId);
          manager.close();
        })
      );
    }
    manager.append(
      scopedAction('保存名称与项目', async () => {
        if (group.source && onRenameWorkRecord) await onRenameWorkRecord(group.source.id, title.value.trim().slice(0, 160));
        await updateGroups([group], { title: title.value.trim().slice(0, 160), project: projectInput.value.trim().slice(0, 80) }, scope, items);
        manager.close();
      })
    );
    manager.append(
      scopedAction(group.favorite ? '取消收藏' : '收藏成果', async () => {
        await updateGroups([group], { favorite: !group.favorite }, scope, items);
        manager.close();
      })
    );
    manager.append(
      scopedAction(view === 'trash' ? '恢复到工作区' : '移至回收站', async () => {
        await updateGroups([group], { trash: view !== 'trash' }, scope, items);
        manager.close();
      })
    );
    if (view === 'trash' && workspace.mode() === 'virtual') {
      const confirmDelete = element('input', { type: 'checkbox' });
      const permanent = scopedAction('永久删除文件', async () => {
        if (!confirmDelete.checked) return;
        for (const file of group.files) await workspace.removeVirtual(file.path);
        await patchCatalog(
          scope,
          group.files.map((file) => file.path),
          null
        );
        manager.close();
        refresh();
      });
      permanent.disabled = true;
      confirmDelete.onchange = () => {
        permanent.disabled = !confirmDelete.checked;
      };
      manager.append(element('label', {}, confirmDelete, document.createTextNode('确认永久删除；较大文件可能没有历史备份')), permanent);
    }
    if (group.source && onRemoveWorkRecord)
      manager.append(
        scopedAction('删除生成记录（保留文件）', async () => {
          await onRemoveWorkRecord(group.source.id);
          cachedSources = null;
          manager.close();
          refresh();
        })
      );
    manager.append(close);
    if (!manager.open) manager.showModal();
  }
  async function render(files, { query = '', category = 'all', fresh = new Set(), current = null, isCurrent = () => true } = {}) {
    const scope = scopeNow();
    if (scope !== currentScope) {
      currentScope = scope;
      selected = new Set();
      cachedSources = null;
    }
    const filter = JSON.stringify([scope, query, category, view, project, showProcess]);
    if (filter !== previousFilter) {
      previousFilter = filter;
      limit = 50;
      selected.clear();
    }
    let items;
    try {
      items = await loadCatalog(scope);
    } catch {
      items = {};
      toast('文件管理标记读取失败，先显示原文件，不会删除文件。');
    }
    const records = cachedSources?.scope === scope ? cachedSources.items : [];
    // 来源查询只在打开管理时进行，不让可选云端索引阻塞文件查找。
    if (!isCurrent()) return null;
    const groups = catalogGroups(files, { items, records, query, category, view, project, process: showProcess });
    projectSelect.hidden = view !== 'projects';
    const projects = [
      ...new Set(
        Object.values(items)
          .map((item) => item.project)
          .filter(Boolean)
      )
    ].sort();
    projectSelect.replaceChildren(
      element('option', { value: '', textContent: '全部项目' }),
      ...projects.map((value) => element('option', { value, textContent: value }))
    );
    projectSelect.value = project;
    const syncBatch = () => {
      const chosen = groups.filter((group) => selected.has(group.key));
      batch.hidden = !chosen.length;
      batch.replaceChildren(
        element('span', { textContent: `已选 ${chosen.length} 项` }),
        action(view === 'favorites' ? '取消收藏' : '收藏', () => updateGroups(chosen, { favorite: view !== 'favorites' }, scope, items)),
        action(view === 'trash' ? '恢复' : '移至回收站', () => updateGroups(chosen, { trash: view !== 'trash' }, scope, items)),
        action('取消选择', () => {
          selected.clear();
          refresh();
        })
      );
    };
    syncBatch();
    const rows = groups.slice(0, limit).map((group) => {
      const primary = group.files[0];
      const checkbox = element('input', { type: 'checkbox', checked: selected.has(group.key), ariaLabel: '选择 ' + group.title });
      checkbox.onclick = (event) => event.stopPropagation();
      checkbox.onchange = () => {
        if (checkbox.checked && selected.size >= 200) {
          checkbox.checked = false;
          toast('一次最多选择200项');
          return;
        }
        if (checkbox.checked) selected.add(group.key);
        else selected.delete(group.key);
        syncBatch();
      };
      const fileTitle = group.files.length === 1 && !items[primary.path]?.title ? primary.path.split('/').pop() : group.title;
      const formats = element('div', { className: 'ws-formats' });
      if (group.files.length > 1) for (const file of group.files) formats.append(action(file.path.split('/').pop(), () => openFile(file.path)));
      const subtitle = [
        group.project,
        primary.path,
        fmtSize(group.files.reduce((sum, file) => sum + file.size, 0)),
        group.mtime ? new Date(group.mtime).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''
      ]
        .filter(Boolean)
        .join(' · ');
      const main = element(
        'div',
        { className: 'ws-file-main' },
        element('span', { className: 'fn', textContent: (group.favorite ? '★ ' : '') + fileTitle }),
        element('span', { className: 'ws-file-subtitle', textContent: subtitle }),
        formats
      );
      const row = element(
        'li',
        { className: 'ws-result', title: group.files.map((file) => file.path).join('\n'), tabIndex: 0 },
        checkbox,
        element('span', { className: 'fx', textContent: group.files.length > 1 ? '组' : workspace.ext(primary.path).toUpperCase() }),
        main,
        action('⋯', () => manage(group, scope, items))
      );
      row.dataset.path = primary.path;
      row.setAttribute('role', 'button');
      if (group.files.some((file) => fresh.has(file.path))) row.classList.add('fresh');
      if (group.files.some((file) => current === file.path)) row.classList.add('active');
      row.onclick = () => openFile(primary.path);
      row.onkeydown = (event) => {
        if (event.target === row && ['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          openFile(primary.path);
        }
      };
      return row;
    });
    list.replaceChildren(
      ...(rows.length
        ? rows
        : [
            element('li', {
              className: 'empty',
              textContent:
                view === 'trash' ? '回收站是空的。' : query ? '没有匹配的成果，试试文件名或项目名。' : '这里还没有成果。上传材料或让未央制作一份文件吧。'
            })
          ])
    );
    hasMore = groups.length > limit;
    more.hidden = !hasMore;
    more.textContent = `加载更多（已显示 ${Math.min(limit, groups.length)} / ${groups.length} 项）`;
    const processCount = files.filter((file) => PROCESS_FILE.test(file.path)).length;
    return { groups: groups.length, files: groups.reduce((sum, group) => sum + group.files.length, 0), processCount };
  }
  return {
    control,
    render,
    setHidden: (hidden) => {
      more.hidden = hidden || !hasMore;
    }
  };
}

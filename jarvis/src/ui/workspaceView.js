import * as workspace from '../agent/workspace.js';
import { fmtSize } from '../agent/tools.js';
import { loadCatalog, patchCatalog, catalogGroups, PROCESS_FILE } from './workspaceCatalog.js';
import { confirmTrashAll } from './workspaceTrashAll.js';
import './workspaceView.css';
const element = (tag, properties = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
};

/** 只渲染前50组，逐次追加50组；选择最多200组、管理标记最多2000路径，缓存一份30秒来源索引。 */
export function initWorkspaceView({ list, refresh, toast, openFile, getScope, getWorkspace = () => workspace, getRecords, onOpenSession, onRenameWorkRecord, onRemoveWorkRecord }) {
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
  const clearAll = action('全部移入回收站', () => {
    const scope = scopeNow();
    return confirmTrashAll({
      source: getWorkspace(),
      refresh,
      toast,
      afterMove: async paths => {
        assertScope(scope);
        const catalog = await loadCatalog(scope);
        const oldMarks = paths.filter(path => catalog[path]?.trash);
        if (oldMarks.length) await patchCatalog(scope, oldMarks, { trash: false });
      }
    });
  });
  clearAll.className = 'ws-clear-all';
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
    element('div', { className: 'ws-organizer-options' }, projectSelect, processLabel, clearAll),
    batch
  );
  const manager = element('dialog', { className: 'ws-manager' });
  document.body.append(manager);
  manager.addEventListener('close', () => {
    managerGeneration++;
    sourceController?.abort();
  });
  list.after(more);

  async function sourceRecords(scope, path, revision = '') {
    if (cachedSources?.scope === scope && cachedSources.path === path && cachedSources.revision === revision && Date.now() - cachedSources.at < 30000) return cachedSources.items;
    sourceController?.abort();
    const controller = (sourceController = new AbortController());
    const timer = setTimeout(() => controller.abort(), 1500);
    let result;
    try {
      result = await getRecords?.(path ? { path, limit: 1, signal: controller.signal } : { kind: 'image', status: '', limit: 200, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (sourceController === controller) sourceController = null;
    }
    const records = (result?.items || []).slice(0, 200);
    cachedSources = { scope, path, revision, at: Date.now(), items: records };
    return records;
  }
  // 保留既有收藏/项目标记的键；云端读取方式不迁移本机已有元数据。
  const scopeNow = () => getScope() + ':' + workspace.mode() + ':' + (workspace.folderName() || '');
  function assertScope(scope) {
    if (scope !== scopeNow()) throw Object.assign(new Error('工作区来源已改变，请重新打开成果管理'), { code: 'WORKSPACE_CHANGED', kind: 'input' });
  }
  async function updateGroups(groups, patch, scope) {
    assertScope(scope);
    await patchCatalog(
      scope,
      groups.flatMap((group) => group.files.map((file) => file.path)),
      patch
    );
    selected.clear();
    refresh();
  }
  async function changeTrash(groups, operation, scope, items) {
    assertScope(scope);
    const source = getWorkspace();
    if (source.mode() === 'folder') return updateGroups(groups, { trash: operation === 'trash' }, scope);
    const files = groups.flatMap(group => group.files);
    let completed = 0;
    try {
      for (const file of files) {
        assertScope(scope);
        const path = file.path;
        const expected = { size: file.size, mtime: file.mtime, trashedAt: file.trashedAt };
        if (operation === 'trash') await source.trash(path, expected);
        if (operation === 'restore' && file.inTrash) await source.restoreTrash(path, expected);
        if (operation === 'purge') {
          // 旧版“回收站”中的文件还在活动目录。先按当时看到的版本移入，再清理对应的回收记录。
          const entry = file.inTrash ? expected : await source.trash(path, expected);
          await source.purgeTrash(path, entry);
          if (items[path]) {
            if (!(await source.exists(path))) await patchCatalog(scope, [path], null);
            else if (items[path].trash) await patchCatalog(scope, [path], { trash: false });
          }
        } else if (items[path]?.trash) {
          await patchCatalog(scope, [path], { trash: false });
        }
        completed++;
      }
    } catch (error) {
      if (completed) {
        if (manager.open) manager.close();
        throw new Error(`已处理 ${completed} / ${files.length} 个文件。${error.message}`);
      }
      throw error;
    } finally {
      selected.clear();
      refresh();
    }
  }
  function action(label, run) {
    const button = element('button', { type: 'button', textContent: label });
    button.onclick = async (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      button.disabled = true;
      try { await run(); }
      catch (error) { toast(error.message); }
      finally { button.disabled = false; }
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
        textContent: getWorkspace().mode() === 'folder'
          ? '连接的本地文件夹只支持在本设备隐藏和恢复列表项，原文件保留在文件夹中。'
          : '移入回收站后，可在当前工作区的回收站恢复文件。显示名称、项目和收藏保存在本设备。'
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
        await updateGroups([group], { title: title.value.trim().slice(0, 160), project: projectInput.value.trim().slice(0, 80) }, scope);
        manager.close();
      })
    );
    manager.append(
      scopedAction(group.favorite ? '取消收藏' : '收藏成果', async () => {
        await updateGroups([group], { favorite: !group.favorite }, scope);
        manager.close();
      })
    );
    manager.append(
      scopedAction(view === 'trash' ? '恢复到工作区' : getWorkspace().mode() === 'folder' ? '从列表隐藏' : '移至回收站', async () => {
        await changeTrash([group], view === 'trash' ? 'restore' : 'trash', scope, items);
        manager.close();
      })
    );
    if (view === 'trash' && getWorkspace().mode() === 'virtual') {
      const confirmDelete = element('input', { type: 'checkbox' });
      const permanent = scopedAction('永久删除文件', async () => {
        if (!confirmDelete.checked) return;
        await changeTrash([group], 'purge', scope, items);
        manager.close();
      });
      permanent.disabled = true;
      confirmDelete.onchange = () => {
        permanent.disabled = !confirmDelete.checked;
      };
      manager.append(element('label', {}, confirmDelete, document.createTextNode('确认永久删除所列文件')), permanent);
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
  async function render(files, { query = '', category = 'all', fresh = new Set(), current = null, isCurrent = () => true, source = getWorkspace() } = {}) {
    clearAll.hidden = source.mode() === 'folder' || view === 'trash';
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
    let trashError = '';
    if (view === 'trash') {
      let trashed = [];
      try {
        if (source.mode() !== 'folder') trashed = await source.listTrash();
      } catch (error) {
        if (!isCurrent() || scope !== scopeNow()) return null;
        trashError = '读取回收站失败：' + error.message;
      }
      const stored = new Set(trashed.map(file => file.path));
      // 旧版本只给仍在工作区的路径打标记。优先真实回收条目，兼容其余旧标记。
      files = [...files.filter(file => items[file.path]?.trash && !stored.has(file.path)), ...trashed.map(file => ({ ...file, inTrash: true }))];
    }
    // 只有存在任务海报时才取简短成果索引，最多等待1.5秒；无此类文件保持原首屏路径。
    let records = cachedSources?.scope === scope ? cachedSources.items : [];
    const posterFiles = files.filter(f => /^\.workflows\/posters\//.test(f.path));
    if (posterFiles.length) {
      const revision = posterFiles.length + ':' + posterFiles.reduce((latest, f) => Math.max(latest, Number(f.mtime) || 0), 0);
      try { records = await sourceRecords(scope, '', revision); } catch { /* 索引不可达时仍可打开过程文件 */ }
    }
    if (!isCurrent() || scope !== scopeNow()) return null;
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
        action(view === 'favorites' ? '取消收藏' : '收藏', () => updateGroups(chosen, { favorite: view !== 'favorites' }, scope)),
        action(view === 'trash' ? '恢复' : source.mode() === 'folder' ? '从列表隐藏' : '移至回收站', () => changeTrash(chosen, view === 'trash' ? 'restore' : 'trash', scope, items)),
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
      const fileTitle = group.files.length === 1 && !group.poster && !items[primary.path]?.title ? primary.path.split('/').pop() : group.title;
      const formats = element('div', { className: 'ws-formats' });
      if (view !== 'trash' && group.files.length > 1) for (const file of group.files) formats.append(action(file.path.split('/').pop(), () => openFile(file.path)));
      if (view !== 'trash' && group.poster) {
        for (const [label, entries] of [['源文件', group.poster.sourceFiles], ['历史稿', group.poster.historyFiles]]) {
          if (!entries.length) continue; // 没有以前的成品就不显示“历史稿（0）”
          const detail = element('details', { className: 'ws-poster-files' }, element('summary', { textContent: label + `（${entries.length}）` }));
          detail.onclick = event => event.stopPropagation();
          for (const file of entries) {
            const button = action(workspace.ext(file.path).toUpperCase() + ' · ' + file.path.split('/').slice(-2).join(' / '), () => { assertScope(scope); return openFile(file.path); });
            button.title = file.path;
            detail.append(button);
          }
          formats.append(detail);
        }
        formats.prepend(element('span', { textContent: group.poster.quality === 'complete' ? '成品海报' : '候选海报 · 待核验' }));
      }
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
      const activate = view === 'trash' ? () => manage(group, scope, items) : () => openFile(primary.path);
      row.onclick = activate;
      row.onkeydown = (event) => {
        if (event.target === row && ['Enter', ' '].includes(event.key)) {
          event.preventDefault();
          activate();
        }
      };
      return row;
    });
    list.replaceChildren(
      ...(trashError ? [element('li', { className: 'empty', textContent: trashError })] : []),
      ...(rows.length
        ? rows
        : trashError ? [] : [
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
    return { groups: groups.length, files: groups.reduce((sum, group) => sum + group.files.length, 0), total: files.length, processCount };
  }
  return {
    control,
    render,
    setHidden: (hidden) => {
      more.hidden = hidden || !hasMore;
    }
  };
}

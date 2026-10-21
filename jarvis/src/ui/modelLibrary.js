/** 模型库主界面：服务商卡片与常用型号，完整目录按搜索和分页显示。 */
import './modelLibrary.css';
import { PROVIDERS, providerById } from '../../shared/providers.js';
import {
  boundedIds,
  configuredProviders,
  providerLabel,
  catalogKey,
  favoriteLines,
  currentLine,
  sameLine,
  toggleFavorite,
  toggleBackup,
  saveCatalog,
  hasRouting
} from '../llm/modelLibrary.js';
import { modelKind } from '../llm/images.js';
import { deepseekSearchPanel } from './deepseekSearchPanel.js';
import { documentStylesPanel } from './documentStylesPanel.js';

export const node = (tag, props = {}, ...children) => {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children.filter((child) => child !== null && child !== undefined));
  return element;
};
const button = (text, action, className = 'ml-button') => {
  const element = node('button', { type: 'button', className, textContent: text });
  element.addEventListener('click', action);
  return element;
};

export function initModelLibrary({ root, workspace, toast }) {
  let catalogProvider = '';
  let query = '';
  let category = 'chat';
  let page = 1;
  let notice = '';
  let generation = 0;
  let busy = false;
  let pullController = null;
  const run = async (action) => {
    if (busy) return;
    busy = true;
    try {
      await action();
    } catch (error) {
      notice = error.name === 'AbortError' ? '已停止拉取' : error.message;
    } finally {
      busy = false;
      render();
    }
  };
  const patch = (update) => run(() => workspace.patch(update));

  function modelRow(cfg, provider, model, { catalog = false } = {}) {
    const line = { provider, model };
    const active = sameLine(currentLine(cfg), line);
    const favorite = favoriteLines(cfg).some((item) => sameLine(item, line));
    const backup = (cfg.fallbackModels || []).findIndex((item) => sameLine(item, line));
    const row = node('div', { className: 'ml-model' });
    row.dataset.model = model;
    row.append(node('span', { className: 'ml-model-title', textContent: model, title: model }));
    if (active) row.append(node('span', { className: 'ml-badge', textContent: '默认' }));
    if (backup >= 0) row.append(node('span', { className: 'ml-badge secondary', textContent: `备用 ${backup + 1}` }));
    const star = button(favorite ? '★' : '☆', () => patch((value) => toggleFavorite(value, line)), 'ml-star');
    star.title = favorite ? '取消常用' : '加入常用';
    star.setAttribute('aria-label', `${star.title} ${model}`);
    star.disabled = active;
    row.append(star);
    if (modelKind(model) === 'chat') {
      const use = button(active ? '使用中' : '设默认', () => run(() => workspace.choose(line)), 'ml-small');
      use.disabled = active;
      row.append(use);
      if (!active) row.append(button(backup >= 0 ? '移除备用' : '设备用', () => patch((value) => toggleBackup(value, line)), 'ml-small'));
    } else if (catalog && ['image', 'video'].includes(modelKind(model))) {
      const kind = modelKind(model);
      const media = button(
        kind === 'image' ? '用于画图' : '用于视频',
        () => patch((value) => ({ ...value, [kind === 'image' ? 'imageModel' : 'videoModel']: model })),
        'ml-small'
      );
      media.disabled = provider !== cfg.provider;
      media.title = provider === cfg.provider ? '不改变对话模型' : '请先选用该服务商的对话模型，再配置其生成型号';
      row.append(media);
    } else if (catalog) row.append(node('small', { textContent: '请在对应功能中配置' }));
    return row;
  }

  function editProvider(cfg, provider, host) {
    const meta = providerById(provider);
    const alias = node('input', { value: providerLabel(cfg, provider), maxLength: 40, ariaLabel: '服务商名称' });
    const address = node('input', {
      value: cfg.baseURLs?.[provider] || meta.baseURL || '',
      placeholder: 'https://…/v1',
      ariaLabel: '接口地址',
      disabled: !meta.custom
    });
    const secret = node('input', {
      type: 'password',
      placeholder: cfg.keys?.[provider] ? '已配置；留空保留原密钥' : '填写 API Key',
      autocomplete: 'off',
      ariaLabel: 'API Key'
    });
    const model = node('input', { placeholder: '手动添加完整模型 ID（可选）', maxLength: 200, ariaLabel: '手动模型 ID' });
    const save = button('保存服务商', () =>
      run(async () => {
        if (meta.custom) {
          let url;
          try {
            url = new URL(address.value.trim());
          } catch {
            throw Object.assign(new Error('请填写有效接口地址'), { kind: 'api', code: 'INVALID_BASE_URL' });
          }
          if (!/^https?:$/.test(url.protocol) || url.username || url.password)
            throw Object.assign(new Error('接口地址必须是HTTP或HTTPS，不能包含账号密码'), { kind: 'api', code: 'INVALID_BASE_URL' });
        }
        await workspace.patch((value) => {
          let next = {
            ...value,
            providerNames: { ...value.providerNames, [provider]: alias.value.trim().slice(0, 40) || meta.name },
            ...(meta.custom && { baseURLs: { ...value.baseURLs, [provider]: address.value.trim() } }),
            ...(secret.value.trim() && { keys: { ...value.keys, [provider]: secret.value.trim() } })
          };
          const id = model.value.trim();
          if (id) {
            next = saveCatalog(next, provider, [...(next.modelLists?.[catalogKey(next, provider)]?.ids || []), id]);
            if (!favoriteLines(next).some((item) => sameLine(item, { provider, model: id }))) next = toggleFavorite(next, { provider, model: id });
          }
          return next;
        });
        secret.value = '';
        notice = '已保存；当前默认模型不变';
      })
    );
    host.append(
      node(
        'div',
        { className: 'ml-editor' },
        node('label', {}, '服务商名称', alias),
        node('label', {}, '接口地址', address),
        node('label', {}, '密钥', secret),
        node('label', {}, '手动型号', model),
        save
      )
    );
  }

  async function pull(provider) {
    const target = workspace.scope;
    pullController = new AbortController();
    notice = '正在拉取模型…';
    render();
    try {
      const result = await workspace.catalog(provider, pullController.signal, target);
      await workspace.patch((cfg) => saveCatalog(cfg, provider, result.ids), target);
      catalogProvider = provider;
      query = '';
      page = 1;
      notice = `已拉取 ${result.ids.length} 个型号；默认模型未改变`;
    } finally {
      pullController = null;
    }
  }

  function providerCard(cfg, meta) {
    const card = node('section', { className: 'ml-provider' });
    const configured = cfg.keys?.[meta.id] || workspace.gateway()?.keys?.includes(meta.id) || meta.needsKey === false;
    const label = providerLabel(cfg, meta.id);
    const icon = label.match(/[A-Za-z0-9]+$/)?.[0].slice(0, 2) || label.slice(0, 1);
    const head = node(
      'div',
      { className: 'ml-provider-head' },
      node('span', { className: 'ml-provider-icon', textContent: icon }),
      node(
        'div',
        { className: 'ml-provider-name' },
        node('strong', { textContent: label }),
        node('small', { textContent: `${configured ? '密钥已配置' : '待配置密钥'} · ${workspace.scope === 'server' ? '服务器' : '本机'}` })
      )
    );
    head.append(
      button(
        '配置 ›',
        () => {
          const existing = card.querySelector('.ml-editor');
          if (existing) existing.remove();
          else editProvider(cfg, meta.id, card);
        },
        'ml-link'
      )
    );
    card.append(head);
    card.append(button('拉取模型', () => run(() => pull(meta.id)), 'ml-pull'));
    card.append(node('small', { className: 'ml-section-label', textContent: '常用模型' }));
    const lines = favoriteLines(cfg).filter((item) => item.provider === meta.id);
    card.append(...lines.map((line) => modelRow(cfg, line.provider, line.model)));
    if (!lines.length) card.append(node('p', { className: 'ml-muted', textContent: '拉取后收藏常用型号，或在配置中手动添加。' }));
    const total = cfg.modelLists?.[catalogKey(cfg, meta.id)]?.ids?.length || 0;
    card.append(
      button(
        `管理全部模型${total ? ` · ${total}` : ''} ›`,
        () => {
          catalogProvider = catalogProvider === meta.id ? '' : meta.id;
          page = 1;
          query = '';
          render();
        },
        'ml-manage'
      )
    );
    if (catalogProvider === meta.id) renderCatalog(cfg, meta.id, card);
    return card;
  }

  function renderCatalog(cfg, provider, card) {
    const search = node('input', { type: 'search', placeholder: '搜索完整模型 ID', value: query, ariaLabel: '搜索全部模型' });
    const select = node(
      'select',
      { ariaLabel: '模型类别' },
      ...[
        ['chat', '对话'],
        ['image', '画图'],
        ['video', '视频'],
        ['audio', '语音'],
        ['embed', '向量'],
        ['all', '全部']
      ].map(([value, textContent]) => node('option', { value, textContent }))
    );
    select.value = category;
    const results = node('div', { className: 'ml-catalog-results' });
    const paint = () => {
      const ids = boundedIds(cfg.modelLists?.[catalogKey(cfg, provider)]?.ids).filter(
        (id) => (category === 'all' || modelKind(id) === category) && id.toLowerCase().includes(query.toLowerCase())
      );
      results.replaceChildren(...ids.slice(0, page * 12).map((id) => modelRow(cfg, provider, id, { catalog: true })));
      results.append(node('p', { className: 'ml-muted', textContent: `${ids.length} 个匹配 · 分类仅按型号名称识别，不代表实测能力` }));
      if (ids.length > page * 12)
        results.append(
          button(
            '显示更多',
            () => {
              page++;
              paint();
            },
            'ml-manage'
          )
        );
    };
    search.addEventListener('input', () => {
      query = search.value;
      page = 1;
      paint();
    });
    select.addEventListener('change', () => {
      category = select.value;
      page = 1;
      paint();
    });
    card.append(node('div', { className: 'ml-catalog' }, node('div', { className: 'ml-search-row' }, search, select), results));
    paint();
  }

  function renderDocumentReviewer(cfg) {
    const lines = favoriteLines(cfg);
    const selected = cfg.documentReviewer;
    if (selected && !lines.some((line) => sameLine(line, selected))) lines.push(selected);
    const select = node(
      'select',
      { ariaLabel: '文档审查模型' },
      node('option', { value: '', textContent: '沿用写作模型（同模型自查）' }),
      ...lines.map((line, index) =>
        node('option', { value: String(index), textContent: `${providerLabel(cfg, line.provider)} · ${line.model}` })
      )
    );
    select.value = selected ? String(lines.findIndex((line) => sameLine(line, selected))) : '';
    select.addEventListener('change', () => {
      const line = select.value === '' ? null : lines[Number(select.value)];
      patch((value) => ({ ...value, documentReviewer: line ? { provider: line.provider, model: line.model } : null }));
    });
    root.append(
      node('h3', { textContent: '模型分工 · 文档审查' }),
      node('p', {
        className: 'ml-muted',
        textContent: '只用于专业文档内容审查，不改变聊天模型。先将审查型号加入常用；可跨服务商，按所选服务商计费。选择与写作不同的型号才是不同模型审查。'
      }),
      select
    );
  }

  function render() {
    if (!root) return;
    const cfg = workspace.config();
    const tabs = node(
      'div',
      { className: 'ml-tabs', role: 'group', ariaLabel: '正在修改的配置位置' },
      ...[
        ['local', '本机'],
        ['server', '云服务器']
      ].map(([value, title]) => {
        const tab = button(
          title,
          () => {
            if (!busy) {
              catalogProvider = '';
              run(() => workspace.selectScope(value));
            }
          },
          workspace.scope === value ? 'selected' : ''
        );
        tab.setAttribute('aria-pressed', String(workspace.scope === value));
        return tab;
      })
    );
    const caption = workspace.scope === 'server' ? '正在修改服务器配置，不影响本机' : '正在修改本机配置，不影响服务器';
    root.replaceChildren(
      node('p', { className: 'ml-muted', textContent: '配置按运行位置独立保存' }),
      tabs,
      node('p', { className: 'ml-scope-note', textContent: caption })
    );
    const server = workspace.serverSettings;
    if (workspace.scope === 'server')
      root.append(node('p', { className: 'ml-connection', textContent: cfg ? `${server.url} · 配置已读取` : '尚未连接，请到设置 → 服务器模式登录' }));
    const message = node('p', { className: 'ml-notice', role: 'status', textContent: notice });
    root.append(message);
    if (pullController) root.append(button('停止拉取', () => pullController.abort(), 'ml-link'));
    if (!cfg) return;
    renderDocumentReviewer(cfg);
    root.append(documentStylesPanel({ workspace, node }));
    root.append(deepseekSearchPanel({ cfg, workspace, node, toast }));
    if (hasRouting(cfg))
      root.append(
        node('p', { className: 'ml-notice', textContent: '高级分工已开启，实际模型可能按任务变化。' }),
        button('统一使用默认模型', () => patch((value) => ({ ...value, routing: { ...value.routing, enabled: false } })), 'ml-link')
      );
    root.append(node('div', { className: 'ml-provider-grid' }, ...configuredProviders(cfg, workspace.gateway()?.keys).map((meta) => providerCard(cfg, meta))));
    const add = node(
      'select',
      { ariaLabel: '添加服务商', className: 'ml-add-select' },
      node('option', { value: '', textContent: '＋ 添加服务商…' }),
      ...PROVIDERS.filter((meta) => meta.kind !== 'mock' && !configuredProviders(cfg).some((item) => item.id === meta.id)).map((meta) =>
        node('option', { value: meta.id, textContent: meta.name })
      )
    );
    add.addEventListener('change', () => {
      if (add.value) patch((value) => ({ ...value, providerNames: { ...value.providerNames, [add.value]: providerById(add.value).name } }));
    });
    root.append(add);
    const backups = cfg.fallbackModels || [];
    root.append(
      node('p', {
        className: 'ml-muted',
        textContent:
          cfg.fallbackPolicy === 'explicit'
            ? `故障回退：${backups.length ? backups.map((line) => `${providerLabel(cfg, line.provider)} · ${line.model}`).join(' → ') : '已关闭自动切换'}。不会轮询。`
            : '沿用旧版备用规则。可设置明确备用，或关闭自动切换。'
      })
    );
    root.append(button('关闭自动切换', () => patch((value) => ({ ...value, fallbackPolicy: 'explicit', fallbackModels: [] })), 'ml-link'));
    if (workspace.scope === 'server') {
      const preview = node(
        'details',
        { className: 'ml-copy' },
        node('summary', { textContent: '从本机复制模型配置' }),
        node('p', { className: 'ml-muted', textContent: '将覆盖服务器的默认模型、文档审查、服务商同名配置、常用和备用；包含本机已填写的模型密钥，不复制声音设置。' }),
        node('p', {
          className: 'ml-muted',
          textContent: `本机默认：${providerLabel(workspace.config('local'), workspace.config('local').provider)} · ${currentLine(workspace.config('local')).model}`
        }),
        button('复制到服务器', () =>
          run(async () => {
            await workspace.copyLocal();
            notice = '已复制到服务器，本机配置保留';
          })
        )
      );
      root.append(preview);
    }
    root.querySelectorAll('button,input,select').forEach((control) => {
      if (busy && control.textContent !== '停止拉取') control.disabled = true;
    });
  }

  async function refresh() {
    const ticket = ++generation;
    notice = '正在读取配置…';
    render();
    try {
      await workspace.refresh();
      if (ticket === generation) notice = '';
    } catch (error) {
      if (ticket === generation) notice = error.message;
    }
    if (ticket === generation) render();
  }
  return { refresh };
}

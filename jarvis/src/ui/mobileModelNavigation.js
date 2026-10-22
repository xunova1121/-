import { providerLabel, hasRouting } from '../llm/modelLibrary.js';

  /** 手机将三类任务分开；切页不保存配置，也不改变任务运行位置。 */
export function mobileModelNavigation({ cfg, workspace, node, button, run, root, providers, mobilePage, catalogProvider, showPage, chooseProvider, pullModels, catalog }) {
    const nav = node('nav', { className: 'mc-nav', ariaLabel: '模型中心分类' });
    const pages = {};
    for (const [id, label] of [['abilities', '能力'], ['providers', '服务商'], ['catalog', '模型库']]) {
      const tab = button(label, () => showPage(id), 'mc-nav-tab');
      tab.setAttribute('aria-pressed', String(mobilePage === id));
      nav.append(tab);
      pages[id] = node('section', { className: 'mc-page', hidden: mobilePage !== id });
      pages[id].dataset.modelPage = id;
    }
    root.append(nav, pages.abilities, pages.providers, pages.catalog);
    const pinned = Boolean(cfg.pinModel);
    const legacy = !pinned && hasRouting(cfg);
    const smart = node('div', { className: 'mc-smart' },
      node('span', { className: 'mc-smart-icon', textContent: '✧', ariaHidden: 'true' }),
      node('div', {}, node('strong', { textContent: pinned ? '固定模型' : legacy ? '高级分工' : '智能选择' }),
        node('p', { textContent: pinned ? '对话已固定型号，能力配置保留' : legacy ? '沿用已保存的高级路由' : '按已配置的能力分工选择模型' })),
      node('span', { className: 'mc-smart-state', textContent: pinned ? '已固定' : '已启用' }));
    if (pinned) smart.append(button('恢复智能', () => run(() => workspace.patch((value) => ({ ...value, pinModel: false, routing: { ...value.routing, enabled: false } }))), 'ml-link'));
    pages.abilities.append(smart);
    pages.catalog.append(node('h3', { className: 'mc-section-title', textContent: '模型库' }), node('p', { className: 'ml-muted', textContent: '先选择服务商，再搜索型号；同名型号按服务商分别保存。' }));
    const chips = node('div', { className: 'mc-provider-chips', role: 'group', ariaLabel: '模型库服务商' });
    for (const meta of providers) {
      const chip = button(providerLabel(cfg, meta.id), () => chooseProvider(meta.id), 'mc-provider-chip');
      chip.setAttribute('aria-pressed', String(catalogProvider === meta.id));
      chips.append(chip);
    }
    pages.catalog.append(chips);
    if (catalogProvider) {
      pages.catalog.append(button('拉取模型', pullModels, 'ml-pull'));
      catalog(pages.catalog);
    }
    return pages;
  }


/**
 * 未来创梦 —— 前端外壳：路由、全局状态、顶部信号链。
 * 无构建、无框架，浏览器直接跑 ES 模块。
 */
import { h, $, clear, api, toast } from './lib.js';

import studio from './views/studio.js';
import bible from './views/bible.js';
import debug from './views/debug.js';
import providersView from './views/providers.js';
import logs from './views/logs.js';
import settingsView from './views/settings.js';

const VIEWS = [
  { id: 'studio', label: '创作台', view: studio },
  { id: 'bible', label: '设定集', view: bible },
  { id: 'debug', label: 'API 联调台', view: debug },
  { id: 'providers', label: '服务商与密钥', view: providersView },
  { id: 'logs', label: '请求记录', view: logs },
  { id: 'settings', label: '设置', view: settingsView }
];

/** 全局状态。视图之间共享的只有这些，够简单，不需要状态库。 */
export const state = {
  catalog: null,
  health: null,
  projectId: localStorage.getItem('fd.projectId') || null,
  current: localStorage.getItem('fd.view') || 'studio'
};

export async function refreshCatalog() {
  const [catalog, health] = await Promise.all([api('/catalog'), api('/health')]);
  state.catalog = catalog;
  state.health = health;
  paintFooter();
  paintChain();
  return catalog;
}

function paintFooter() {
  const { health, catalog } = state;
  const dataDir = $('#foot-datadir');
  dataDir.textContent = health.dataDir.split(/[\\/]/).slice(-2).join('/');
  dataDir.title = health.dataDir;

  const vault = $('#foot-vault');
  const dpapi = health.vaultBackend === 'dpapi';
  vault.textContent = dpapi ? 'DPAPI' : 'AES-256';
  vault.title = dpapi
    ? '由 Windows DPAPI 加密，密钥绑当前用户账户'
    : '本地 AES-256-GCM 加密（命令行模式）。在桌面应用里打开可升级为 DPAPI';

  const ff = $('#foot-ffmpeg');
  ff.textContent = catalog.ffmpeg.available ? catalog.ffmpeg.source : '未安装';
  ff.title = catalog.ffmpeg.available ? catalog.ffmpeg.version : catalog.ffmpeg.hint;
  ff.style.color = catalog.ffmpeg.available ? 'var(--good)' : 'var(--caution)';
}

/** 顶部信号链：一眼看清每种能力落到了哪家。排错时最先看这里。 */
function paintChain() {
  const chain = clear($('#chain'));
  const labels = { chat: '剧本', vision: '复核', image: '出图', video: '视频', tts: '配音' };
  const providers = Object.fromEntries(state.catalog.providers.map((p) => [p.id, p]));
  for (const [cap, label] of Object.entries(labels)) {
    const route = state.catalog.routing[cap];
    const provider = providers[route?.provider];
    const ready = provider?.credentials?.ready;
    chain.append(
      h(
        'span',
        {
          class: `chain-seg ${ready ? '' : 'off'}`,
          title: ready
            ? `${provider.name} / ${route.model}`
            : `${provider?.name || route?.provider || '未配置'} —— 缺少密钥，去「服务商与密钥」补上`
        },
        `${label} `,
        h('b', {}, provider ? provider.id : '—')
      )
    );
  }
}

function paintNav() {
  const nav = clear($('#nav'));
  VIEWS.forEach((v, i) => {
    nav.append(
      h(
        'button',
        {
          class: `nav-item ${state.current === v.id ? 'active' : ''}`,
          onclick: () => go(v.id)
        },
        h('span', { class: 'nav-num' }, String(i + 1).padStart(2, '0')),
        h('span', {}, v.label)
      )
    );
  });
}

export async function go(id) {
  const entry = VIEWS.find((v) => v.id === id) || VIEWS[0];
  state.current = entry.id;
  localStorage.setItem('fd.view', entry.id);
  $('#view-title').textContent = entry.label;
  paintNav();

  const host = clear($('#view-inner'));
  host.append(h('div', { class: 'empty' }, '载入中…'));
  try {
    const node = await entry.view.render({ state, go, refreshCatalog });
    clear(host).append(node);
  } catch (err) {
    clear(host).append(
      h('div', { class: 'empty' }, h('b', {}, '这个页面没能打开'), err.message)
    );
  }
}

function initTheme() {
  const saved = localStorage.getItem('fd.theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  $('#btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('fd.theme', next);
  });
}

async function boot() {
  initTheme();
  $('#btn-refresh').addEventListener('click', async () => {
    await refreshCatalog();
    await go(state.current);
    toast('已刷新', 'ok');
  });

  try {
    await refreshCatalog();
  } catch (err) {
    toast(`连不上本地服务：${err.message}`, 'err');
    return;
  }
  await go(state.current);
}

boot();

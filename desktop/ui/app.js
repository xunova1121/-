/**
 * 未来创梦 —— 前端外壳：路由、全局状态、顶部信号链。
 * 无构建、无框架，浏览器直接跑 ES 模块。
 */
import { h, $, clear, api, toast } from './lib.js';

import projectsView from './views/projects.js';
import studio from './views/studio.js';
import bible from './views/bible.js';
import debug from './views/debug.js';
import providersView from './views/providers.js';
import logs from './views/logs.js';
import settingsView from './views/settings.js';

const VIEWS = [
  { id: 'projects', label: '项目', view: projectsView },
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
  /** 开机自检的结果：{ checkedAt, capabilities: { chat: {ok,reason,...} } } */
  routingCheck: null,
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
    // 开机自检的结果：null = 还没探 / 这家没探针，true = 通，false = 不通
    const checked = state.routingCheck?.capabilities?.[cap];
    const bad = ready && checked && checked.ok === false;
    chain.append(
      h(
        'span',
        {
          class: `chain-seg ${ready ? '' : 'off'} ${bad ? 'bad' : checked?.ok ? 'good' : ''}`,
          title: !ready
            ? `${provider?.name || route?.provider || '未配置'} —— 缺少密钥，去「服务商与密钥」补上`
            : bad
              ? `${provider.name} / ${route.model}\n✕ 连不通：${checked.reason}`
              : checked?.ok
                ? `${provider.name} / ${route.model}\n✓ 已连通${checked.latencyMs ? `（${checked.latencyMs}ms）` : ''}`
                : `${provider.name} / ${route.model}`
        },
        `${label} `,
        h('b', {}, provider ? provider.id : '—'),
        bad ? h('span', { style: 'color:var(--alarm)' }, ' ✕') : checked?.ok ? h('span', { style: 'color:var(--good)' }, ' ✓') : null
      )
    );
  }
}

/**
 * 打开应用时自动探一遍当前路由到的服务商。
 *
 * 为什么值得做：配置坏了的代价不是"自检红一下"，而是你兴冲冲跑到第 04 步、
 * 等了两分钟、才被告知密钥没配 —— 那两分钟和那次失败都是白花的。
 * **问题应该在你下手之前就摆在眼前。**
 *
 * 只发各家最便宜的探针（列模型 / max_tokens=1 / 列任务），不出图不出视频，
 * 所以自动跑没有代价。跑在后台，不挡着界面先出来。
 */
export async function runRoutingCheck({ silent = false } = {}) {
  try {
    state.routingCheck = await api('/routing/check', { method: 'POST' });
  } catch (err) {
    state.routingCheck = { error: err.message, capabilities: {} };
    return state.routingCheck;
  }
  paintChain();
  paintRoutingBanner();
  if (!silent) {
    const bad = badRoutes();
    if (bad.length) {
      toast(`${bad.map((b) => b.label).join('、')} 连不通，先去「服务商与密钥」看看`, 'err');
    }
  }
  return state.routingCheck;
}

const CAP_LABELS = { chat: '剧本与分镜', vision: '一致性复核', image: '出图', video: '视频', tts: '配音' };

export function badRoutes() {
  const caps = state.routingCheck?.capabilities || {};
  return Object.entries(caps)
    .filter(([, v]) => v.ok === false)
    .map(([cap, v]) => ({ cap, label: CAP_LABELS[cap] || cap, ...v }));
}

/**
 * 顶部横幅。toast 会自己消失，而"密钥没配"是个**持续的状态**，
 * 不该在你去泡杯茶的功夫里悄悄划过去。
 */
function paintRoutingBanner() {
  const host = $('#route-banner');
  if (!host) return;
  clear(host);
  const bad = badRoutes();
  if (!bad.length) {
    host.style.display = 'none';
    return;
  }
  host.style.display = '';

  /**
   * 按**服务商**归并，不按能力列。
   *
   * 一把密钥填错，会同时让复核、出图、视频三条能力都红 —— 逐条列的话，
   * 同一句"API Key 无效"会重复三遍，看起来像三个问题，其实只有一个。
   * 归并之后是"这一家不通，影响这三条"，和事实一致，也知道该去改哪儿。
   */
  const byProvider = new Map();
  for (const b of bad) {
    const key = b.provider || '未配置';
    if (!byProvider.has(key)) byProvider.set(key, { name: b.providerName || key, caps: [], reason: b.reason });
    byProvider.get(key).caps.push(b.label);
  }

  host.append(
    h('b', {}, `${byProvider.size} 家服务商连不通`),
    h('span', {},
      [...byProvider.values()].map((p) =>
        h('div', { title: p.reason },
          h('b', { style: 'color:var(--ink)' }, p.name),
          `（${p.caps.join('、')}）：`,
          // 长诊断只留第一句，完整的挂在 title 上 —— 横幅是提醒，不是报告
          (p.reason || '').split(/[。\n]/)[0]))),
    h('button', {
      class: 'btn ghost sm',
      onclick: () => {
        localStorage.setItem('fd.view', 'providers');
        location.reload();
      }
    }, '去配密钥'),
    h('button', {
      class: 'btn ghost sm',
      onclick: (e) => {
        e.target.disabled = true;
        runRoutingCheck().finally(() => (e.target.disabled = false));
      }
    }, '重新检测')
  );
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

/** 起不来时也要给出下一步，而不是一句"连不上" */
function showBootError(reachable, message) {
  if (reachable) {
    toast(`本地服务是通的，但有一项没读出来：${message}`, 'err');
    return;
  }
  const host = $('#view-inner');
  if (host) {
    clear(host).append(
      h('div', { class: 'empty' },
        h('b', {}, '连不上本地服务'),
        h('div', {}, message),
        h('div', { style: 'margin-top:10px;font-size:12px' },
          '常见原因：启动.bat 那个黑窗口被关掉了，或者端口被别的程序占用。把窗口重开一次即可。'))
    );
  }
  toast(`连不上本地服务：${message}`, 'err');
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
    // 刷新时顺手重探一遍：多半就是刚去改完密钥或 baseUrl 回来的
    if (state.catalog?.settings?.autoCheckOnStart !== false) runRoutingCheck({ silent: true });
  });

  try {
    await refreshCatalog();
  } catch (err) {
    // "连不上"和"接口报错"是两回事。早期版本一律说成前者，
    // 于是一份读不出来的密钥文件被报成"连不上本地服务"——
    // 服务好好的，用户却被堵在门外，连进去重填密钥的机会都没有。
    const reachable = await fetch('/api/health').then((r) => r.ok).catch(() => false);
    showBootError(reachable, err.message);
    // 服务是通的就照常进界面：具体哪个页面能不能用，让那个页面自己说
    if (reachable) await go(state.current);
    return;
  }
  await go(state.current);

  /**
   * 开机自检放在**界面出来之后**跑，而且不 await ——
   * 它要发好几个网络请求，挡在前面的话，网络慢时应用看起来像卡死了。
   * 结果回来再回填到信号链和顶部横幅上。
   */
  if (state.catalog?.settings?.autoCheckOnStart !== false) {
    runRoutingCheck();
  }
}

boot();

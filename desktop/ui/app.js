/**
 * 未来创梦 —— 前端外壳：路由、全局状态、顶部信号链。
 * 无构建、无框架，浏览器直接跑 ES 模块。
 */
import { h, $, clear, api, toast } from './lib.js';
import { stepsOf, stepProgress, stepState } from './pipeline.js';

import projectsView from './views/projects.js';
import studio from './views/studio.js';
import debug from './views/debug.js';
import providersView from './views/providers.js';
import logs from './views/logs.js';
import settingsView from './views/settings.js';

const VIEWS = [
  { id: 'projects', label: '项目', view: projectsView },
  { id: 'studio', label: '创作台', view: studio },
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
  current: localStorage.getItem('fd.view') || 'studio',
  /**
   * 当前在流水线的哪一步。放在全局而不是创作台的闭包里 ——
   * 左边菜单要靠它高亮，创作台要靠它决定显示哪一块。
   */
  stage: localStorage.getItem('fd.stage') || 'script-src',
  /** 当前项目的快照，只给左边菜单算对勾用。创作台跑完一步会更新它并重画菜单 */
  project: null
};

/** 换一步：菜单和创作台共用这一条路 */
export function goStage(id) {
  state.stage = id;
  localStorage.setItem('fd.stage', id);
  if (state.current !== 'studio') {
    go('studio');
    return;
  }
  paintNav();
  window.dispatchEvent(new CustomEvent('fd:stage', { detail: { id } }));
}

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
  const labels = { chat: '剧本', director: '调度', vision: '复核', image: '出图', video: '视频', tts: '配音' };
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
/**
 * 闲置多久之后重探一次。
 *
 * 为什么要重探：密钥会过期、额度会用完、公司网络会断 —— 而这些都发生在
 * 你没动应用的那段时间里。开机探过一次就再也不管，等于只在第一分钟是准的。
 *
 * 只在**闲置**之后探，不按固定周期探：你正在敲字的时候没必要打扰，
 * 而离开一阵子回来正是最该确认一下的时刻。
 */
const IDLE_RECHECK_MS = 20 * 60 * 1000;
let lastActivity = Date.now();
let idleTimer = null;

function markActivity() {
  lastActivity = Date.now();
}

function startIdleWatch() {
  for (const ev of ['mousedown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(ev, markActivity, { passive: true });
  }
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (state.catalog?.settings?.autoCheckOnStart === false) return;
    if (Date.now() - lastActivity < IDLE_RECHECK_MS) return;
    // 探完把计时重新起头，免得一直闲置时每分钟探一次
    lastActivity = Date.now();
    runRoutingCheck({ silent: true });
  }, 60 * 1000);
}

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

const CAP_LABELS = {
  chat: '剧本与分镜',
  director: '调度（挑技法 / 绑说话人）',
  vision: '一致性复核',
  image: '出图',
  video: '视频',
  tts: '配音'
};

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
/**
 * 关掉过的那批问题。
 *
 * 存的不是"关没关"这个布尔，而是**关掉的是哪一批问题**。
 * 只存布尔的话，每次自动重探都会把它清掉 —— 密钥一直没配的话，
 * 你点一次「知道了」，二十分钟后它又冒出来，点多少次都一样。
 * 那不是提醒，那是骚扰。
 *
 * 存签名之后：同一批问题只提醒一次；出现**新的**问题才重新亮出来。
 * 存进 localStorage，重开应用也记得 —— 你昨天说过知道了。
 */
const DISMISS_KEY = 'fd.routeBannerDismissed';

function failureSignature(bad) {
  return bad.map((b) => `${b.provider}:${b.reason}`).sort().join('|');
}

function isDismissed(bad) {
  try {
    return localStorage.getItem(DISMISS_KEY) === failureSignature(bad);
  } catch {
    return false;
  }
}

function paintRoutingBanner() {
  const host = $('#route-banner');
  if (!host) return;
  clear(host);
  const bad = badRoutes();
  if (!bad.length) {
    // 全通了就把"知道了"的记号清掉 —— 下次真出问题时才提醒得动
    try {
      localStorage.removeItem(DISMISS_KEY);
    } catch {
      /* 无所谓 */
    }
    host.style.display = 'none';
    return;
  }
  if (isDismissed(bad)) {
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
    }, '重新检测'),
    // 明知道没配也想先干别的，是很正常的事 —— 给一个关掉的口子。
    // 只关这一次；下次探出新结果还会回来。
    h('button', {
      class: 'btn ghost sm',
      title: '这批问题不用再提醒了。出现新的问题才会再冒出来',
      onclick: () => {
        try {
          localStorage.setItem(DISMISS_KEY, failureSignature(bad));
        } catch {
          /* 隐私模式下写不了 localStorage，那就只关这一次 */
        }
        paintRoutingBanner();
      }
    }, '知道了'),
    h('button', {
      class: 'btn ghost sm',
      title: '以后打开应用不再自动检测（「设置 → 本机环境」里可以再打开）',
      onclick: async () => {
        await api('/settings', { method: 'POST', body: { autoCheckOnStart: false } });
        if (state.catalog?.settings) state.catalog.settings.autoCheckOnStart = false;
        try {
          localStorage.setItem(DISMISS_KEY, failureSignature(bad));
        } catch {
          /* 写不了就算了 */
        }
        paintRoutingBanner();
        toast('已关掉自动检测，可在「设置 → 本机环境」再打开', 'ok');
      }
    }, '不再自动检测')
  );
}

/**
 * 左边菜单 = 页面 + **流水线**。
 *
 * 流水线挂在「创作台」下面，每一步后面跟着完成标记（✓ 齐了 / ◗ 差一些 / 空着没跑）。
 * 这样两件事在同一处解决：现在做到哪一步了，以及点哪儿能到那一步。
 * 早先流水线是创作台页里的一条横向轨道，而那一页从剧本一路铺到分镜网格 ——
 * 想点第 04 步得先滚过三屏，这是最浪费时间的一种设计。
 */
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
    if (v.id === 'studio') nav.append(paintPipelineNav());
  });
}

function paintPipelineNav() {
  const box = h('div', { class: 'nav-sub' });
  const project = state.project;
  if (!project) {
    box.append(h('div', { class: 'nav-sub-empty' }, '选一个项目后，这里显示流水线'));
    return box;
  }
  stepsOf(state.catalog).forEach((step, i) => {
    const st = stepState(project, step.id);
    const { done, total } = stepProgress(project, step.id);
    box.append(
      h('button', {
        class: `nav-step ${st} ${state.current === 'studio' && state.stage === step.id ? 'active' : ''}`,
        title: step.hint || '',
        onclick: () => goStage(step.id)
      },
        h('span', { class: 'nav-step-num' }, String(i + 1).padStart(2, '0')),
        h('span', { class: 'nav-step-label' }, step.label),
        // 数字比对勾多一层信息："8/12" 一眼看出还差四张，而对勾只说"没齐"
        total > 1 ? h('span', { class: 'nav-step-count' }, `${done}/${total}`) : null,
        h('span', { class: 'nav-step-mark' }, st === 'done' ? '✓' : st === 'partial' ? '◗' : ''))
    );
  });
  return box;
}

/** 创作台跑完一步后喊一声，菜单上的对勾才跟着变 */
export function refreshPipelineNav(project) {
  if (project) state.project = project;
  paintNav();
}

/**
 * 视图之间靠事件说话，不互相 import —— app.js 已经 import 了每个视图，
 * 视图再反过来 import app.js 会绕成一个环。
 */
window.addEventListener('fd:project', (e) => refreshPipelineNav(e.detail?.project || null));
window.addEventListener('fd:goto-stage', (e) => {
  if (e.detail?.id) goStage(e.detail.id);
});

export async function go(id) {
  const entry = VIEWS.find((v) => v.id === id) || VIEWS[0];
  state.current = entry.id;
  localStorage.setItem('fd.view', entry.id);
  $('#view-title').textContent = entry.label;
  paintNav();

  const host = $('#view-inner');
  // 让上一次渲染有机会摘掉它挂在 window 上的监听
  host.firstElementChild?.dispatchEvent(new CustomEvent('fd:detach'));
  clear(host).append(h('div', { class: 'empty' }, '载入中…'));
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
  // 离开一阵子回来时再探一次：密钥过期、额度用完、网络断掉，
  // 都发生在你没动它的那段时间里
  startIdleWatch();
}

boot();

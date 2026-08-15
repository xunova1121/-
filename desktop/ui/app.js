/**
 * 未来创梦 —— 前端外壳：路由、全局状态、顶部信号链。
 * 无构建、无框架，浏览器直接跑 ES 模块。
 */
import { h, $, clear, api, toast, setAuthKey } from './lib.js';
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
  // 只有**手动点「重新检测」**时才吭声。开机自动探那一次一律安静 ——
  // 探针连不通有太多不是真问题的原因，为它弹一个红 toast 只会训练人无视提示
  if (!silent) {
    const bad = badRoutes();
    toast(
      bad.length ? `${bad.map((b) => b.label).join('、')} 连不通，去「服务商与密钥」看看` : '各家都连得通',
      bad.length ? 'err' : 'ok'
    );
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

/**
 * 顶部那条"服务商连不通"的横幅，默认**不再出现**。
 *
 * 它当初的理由是对的：配置坏了应该在你下手之前就知道。但实际用下来，
 * 探针连不通有太多**不是真问题**的原因 —— 公司网络慢、厂商临时抖一下、
 * 某家压根没提供便宜的探测接口。而一条常驻的红色横幅压在页面顶上，
 * 会让人很快学会无视所有横幅，包括真正要紧的那些。
 *
 * 信息本身没丢：顶部信号链上每条能力仍然带着 ✓ / ✕，鼠标悬停有原话，
 * 「设置 → 本机环境」里也能手动再探一次。真到跑不动的那一步，
 * 报错会带着服务端原话摊在失败框里 —— 那才是要读的时候。
 *
 * 想把横幅要回来：设置里打开 routeBannerOn（默认关）。
 */
function paintRoutingBanner() {
  const host = $('#route-banner');
  if (!host) return;
  clear(host);
  if (state.catalog?.settings?.routeBannerOn !== true) {
    host.style.display = 'none';
    return;
  }
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

const TOKEN_STORE = 'fd.accessToken';

/**
 * 访问口令那一屏。
 *
 * 只有**服务器模式**才会看到它：那时候这个服务在公网上，任何人都能打到端口，
 * 所以每一条请求都要带口令（见 core/deploy.js）。
 * 本机跑的时候一律不出现 —— 能打开 127.0.0.1 这个端口的人本来就坐在这台机器前，
 * 为他加一道口令只是白挡自己。
 */
function showLogin(reason = '') {
  const host = $('#view-inner');

  /**
   * 问什么，取决于这台服务处在哪个阶段：
   *
   *   还没建账号  问那串访问口令（启动日志里那个），并顺手让他把账号建了
   *   建过账号    问用户名密码
   *
   * 探不到就按"口令"办 —— 那是老行为，最坏情况下人还是进得去。
   * 界面能不能用，不该取决于一次探测成没成（这一条上次已经栽过一回）。
   */
  clear(host).append(h('div', { class: 'empty' }, '正在确认这台服务要什么…'));
  Promise.race([
    api('/mode').catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 2000))
  ]).then((info) => paintLogin(info?.auth === 'account' ? 'account' : 'token', reason));
}

function paintLogin(kind, reason) {
  const host = $('#view-inner');
  const wrap = h('div', { class: 'empty', style: 'max-width:420px;margin:8vh auto;text-align:left' });

  const field = (label, attrs) => {
    const input = h('input', { ...attrs, style: 'margin-top:6px' });
    return { input, node: h('div', { class: 'field', style: 'margin-top:12px' }, h('label', {}, label), input) };
  };

  if (kind === 'account') {
    const u = field('用户名', { type: 'text', autocomplete: 'username' });
    const p = field('密码', { type: 'password', autocomplete: 'current-password' });
    const go = h('button', { class: 'btn primary', style: 'margin-top:14px;width:100%' }, '登录');
    const submit = async () => {
      go.disabled = true;
      try {
        // cap:account-login
        const r = await api('/account/login', {
          method: 'POST',
          body: { user: u.input.value.trim(), password: p.input.value }
        });
        setAuthKey(r.token);
        localStorage.setItem(TOKEN_STORE, r.token);
        location.reload();
      } catch (err) {
        go.disabled = false;
        paintLogin('account', err.message || '登录失败');
      }
    };
    go.onclick = submit;
    p.input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
    wrap.append(
      h('b', { style: 'font-size:17px' }, '登录'),
      reason ? h('p', { style: 'color:var(--alarm);margin:8px 0 0' }, reason) : null,
      u.node, p.node, go
    );
    setTimeout(() => u.input.focus(), 30);
    clear(host).append(wrap);
    return;
  }

  // ── 还没建账号：先用启动日志里那串口令进来，顺手把账号建了 ──
  const tok = field('访问口令', { type: 'password', class: 'mono', placeholder: '32 位口令' });
  const newUser = field('用户名（可留空，只用口令进也行）', { type: 'text', autocomplete: 'username' });
  const newPass = field('密码（至少 8 位）', { type: 'password', autocomplete: 'new-password' });
  const go = h('button', { class: 'btn primary', style: 'margin-top:14px;width:100%' }, '进入');

  const submit = async () => {
    const val = tok.input.value.trim();
    if (!val) return;
    go.disabled = true;
    setAuthKey(val);

    // 填了用户名密码就顺手建账号：以后就不用再记那串 32 位的东西了
    if (newUser.input.value.trim() && newPass.input.value) {
      try {
        const r = await api('/account/setup', {
          method: 'POST',
          body: { user: newUser.input.value.trim(), password: newPass.input.value, accessToken: val }
        });
        setAuthKey(r.token);
        localStorage.setItem(TOKEN_STORE, r.token);
        location.reload();
        return;
      } catch (err) {
        setAuthKey('');
        go.disabled = false;
        paintLogin('token', `账号没建成：${err.message}`);
        return;
      }
    }

    try {
      await api('/auth');
      localStorage.setItem(TOKEN_STORE, val);
      location.reload();
    } catch {
      setAuthKey('');
      go.disabled = false;
      paintLogin('token', '口令不对。多试几次会被锁一阵子。');
    }
  };
  go.onclick = submit;
  tok.input.onkeydown = (e) => {
    if (e.key === 'Enter') submit();
  };

  wrap.append(
    h('b', { style: 'font-size:17px' }, '输入访问口令'),
    h('p', { style: 'margin:10px 0 0;line-height:1.7' },
      '这台服务器在公网上，所以要口令才能进。口令在第一次启动的日志里（',
      h('code', {}, 'docker compose logs app'),
      '），或者由部署时的 FUTUREDREAM_ACCESS_TOKEN 指定。'),
    reason ? h('p', { style: 'color:var(--alarm);margin:8px 0 0' }, reason) : null,
    tok.node,
    h('p', { class: 'field-hint', style: 'margin-top:16px' },
      '顺手建个账号（可选）：以后用用户名密码登，就不用再记那串 32 位的东西了。'
      + '而且每台设备一个会话 —— 手机丢了只踢那一台，不影响电脑。'),
    newUser.node, newPass.node, go
  );
  setTimeout(() => tok.input.focus(), 30);
  clear(host).append(wrap);
}

/**
 * 屏幕这么窄，八成是拿手机开的 —— 给一条去手机版的路。
 *
 * 服务端已经按 User-Agent 把手机从根地址转走了，但 UA 是出了名的不可靠：
 * 装到主屏的快捷方式、微信里打开、平板横屏、改过 UA 的浏览器，都可能漏。
 * 漏了的人看到的就是一整套按鼠标设计的界面，在手机上根本没法点。
 *
 * 所以这里补一条**看得见摸得着**的兜底：不自动跳（电脑上把窗口拉窄不该被踢走），
 * 只在顶上摆一条能点的横幅，而且能关掉。口令两边共用一份，过去不用重输。
 */
function offerMobile() {
  if (window.innerWidth > 720) return;
  if (new URL(location.href).searchParams.has('pc')) return;
  try {
    if (sessionStorage.getItem('fd.noMobileTip')) return;
  } catch {
    /* 读不到就当没关过 */
  }
  const bar = h('div', { class: 'mobile-hint' },
    h('span', {}, '屏幕比较窄 —— 手机版是照手机做的，点起来顺手得多'),
    h('a', { class: 'btn sm primary', href: '/m' }, '去手机版'),
    h('button', {
      class: 'btn ghost sm',
      title: '这次不提示',
      onclick: () => {
        bar.remove();
        try {
          sessionStorage.setItem('fd.noMobileTip', '1');
        } catch {
          /* 写不进去就只关这一次 */
        }
      }
    }, '✕')
  );
  document.body.prepend(bar);
}

async function boot() {
  initTheme();
  offerMobile();
  // 存过就带上；服务器模式下没有它，下面第一条请求就会 401
  // 手机版存的是同一把口令（同源），从那边过来的人不用再输一次
  try {
    const saved = localStorage.getItem(TOKEN_STORE) || localStorage.getItem('fd.m.key');
    if (saved) setAuthKey(saved);
  } catch {
    /* 隐私模式下读不到，那就每次手输 */
  }
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
    // 服务器模式下没带口令 / 口令不对，走登录屏而不是"连不上"那一屏 ——
    // 这两件事的下一步动作完全不同
    if (err.status === 401) {
      showLogin(localStorage.getItem(TOKEN_STORE) ? '存着的口令失效了，重新输一次。' : '');
      return;
    }
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

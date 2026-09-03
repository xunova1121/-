/**
 * 手机端：遥控 + 审片。
 *
 * ── 它不是什么 ──
 *
 * 不是把电脑版缩小。电脑版那一屏摆着服务商、模型、种子、提示词、请求记录 ——
 * 那些是**配置和排错**，坐在电脑前做才合适。手机上真正要做的只有三件：
 *   看进度（一步跑十几分钟，你总不能一直守着电脑）
 *   审片（哪一镜不对，当场标出来重出）
 *   看成片
 *
 * ── 引擎在电脑上，手机只是遥控器 ──
 *
 * 密钥、FFmpeg、几百 MB 的中间文件都在那台机器上，也只该在那台机器上。
 * 手机丢了不等于密钥丢了。所以这一端不碰任何配置，只发指令、只看结果。
 *
 * ── 配对码 ──
 *
 * 局域网里谁都能扫到这个端口，后面挂着的是你的额度。所以除了这个页面本身，
 * 每一条请求都要带配对码（服务端 checkKey）。码存在 localStorage，
 * 电脑上点「换一个」就能把丢了的手机踢下线。
 */

/**
 * Service Worker 只在**安全上下文**里注册。
 *
 * 这一条是实测出来的，不是照抄规范：从手机上访问 http://192.168.x.x:5179 时，
 * `window.isSecureContext === false`，而且 `navigator.serviceWorker` **压根不存在** ——
 * 浏览器在非安全源上直接不给这个接口。连带的后果是安卓 Chrome 不会提供
 * 「安装应用」（WebAPK），「添加到主屏幕」只会得到一个开在标签页里的书签。
 *
 * 所以这里不硬试（试了也只是吞掉一个异常，还让人以为装上了），
 * 而是在界面上说清楚：要真正的应用图标和独立窗口，装那个 apk。
 */
/**
 * 预演台那块画布是**和电脑版共用同一份**（ui/previz-canvas.js）。
 *
 * 这一端本来一个 import 都没有，是个自包含模块。破这个例是有理由的：
 * 排位是几何，两端各写一份的话会以肉眼看不出的方式漂开
 *（一边顺时针一边逆时针），而漂开不报错，只会让同一份排位在两端
 * 算出不同的机位关系 —— 那比少一个功能糟糕得多。
 */
import { previzPanel, blankStage } from '/previz-canvas.js';
import { inheritStage } from '/previz.js';
// 台词念不念得完，用引擎自己那份估法（同一个文件，不是抄一份）
import { speechSeconds, SPEECH_HEADROOM } from '/duration.js';
/**
 * 接缝那几句话读引擎那一份原件 —— 三处（设置下拉、这张卡片、出视频时的说明）
 * 必须是同一句。各写各的话已经错过一次：这里写的是 tail 的行为，跑的是 lock。
 */
import * as SEAM from '/seam.js';
import * as SITE from '/site-canvas.js';
import * as OUTLINE from '/outline.js';
/**
 * 单价换算取服务端原件。手机上那句话和电脑上那句话必须同源 ——
 * 两端各拼一份措辞，迟早会出现同一笔账两个说法。
 */
import * as PRICING from '/pricing.js';

const canInstall = window.isSecureContext && 'serviceWorker' in navigator;
if (canInstall) {
  navigator.serviceWorker.register('/m/sw.js').catch(() => {});
}

/**
 * 配色三态。存在这台手机上 —— 它是"这块屏幕现在在什么光线下"的事，
 * 跟项目、跟账号都没关系，同一个人在电脑上和手机上要的完全可以不一样。
 */
const THEME_STORE = 'fd.m.theme';
const THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
const THEME_LABEL = { auto: '跟随系统', light: '白天模式', dark: '夜间模式' };
let themeMode = 'auto';

function setTheme(mode) {
  themeMode = ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto';
  // auto 就是**不写这个属性** —— 交给 CSS 里的 prefers-color-scheme
  if (themeMode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = themeMode;
  try {
    localStorage.setItem(THEME_STORE, themeMode);
  } catch {
    /* 隐私模式下写不进去，那这一次有效 */
  }
}

const KEY_STORE = 'fd.m.key';
const PROJ_STORE = 'fd.m.project';
/**
 * 服务器模式下电脑版和手机版是**同一个源**，口令自然该共用一份 ——
 * 在电脑版输过一次，手机版再问一遍纯属折腾。局域网那条路两边不同源，用不上这个。
 */
const PC_KEY_STORE = 'fd.accessToken';

/**
 * 这台服务要我输的是什么。
 *
 *   lan    局域网配对码：8 位、只有大写、给人在手机上一个一个敲
 *   server 公网访问口令：32 位、大小写混排、复制粘贴进来
 *
 * 这一屏原来写死了前者（强制转大写、maxlength 12），于是在服务器上
 * **根本输不进去**：32 位口令被截断、大小写被抹平。
 */
let mode = 'lan';

// ───────────────────────── 小工具 ─────────────────────────

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'object') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

let authKey = '';

function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function api(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(authKey ? { 'X-FD-Key': authKey } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

/**
 * NDJSON 流。手机端也要能发起整步任务 —— 出门在外看到"第 3 镜失败了"，
 * 总得能当场点一下重出，而不是记在心里回去再说。
 */
/**
 * 流中途断了，说人话。
 *
 * 浏览器对**所有**网络层失败都只给一句 `network error`（或者
 * `Failed to fetch` / `Load failed`，各家措辞还不一样）。它不区分
 * "服务器挂了""网断了""连接闲太久被回收了"，而这三件事该做的处理完全不同。
 *
 * 最要紧的一点是：这条流断掉时，**任务在服务器上多半还在跑**。
 * 报一句"失败了"会让人以为白花了钱，然后再点一次 —— 那才是真的白花。
 */
function streamBroke(err, got) {
  const raw = String(err?.message || err || '');
  const looksNetwork = /network error|Failed to fetch|Load failed|terminated|aborted/i.test(raw);
  if (!looksNetwork) return err;
  return new Error(
    (got ? '跑到一半连接断了' : '连接没建起来')
    + '（手机息屏、切了网、或者连接闲置被回收都会这样）。'
    + '**这一步多半还在服务器上跑着** —— 回来点「刷新」看看结果，别急着重跑，重跑是重新花一次钱。'
    + `（原始报错：${raw.slice(0, 60)}）`
  );
}

async function stream(path, body, onEvent) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authKey ? { 'X-FD-Key': authKey } : {}) },
      body: JSON.stringify(body || {})
    });
  } catch (err) {
    throw streamBroke(err, false);
  }
  /**
   * 开不了流的时候，**把服务端那句话读出来**。
   *
   * 原来这里直接抛 `HTTP ${status}` —— 手机上看到的就是光秃秃一行
   * "HTTP 409"，而服务端那一侧其实写着整整一段：
   * "这个项目已经在跑「视频生成」了（38 秒前开始）。要么等它跑完，
   *  要么先点「停下来」。同时跑两遍会让两条流水线抢同一批文件…"
   *
   * 一个状态码对用户是零信息 —— 尤其 409 这种，字面上什么也没说，
   * 而它恰恰是最容易碰上的那个（切屏回来又点了一次「往后全跑」）。
   * 话本来就写好了，只是没被读出来。
   */
  if (!res.ok) {
    let said = '';
    try {
      const text = await res.text();
      said = JSON.parse(text)?.error || text.slice(0, 200);
    } catch {
      /* 不是 JSON 就算了，下面用状态码兜底 */
    }
    throw new Error(said || `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error(`HTTP ${res.status}：服务端没有回内容`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let got = false;
  for (;;) {
    let chunk;
    try {
      // eslint-disable-next-line no-await-in-loop
      chunk = await reader.read();
    } catch (err) {
      throw streamBroke(err, got);
    }
    if (chunk.done) break;
    got = true;
    buf += dec.decode(chunk.value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      dispatchLine(line, onEvent);
    }
  }
  /**
   * 收尾：最后一截没有换行的也要处理。
   * 服务端的 end() 现在是带换行的，所以这行平时用不上 —— 留着是因为
   * "最后一个事件恰好被丢掉"和"服务端没回"在界面上长得一模一样。
   */
  if (buf.trim()) dispatchLine(buf.trim(), onEvent);
}

/**
 * ══════════ 半截行该忽略，处理器里的错不许吞 ══════════
 *
 * 原来解析和分发包在**同一个 try** 里，那个 catch 的本意只是
 * "网络切在一行中间，残行丢掉等下一块" —— 但它把 onEvent 里抛的
 * **每一个错**也一起吃掉了。而 onEvent 做的是渲染、落盘、弹提示，
 * 那才是真正会出错的地方。
 *
 * 后果：事件到了、渲染时抛了异常、被静默吞掉，于是**东西没出来、
 * 也没有任何报错**，按钮照常变回原样。用户看到的是"点了没反应"。
 */
function dispatchLine(line, onEvent) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // 半截行，等下一块
  }
  onEvent(ev);
}

/**
 * 界面自带的静态图（画风示例图）也要带口令。
 *
 * 这一端除了页面壳子本身，**每一条请求都要口令**（服务端 checkKey），
 * 而 `<img src>` 加不了自定义头 —— 于是画风缩略图整排 401，
 * 显示成一片空框。这类"图裂了"最容易被当成图片本身有问题，
 * 而实际上是鉴权。凡是同源的资源地址，一律从这儿过一道。
 */
function asset(p) {
  if (!p || /^data:|^https?:/.test(p)) return p;
  return `${p}${p.includes('?') ? '&' : '?'}k=${encodeURIComponent(authKey)}`;
}

/** 图片和视频也要带配对码：<img> 没法加自定义头，所以走查询串 */
function media(p, v) {
  return `/media?p=${encodeURIComponent(p)}${v ? `&v=${v}` : ''}${authKey ? `&k=${encodeURIComponent(authKey)}` : ''}`;
}

// ───────────────────────── 看图 ─────────────────────────

/**
 * 全屏看图：捏合缩放、双击放大、拖动、下滑关闭。
 *
 * ── 为什么要自己写，而不是靠浏览器自带的双指缩放 ──
 *
 * 页面头上写着 `user-scalable=no`。那不是随手加的：手机上一旦点中输入框，
 * 系统会自动把页面放大到那个框上，放大之后**退不回去**，整个界面就歪了 ——
 * 而这一端到处都是输入框。所以系统缩放必须关掉。
 *
 * 代价就是图也放不大了。而审片时最需要的恰恰是放大 ——「这个人的手怎么了」
 * 「衣领的花纹和上一镜对不上」，不放大根本看不出来。所以这一层是必须补的。
 *
 * ── 手势 ──
 *
 *   单指   放大后拖动看别处；没放大时下滑关闭
 *   双指   捏合缩放，围绕两指中点，不是围绕图心 —— 围绕图心的话
 *          你想看的那个角落会在放大时跑出屏幕
 *   双击   在 1 倍和 2.5 倍之间切，落点就是你点的那儿
 */
function openViewer(src, alt = '') {
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let lastTap = 0;

  const img = h('img', { class: 'viewer-img', src, alt });
  const hint = h('div', { class: 'viewer-hint' }, '双指缩放 · 双击放大 · 下滑关闭');
  const layer = h('div', { class: 'viewer' },
    h('button', { class: 'viewer-x', onclick: () => close() }, '✕'),
    img,
    hint);

  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const close = () => {
    layer.remove();
    document.body.style.overflow = '';
  };

  // 放大之后不能让图被拖到看不见的地方 —— 拖出去就找不回来了
  const clamp = () => {
    const maxX = Math.max(0, (img.clientWidth * scale - window.innerWidth) / 2);
    const maxY = Math.max(0, (img.clientHeight * scale - window.innerHeight) / 2);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  };

  let start = null;
  layer.addEventListener('touchstart', (e) => {
    hint.classList.add('gone');
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      start = {
        kind: 'pinch',
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        scale,
        // 围绕两指中点缩放：围绕图心的话，你正想看的那个角落会在放大时跑出屏幕
        cx: (a.clientX + b.clientX) / 2 - window.innerWidth / 2 - tx,
        cy: (a.clientY + b.clientY) / 2 - window.innerHeight / 2 - ty,
        tx,
        ty
      };
    } else if (e.touches.length === 1) {
      start = { kind: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY, tx, ty };
    }
  }, { passive: true });

  layer.addEventListener('touchmove', (e) => {
    if (!start) return;
    if (start.kind === 'pinch' && e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const next = Math.min(6, Math.max(1, start.scale * (dist / start.dist)));
      const k = next / start.scale;
      tx = start.tx - start.cx * (k - 1);
      ty = start.ty - start.cy * (k - 1);
      scale = next;
      clamp();
      apply();
    } else if (start.kind === 'pan' && e.touches.length === 1) {
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (scale > 1.02) {
        e.preventDefault();
        tx = start.tx + dx;
        ty = start.ty + dy;
        clamp();
        apply();
      } else if (dy > 90 && Math.abs(dx) < 60) {
        // 没放大时下滑关闭 —— 这是手机上最自然的"退出看图"手势
        close();
      }
    }
  }, { passive: false });

  layer.addEventListener('touchend', () => {
    if (scale <= 1.02) {
      scale = 1;
      tx = 0;
      ty = 0;
      apply();
    }
    start = null;
  });

  // 双击：在 1 倍和 2.5 倍之间切，落点就是你点的那儿
  layer.addEventListener('click', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      if (scale > 1.02) {
        scale = 1;
        tx = 0;
        ty = 0;
      } else {
        scale = 2.5;
        tx = (window.innerWidth / 2 - e.clientX) * 1.5;
        ty = (window.innerHeight / 2 - e.clientY) * 1.5;
        clamp();
      }
      apply();
      lastTap = 0;
      return;
    }
    lastTap = now;
    // 单击空白处关掉；点在图上不关，免得刚要拖就退出去了
    if (e.target === layer) setTimeout(() => { if (lastTap) close(); }, 300);
  });

  document.body.style.overflow = 'hidden';
  document.body.append(layer);
}

/** 能点开看大图的图片。cap:image-zoom */
function zoomable(attrs, src, alt) {
  return h('img', { ...attrs, src, alt, onclick: () => openViewer(src, alt) });
}

// ───────────────────────── 流水线定义（和电脑端同一套口径）─────────────────────────

const STEPS = [
  { id: 'bible', label: '设定集' },
  { id: 'script', label: '分镜' },
  { id: 'assets', label: '镜头出图' },
  { id: 'video', label: '视频生成' },
  { id: 'voice', label: '配音' },
  { id: 'compose', label: '合成' }
];

function progressOf(project, id) {
  const shots = project?.shots || [];
  const bible = project?.bible;
  switch (id) {
    case 'bible': {
      const all = bible ? [...bible.characters, ...bible.scenes, ...(bible.props || [])] : [];
      return { done: all.filter((x) => x.sheetPath).length, total: all.length };
    }
    case 'script':
      return { done: shots.length, total: shots.length };
    case 'assets':
      return { done: shots.filter((s) => s.imagePath).length, total: shots.length };
    case 'video':
      return { done: shots.filter((s) => s.videoPath).length, total: shots.length };
    case 'voice': {
      const need = shots.filter((s) => s.dialogue?.trim());
      return { done: need.filter((s) => s.audioPath).length, total: need.length };
    }
    case 'compose':
      return { done: project?.outputs?.video ? 1 : 0, total: 1 };
    default:
      return { done: 0, total: 0 };
  }
}

function stateOf(project, id) {
  const { done, total } = progressOf(project, id);
  if (!total) return project?.stageStatus?.[id] === 'done' ? 'done' : 'pending';
  if (done >= total) return 'done';
  return done > 0 ? 'partial' : 'pending';
}

// ───────────────────────── 状态 ─────────────────────────

const app = document.querySelector('#app');
let project = null;
let projects = [];
/**
 * 全局设置里手机端只读、不改的那几项（现在只有接缝模式）。
 *
 * 为什么非要拿：接缝那句话必须说**当前模式**的行为 —— 两种模式看起来
 * 完全不一样，说错一种，用户照着去看成片只会得出"坏了"的结论。
 * 而这正是上一版犯的错。
 *
 * 拿不到就留空对象，措辞那边会退回默认（lock），不会炸。
 */
let appSettings = {};
let tab = 'flow';
const job = { running: false, label: '', message: '', fail: 0 };

// ───────────────────────── 配对 ─────────────────────────

/**
 * 建了账号之后，这一屏问的是用户名密码。
 *
 * 手机上这个差别比电脑上更要紧：32 位混排口令在手机键盘上敲一次要半分钟，
 * 而且极容易敲错 —— 而用户名密码是能记住、能用密码管理器填的。
 */
function paintAccountLogin(reason = '') {
  const u = h('input', { type: 'text', class: 'code', placeholder: '用户名', autocapitalize: 'none', autocomplete: 'username' });
  const p = h('input', { type: 'password', class: 'code', placeholder: '密码', autocomplete: 'current-password', style: 'margin-top:10px' });
  const go = h('button', { class: 'btn primary block', style: 'margin-top:14px' }, '登录');
  go.onclick = async () => {
    if (!u.value.trim() || !p.value) return toast('用户名和密码都要填', 'err');
    go.disabled = true;
    try {
      // cap:account-login
      const r = await api('/account/login', { method: 'POST', body: { user: u.value.trim(), password: p.value } });
      authKey = r.token;
      rememberKey(r.token);
      toast(`欢迎，${r.user}`, 'ok');
      boot();
    } catch (err) {
      go.disabled = false;
      toast(err.status === 401 ? '用户名或密码不对' : err.message, 'err');
    }
  };
  p.onkeydown = (e) => {
    if (e.key === 'Enter') go.click();
  };
  clear(app).append(
    h('div', { class: 'pair' },
      h('h1', {}, '未来创梦'),
      h('p', { class: 'muted' }, '用电脑上建的那个账号登录。每台设备一个会话 —— 手机丢了，在电脑上把这一台踢掉就行，不影响别处。'),
      reason ? h('p', { class: 'muted', style: 'color:var(--alarm)' }, reason) : null,
      u, p, go));
}

function paintPair(reason = '') {
  if (mode === 'account') return paintAccountLogin(reason);
  const server = mode === 'server';
  clear(app).append(
    h('div', { class: 'pair' },
      h('h1', {}, '未来创梦 · 手机端'),
      h('p', { class: 'muted' },
        server
          ? '这台服务器在公网上，要访问口令才能进。口令在服务器第一次启动的日志里，或者由部署时的 FUTUREDREAM_ACCESS_TOKEN 指定。'
          : '这台手机要和电脑上的应用配对一次。电脑上打开「设置 → 手机遥控」，把那串 8 位配对码敲进来。'),
      reason ? h('p', { class: 'muted', style: 'color:var(--alarm)' }, reason) : null,
      (() => {
        /**
         * 输入框**不按模式收紧**，只按模式换提示文案。
         *
         * 上一版是按 mode 决定 maxlength 和自动大写的，于是多了一条要命的依赖：
         * 只要 /api/mode 那一问没拿到（旧版本服务端没有这条、网络抖一下、
         * 被什么东西挡了），它就退回"局域网"，输入框缩成 12 位、强制大写 ——
         * 32 位的服务器口令**根本填不进去**，人就被锁在门外，而且完全看不出为什么。
         *
         * 界面能不能用，不该取决于一次探测成没成。所以一律按最宽的来：
         * 装得下 64 位、不动大小写。局域网那个配对码本来就不挑大小写
         * （服务端 checkKey 里统一处理），宽一点不会有任何副作用。
         */
        const input = h('input', {
          class: 'code',
          type: 'text',
          inputmode: 'latin',
          autocapitalize: 'none',
          autocorrect: 'off',
          spellcheck: false,
          autocomplete: 'off',
          placeholder: server ? '32 位访问口令' : 'ABCD2345',
          maxlength: 64
        });
        const go = h('button', { class: 'btn primary block', style: 'margin-top:14px' }, '连接');
        go.onclick = async () => {
          // 一律原样送出去：配对码不区分大小写这件事由服务端认（core/server.js checkKey），
          // 客户端无脑转大写会把服务器那个混排口令毁掉
          const code = input.value.trim();
          if (!code) return toast(server ? '先把访问口令填进来' : '先把配对码敲进来', 'err');
          go.disabled = true;
          authKey = code;
          try {
            await api('/health');
            rememberKey(code);
            toast('连上了', 'ok');
            boot();
          } catch (err) {
            authKey = '';
            go.disabled = false;
            toast(err.status === 401 ? (server ? '口令不对' : '配对码不对') : err.message, 'err');
          }
        };
        input.onkeydown = (e) => {
          if (e.key === 'Enter') go.click();
        };
        return h('div', { style: 'margin-top:20px' }, input, go);
      })(),
      h('p', { class: 'muted', style: 'margin-top:22px' },
        '连不上的话检查三件事：手机和电脑在同一个 Wi-Fi；电脑上的「手机遥控」开关是开着的；地址里的 IP 和电脑上显示的一致。')
    )
  );
}

// ───────────────────────── 主界面 ─────────────────────────

function paint() {
  clear(app).append(
    h('div', { class: 'top' },
      // 手上同时做着几部片子是常事 —— 写死"第一个项目"等于一半时候打开的是错的那部
      projects.length > 1
        ? h('select', {
            class: 'top-pick',
            // cap:project-switch
            onchange: async (e) => {
              localStorage.setItem(PROJ_STORE, e.target.value);
              await reload();
            }
          }, projects.map((p) => h('option', { value: p.id, selected: p.id === project?.id }, p.title)))
        : h('div', { class: 'top-title' }, project?.title || '未来创梦'),
      /**
       * 新建项目 —— 放在顶栏，任何时候都点得到。
       *
       * ── 为什么补这个 ──
       *
       * 原来"新建"只存在于 newProjectCard()，而那张卡片只在
       * **一个项目都没有**的时候才画（`if (!project)`）。也就是说它是个
       * 空状态提示，不是功能：建完第一部片子之后，手机上就再也建不了第二部了。
       *
       * 能力清单一直是绿的 —— `// cap:project-new` 那行标记确实在代码里。
       * 这和手机端「重出参考图」那次是同一类漏法：标记证明"写了代码"，
       * 证明不了"用户点得到"。
       */
      h('button', {
        class: 'btn sm',
        title: '再开一部片子',
        onclick: () => newProjectSheet()
      }, '＋'),
      /**
       * 白天 / 夜间。
       *
       * 用户的原话："手机版要有白天使用模式，现在 ui 全是黑的，晚上看不见"。
       * 深色在暗处很好，在**日光下的手机屏**上是另一回事 ——
       * 屏幕反光加上深底浅字，对比度直接塌掉。而这一端本来就是给
       * "在路上"设计的，路上最常见的光线恰恰是白天的户外。
       *
       * 三态循环：跟随系统 → 浅色 → 深色 → 跟随系统。
       * 默认跟随系统，因为多数人的手机本来就按日程自动切了。
       */
      h('button', {
        class: 'btn sm',
        title: THEME_LABEL[themeMode],
        onclick: () => {
          const next = { auto: 'light', light: 'dark', dark: 'auto' };
          setTheme(next[themeMode] || 'auto');
          toast(THEME_LABEL[themeMode]);
          paint();
        }
      }, THEME_ICON[themeMode]),
      h('button', {
        class: 'btn sm',
        onclick: async () => {
          await reload();
          toast('已刷新');
        }
      }, '刷新')),
    h('div', { class: 'body' },
      tab === 'flow' ? paintFlow()
        : tab === 'script' ? paintScript()
          : tab === 'bible' ? paintBible()
            : tab === 'shots' ? paintShots()
              : paintFilm()),
    paintLive(),
    /**
     * 五个页签，正好对应"一部片子从无到有"要碰的五样东西：
     * 跑到哪儿了 / 写什么 / 长什么样 / 每一镜对不对 / 成片。
     * 再多就该收进二级菜单了 —— 底部这一排超过五个，拇指就点不准了。
     */
    h('div', { class: 'tabs' },
      ...[
        ['flow', '◍', '流水线'],
        ['script', '✎', '剧本'],
        ['bible', '☰', '设定'],
        ['shots', '▤', '分镜'],
        ['film', '▶', '成片']
      ].map(([id, dot, label]) =>
        h('button', {
          class: `tab ${tab === id ? 'active' : ''}`,
          onclick: () => {
            tab = id;
            paint();
          }
        }, h('span', { class: 'tab-dot' }, dot), label,
        /**
         * 有镜头带着"导出去一定看得出来"的毛病时，页签上点一个红点。
         * 不点进去也知道有事 —— 否则那几镜要等到审片翻到才被发现，
         * 而人多半是跑完全流程、看一眼成片觉得还行就发了。
         */
        id === 'shots' && (() => {
          const list = (project?.shots || []).slice().sort((a, b) => a.index - b.index);
          return list.some((s, i) => shotLevel(s, i ? list[i - 1] : null) === 'bad');
        })()
          ? h('span', { class: 'tab-flag' })
          : null))
    )
  );
}

function paintLive() {
  if (!job.running && !job.fail && !job.message) return h('div', { class: 'live', hidden: true });
  return h('div', { class: `live ${job.fail ? 'bad' : job.running ? '' : 'good'}` },
    h('div', { class: 'row' },
      job.running ? h('span', { class: 'spin' }, '◐') : h('span', {}, job.fail ? '✕' : '✓'),
      /**
       * 「视频生成 · 第 5 镜」比光写「视频生成」有用得多：
       * 十二镜跑二十分钟，人真正想知道的是"到第几镜了、有没有卡住"。
       * 这个数在流断了之后由 GET /job 接回来（见 syncJob）。
       */
      h('b', { class: 'grow' },
        (job.label || (job.running ? '运行中' : '完成'))
        + (job.running && job.shotIndex ? ` · 第 ${job.shotIndex} 镜` : '')),
      /**
       * 跑到一半发现分镜写错了，手机上也得停得下来 —— 这恰恰是最需要它的场景：
       * 人不在电脑前，而视频那一步是按镜数计费的，一镜一镜烧下去。
       *
       * 按钮上写「停在这一镜之后」而不是「取消」：手上那一镜会跑完
       *（钱已经花了，掐掉等于白花），写「取消」会让人以为按钮坏了。
       */
      job.running
        ? h('button', {
            class: 'btn sm',
            disabled: job.stopping,
            // cap:job-cancel
            onclick: async (e) => {
              job.stopping = true;
              e.target.disabled = true;
              try {
                const r = await api(`/projects/${project.id}/cancel`, { method: 'POST' });
                job.message = r.message;
              } catch (err) {
                job.message = err.message;
              }
              updateLive();
            }
          }, job.stopping ? '正在停…' : '■ 停在这一镜之后')
        : h('button', {
            class: 'btn sm',
            onclick: () => {
              job.message = '';
              job.fail = 0;
              paint();
            }
          }, '知道了')),
    job.message ? h('div', { class: 'live-line' }, job.message) : null);
}

function paintFlow() {
  if (!project) return h('div', { class: 'card muted' }, '电脑上还没有项目。先在电脑上建一个、把剧本贴进去。');
  const box = h('div', { class: 'card', style: 'padding:0' });
  STEPS.forEach((s, i) => {
    const st = stateOf(project, s.id);
    const { done, total } = progressOf(project, s.id);
    /**
     * "8/12" 这种数字在手机上要看两眼才知道跑了多少 —— 画成条一眼就有。
     * 数字留着（有时候确实要知道是第几镜），但不再是唯一的表达。
     */
    const pct = total > 0 ? Math.round((done / total) * 100) : (st === 'done' ? 100 : 0);
    const running = job.running && job.stage === s.id;
    box.append(
      h('div', { class: `step ${st} ${running ? 'running' : ''}` },
        h('span', { class: 'step-num' }, String(i + 1).padStart(2, '0')),
        h('span', { class: 'step-body' },
          h('span', { class: 'step-name' }, s.label,
            total > 1 ? h('span', { class: 'step-count', style: 'margin-left:7px' }, `${done}/${total}`) : null),
          h('span', { class: 'pbar' }, h('i', { style: `width:${pct}%` }))),
        h('span', { class: 'step-mark' }, running ? '◐' : st === 'done' ? '✓' : st === 'partial' ? '◗' : ''),
        h('button', {
          class: 'btn sm',
          disabled: job.running,
          // cap:run-stage
          onclick: async () => {
            /**
             * ══════════ 开跑之前先看一眼清单 ══════════
             *
             * ⚠ 手机上**更需要**这一下，不是更不需要。
             *
             * 出门在外按这一下的人，没法当场去翻分镜表核对"这几镜到底
             * 排没排位、选没选技法卡"。而这一步照样真花钱 ——
             * 花完之后他离能改的地方（电脑）更远。
             *
             * 电脑上那份是常驻清单（摆在按钮上面，看不看由人）；
             * 手机上屏幕小、摆不下，所以做成**按下去那一刻**给一次。
             * 有问题才拦，干净就直接跑 —— 干净时还弹一下等于纯骚扰。
             */
            const sc = await stepCheckFor(s.id);
            if (sc && sc.items.length) {
              const lines = sc.items.slice(0, 4).map((it) =>
                `${it.level === 'blocker' ? '【要先处理】' : it.level === 'warn' ? '【建议先改】' : '【可选】'}${it.what}\n${it.fix}`);
              const tail = sc.skipCost ? `\n\n${sc.skipCost}` : '';
              // eslint-disable-next-line no-alert
              if (!confirm(`${sc.summary}\n\n${lines.join('\n\n')}${tail}\n\n还是要现在跑吗？`)) return;
            }
            runStage(s.id, s.label);
          }
        }, st === 'pending' ? '开始' : '继续'),
        // 出门在外最想按的其实是这个：把剩下几步一次串完，回去直接看成片。
        // 从这一步往后跑，前面几步的产出原样保留 —— 不重跑、不重复计费
        h('button', {
          class: 'btn sm',
          disabled: job.running,
          title: '从这一步一路跑到合成',
          onclick: async () => {
            const rest = STEPS.length - i;
            /**
             * 先问服务端这一趟要花多少，再弹确认。
             *
             * 原来这句写的是"视频那步按镜数计费，可能是最大的一笔开销"——
             * 正确，但没有信息量。出门在外按下这一下的人**比坐在电脑前的人
             * 更需要一个数**：他没法当场去翻厂商后台核对。
             *
             * 多一次往返换一个数，值。真要拿不到（离线、超时）就照旧弹，
             * 不能因为算不出价钱就把「往后全跑」这个功能堵死。
             */
            const cost = await costLineFor('all', { from: s.id });
            // eslint-disable-next-line no-alert
            if (!confirm(`从「${s.label}」一路跑到合成，共 ${rest} 步。\n\n${cost || '视频那步按镜数计费，可能是最大的一笔开销。'}`)) return;
            // cap:run-from
            runStage('all', `${s.label} → 合成`, { from: s.id });
          }
        }, '往后全跑'))
    );
  });

  /**
   * 待认领：提交成功了、**钱花了**、片子在厂商那边，我们没取回来。
   *
   * 这一块原来只有电脑版有。手机上看到的是"有图没视频"，
   * 唯一能做的动作就是重出 —— 而重出是**第二次付钱**，
   * 第一次那份还好好地在厂商那儿放着。
   *
   * 用户的原话："视频13段都生成两次了，PC和移动端还是显示只生成了4段"。
   * 那个循环就是这么闭合的：取不回来 → 没有 videoPath → 下次全跑照样重提交。
   */
  const shots = (project.shots || []);
  const owed = shots.filter((s) => s.pendingTask && !s.videoPath);
  const failedShots = shots.filter((s) => !s.videoPath && !s.pendingTask && s.videoError);
  const notRun = shots.filter((s) => !s.videoPath && !s.pendingTask && !s.videoError);
  const missing = owed.length + failedShots.length + notRun.length;

  /**
   * ⚠ **没有可捞的东西时，这一块也必须说话。**
   *
   * 上一版只在 owed.length 时才画那张黄卡。用户于是对着一个
   * 什么都没有的流水线页问："在哪，在哪捞回来"—— 而正确答案是
   * "没有可捞的"。可"没有卡"和"这个功能还没更新上"长得一模一样，
   * 他没有任何办法分辨。
   *
   * 这是这个项目里同一个教训的第 N 次：**不触发的分支是彻底安静的**，
   * 而安静会被读成"坏了"。所以只要还差视频，这一块就always在，
   * 把三种处境分开摆出来 —— 它们在界面上长得一模一样（都是"有图没视频"），
   * 补救动作却完全不同，而其中只有一种是免费的。
   */
  const nums = (list) => `第 ${list.map((s) => s.index).join('、')} 镜`;
  const videoState = missing
    ? h('div', { class: `card ${owed.length ? 'warn' : ''}` },
        h('b', {}, `${shots.length} 镜里还差 ${missing} 镜没有视频`),
        h('div', { style: 'margin-top:10px' },
          h('div', { class: 'row', style: 'align-items:flex-start;padding:7px 0' },
            h('span', { style: `flex:0 0 22px;color:${owed.length ? 'var(--caution)' : 'var(--ink-faint)'}` }, '$'),
            h('div', { class: 'grow' },
              h('div', {}, `钱花了没取回来 ${owed.length} 镜`),
              h('div', { class: 'muted' },
                owed.length
                  ? `${nums(owed)} —— 提交成功过，片子多半还在厂商那边。重出等于第二次付钱，用下面那个按钮免费捞。`
                  : '没有这一类 —— 也就是说没有"可以免费捞回来"的镜头。'))),
          h('div', { class: 'row', style: 'align-items:flex-start;padding:7px 0;border-top:1px solid var(--line-soft)' },
            h('span', { style: `flex:0 0 22px;color:${failedShots.length ? 'var(--alarm)' : 'var(--ink-faint)'}` }, '✕'),
            h('div', { class: 'grow' },
              h('div', {}, `出视频失败了 ${failedShots.length} 镜`),
              h('div', { class: 'muted' },
                failedShots.length
                  ? `${nums(failedShots)}：${String(failedShots[0].videoError.message).slice(0, 70)}`
                  : '没有这一类。'))),
          h('div', { class: 'row', style: 'align-items:flex-start;padding:7px 0;border-top:1px solid var(--line-soft)' },
            h('span', { style: 'flex:0 0 22px;color:var(--ink-faint)' }, '·'),
            h('div', { class: 'grow' },
              h('div', {}, `还没跑到 ${notRun.length} 镜`),
              h('div', { class: 'muted' },
                notRun.length
                  ? `${nums(notRun)} —— 点上面「视频生成」那行的「继续」就会接着出这几镜。`
                  : '没有这一类。')))),
        /**
         * 老项目上"失败原因"是空的 —— 它是后来才开始存的。
         * 不说这一句的话，跑过又失败的镜会被读成"还没跑到"，
         * 而那两件事的判断完全不同。
         */
        notRun.length && !failedShots.length && !owed.length
          ? h('p', { class: 'muted', style: 'margin:10px 0 0' },
              '⚠ 如果这几镜其实跑过、只是失败了：失败原因是新版才开始记的，'
              + '更早那些失败没有留下记录，所以在这儿显示成"还没跑到"。'
              + '先单独重出**一镜**（分镜页 → 那一镜 →「重出这段视频」）看看报什么错，'
              + '别整段跑 —— 整段跑是按镜数计费的。')
          : null)
    : null;

  const reclaim = owed.length
    ? (() => {
        const go = h('button', { class: 'btn primary block', disabled: job.running }, `把这 ${owed.length} 镜捞回来（不花钱）`);
        go.onclick = async () => {
          go.disabled = true;
          job.running = true;
          job.label = '重查待认领';
          job.message = '正在查…';
          job.fail = 0;
          job.streaming = true;
          paint();
          try {
            // cap:task-reclaim
            await stream(`/projects/${project.id}/tasks/recheck`, {}, (ev) => {
              if (ev.message) job.message = ev.message;
              updateLive();
            });
          } catch (err) {
            job.fail += 1;
            job.message = err.message;
          } finally {
            job.running = false;
            job.streaming = false;
            await reload();
          }
        };
        return h('div', { class: 'card warn' },
          h('p', { class: 'muted', style: 'margin:0 0 10px' },
            '查一次**不花钱**（只是再问厂商一遍那个任务号出片了没有）。'
            + '刚在「服务商与密钥 → 接口地址」里填对查询地址的话，这一下能全收回来。'),
          go);
      })()
    : null;

  /**
   * 上一次跑的结果。
   *
   * 进度流是给"正在看着"的那个人用的；这一条是给**回来的人**用的。
   * 没有它的话，切屏回来看到的是一个静止的流水线 —— 4/12，没有转圈、
   * 没有报错、没有任何痕迹说明刚才跑过一次。用户读到的是"这个 bug 还在"，
   * 而实际上那一次早就跑完了，只是跑完的结果没有留下来。
   */
  const lr = project.lastRun;
  const lastRunCard = lr && !job.running
    ? h('div', { class: `card ${lr.outcome === 'error' || lr.failed ? 'warn' : ''}`, style: 'padding:11px 13px' },
        h('div', { class: 'row' },
          h('span', {}, lr.outcome === 'error' ? '✕' : lr.outcome === 'cancelled' ? '■' : lr.failed ? '!' : '✓'),
          h('div', { class: 'grow' },
            h('div', {},
              `上次跑「${lr.stageLabel}」：`
              + (lr.outcome === 'cancelled' ? '你叫停了'
                : lr.outcome === 'error' ? '中途出错'
                  : lr.failed ? `完成，但 ${lr.failed} 镜失败` : '全部完成')),
            h('div', { class: 'muted' },
              new Date(lr.at).toLocaleString('zh-CN')
              + (lr.message ? ` · ${String(lr.message).slice(0, 60)}` : '')))))
    : null;

  return [
    h('p', { class: 'muted', style: 'margin:2px 4px 10px' },
      '每一步都在电脑上跑，手机只是发个指令 —— 关掉这个页面也不影响它继续跑。'),
    lastRunCard,
    videoState,
    reclaim,
    box,
    h('div', { class: 'card' },
      h('div', { class: 'muted' },
        '剧本、设定集描述、能力路由这些要坐下来改的东西，都在电脑上。这里管的是"跑到哪儿了"和"哪一镜不对"。')),
    // 浏览器在局域网 HTTP 上不给「安装应用」——这不是我们能绕开的，
    // 与其让人对着"添加到主屏幕"得到一个书签，不如直说该装哪个
    !canInstall
      ? h('div', { class: 'card' },
          h('b', {}, '想要独立图标？装安卓版'),
          h('p', { class: 'muted', style: 'margin:6px 0 0' },
            '现在这样在浏览器里用，功能一模一样。但浏览器在局域网 HTTP 上不提供「安装应用」，'
            + '「添加到主屏幕」只会得到一个开在标签页里的书签。'
            + '想要真正的图标、独立窗口、下载走系统下载器（素材包几百 MB，那边有断点和通知栏进度），'
            + '去电脑上那个 GitHub 发布页下 FutureDream-Remote.apk 装一下 —— 里面装的就是这个页面。'))
      : null
  ];
}

/**
 * 剧本 + 画风。
 *
 * 这两样以前是"回电脑上做"的。但实际用起来，最常发生的恰恰是：在外面想到一句
 * 更好的开头，或者看到出图不对、想换个画风 —— 而这两件事都只是敲几个字、点一下，
 * 没有任何理由必须回到电脑前。
 */
function paintScript() {
  if (!project) return newProjectCard();

  const ta = h('textarea', { rows: 14, class: 'mta', placeholder: '把小说或剧本贴进来…' }, project.script || '');
  const save = h('button', { class: 'btn primary grow' }, '保存剧本');
  save.onclick = async () => {
    save.disabled = true;
    try {
      // cap:script-edit
      await api(`/projects/${project.id}`, { method: 'PATCH', body: { script: ta.value } });
      toast('已保存。重跑「分镜」那一步才会按新剧本拆', 'ok');
      await reload();
    } catch (err) {
      toast(err.message, 'err');
      save.disabled = false;
    }
  };

  return [
    h('div', { class: 'card' },
      h('b', {}, '剧本'),
      h('p', { class: 'muted', style: 'margin:6px 0 10px' },
        '这是整条流水线的源头。改完要重跑「分镜」才会生效 —— 那会把现在的分镜表整个换掉，'
        + '已经出好的图和视频不会自动跟着变。'),
      ta,
      h('div', { class: 'row', style: 'margin-top:10px' }, save)),
    outlineCard(),
    appendChapterCard(),
    formatCard(),
    styleCard()
  ];
}

/**
 * 出片规格：画幅 + 分辨率，**记在这部片子上**。
 *
 * ── 为什么必须在手机上有 ──
 *
 * 用户的原话："有的时候是在手机新建项目，不默认他们的设置"。
 *
 * 全局设置是坐在电脑前为**上一部片子**调的。在手机上新建一部竖屏短剧，
 * 却继承了上一部横屏纪录片的画幅和 1080p —— 而这两样一旦跑起来就
 * **改不动了**：分镜图按那个比例出完，视频跟着图走，发现不对时
 * 前两步的钱已经花掉了。
 *
 * 画幅本来就记在项目上（电脑版项目页能改），手机上一直缺；
 * 分辨率原来只有全局一个，这次也给项目加了一层覆盖。
 *
 * ⚠ 服务商不在这儿。选厂商要对着价格、能力、额度一起看，
 * 那是坐下来做的事 —— 而且它决定的是钱怎么花，不该在路上顺手点一下。
 */
const M_RATIOS = [
  ['16:9', '16:9 横屏'], ['9:16', '9:16 竖屏'], ['1:1', '1:1 方形'],
  ['4:3', '4:3 传统'], ['21:9', '21:9 宽银幕']
];
const M_RES = [['', '跟随设置'], ['480P', '480P 省钱'], ['720P', '720P'], ['1080P', '1080P'], ['2K', '2K']];

function formatCard() {
  let ratio = project.aspectRatio || '';
  let res = project.videoResolution || '';
  const save = h('button', { class: 'btn primary grow' }, '保存规格');
  save.onclick = async () => {
    save.disabled = true;
    try {
      // cap:project-format
      await api(`/projects/${project.id}`, {
        method: 'PATCH',
        body: { aspectRatio: ratio, videoResolution: res }
      });
      toast('已保存。已经出好的图和视频不会跟着变，要重出才会', 'ok');
      await reload();
    } catch (err) {
      toast(err.message, 'err');
      save.disabled = false;
    }
  };
  return h('div', { class: 'card' },
    h('b', {}, '出片规格'),
    h('p', { class: 'muted', style: 'margin:6px 0 10px' },
      '记在**这一部片子**上，不跟着全局设置走 —— 手机上新建的片子不会继承上一部的比例。'),
    field('画幅', chips(M_RATIOS.map((r) => r[1]), M_RATIOS.find((r) => r[0] === ratio)?.[1] || '',
      (v) => { ratio = M_RATIOS.find((r) => r[1] === v)?.[0] || ''; }),
    '出图和出视频共用一个，免得成片里两者打架。**跑之前定好** —— 分镜图按这个比例出完之后再改，那些图就白出了。'),
    field('视频分辨率', chips(M_RES.map((r) => r[1]), M_RES.find((r) => r[0] === res)?.[1] || '跟随设置',
      (v) => { res = M_RES.find((r) => r[1] === v)?.[0] || ''; }),
    '越高越贵、出得越慢。建议先用 480P 跑通全流程、确认分镜和人设都对，最后一遍再拉高重出。'),
    h('div', { class: 'row' }, save));
}

/** 画风：选一张卡 + 一段可以自己写的描述 */
function styleCard() {
  const host = h('div', { class: 'card' }, h('div', { class: 'muted' }, '正在读画风…'));

  api('/styles').then(({ presets }) => {
    let picked = project.styleId || 'ink';
    let text = project.style || '';
    const grid = h('div', { class: 'style-mini' });
    const note = h('div', { class: 'muted', style: 'margin-top:8px' });
    const box = h('textarea', { rows: 3, class: 'mta', placeholder: '例：雨夜为主，霓虹反光' }, text);
    box.oninput = () => (text = box.value);

    const paintNote = () => {
      note.textContent = picked === 'custom'
        ? '选了「自定义」，这段话就是全片的风格描述 —— 不写等于没选画风。'
        : '想在预设之外补一句就写这里，可以留空。它接在预设后面，不会把预设顶掉。';
    };

    for (const preset of presets) {
      const card = h('button', {
        class: `style-mini-card ${preset.id === picked ? 'on' : ''}`,
        onclick: () => {
          picked = preset.id;
          for (const el of grid.children) el.classList.remove('on');
          card.classList.add('on');
          paintNote();
        }
      },
        preset.previewPath || preset.sample
          ? h('img', { src: preset.previewPath ? media(preset.previewPath) : asset(preset.sample), alt: preset.name, loading: 'lazy' })
          : h('span', { class: 'style-mini-blank' }),
        h('span', { class: 'style-mini-name' }, preset.name));
      grid.append(card);
    }
    paintNote();

    const save = h('button', { class: 'btn primary grow' }, '保存画风');
    save.onclick = async () => {
      if (picked === 'custom' && !text.trim()) return toast('选了自定义就得写一段风格描述', 'err');
      save.disabled = true;
      try {
        // cap:style-pick
        await api(`/projects/${project.id}`, { method: 'PATCH', body: { styleId: picked, style: text.trim() } });
        toast('已保存。设定集里的风格锚也跟着换了，重出图才会变', 'ok');
        await reload();
      } catch (err) {
        toast(err.message, 'err');
        save.disabled = false;
      }
    };

    clear(host).append(
      h('b', {}, '画风'),
      h('p', { class: 'muted', style: 'margin:6px 0 10px' },
        '画风会写进设定集，出现在每一条提示词最前面。换了它，已经出好的图要重出才会跟着变。'),
      grid, box, note,
      h('div', { class: 'row', style: 'margin-top:10px' }, save));
  }).catch((err) => clear(host).append(h('div', { class: 'muted' }, `画风读不出来：${err.message}`)));

  return host;
}

/**
 * 设定集：角色 / 场景 / 道具的外貌，和各自那张参考图。
 *
 * 这一页是整条一致性链路的地基 —— 改这里的描述，比在每一镜里改一遍有效得多。
 * 手机上放开它，是因为审片时最常发现的问题就是"这个人的衣服不对"，
 * 而那句话就写在这儿。
 */
function paintBible() {
  if (!project) return newProjectCard();
  if (!project.bible) {
    return h('div', { class: 'card muted' }, '还没有设定集。去「流水线」跑第 01 步 —— 模型会读一遍剧本，把角色和场景的外貌固定下来。');
  }

  const v = Date.parse(project.updatedAt || '') || 0;
  const out = [driftCard()];

  for (const [kind, title, items] of [
    ['char', '角色', project.bible.characters || []],
    ['scene', '场景', project.bible.scenes || []],
    ['prop', '道具', project.bible.props || []]
  ]) {
    if (!items.length) continue;
    out.push(h('div', { class: 'sec' }, title));
    for (const item of items) out.push(bibleCard(kind, item, v));
  }
  /**
   * 场地图**永远摆出来**，哪怕一个场景都还没有。
   *
   * ⚠ 第一版把它塞进了上面那个循环的"场景"分支里，于是没有场景时
   * 整张卡片**凭空消失** —— 电脑版在同样情况下是显示一句"得先有场景"。
   * 同一个功能在两端一个说话一个装死，比两端都没有更糟：
   * 用户在手机上找不到，会以为这个功能手机上没做。
   */
  out.push(extendCard());
  out.push(siteCard());
  out.push(spendCard());
  return out;
}

/**
 * ── 补上新增的角色和场景 ──
 *
 * 手机上做这一块，是因为"剧本又来了一章"这件事**最常发生在手机上** ——
 * 作者在手机上写、在手机上贴。而不补的后果是静默的：新角色那几镜
 * 没有参考图、没有外貌描述、复核没有基准，静默降级成"文生图"，
 * 而流水线一路绿。
 */
/**
 * ══════════ 手机上的账 ══════════
 *
 * 为什么手机上也要有：出门在外点「往后全跑」的人，比坐在电脑前的人
 * **更需要**先知道这一下多少钱 —— 他没法当场去翻厂商后台核对。
 * 只在电脑上显示价钱，等于把手机版又做回一个"能按但不知道按下去会怎样"的遥控器。
 *
 * 和电脑版的实现不一样：这里走服务端那条预估接口，不在浏览器里自己算。
 * 电脑版之所以在本地算，是因为它已经把整份 catalog（路由 + 厂商档位）
 * 载进内存了；手机版没有，为了一行字去拉整份目录不划算。
 * 两端算的是同一套东西 —— 服务端用的就是 estimate.js 那个文件。
 */
function spendCard() {
  const host = h('details', { class: 'card site-details' });
  const head = h('summary', {}, '花了多少 ', h('span', { class: 'muted' }, '用量是实数，钱按你填的单价算'));
  const body = h('div', {});
  let loaded = false;

  const paint = (data) => {
    clear(body);
    if (data?.error) {
      body.append(h('div', { class: 'muted', style: 'line-height:1.7' }, `读不出来：${data.error}`));
      return;
    }
    body.append(h('div', { style: 'line-height:1.7;font-size:13px' }, data.line || ''));

    for (const [kind, spec] of Object.entries(data.kinds || {})) {
      const b = data.total?.byKind?.[kind];
      if (!b || !b.calls) continue;
      body.append(h('div', { class: 'spend-row' },
        h('span', { class: 'spend-kind' }, spec.label),
        h('span', { class: 'spend-units' }, PRICING.describeUnits(kind, b.units)),
        h('span', { class: 'spend-money' }, b.priced ? PRICING.fmtMoney(b.cny) : '没填单价')));
    }

    if (data.unmetered) {
      body.append(h('div', { class: 'muted', style: 'line-height:1.7;margin-top:6px' },
        `另有 ${data.unmetered} 次没记上账 —— 厂商没回用量。这几次的钱确实花了，只是数不出来。`));
    }

    const missing = data.total?.missing || [];
    if (missing.length) body.append(mRateFiller(missing, load));
  };

  async function load() {
    try {
      paint(await api(`/projects/${project.id}/spend`));
    } catch (err) {
      paint({ error: err.message });
    }
  }

  host.append(head, body);
  host.addEventListener('toggle', () => {
    if (host.open && !loaded) {
      loaded = true;
      // cap:spend-project
      load();
    }
  });
  return host;
}

/**
 * 手机上就地填单价。
 *
 * 和电脑版一样**不预填任何厂商的价** —— 预填等于给一个看起来权威的默认值，
 * 而多数人会直接点保存。照自己账单上的抄才是对的。
 */
function mRateFiller(missing, after) {
  const box = h('div', { style: 'margin-top:10px' });
  const inputs = new Map();
  box.append(h('div', { class: 'muted', style: 'line-height:1.7' }, '这几样用过了但没填单价：'));
  for (const m of missing) {
    const spec = PRICING.KINDS[m.kind] || {};
    const row = h('div', { class: 'rate-row' });
    row.append(h('span', { class: 'rate-who' }, PRICING.describeMissing(m)));
    if (spec.pair) {
      const i1 = h('input', { class: 'input sm', type: 'number', step: 'any', min: '0', placeholder: '输入' });
      const i2 = h('input', { class: 'input sm', type: 'number', step: 'any', min: '0', placeholder: '输出' });
      inputs.set(m.key, { pair: true, i1, i2 });
      row.append(i1, i2);
    } else {
      const i1 = h('input', { class: 'input sm', type: 'number', step: 'any', min: '0', placeholder: spec.priceUnit || '单价' });
      inputs.set(m.key, { pair: false, i1 });
      row.append(i1);
    }
    box.append(row);
  }
  box.append(h('button', {
    class: 'fbtn',
    style: 'margin-top:8px',
    // cap:spend-rates
    onclick: async () => {
      const rates = {};
      for (const [key, f] of inputs) {
        if (f.pair) {
          if (f.i1.value === '' || f.i2.value === '') continue;
          rates[key] = { in: Number(f.i1.value), out: Number(f.i2.value) };
        } else {
          if (f.i1.value === '') continue;
          rates[key] = { cny: Number(f.i1.value) };
        }
      }
      if (!Object.keys(rates).length) return toast('还没填');
      try {
        await api('/rates', { method: 'PUT', body: { rates } });
        appSettings = await api('/settings');
        toast('存下了，过去的账也按新单价重算了');
        await after();
      } catch (err) {
        toast(`存不下：${err.message}`);
      }
    }
  }, '存单价'));
  return box;
}

/**
 * 跑之前那句话。
 *
 * 拿服务端算好的一行字直接用 —— 手机上不重新拼一遍措辞，
 * 两端说法不一致比少一句话更糟。
 */
/**
 * 这一步开跑之前该知道什么。拿服务端算好的那一份 ——
 * 手机上不重新判一遍，两端说法不一致比少一句话更糟。
 *
 * 拿不到（离线、超时）就回 null，照旧能跑 —— 检查不上不该把功能堵死。
 */
async function stepCheckFor(stage) {
  try {
    // cap:stepcheck
    const r = await api(`/projects/${project.id}/stepcheck?stage=${encodeURIComponent(stage)}`);
    return r && Array.isArray(r.items) ? r : null;
  } catch {
    return null;
  }
}

async function costLineFor(stage, { from = null } = {}) {
  try {
    const q = from ? `stage=all&from=${encodeURIComponent(from)}` : `stage=${encodeURIComponent(stage)}`;
    // cap:spend-estimate
    const r = await api(`/projects/${project.id}/estimate?${q}`);
    return r.line || '';
  } catch {
    return '';
  }
}

function extendCard() {
  const host = h('details', { class: 'card site-details' });
  const head = h('summary', {}, '剧本又加了新章？ ', h('span', { class: 'muted' }, '只补没见过的角色和场景'));
  const log = h('div', { class: 'muted', style: 'margin-top:8px;line-height:1.6' });
  const btn = h('button', { class: 'btn sm grow' }, '扫一遍，补上新增的');
  btn.onclick = async () => {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '扫描中…';
    log.textContent = '';
    try {
      // cap:extend-bible
      await stream(`/projects/${project.id}/extend-bible`, {}, (ev) => {
        if (ev.message) log.textContent = ev.message;
        if (ev.type === 'error') toast(ev.message, 'err');
        if (ev.type === 'finished') {
          project.bible = ev.project?.bible || project.bible;
          toast(ev.added?.length
            ? `补了 ${ev.added.length} 条：${ev.added.map((a) => a.name).join('、')}`
            : '没有新的角色或场景', 'ok');
          paint();
        }
      });
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };
  host.append(head,
    h('div', { class: 'muted', style: 'line-height:1.7' },
      '已有的一条都不动、一张图都不重出 —— 所以主角不会换脸，也不会重复花钱。'),
    h('div', { class: 'row', style: 'margin-top:8px' }, btn),
    log);
  return host;
}

/**
 * ── 大纲 ──
 *
 * 手机上做这一层，理由和「追加一章」一样：**改大纲最常发生在手机上**。
 * 想起来"第二场太拖了"这件事，很少发生在坐下来对着电脑的时候。
 *
 * 而这一层恰恰是手机装得下的：一行一场戏，十来行；
 * 分镜表那种一屏六七个字段的东西才是手机上做不了的。
 */
function outlineCard() {
  const host = h('details', { class: 'card site-details' });
  const listHost = h('div', { style: 'margin-top:8px' });
  const chatHost = h('div', { style: 'margin-top:8px' });
  const sumLine = h('div', { class: 'muted', style: 'line-height:1.7' });

  const paint = () => {
    clear(listHost);
    const o = OUTLINE.normalizeOutline(project.outline);
    sumLine.textContent = OUTLINE.summarize(project.outline, project.targetDuration);
    if (!o.beats.length) {
      listHost.append(h('div', { class: 'muted', style: 'line-height:1.7' },
        '还没有大纲。先生成一份 —— 一行一场戏，改顺了再拆分镜。'));
      return;
    }
    for (const [i, b] of o.beats.entries()) {
      const est = OUTLINE.estimateSeconds(b);
      listHost.append(h('div', { class: `mob-row${b.locked ? ' locked' : ''}` },
        h('div', { class: 'mob-head' },
          h('b', {}, `${i + 1}. ${b.scene || '（未定）'}`),
          h('span', { class: 'muted' }, `${est.suggested} 秒`),
          est.floor ? h('span', { class: 'mob-floor' }, `台词 ${est.floor}s`) : '',
          b.locked ? h('span', { class: 'badge' }, '锁') : ''),
        h('div', { class: 'muted', style: 'line-height:1.6' }, b.summary)));
    }
    /**
     * 还没拆分镜的那几场。和电脑版同一条理由：插了一场之后
     * 如果没人说"有 1 场还没拆"，它就会一直躺在那儿。
     */
    const pend = OUTLINE.pendingBeats(project.outline);
    if (pend.length && o.beats.some((b) => b.locked)) {
      const go = h('button', { class: 'btn sm grow' }, `拆这 ${pend.length} 场的分镜`);
      go.onclick = () => {
        // cap:run-stage
        runStage('script', '分镜');
      };
      listHost.append(h('div', { class: 'mob-pending' },
        h('b', {}, `有 ${pend.length} 场还没拆分镜`),
        h('div', { class: 'muted', style: 'margin:3px 0 8px' },
          `${pend.map((b) => b.scene || b.id).join('、')}。已经拆过的那几场不会被动。`),
        h('div', { class: 'row' }, go)));
    }

    const bud = OUTLINE.budgetCheck(project.outline, project.targetDuration);
    for (const one of bud?.issues || []) {
      listHost.append(h('div', { class: `mob-issue${one.kind === 'floor-over' ? ' hard' : ''}` },
        h('b', {}, one.what),
        h('div', { class: 'muted', style: 'line-height:1.6;margin-top:3px' }, one.why),
        h('div', { style: 'line-height:1.6;margin-top:3px' }, one.fix)));
    }
  };

  const buildBtn = h('button', { class: 'btn sm grow' }, '从剧本生成大纲');
  buildBtn.onclick = async () => {
    const o = OUTLINE.normalizeOutline(project.outline);
    if (o.beats.length && !confirm('重新生成会按当前剧本重排场次。已经拆过分镜的那几场会原样留下。继续？')) return;
    buildBtn.disabled = true;
    const old = buildBtn.textContent;
    buildBtn.textContent = '拆场次中…';
    try {
      // cap:outline
      await stream(`/projects/${project.id}/outline/build`, {}, (ev) => {
        if (ev.type === 'stage' && ev.message) sumLine.textContent = ev.message;
        if (ev.type === 'error') toast(ev.message, 'err');
        if (ev.type === 'finished') {
          project.outline = ev.project?.outline || project.outline;
          paint();
          toast('大纲出来了', 'ok');
        }
      });
    } catch (err) { toast(err.message, 'err'); } finally {
      buildBtn.disabled = false;
      buildBtn.textContent = old;
    }
  };

  const say = h('input', { type: 'text', placeholder: '想怎么改？比如「第 2 场砍一半」' });
  const askBtn = h('button', { class: 'btn sm grow' }, '让它想想');
  askBtn.onclick = async () => {
    if (!say.value.trim()) { toast('想改什么？说一句', 'err'); return; }
    askBtn.disabled = true;
    const old = askBtn.textContent;
    askBtn.textContent = '想…';
    try {
      // cap:outline-revise
      const r = await api(`/projects/${project.id}/outline/revise`, {
        method: 'POST', body: { instruction: say.value }
      });
      clear(chatHost);
      if (!r.preview?.length) {
        chatHost.append(h('div', { class: 'muted' }, r.note || '它没想出要改什么'));
        return;
      }
      if (r.note) chatHost.append(h('div', { class: 'muted', style: 'line-height:1.7' }, r.note));
      const boxes = [];
      for (const one of r.preview) {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = !one.refused;
        cb.disabled = Boolean(one.refused);
        boxes.push({ cb, op: one.op });
        chatHost.append(h('label', { class: `mob-op${one.refused ? ' refused' : ''}` },
          cb, h('span', {}, one.text),
          one.refused ? h('span', { class: 'mob-refused' }, `（做不了：${one.refused}）`) : ''));
      }
      const apply = h('button', { class: 'btn sm grow' }, '应用勾中的');
      apply.onclick = async () => {
        const ops = boxes.filter((x) => x.cb.checked).map((x) => x.op);
        if (!ops.length) { toast('一条都没勾', 'err'); return; }
        apply.disabled = true;
        try {
          // cap:outline-revise
          const res = await api(`/projects/${project.id}/outline/apply`, { method: 'POST', body: { ops } });
          project.outline = res.project.outline;
          paint();
          clear(chatHost);
          toast(`改了 ${res.applied} 条`, 'ok');
        } catch (err) { toast(err.message, 'err'); } finally { apply.disabled = false; }
      };
      chatHost.append(h('div', { class: 'row', style: 'margin-top:8px' }, apply));
    } catch (err) { toast(err.message, 'err'); } finally {
      askBtn.disabled = false;
      askBtn.textContent = old;
    }
  };

  host.append(
    h('summary', {}, '大纲 ', h('span', { class: 'muted' }, '一行一场戏，改顺了再拆分镜')),
    sumLine,
    h('div', { class: 'row', style: 'margin-top:8px' }, buildBtn),
    listHost,
    h('div', { class: 'row', style: 'margin-top:10px' }, say),
    h('div', { class: 'row', style: 'margin-top:8px' }, askBtn),
    chatHost
  );
  paint();
  return host;
}

/**
 * ── 追加一章 ──
 *
 * 往剧本末尾拼，前面的正文一个字都不会动。
 * 手工粘贴最容易毁掉的就是这一点：碰掉前面一个空格，那一章就被判定
 * "改过了"，已经出好的分镜全部作废重跑 —— 而且没有任何提示。
 */
function appendChapterCard() {
  const host = h('details', { class: 'card site-details' });
  const title = h('input', { type: 'text', placeholder: '章节标题（留空自动编号）' });
  const body = h('textarea', { rows: 5, class: 'mta', placeholder: '把新一章的正文贴在这儿' });
  const btn = h('button', { class: 'btn sm grow' }, '追加这一章');
  btn.onclick = async () => {
    if (!body.value.trim()) { toast('这一章是空的', 'err'); return; }
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '追加中…';
    try {
      // cap:append-chapter
      const r = await api(`/projects/${project.id}/chapters/append`, {
        method: 'POST', body: { title: title.value, script: body.value }
      });
      project = r.project || project;
      body.value = '';
      title.value = '';
      toast('已追加 —— 前面几章的进度都还在', 'ok');
      paint();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };
  /**
   * ── 新章还没对过设定集 ──
   *
   * 电脑版有这条，手机版原来没有。三端对齐那条自检**抓不到**：
   * 能力清单里 extend-bible 标着"手机版有"（按钮确实在设定集页），
   * 只是**提示**没有 —— 清单管得了"功能在不在"，管不了"提示在不在"。
   *
   * 而不提示的后果是静默的：新章里的角色不进设定集，那几镜没有参考图、
   * 没有外貌描述、复核没有基准，静默降级成"文生图"，流水线一路绿。
   */
  const unscanned = (project?.chapters || []).filter((c) => !c.castScanned);
  const scanRow = unscanned.length && project?.bible ? (() => {
    const btn = h('button', { class: 'btn sm grow' }, `扫这 ${unscanned.length} 章`);
    const log = h('div', { class: 'muted', style: 'margin-top:6px' });
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        // cap:extend-bible
        await stream(`/projects/${project.id}/extend-bible`, {}, (ev) => {
          if (ev.message) log.textContent = ev.message;
          if (ev.type === 'error') toast(ev.message, 'err');
          if (ev.type === 'finished') {
            project.bible = ev.project?.bible || project.bible;
            toast(ev.added?.length
              ? `补了 ${ev.added.length} 条：${ev.added.map((a) => a.name).join('、')}`
              : '这几章用的都是已有的角色和场景', 'ok');
            paint();
          }
        });
      } catch (err) { toast(err.message, 'err'); } finally { btn.disabled = false; }
    };
    return h('div', { class: 'mob-pending' },
      h('b', {}, `有 ${unscanned.length} 章还没对过设定集`),
      h('div', { class: 'muted', style: 'margin:3px 0 8px' },
        '扫一遍，只把没见过的角色和场景补进来 —— 已有的一条都不动、一张图都不重出。'
        + '不扫的话，新角色那几镜会没有参考图，而且不报错。'),
      h('div', { class: 'row' }, btn), log);
  })() : null;

  host.append(
    h('summary', {}, '追加一章 ', h('span', { class: 'muted' }, '剧本一章一章来的时候用')),
    scanRow || '',
    h('div', { class: 'muted', style: 'line-height:1.7' },
      '往剧本末尾拼，前面的正文一个字都不动 —— 已经跑完的章不会作废重跑。'),
    title, body,
    h('div', { class: 'row', style: 'margin-top:8px' }, btn));
  return host;
}

/**
 * ── 场地图 ──
 *
 * 手机上做这一块，和剪辑台不同，不是"把电脑那套缩小塞进来"。
 *
 * 画布本身在手机上是**更好用**的：两指捏合缩放、一根手指平移，
 * 这套手势本来就是触屏的母语，鼠标那边反而要靠滚轮凑合。
 * 而它要交付的那件事 —— "这片山坡上三场戏的太阳对不对得上" ——
 * 恰恰是审片时最容易发现、最该当场记一笔的。
 *
 * 折叠起来是因为它不是每次打开设定集都要看的东西。
 */
function siteCard() {
  /**
   * 用原生 <details>，不自己写开合。
   *
   * ⚠ 第一版把标题套在 `.fchip.icon` 上 —— 那个类是 `width: 32px` 的
   * **方形图标按钮**（分镜页那个「⋯」用的就是它）。四个字塞进 32 像素，
   * 结果是一个挤成一团、点不准的东西，而 CSS 不会因此报任何错。
   * 原生 details 自带箭头、自带键盘可达性，也不会有开合状态对不上的 bug。
   */
  const host = h('details', { class: 'card site-details' });
  const head = h('summary', {}, '场地图 ', h('span', { class: 'muted' }, '几个场景摆到一张图上'));
  const body = h('div', {});
  let built = false;
  host.addEventListener('toggle', () => {
    if (!host.open || built) return;
    built = true;
    body.append(SITE.sitePanel(project, {
      onAlign: async (name) => {
        try {
          // cap:site-map
          const p2 = await api(`/projects/${project.id}/site/apply`, {
            method: 'POST', body: { site: name }
          });
          project.bible = p2.project.bible;
          toast(p2.changed.length
            ? `已按场地图对齐 ${p2.changed.length} 个场景：${p2.changed.join('、')}`
            : '这几个场景本来就和场地图一致，没有要改的', 'ok');
        } catch (err) { toast(err.message, 'err'); }
      },
      onPlace: async (scene, place) => {
        try {
          // cap:site-map
          const p2 = await api(`/projects/${project.id}/scene-place`, {
            method: 'POST', body: { scene, place }
          });
          project.bible = p2.bible;
        } catch (err) { toast(err.message, 'err'); }
      },
      onSite: async (name, patch) => {
        try {
          // cap:site-map
          const p2 = await api(`/projects/${project.id}/site`, {
            method: 'POST', body: { site: name, ...patch }
          });
          project.bible = p2.bible;
        } catch (err) { toast(err.message, 'err'); }
      }
    }).node);
  });
  host.append(head, body);
  return host;
}


/**
 * 把手机相册里那张大图缩到长边 maxSide，转成 dataUrl。
 *
 * 手机拍的照片五六 MB 很常见，base64 再胀三分之一 —— 直接传会被
 * 请求体上限挡掉，而那个失败长得像"传不上去"，看不出是大小问题。
 * 参考图本来也不需要那么大：它回答的是"这个人长什么样"，1280 绰绰有余。
 */

function shrinkImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));

      const w = Math.max(1, Math.round(img.width * scale));
      const hgt = Math.max(1, Math.round(img.height * scale));
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = hgt;
      cv.getContext('2d').drawImage(img, 0, 0, w, hgt);
      // JPEG 而不是 PNG：照片用 PNG 存反而更大，而参考图不需要无损
      resolve(cv.toDataURL('image/jpeg', 0.9));

    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('这个文件读不出来，换一张图试试'));
    };
    img.src = url;
  });
}

function bibleCard(kind, item, v) {
  const look = h('textarea', { rows: 3, class: 'mta' }, item.appearance || '');
  const save = h('button', { class: 'btn sm grow' }, '保存描述');
  save.onclick = async () => {
    save.disabled = true;
    try {
      // cap:bible-edit
      const fresh = await api(`/projects/${project.id}`);
      const list = kind === 'char' ? fresh.bible.characters : kind === 'scene' ? fresh.bible.scenes : fresh.bible.props;
      const target = list.find((x) => x.name === item.name);
      if (!target) throw new Error('这一条已经不在设定集里了');
      target.appearance = look.value.trim();
      // 描述改了就把旧的提示词覆盖清掉，否则重出图画的还是旧描述（电脑端踩过两次的坑）
      for (const variant of target.variants || []) delete variant.sheetPrompt;
      await api(`/projects/${project.id}`, { method: 'PATCH', body: { bible: fresh.bible } });
      toast('已保存。重出这一张参考图才会按新描述画', 'ok');
      await reload();
    } catch (err) {
      toast(err.message, 'err');
      save.disabled = false;
    }
  };


  /**
   * ── 传一张自己的图当设定图 ──
   *
   * 用户的原话："要么你在手机上添加一个上传图片的功能"。
   *
   * 手机上原来**完全没有**这个 —— 而这件事恰恰最该在手机上做：
   * 想用的那张脸多半就在手机相册里，为了传一张图专门开电脑，
   * 是把一个三秒钟的动作变成一趟路。而这条一直没登记进能力清单，
   * 所以"三端对齐"那条自检从来没红过。
   *
   * ⚠ 传上去之后 sheetSource 记成 upload，出分镜图时默认就会带上它
   *（见 consistency.refPlan 的 auto 档）—— 这两件事必须一起才算数：
   * 只能传、传完不发，和不能传没有区别。
   */
  const pick = h('input', {
    type: 'file',
    accept: 'image/*',
    style: 'display:none'
  });

  const up = h('button', { class: 'btn sm grow', disabled: job.running }, '传一张图');
  up.onclick = () => pick.click();
  pick.onchange = async () => {
    const file = pick.files?.[0];
    if (!file) return;

    /**
     * 手机拍的照片动辄五六 MB，base64 再胀三分之一。
     * 服务端那条路收 dataUrl，太大直接被请求体上限挡掉 —— 而那个失败
     * 长得像"传不上去"，看不出是大小问题。所以先在本地缩到长边 1280。
     */
    up.disabled = true;
    const label0 = up.textContent;

    up.textContent = '处理中…';
    try {
      const dataUrl = await shrinkImage(file, 1280);
      let failed = null;

      // cap:sheet-upload

      await stream(
        `/projects/${project.id}/bible/${kind}/${encodeURIComponent(item.name)}/upload`,
        { dataUrl, fileName: file.name },
        (ev) => { if (ev.type === 'error') failed = ev.message; }
      );
      if (failed) throw new Error(failed);
      toast(`${item.name} 已换成你传的图，出分镜图时会带上它`, 'ok');
      await reload();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      pick.value = '';
      up.disabled = false;

      up.textContent = label0;

    }
  };

  const redo = h('button', { class: 'btn sm grow', disabled: job.running }, '重出参考图');
  redo.onclick = async () => {
    redo.disabled = true;
    job.running = true;
    job.label = `${item.name} 参考图`;
    job.message = '正在出…';
    updateLive();
    try {
      // cap:sheet-regen
      let failed = null;
      await stream(`/projects/${project.id}/bible/${kind}/${encodeURIComponent(item.name)}/regenerate`, {}, (ev) => {
        if (ev.type === 'error') failed = ev.message;
        if (ev.message) {
          job.message = ev.message;
          updateLive();
        }
      });
      if (failed) throw new Error(failed);
      toast(`${item.name} 的参考图出好了`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      job.running = false;
      updateLive();
      await reload();
    }
  };

  /**
   * 补角度：侧面 / 背面 / 俯视平面。
   *
   * 手机上**不列角度清单**，直接"全补" —— 服务端不带 angles 时默认补齐这一类的全部。
   * 手机端是遥控 + 审片，审片时发现"他一转身就变了个人"，当场点一下补上就够了；
   * 挑哪几个角度这种事留给电脑版。
   */
  const angleRow = (item.variants?.[0]?.angles || []).filter((a) => a?.sheetPath);
  const angleBtn = kind === 'prop'
    ? null
    : h('button', { class: 'btn sm grow', disabled: job.running || !item.sheetPath }, angleRow.length ? `补角度（已有 ${angleRow.length}）` : '补角度');
  if (angleBtn) {
    angleBtn.onclick = async () => {
      if (!confirm(`给「${item.name}」补出其他角度？每张都是一次出图开销。\n\n补完之后，需要那个朝向的镜头会自动改用对应的图。`)) return;
      angleBtn.disabled = true;
      job.running = true;
      job.label = `${item.name} 补角度`;
      job.message = '正在出…';
      updateLive();
      try {
        // cap:sheet-angles
        let failed = null;
        await stream(`/projects/${project.id}/bible/${kind}/${encodeURIComponent(item.name)}/angles`, {}, (ev) => {
          if (ev.type === 'error') failed = ev.message;
          if (ev.message) {
            job.message = ev.message;
            updateLive();
          }
        });
        if (failed) throw new Error(failed);
        toast(`${item.name} 的角度补好了`, 'ok');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        job.running = false;
        updateLive();
        await reload();
      }
    };
  }

  return h('div', { class: 'card' },
    h('div', { class: 'row' },
      item.sheetPath
        ? zoomable({ class: 'sheet-thumb', loading: 'lazy' }, media(item.sheetPath, v), item.name)
        : h('div', { class: 'sheet-thumb blank' }, '无图'),
      h('div', { class: 'grow' },
        h('b', {}, item.name),
        item.role ? h('div', { class: 'muted' }, item.role) : null,
        item.seed != null ? h('div', { class: 'muted' }, `种子 ${item.seed}`) : null)),

    /**
     * 这张图哪来的 —— 一眼看得出是"你传的"还是"模型出的"。
     *
     * 这一条直接对应用户撞上的那个死结：分镜说"没带你传的图"，
     * 而他确信设定集里就是他的照片。两句话必有一句错，
     * 而在设定集上标出来源，当场就分得清。
     */

    item.sheetPath
      ? h('div', { class: 'muted', style: 'margin-top:6px' },
          item.sheetSource === 'upload'
            ? `这张是你传的${item.sheetFileName ? `（${item.sheetFileName}）` : ''} —— 出分镜图时会带上它`
            : '这张是模型出的。想用自己的照片就点下面「传一张图」')
      : null,
    h('div', { style: 'margin-top:10px' }, look),
    pick,
    h('div', { class: 'row', style: 'margin-top:9px' }, save, up, redo, angleBtn));
}

/** 画风和设定集里冻结的那段对不上时，给一条能一键换过来的提示 */
function driftCard() {
  const host = h('div', {});
  api(`/projects/${project.id}/style`).then((d) => {
    if (!d.drifted) return;
    const go = h('button', { class: 'btn sm primary grow' }, '换成预设的那一段');
    go.onclick = async () => {
      go.disabled = true;
      try {
        // cap:style-sync
        await api(`/projects/${project.id}/style/sync`, { method: 'POST' });
        toast('画风已同步，重出图才会变', 'ok');
        await reload();
      } catch (err) {
        toast(err.message, 'err');
        go.disabled = false;
      }
    };
    clear(host).append(
      h('div', { class: 'card warn' },
        h('b', {}, `画风「${d.name}」和这里冻结的不一样`),
        h('p', { class: 'muted', style: 'margin:6px 0 8px' },
          '风格锚是跑第 01 步时冻结的，换画风不会自动生效。只换这一段话，角色和场景一个字不动。'),
        h('div', { class: 'muted', style: 'margin-bottom:8px' }, `现在：${d.current.anchor}`),
        h('div', { class: 'muted', style: 'margin-bottom:10px' }, `换成：${d.preset.anchor}`),
        h('div', { class: 'row' }, go)));
  }).catch(() => {
    /* 查不到就当没这回事，不能因为一条提示把整页挡住 */
  });
  return host;
}

/** 一台设备上一个项目都没有时，得能直接建一个，而不是"回电脑上建" */
/**
 * 真正建项目的那一步。空状态那张卡片和顶栏那个 ＋ 都走它 ——
 * 两处各写一份的话，迟早一处改了另一处没改（比如以后要带上画风），
 * 而"从哪儿进来的决定建出来的项目长什么样"是最难查的一类不一致。
 */
async function createProject(title) {
  // cap:project-new
  const p = await api('/projects', { method: 'POST', body: { title } });
  localStorage.setItem(PROJ_STORE, p.id);
  await reload();
  return p;
}

/**
 * 从底下推上来的一层。
 *
 * 手机上没有 Esc，也没有"点旁边关掉"的鼠标习惯 —— 所以每一层都要同时给
 * ①点浮层外面关 ②面板里一个整行的取消。只给其中一个，总有人被困在里面。
 *
 * @param inner 面板内容（自己带 padding 的节点，比如一张 .card）
 * @param opts.bare true = 内容自己就是面板，不再包一层 .sheet-box
 */
/** 切页签。原来只有页签按钮自己会改 tab，别处要跳过去就没有入口 */
function goTab(id) {
  tab = id;
  paint();
}

function openSheet(inner, { bare = false } = {}) {
  const layer = h('div', { class: 'sheet' });
  const close = () => layer.remove();
  layer.append(bare ? inner : h('div', { class: 'sheet-box' }, inner));
  layer.onclick = (e) => { if (e.target === layer) close(); };
  document.body.append(layer);
  return { layer, close };
}

/**
 * 一镜的「⋯」。
 *
 * 卡片上放不下的动作全在这儿，每一条都是整行 56px 的目标 ——
 * 比原来挤在一排的五个小按钮好点得多，而且每条底下能写一句
 * "什么时候该用它"，那句话原来无处可写。
 */
function openShotActions(s) {
  const box = h('div', { class: 'sheet-box acts-sheet' });
  const { layer, close } = openSheet(box, { bare: true });

  const row = (icon, label, sub, onclick, { hot = false, disabled = false, tail = '' } = {}) =>
    h('button', { class: 'row-act', disabled, onclick: () => { close(); onclick(); } },
      h('span', { class: `ic ${hot ? 'hot' : ''}` }, icon),
      h('span', { class: 'grow' },
        h('div', {}, label),
        sub ? h('div', { class: 'sub' }, sub) : null),
      tail ? h('span', { class: 'muted', style: 'font-size:12px' }, tail) : null);

  box.append(
    h('div', { class: 'grab' }),
    h('div', { class: 'row' },
      s.imagePath
        ? h('img', { src: media(s.imagePath), style: 'width:54px;height:34px;flex:0 0 54px;object-fit:cover;border-radius:7px;background:#000' })
        : null,
      h('div', { class: 'grow' },
        h('b', {}, `第 ${s.index} 镜`),
        h('div', { class: 'muted', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
          s.description || '（无描述）'))),
    // cap:shot-regen
    row('↻', '重出这张图', '改完描述先出图，看对了再出视频 —— 省一次视频钱',
      () => regen(s, 'image'), { hot: true, disabled: job.running }),
    row('▶', '重出这段视频', s.imagePath ? '按首尾帧重出，会重新去接上一镜的末帧' : '得先有图才能出视频',
      () => regen(s, 'video'), { hot: true, disabled: job.running || !s.imagePath }),
    row('✎', '改这一镜', '描述、台词、景别、时长…', () => openEditor(s)),
    row('⌖', '预演台', s.stage?.cam ? '已排位，点进去调整' : '排机位、算景别、查越轴',
      () => openEditor(s, 'stage')),
    // cap:shot-versions
    row('⏱', '历史版本', '留最近 5 版，换回去是可逆的', () => openVersions(s)),
    // cap:image-zoom
    s.imagePath
      ? row('⤢', '看大图', '双指放大，查手指、查衣领花纹',
          () => openViewer(media(s.imagePath), `第 ${s.index} 镜`))
      : null,
    h('button', { class: 'btn block', style: 'margin-top:14px', onclick: close }, '取消'));

  return layer;
}

/**
 * 顶栏那个 ＋ 弹出来的一层。
 *
 * 用一层浮层而不是 prompt()：prompt 在部分安卓浏览器和加到主屏的
 * WebAPK 里**根本不弹**，点了没反应 —— 而"点了没反应"是最难报的故障，
 * 用户只会觉得这个按钮坏了。
 */
function newProjectSheet() {
  const name = h('input', { type: 'text', placeholder: '片名', autofocus: true });
  const go = h('button', { class: 'btn primary grow' }, '建');
  const layer = h('div', { class: 'sheet' });
  const close = () => layer.remove();
  go.onclick = async () => {
    const title = name.value.trim();
    if (!title) return toast('先起个名字', 'err');
    go.disabled = true;
    try {
      await createProject(title);
      close();
      toast('建好了，把剧本贴进来', 'ok');
    } catch (err) {
      toast(err.message, 'err');
      go.disabled = false;
    }
  };
  name.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
  layer.append(
    h('div', { class: 'sheet-box' },
      h('b', {}, '新建项目'),
      h('p', { class: 'muted', style: 'margin:6px 0 10px' }, '起个名字就能开工，剧本可以之后再贴。'),
      name,
      h('div', { class: 'row', style: 'margin-top:12px' },
        go,
        h('button', { class: 'btn sm', onclick: close }, '取消')))
  );
  // 点浮层外面关掉。手机上没有 Esc，这是唯一自然的退出方式
  layer.onclick = (e) => { if (e.target === layer) close(); };
  document.body.append(layer);
  setTimeout(() => name.focus(), 50);
  return layer;
}

function newProjectCard() {
  const name = h('input', { type: 'text', placeholder: '片名' });
  const go = h('button', { class: 'btn primary grow' }, '新建项目');
  go.onclick = async () => {
    const title = name.value.trim();
    if (!title) return toast('先起个名字', 'err');
    go.disabled = true;
    try {
      await createProject(title);
      toast('建好了，把剧本贴进来', 'ok');
    } catch (err) {
      toast(err.message, 'err');
      go.disabled = false;
    }
  };
  return h('div', { class: 'card' },
    h('b', {}, '还没有项目'),
    h('p', { class: 'muted', style: 'margin:6px 0 10px' }, '起个名字就能开工，剧本可以之后再贴。'),
    name,
    h('div', { class: 'row', style: 'margin-top:10px' }, go));
}

/**
 * 一段镜头一起标衔接关系。
 *
 * 「这一段是一个连贯动作」是**按段**发生的想法，不是按镜：
 * 推门→进门→环视→停下，四镜是一件事。一镜一镜点四次容易漏掉中间那一镜，
 * 而漏掉的那一镜恰恰是断点 —— 出完片才看得出来。
 */
/**
 * ══════════ 指令框 ══════════
 *
 * 一句人话 → 先摆出**要做什么** → 你点了才执行。
 *
 * ⚠ 这三步中间那一步不能省。省掉它就变成了"说一句话它就动手"，
 * 而这个应用里动手的代价是真钱和几十镜的文案。所以：
 *   · 打字时实时预览（解析只在本地算，不调模型、不花钱）
 *   · 执行按钮上写的是**这次到底要改哪几镜、改成什么**
 *   · 花钱的动作按钮变色，而且照旧走原来那条预检 + 估算
 *
 * 看不懂时不猜。宁可让你再打一遍，也不拿真钱赌一个"最像的"。
 */
function commandCard(close) {
  const box = h('textarea', {
    class: 'mta', rows: '2', placeholder: '比如：第 6-12 镜改成中景'
  });
  const preview = h('div', { class: 'cmd-preview muted' });
  const go = h('button', { class: 'btn sm grow', disabled: true }, '先说要做什么');
  let plan = null;

  const render = () => {
    if (!plan) {
      preview.className = 'cmd-preview muted';
      preview.textContent = '';
      go.disabled = true;
      go.textContent = '先说要做什么';
      return;
    }
    if (!plan.ok) {
      preview.className = 'cmd-preview bad';
      preview.textContent = plan.why + (plan.examples?.length ? `\n试试：${plan.examples[0]}` : '');
      go.disabled = true;
      go.textContent = '没听懂';
      return;
    }
    preview.className = `cmd-preview ${plan.costs ? 'costly' : 'ok'}`;
    preview.textContent = plan.say + (plan.costs ? '\n⚠ 这一步要花钱，按下去之前还会再过一遍预检和估算。' : '');
    go.disabled = false;
    go.className = `btn sm grow ${plan.costs ? 'primary' : ''}`;
    go.textContent = plan.verb === 'ask' ? '看一下' : plan.costs ? '去预检' : '就这么改';
  };

  const egs = h('div', { class: 'cmd-eg' });
  const paintEgs = (list) => {
    clear(egs);
    for (const s of list || []) {
      egs.append(h('button', {
        class: 'fchip',
        onclick: () => { box.value = s; box.dispatchEvent(new Event('input')); }
      }, s));
    }
  };
  // 空串也问一次，纯粹为了把这个项目的例子拿回来填上
  api(`/projects/${project.id}/command`, { method: 'POST', body: { text: '' } })
    .then((r) => paintEgs(r.examples))
    .catch(() => {});

  let timer = null;
  box.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const text = box.value.trim();
      if (!text) { plan = null; render(); return; }
      try {
        // cap:command-box
        plan = await api(`/projects/${project.id}/command`, { method: 'POST', body: { text } });
      } catch (err) {
        plan = { ok: false, why: err.message, examples: [] };
      }
      if (plan?.examples?.length) paintEgs(plan.examples);
      render();
    }, 250);
  };

  go.onclick = async () => {
    if (!plan?.ok) return;
    if (plan.verb === 'edit') {
      go.disabled = true;
      try {
        const r = await api(`/projects/${project.id}/shots/batch`, {
          method: 'POST',
          body: {
            ids: plan.targets, patch: plan.patch,
            addSkills: plan.addSkills, removeSkills: plan.removeSkills
          }
        });
        toast(`改了 ${r.changed} 镜`, 'ok');
        await reload();
        close();
      } catch (err) {
        toast(err.message, 'bad');
        go.disabled = false;
      }
      return;
    }
    /**
     * 花钱的和"问一问"的都交回给现成的那条路 ——
     * 预检、估算、停下来那一整套已经在那儿了，指令框不另起炉灶。
     * 另起一套的话，那几道闸门就会有一条绕过它们的近路。
     */
    close();
    if (plan.verb === 'run') {
      toast(`到「流水线」按清单开始 —— ${plan.say}`, 'ok');
      goTab('flow');
      return;
    }
    if (plan.verb === 'ask' && plan.targets?.length === 1) {
      const s = (project.shots || []).find((x) => x.id === plan.targets[0]);
      if (s) { openWhy(s, true); return; }
    }
    toast(plan.say, 'ok');
    goTab('flow');
  };

  return h('div', { class: 'sheet-card' },
    h('h3', {}, '说一句话'),
    box,
    preview,
    h('div', { class: 'row', style: 'margin-top:10px' }, go),
    h('div', { class: 'muted', style: 'margin-top:10px;font-size:12px' },
      '它只会做你本来就能做的事，做之前先摆给你看。'),
    /**
     * 例子是**可点的模板**，而且镜号人名全取自你自己的分镜表 ——
     * 写死"第 6-12 镜"的话，在一个只有 2 镜的项目里点下去选不到任何东西，
     * 而那是用户对这个功能的第一印象。服务端 examplesFor 已经按项目算好，
     * 随任意一次解析回来（看不懂时那份就是给这儿用的）。
     */
    egs);
}

function linkRangeCard(shots) {
  const from = h('input', { type: 'number', min: 1, value: '1', style: 'width:80px' });
  const to = h('input', { type: 'number', min: 1, value: String(shots.length) , style: 'width:80px' });
  const kind = h('select', { class: 'msel' },
    h('option', { value: 'continuous', selected: true }, '连续动作（动作不能断）'),
    h('option', { value: 'cut' }, '同场景换机位'),
    h('option', { value: 'new-scene' }, '换场景'));
  // 通读的过程要**全留着**（拒绝的理由都在里面），所以给它一个能滚的框
  const status = h('div', { class: 'muted', style: 'margin-top:8px;max-height:220px;overflow-y:auto' });
  const go = h('button', { class: 'btn sm grow' }, '整段标记');
  go.onclick = async () => {
    if (kind.value === 'continuous') {
      const n = Math.abs(Number(to.value) - Number(from.value)) + 1;
      // 代价要在按之前说，不是按完之后才发现"怎么这么慢"
      if (!confirm(`把第 ${from.value}~${to.value} 镜（共 ${n} 镜）标成连续动作？\n\n这几镜会串行生成，比并行慢好几倍；而且机位被锁住，标多了整段变成一个长镜头。`)) return;
    }
    go.disabled = true;
    try {
      // cap:link-batch
      const r = await api(`/projects/${project.id}/shots/link`, {
        method: 'POST',
        body: { from: Number(from.value), to: Number(to.value), link: kind.value }
      });
      status.textContent = r.changed.length ? `改了 ${r.changed.length} 镜` : '本来就是这个关系，没动';
      await reload();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      go.disabled = false;
    }
  };
  const auto = h('button', { class: 'btn sm grow' }, '让模型通读全片自动标');
  auto.onclick = async () => {
    auto.disabled = true;
    const label = auto.textContent;
    auto.textContent = '通读中…';
    try {
      let failed = null;
      // cap:link-auto
      /**
       * ⚠ 每条消息都要**留住**，不能只写最后一行。
       *
       * 这里原来是 `status.textContent = ev.message` —— 后一条冲掉前一条。
       * 而这一步最值钱的输出恰恰是中间那些：「第 7 镜模型想标连续动作，
       * 没采纳：和第 6 镜跨了场次」。冲掉之后用户只看到最后那句
       * "没有哪两镜构成连续动作"，然后问"很明显的连贯动作，为什么看不出来" ——
       * 而理由其实说过了，只是被下一行覆盖了。
       */
      clear(status);
      await stream(`/projects/${project.id}/shots/link/auto`, {}, (ev) => {
        if (ev.type === 'error') failed = ev.message;
        if (!ev.message) return;
        const line = h('div', { class: 'muted', style: 'margin-top:4px' }, ev.message);
        if (/没采纳|想标/.test(ev.message)) line.style.color = 'var(--warn, #c98a2b)';
        status.append(line);
        status.scrollTop = status.scrollHeight;
      });
      if (failed) throw new Error(failed);
      await reload();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      auto.disabled = false;
      auto.textContent = label;
    }
  };

  return h('div', { class: 'card' },
    h('b', {}, '整段标衔接'),
    /**
     * ⚠ 这句话**写错过**，而且错得很有代价。
     *
     * 原文是「标成连续动作会把上一镜的末帧锁成下一镜的首帧」—— 那描述的是
     * tail 模式，而默认跑的是 lock（首尾帧）。用户照着这句话去看成片，
     * 看到"这一段的第一帧根本不是上一段的最后一帧"，只能得出"坏了"的结论。
     *
     * 现在按**当前模式**说，而且措辞读的是引擎那一份（core/seam.js）——
     * 三处（设置下拉、这张卡片、出视频时的说明）用同一句，才不会再漂开。
     */
    h('p', { class: 'muted', style: 'margin:6px 0 10px' },
      '推门→进门→环视 这种连贯动作，标成「连续动作」才会做接缝。'),
    h('p', { class: 'muted', style: 'margin:0 0 10px' },
      SEAM.howItWorks(appSettings.seamMode)),
    h('div', { class: 'row' },
      h('span', { class: 'muted' }, '第'), from,
      h('span', { class: 'muted' }, '到'), to,
      h('span', { class: 'muted' }, '镜')),
    h('div', { style: 'margin-top:9px' }, kind),
    h('div', { class: 'row', style: 'margin-top:9px' }, go),
    /**
     * 让调度模型通读全片自动标。
     *
     * 手工整段标要人自己一对一对看"这两镜是不是同一个动作"，二十镜很累，
     * 而在手机上更累。这一条恰恰是**模型比规则强**的地方：
     * 规则只能比场景名，读不懂「伸手去够门把手」和「把门把手拧下去」
     * 是同一只手的同一个动作。
     */
    h('div', { class: 'row', style: 'margin-top:9px' }, auto),
    status);
}

/**
 * 这一镜有什么毛病，以及**该按哪个键**。
 *
 * 分档和字段名跟 core/pipeline/quality.js（成片体检）对齐。两处结论不一致
 * 比没有结论更糟：卡片上说没事、体检页说不能发，人只会两个都不信。
 *
 *   blocker  导出去一定有人看得出来（缺产物、有台词没配音、标着无缝而实际没接上）
 *   warn     质量风险，未必看得出来（一致性偏低、首帧没吃、比例不符）
 *
 * `fix` 是"按下去就能修"的那个动作；修不了的（比如配音要整步跑）留 null，
 * 界面上就不给主按钮 —— 给一个按下去没用的按钮比不给更让人恼火。
 */
function shotIssues(s, prev = null) {
  const out = [];
  if (!s.imagePath) {
    out.push({ level: 'blocker', what: '还没出图', fix: 'image', how: '重出这张图' });
  } else if (!s.videoPath && s.pendingTask) {
    /**
     * 钱已经花了，片子在厂商那边 —— 这一条**必须排在"有图没视频"前面**，
     * 而且不能给「重出」那个主按钮：重出是第二次付钱，而正确的动作是免费捞回来。
     * 两者长得一模一样（都是"有图没视频"），代价差一整镜的视频钱。
     */
    out.push({
      level: 'blocker',
      what: '这一镜的钱已经花了、片子没取回来 —— 重出等于再付一次',
      fix: null,
      how: '去流水线点「把这几镜捞回来（不花钱）」'
    });
  } else if (!s.videoPath) {
    out.push({
      level: 'blocker',
      // 失败过就把厂商原话摆出来。原来这句话只活在那条流里，流一断就没了
      what: s.videoError?.message
        ? `出视频失败：${String(s.videoError.message).slice(0, 60)}`
        : '有图没视频 —— 合成时这一镜会被直接跳过',
      fix: 'video',
      how: '重出这段视频'
    });
  }
  if (s.link === 'continuous' && s.tailAlign?.verdict === 'missed') {
    out.push({ level: 'blocker', what: '标着「连续动作」，接缝其实没锁上', fix: 'video', how: '重出这段视频' });
  }
  /**
   * 标着「连续动作」，而两条路一条都没走成。
   *
   * 接缝在首尾帧模式下是做在**上一镜**身上的，所以证据也在上一镜：
   *   首尾帧  上一镜的 endFrameChained（末帧真的发出去了）
   *   接住末帧 这一镜的 headFromTail（首帧真的是上一段抠出来的）
   * 都没有，这两镜之间就什么衔接都没有 —— 而卡片上还写着「连续动作」。
   *
   * ⚠ 要重出的是**上一镜**，不是这一镜。不说清楚的话，人会一遍遍重出
   * 后面这一镜然后觉得功能是坏的 —— 而那正是最贵的一种误解。
   */
  if (s.link === 'continuous' && s.videoPath && prev?.videoPath
      && !s.headFromTail && !prev.endFrameChained) {
    out.push({
      level: 'blocker',
      what: `标着「连续动作」，但和第 ${prev.index} 镜之间什么衔接都没做上`,
      fix: null,
      how: `去重出第 ${prev.index} 镜 —— 接缝做在上一镜身上`
    });
  }
  if (String(s.dialogue || '').trim() && !s.audioPath) {
    out.push({ level: 'blocker', what: '有台词但没配音 —— 嘴在动，没有声音', fix: null, how: '去流水线跑「配音」' });
  }
  if (s.headMatch?.verdict === 'mismatch') {
    out.push({ level: 'warn', what: '视频首帧和发过去的图对不上', fix: 'video', how: '重出这段视频' });
  }
  if (s.imageSize && s.imageSize.ok === false) {
    out.push({ level: 'warn', what: `画面比例不符（${s.imageSize.width}×${s.imageSize.height}）`, fix: 'image', how: '重出这张图' });
  }
  const c = s.consistency;
  if (c?.stale) {
    out.push({ level: 'warn', what: '一致性分数是改文案之前打的，不作数了', fix: 'image', how: '重出这张图' });
  } else if (c && c.score != null && c.pass === false) {
    out.push({ level: 'warn', what: `一致性只有 ${c.score} 分 —— 这一镜里的人和设定图对不上`, fix: 'image', how: '重出这张图' });
  }
  if (s.sfxPath && s.sfxOf !== s.sound) {
    out.push({ level: 'warn', what: '音效是按旧描述出的', fix: null, how: '去流水线重跑「音效」' });
  }
  return out;
}

/** 这一镜是红的、黄的、还是干净的 */
function shotLevel(s, prev = null) {
  const p = shotIssues(s, prev);
  return p.some((i) => i.level === 'blocker') ? 'bad' : p.length ? 'iffy' : 'ok';
}

/** 分镜页当前只看哪一类。放模块级：切到别的页再回来，筛选还在 */
let shotFilter = 'all';

/**
 * 分镜页。
 *
 * 这一页的真实用法是**审片**：从头翻到尾，找出哪几镜不对，当场改或当场重出。
 * 所以最上面那条筛选不是装饰 —— 十二镜里有三镜有毛病，让人一镜一镜翻过去找，
 * 等于把机器该干的事推给人；而手机上一屏只看得见一两镜，翻的代价还要再高一截。
 */
function paintShots() {
  const shots = (project?.shots || []).slice().sort((a, b) => a.index - b.index);
  if (!shots.length) return h('div', { class: 'card muted' }, '还没有分镜。先在流水线里跑到第 02 步。');
  const v = Date.parse(project.updatedAt || '') || 0;
  const portrait = /^9:16$|^3:4$/.test(project.aspectRatio || '');

  // 接缝的证据在上一镜身上，所以每一镜都要连着它的前一镜一起看
  const probs = new Map(shots.map((s, i) => [s.id, shotIssues(s, i ? shots[i - 1] : null)]));
  const level = (s) => {
    const p = probs.get(s.id);
    return p.some((i) => i.level === 'blocker') ? 'bad' : p.length ? 'iffy' : 'ok';
  };
  const counts = { bad: 0, iffy: 0, novideo: 0 };
  for (const s of shots) {
    const l = level(s);
    if (l !== 'ok') counts[l] += 1;
    if (!s.videoPath) counts.novideo += 1;
  }

  const PICKS = [
    ['all', `全部 ${shots.length}`, ''],
    ['bad', `有问题 ${counts.bad}`, 'bad'],
    ['iffy', `值得看 ${counts.iffy}`, 'warnish'],
    ['novideo', `缺视频 ${counts.novideo}`, '']
  ].filter(([id]) => id === 'all' || counts[id]);
  if (!PICKS.some(([id]) => id === shotFilter)) shotFilter = 'all';

  const keep = (s) => (shotFilter === 'all' ? true
    : shotFilter === 'novideo' ? !s.videoPath
      : level(s) === shotFilter);

  const bar = h('div', { class: 'filterbar' },
    ...PICKS.map(([id, label, tone]) => h('button', {
      class: `fchip ${tone} ${shotFilter === id ? 'on' : ''}`,
      onclick: () => {
        shotFilter = id;
        paint();
      }
    }, label)),
    /**
     * 整段标衔接原来是列表最上面那张大卡，占掉小半屏 —— 而它是**偶尔用一次**的东西：
     * 一部片子标一遍就完了，剩下九十九次打开分镜页的人都在被它挡着。收进这儿。
     */
    h('button', {
      class: 'fchip icon',
      onclick: () => openSheet(linkRangeCard(shots))
    }, '⋯'),
    /**
     * 指令框的入口。放在筛选条上，因为它做的正是筛选条做不到的那半件事：
     * 筛选只能"看哪些"，它能"对这些做什么"。
     */
    h('button', {
      class: 'fchip icon',
      onclick: () => {
        // openSheet 回的是 { close } —— 卡片要自己关掉自己，所以得先拿到它
        const box = h('div');
        const { close } = openSheet(box);
        box.append(commandCard(close));
      }
    }, '⌘'));

  /**
   * 场次分隔条。手机上一屏只看得见一两镜，边界更容易被漏掉 ——
   * 而跨边界不能锁末帧、不能拿邻镜当参考，看不见的话人只会觉得
   * "这两镜怎么接不上"，而那条线正在眼皮底下。
   */
  const segs = project.segments || [];
  let lastSeg = null;
  const out = [bar];

  const visible = shots.filter(keep);
  if (!visible.length) {
    out.push(h('div', { class: 'card muted', style: 'margin-top:12px' }, '这一类一个都没有 —— 挺好的。'));
    return out;
  }

  for (const s of visible) {
    const seg = Number(s.segment || 1);
    if (seg !== lastSeg) {
      const meta = segs.find((x) => Number(x.index) === seg && (x.chapterId || null) === (s.chapterId || null));
      const enter = lastSeg === null ? '' : s.transition || 'cut';
      out.push(
        h('div', { class: 'seg-head' },
          h('b', {}, `第 ${seg} 场`),
          h('span', { class: 'muted' },
            `${meta?.where || s.scene || '未标场景'}${meta?.when ? ` · ${meta.when}` : ''}`),
          enter && enter !== 'cut'
            ? h('span', { class: 'tag' }, enter === 'fade' ? '黑场进入' : '叠化进入 −0.5s')
            : null)
      );
      lastSeg = seg;
    }
    out.push(shotCardOf(s, v, portrait, probs.get(s.id)));
  }
  return out;
}

/**
 * 一张分镜卡。
 *
 * 前一版底下并排五个等宽灰按钮（重出图 / 重出视频 / 改这一镜 / 预演台 / 历史版本），
 * 390px 宽根本排不下，而且**五个一样重的按钮等于没有主次** ——
 * 每次都要读一遍才知道该按哪个。
 *
 * 现在按状态决定那唯一一个亮色主按钮：这一镜此刻最该做的那件事。
 * 没毛病的镜，那件事就是「改这一镜」；有毛病的镜，就是修它的那个重出。
 * 剩下的全部收进「⋯」，那里每一条都是整行大目标，比挤在一排的小按钮好点得多。
 */

/**
 * 这一镜出图带了哪几张参考图 —— 而且**说得出没带的原因**。
 *
 * 只说"没带任何参考图"是不够的：那句话盖住了两种完全不同的情况，
 * 而它们的下一步动作背道而驰 ——
 *
 *   设定集里这个角色压根没有图 → 去给他出一张 / 传一张
 *   有图，但按当前设置没发     → 去设置里改一项，图早就有了
 *
 * 用户看到"没带"之后跑去传图，而图其实一直都在，只是没发 ——
 * 那一趟白跑，而且会让他更确信"这功能是坏的"。
 */
function refLine(s) {
  if (s.bibleRefs?.length) return `出图带了参考图：${s.bibleRefs.join('、')}`;
  if (s.refsAvailable > 0) {
    /**
     * ⚠ 一张都没发时，**必须说清那几张分别是谁**。
     *
     * 只报一个数字（"有 3 张可以带"）等于让人继续猜。真正要回答的是：
     * 我传的那张照片**在不在这三张里**？
     *   在  → 是设置把它筛掉了，改设置就行
     *   不在 → 完全另一个问题：照片挂到了别的条目上，
     *          或者这一镜引用的角色名和设定集里的对不上
     * 这两件事的下一步毫不相干，而一个数字分不出来。
     */
    const list = s.refsAvailableLabels?.length ? `（${s.refsAvailableLabels.join('、')}）` : '';
    const mine = (s.refsAvailableLabels || []).some((x) => x.includes('你传的'));
    const head = `设定集里有 ${s.refsAvailable} 张图可以带${list}，但这一次一张都没发。\n`;
    /**
     * ⚠ **拦住它的开关有两个**，而它们隔着两个设置面板。
     * 上一版这里写死了指向其中一个 —— 用户照着去改，而真正关着的是另一个，
     * 改完照旧不发，他只会以为"改了没用"。
     * 所以现在用出图时**记下来的那句话**，不猜。
     */
    if (s.refBlockedHint) {
      return `${head}原因：${s.refBlockedHint}。\n`
        + (mine ? '你传的那张就在上面那几张里 —— 把这一项打开，再重出这一镜就会带上它。'
          : '打开之后会带上上面那几张（不过里面没有你传的照片，见下）。');
    }
    /**
     * ⚠ **卡片是历史记录，不是当前状态。**
     *
     * 这一行读的全是出图那一刻存下来的字段。程序更新了、设置改了，
     * 它一个字都不会变 —— 除非把这一镜重出一次。
     *
     * 上传图改成"不受开关管"之后，用户更新完，卡片照旧写着
     * "去改设置"（那是上一次出图时写下的），他改了、没用、又来问。
     * 来回三轮，全在讨论一条早就作废的记录。
     *
     * 所以先看有没有戳：没戳就说清"这条记录是旧的"，别再指挥他去改设置。
     */
    if (mine && s.refPolicy !== 'uploads-always') {
      return `${head}⚠ 不过这条记录是程序更新之前出这张图时留下的，现在已经不作数了 ——`
        + '新版里你自己传的照片不受任何开关管，一定会发出去。'
        + '把这一镜重出一次，这行字才反映现在的情况。';
    }
    return head + (mine
      ? '⚠ 这一镜是新版出的，你传的照片本该无条件发出去，却没发 —— 这是程序的问题，'
        + '不是设置的问题，去改设置没有用。把这一镜的「完整请求记录」发给我。'
      : '⚠ 这几张全是模型出的，没有你传的那张 —— 所以问题不在设置。'
        + '要么照片传到了别的条目上，要么这一镜引用的角色名和设定集里的对不上。'
        + '先去设定集确认：那个角色的图是不是你传的那张。');
  }
  if (s.refsAvailable === 0) {
    return '这一镜引用的角色/场景在设定集里还没有图 —— 没有图可带，'
      + '脸完全由文字描述决定。先去设定集给他出一张或传一张。';
  }
  // refsAvailable 是 null/undefined：这张图是**这次改动之前**出的，那时候没记这个数
  return '这张图是早前出的，当时没记下带过哪些参考图。重出一次就知道了。';
}

/**
 * ══════════ 一张镜头卡 ══════════
 *
 * ── 为什么重写过一次 ──
 *
 * 每报一个问题我就往卡上加一行字或一颗按钮，加了十几次、一次没删过。
 * 最后一张卡上同时挂着：警告横幅、三个标签、参考图那行、「为什么不对」、
 * 「重出这段视频」、「改这一镜」、「⋯」—— 用户的原话是"都太杂太乱了"。
 *
 * ── 现在按"你什么时候需要它"分三层 ──
 *
 *   一眼      画面 + 镜号时长 + 一句描述 + 一个状态点     永远看得见
 *   有问题时  一句话说清是什么 + **一颗**主按钮           只在这一镜有问题时
 *   要动手时  标签、参考图、诊断、改文案、历史版本        点开「详情」才有
 *
 * ⚠ **一张卡最多一颗主按钮。**
 *
 * 原来「重出这段视频」和「为什么不对」并排摆着，可它们是**先后关系**
 * 不是并列：先看为什么、再决定重不重出。并排摆等于让人在
 * "花钱重来"和"先搞明白"之间凭感觉挑一个 —— 而多数人会挑那颗显眼的，
 * 也就是花钱那颗。
 *
 * ⚠ 详情默认**折叠**，但折叠的东西一样都没少。
 * 藏起来的是"排查时才翻"的那些；浏览五十镜时它们全是噪音，
 * 而真要查一镜的时候点一下就有。
 */

function shotCardOf(s, v, portrait, probs = shotIssues(s)) {
  const worst = probs.find((i) => i.level === 'blocker') || probs[0] || null;
  const tone = probs.some((i) => i.level === 'blocker') ? 'bad' : probs.length ? 'iffy' : '';
  const fixable = probs.find((i) => i.fix) || null;
  const live = job.running && job.shotId === s.id;

  /**
   * ── 第二层：有问题时的那一颗按钮 ──
   *
   * 出过图的镜头，第一动作永远是**先看为什么**（免费），不是直接重出（花钱）。
   * 还没出图的没什么可诊断的，那时候「重出」才是第一动作。
   */
  const acts = h('div', { class: 'acts' });
  if (worst && s.imagePath) {
    acts.append(h('button', {
      class: 'btn primary wide',
      onclick: () => openWhy(s, fixable)
    }, '看看为什么'));
  } else if (fixable) {
    acts.append(h('button', {
      class: 'btn primary wide',
      disabled: job.running,
      onclick: () => regen(s, fixable.fix)
    }, fixable.how));
  } else {
    // 没问题的镜头也得有个入口，否则这张卡除了看什么都做不了
    acts.append(h('button', { class: 'btn wide', onclick: () => openShotActions(s) }, '这一镜还能做什么'));
  }
  /**
   * ⚠ 「⋯」留在**表面**，不收进详情。
   *
   * 详情本身就是一个"更多"，再往里套一个"更多"是两层嵌套 ——
   * 而那张动作表（重出图/重出视频/改这一镜/预演台…）是真正要动手时去的地方，
   * 藏两层等于没有。
   */
  if (worst || fixable) {
    acts.append(h('button', { class: 'iconbtn', onclick: () => openShotActions(s) }, '⋯'));
  }

  /** ── 第三层：详情。默认折叠，点开才有 ── */
  const more = h('details', { class: 'shot-more' },
    h('summary', {}, '详情'),
    h('div', { class: 'tags', style: 'margin-top:8px' },
      s.camera ? h('span', { class: 'tag' }, s.camera) : null,
      s.scene ? h('span', { class: 'tag' }, s.scene) : null,
      s.consistency?.score != null && s.consistency.pass
        ? h('span', { class: 'tag ok' }, `一致性 ${s.consistency.score}`)
        : null,
      s.sfxPath && s.sfxOf === s.sound ? h('span', { class: 'tag' }, '有音效')
        : !s.sfxPath && s.sound ? h('span', { class: 'tag' }, '待出音效') : null),
    /**
     * 这一镜出图时带了哪几张参考图。
     *
     * ⚠ **一张都没带的时候更要说**：你传了照片而这一镜根本没用上它 ——
     * 那正是最需要知道的情况，沉默在这里等于误导。
     * （收进详情是因为它是排查用的；浏览时不需要，排查时一点就有。）
     */
    // cap:shot-refs
    s.imagePath
      ? h('div', { class: 'muted', style: 'margin-top:8px;line-height:1.6' }, refLine(s))
      : null,
    // 还剩几条问题，在这儿一次说完 —— 上面那条只摆最要紧的
    probs.length > 1
      ? h('div', { class: 'muted', style: 'margin-top:8px;line-height:1.6' },
          `还有 ${probs.length - 1} 条：${probs.slice(1).map((p) => p.what).join('；')}`)
      : null,
    );

  return h('div', { class: `card shot ${tone} ${live ? 'live-shot' : ''}` },
    // 镜号和时长压在画面上：省掉一整行，而且它们出现在眼睛已经在的地方
    h('div', { class: 'mediawrap' },
      s.videoPath
        ? h('video', { class: `shot-media ${portrait ? 'portrait' : ''}`, src: media(s.videoPath, v), controls: true, preload: 'metadata', playsinline: true })
        : s.imagePath
          ? zoomable({ class: `shot-media ${portrait ? 'portrait' : ''}`, loading: 'lazy' }, media(s.imagePath, v), `第 ${s.index} 镜`)
          : h('div', { class: 'shot-media', style: 'display:flex;align-items:center;justify-content:center;color:var(--ink-faint);font-size:13px' }, '还没出图'),
      h('div', { class: 'overlay tl' },
        h('span', {}, `SH ${String(s.index).padStart(3, '0')}`),
        h('span', { class: 'dim' }, `${Number(s.duration).toFixed(1)}s`),
        /**
         * ⚠ 状态用**一个点**，不用一整条横幅。
         *
         * 原来每张卡上都挂一条"有图没视频 —— 合成时这一镜会被直接跳过"。
         * 一句正确的话，但 50 镜就是 50 条一模一样的话 —— 而顶上的筛选条
         * 早就说了「缺视频 49」。重复的警告不会让人更警觉，只会让人不再看警告。
         */
        worst ? h('span', { class: `dot ${worst.level}` }, '●') : null),
      live ? h('div', { class: 'overlay bl running' }, h('span', { class: 'spin' }, '◐'), '正在跑') : null,
      s.link === 'continuous' ? h('div', { class: 'overlay bl link' }, '连续动作 ↑') : null),

    h('div', { class: 'shot-info' },
      /**
       * ⚠ **点描述就能改。**
       *
       * 「改这一镜」收进详情之后，改文案就多了一次点击 —— 而那是审片时
       * 最高频的动作（看到一句不对，当场改掉）。电脑版本来就是点描述即编辑，
       * 手机上没有，纯属漏了。
       *
       * 这样详情里那颗「改这一镜」变成"找得到的那个入口"，
       * 而真正天天用的路径一次点击都没多。
       */
      h('div', {
        class: 'shot-desc tappable', style: 'margin-top:0',
        title: '点一下改这一镜',
        onclick: () => openEditor(s)
      }, s.description || '（无描述）'),
      /** 有问题时**一句话**，不展开原因 —— 展开是「看看为什么」那颗按钮的事 */
      worst
        ? h('div', { class: `prob ${worst.level}` },
            h('span', {}, worst.level === 'blocker' ? '✕' : '!'),
            h('span', { class: 'grow' }, worst.what))
        : null,
      s.dialogue
        ? h('div', { class: 'row', style: 'margin:8px 0 0' },
            h('span', { class: 'tag', style: 'flex:0 0 auto' }, LINE_KIND_SHORT[s.lineKind || (s.speaker ? 'speech' : 'voiceover')] || '白'),
            h('span', { class: 'muted grow', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
              `${s.speaker || '旁白'}：「${s.dialogue}」`))
        : null,

      acts,
      more));
}

/**
 * 「看看为什么」：拉一次诊断，摆出原因 + 下一步。
 *
 * ⚠ 重出那颗按钮**只在这儿出现**，而且排在原因下面。
 * 顺序就是判断顺序：先知道为什么，再决定要不要花这笔钱。
 */
async function openWhy(s, fixable) {
  const host = h('div', { class: 'diag-host' });
  const box = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, `第 ${s.index} 镜 · 为什么不对`),
    host);
  add(host, h('div', { class: 'muted' }, '查…'));
  const { close } = openSheet(box);
  try {
    // cap:diagnose-shot
    const r = await api(`/projects/${project.id}/shots/${s.id}/diagnose`);
    clear(host);
    add(host, ...(r.items || []).map((it) => h('div', { class: 'diag-item' },
      h('div', { class: 'diag-what' }, it.what),
      h('div', { class: 'diag-why' }, it.why),
      h('div', { class: 'diag-how' }, `→ ${it.how}`),
      it.costs ? h('span', { class: 'diag-cost' }, '这一下要重新出图（花钱）') : null)));
    if (fixable) {
      add(host, h('button', {
        class: 'btn primary wide', style: 'margin-top:12px', disabled: job.running,
        onclick: () => { close(); regen(s, fixable.fix); }
      }, fixable.how));
    }
  } catch (err) {
    clear(host);
    add(host, h('div', { class: 'diag-item' }, err.message));
  }

}

/** 台词类型在卡片上只占一个字：整个词摆上去，一行就没了 */
const LINE_KIND_SHORT = { speech: '白', inner: '心', voiceover: '旁', offscreen: '外' };

/**
 * 就地改这一镜。
 *
 * 审片的完整回路是**看到不对 → 改一句 → 重出**，缺了中间那步，
 * 手机端就只剩"看到不对，记在心里回去再说"—— 而回到电脑前你多半已经忘了是哪一镜。
 *
 * 早先只放开了描述和时长，理由是"别的在手机上改起来慢"。这个判断是错的：
 * 真正会当场想改的恰恰是**台词和谁说的** —— 那两样一眼就能看出不对，
 * 而且改起来只是敲几个字。景别和运镜也一样，选一下就完事。
 * 所以现在按服务端那份白名单（studio.js SHOT_EDITABLE）全放开，
 * 只是排布上按"最常改的放最上面"。
 */
const CAMERAS = ['特写', '近景', '中景', '全景', '远景', '过肩', '俯视', '仰视'];
const MOTIONS = ['固定', '缓推', '缓拉', '横移', '跟随', '手持'];

function field(label, control, hint) {
  return h('div', { class: 'mfield' },
    h('label', {}, label),
    control,
    hint ? h('div', { class: 'muted', style: 'margin-top:4px' }, hint) : null);
}

function chips(options, current, onPick) {
  const wrap = h('div', { class: 'chips' });
  let picked = current;
  for (const opt of options) {
    const b = h('button', {
      class: `chip ${opt === current ? 'on' : ''}`,
      onclick: () => {
        picked = opt === picked ? '' : opt; // 再点一下取消，不然选错了没法回到空
        for (const el of wrap.children) el.classList.remove('on');
        if (picked) b.classList.add('on');
        onPick(picked);
      }
    }, opt);
    wrap.append(b);
  }
  return wrap;
}

/**
 * 单镜编辑：**整屏一层**，不是卡片里就地展开的手风琴。
 *
 * 原来那种做法在手机上有一个致命处：十二个字段一展开，卡片被撑到要滚很久，
 * 而滚到第七个字段时屏幕上已经没有任何东西写着"你在改第几镜"了 ——
 * 偏偏这一页最常见的用法就是连着改好几镜。
 *
 * 十二个字段按"一屏只答一类问题"分成四组：
 *
 *   内容    这一镜演什么、谁说什么（改得最多，默认停在这儿）
 *   镜头    怎么拍、多长、怎么进来
 *   预演台  机位排布（不是每一镜都值得排，所以单独一组、按需才建）
 *   高级    第几场、走哪一档模型
 *
 * @param jump 直接落到某一组（从「⋯ → 预演台」进来时用）
 */
function openEditor(s, jump = 'content') {
  const desc = h('textarea', { rows: 4, class: 'mta' }, s.description || '');
  /**
   * 这一镜画面里**看得见**的关键道具。撑着"道具消失又回来"那条检查。
   * ⚠ 只填真的在画面里的：特写里看不见的东西填上去，那条检查会开始乱报。
   */
  const propsBox = h('input', { type: 'text', value: (s.props || []).join('、') });
  const line = h('textarea', { rows: 2, class: 'mta' }, s.dialogue || '');
  // 画外音效。单开一栏是因为写进画面描述会让出图模型去画那个声音 ——
  //「敲门声」最常见的下场是画出一扇开着的门，而这一镜的前提是门还关着
  const sfx = h('input', { type: 'text', class: 'min', placeholder: '敲门声、脚步声…', value: s.sound || '' });
  const dur = h('input', { type: 'number', step: '0.5', min: '0.5', max: '30', value: String(s.duration ?? 4) });

  // 说话人只能从设定集里的角色里选 —— 手打一个名字，配音那步就配不上音色
  const cast = (project?.bible?.characters || []).map((c) => c.name);
  const who = h('select', { class: 'msel' },
    h('option', { value: '', selected: !s.speaker }, '旁白（画外音）'),
    ...cast.map((n) => h('option', { value: n, selected: s.speaker === n }, n)));

  let camera = s.camera || '';
  let motion = s.motion || '';
  // 这一镜走哪一档模型。自动判定给一个，判错的那几镜由人改
  let tier = s.tier || '';
  const TIER_PICK = [['', '自动判定'], ['high', '关键镜'], ['normal', '一般'], ['low', '空镜']];
  /**
   * 台词类型。漏掉它的时候「心里话」根本没法表达 ——
   * 填了说话人画面就要求口型对上（成了自言自语），留空又变成旁白的音色。
   */
  const LINE_KINDS = [
    ['speech', '对白'], ['inner', '心里话'], ['voiceover', '旁白'], ['offscreen', '画外音']
  ];
  let lineKind = s.lineKind || (s.speaker ? 'speech' : 'voiceover');
  const kindPick = (() => {
    const wrap = h('div', { class: 'chips' });
    for (const [val, label] of LINE_KINDS) {
      const b = h('button', {
        class: `chip ${val === lineKind ? 'on' : ''}`,
        onclick: () => {
          lineKind = val;
          for (const el of wrap.children) el.classList.remove('on');
          b.classList.add('on');
        }
      }, label);
      wrap.append(b);
    }
    return wrap;
  })();

  // 属于第几场。模型划边界是读剧本猜的，猜错很正常，得能改
  const segIn = h('input', { type: 'number', class: 'min', min: '1', max: '99', value: String(s.segment || 1) });

  // 怎么进入这一镜。默认硬切 —— 满屏叠化是最典型的业余做法
  let transition = s.transition || 'cut';
  const TRANS_PICK = [['cut', '硬切'], ['fade', '黑场'], ['dissolve', '叠化']];

  /**
   * 这句话在这个时长里念不念得完 —— **改的时候就说**。
   *
   * 原来这件事要等到合成那一步才发现，而那时候视频已经出完、钱已经花掉了。
   * 估算用的是引擎自己那份 core/duration.js（服务端发过来的同一个文件），
   * 不是在这儿另写一个 —— 两份估法会以肉眼看不出的方式漂开，
   * 然后界面说念得完、合成说念不完，人两个都不信。
   */
  const fit = h('div', { class: 'fit ok' });
  const refreshFit = () => {
    const need = speechSeconds(line.value);
    const have = Number(dur.value) || 0;
    if (!need) {
      fit.style.display = 'none';
      return;
    }
    fit.style.display = '';
    const ok = have >= need + SPEECH_HEADROOM;
    fit.className = `fit ${ok ? 'ok' : 'over'}`;
    clear(fit);
    fit.append(
      h('span', {}, ok ? '✓' : '!'),
      h('span', { class: 'grow' }, ok
        ? `这句约 ${need} 秒，本镜 ${have} 秒 —— 说得完`
        : `这句约 ${need} 秒，本镜只有 ${have} 秒 —— 会说不完。把时长改到 ${(need + SPEECH_HEADROOM).toFixed(1)} 秒以上，或者把话说短点`));
  };
  line.addEventListener('input', refreshFit);
  dur.addEventListener('input', refreshFit);
  refreshFit();

  /**
   * 预演台按需才建：不是每一镜都值得排位。空镜、过渡镜写句"全景"就够了，
   * 值得排的是对话戏和动作接续 —— 那两种地方越轴和景别跳最要命。
   */
  let stageDraft = s.stage || null;
  const stageWrap = h('div');
  let stageBuilt = false;
  const buildStage = () => {
    if (stageBuilt) return;
    stageBuilt = true;
    // 上一镜的排位拿来比轴线 —— 越轴是两镜之间的事，单看一镜看不出来
    const prev = (project.shots || []).filter((x) => x.index < s.index).slice(-1)[0];
    if (!stageDraft) {
      // 接着上一镜排（同场次才接）—— 人不会在两镜之间瞬移，
      // 而且位置一变轴线就跟着转，越轴检查会开始乱报
      const sameSeg = prev && Number(prev.segment || 1) === Number(s.segment || 1);
      const names = (s.characters || []).slice(0, 4);
      stageDraft = (sameSeg && inheritStage(prev.stage, names)) || blankStage(names);
    }
    stageWrap.append(previzPanel(stageDraft, {
      duration: s.duration || 5,
      size: 300,
      assets: [
        ...[
          ['character', project.bible?.characters || []],
          ['scene', project.bible?.scenes || []],
          ['prop', project.bible?.props || []]
        ].flatMap(([kind, list]) => list.map((x) => {
          const wanted = s.variants?.[x.name];
          const variant = (x.variants || []).find((v) => v.id === wanted) || x.variants?.[0] || x;
          const sheetPath = variant.sheetPath || x.sheetPath;
          return {
            kind, name: x.name, ref: x.id || x.name, variantId: variant.id || 'default',
            image: sheetPath ? media(sheetPath) : '',
            modelUrl: variant.modelPath ? media(variant.modelPath) : x.modelPath ? media(x.modelPath) : ''
          };
        }))
      ],
      onExportControls: async (stage) => {
        const r = await api(`/projects/${project.id}/shots/${s.id}/controls`, { method: 'POST', body: { stage } });
        const v = Date.now();
        return Object.fromEntries(['start', 'depth', 'mask'].map((key) => [key, media(r.controls[key], v)]));
      },
      prevStage: prev?.stage || null,
      // 同一个场景会反复回来，而逐镜继承隔一场就断了 —— 布局要挂到场景上
      scene: s.scene || '',
      sceneLayout: (project.bible?.scenes || []).find((x) => x.name === s.scene)?.layout || null,
      onSaveScene: async (layout) => {
        try {
          // cap:scene-layout
          const p2 = await api(`/projects/${project.id}/scene-layout`, {
            method: 'POST',
            body: { scene: s.scene, stage: { ...stageDraft, ...layout } }
          });
          project.bible = p2.bible;
          toast(`已存成「${s.scene}」的默认布局`, 'ok');
        } catch (err) {
          toast(err.message, 'err');
        }
      }
    }).node);
  };

  // ── 四组 ──
  /**
   * 「改了要重出 X」—— 和电脑版同一套口径。
   *
   * 三样东西喂的是**不同的下游**：画面→出图、运镜/衔接→出视频、
   * 台词/说话人→配音。改一样东西要付多少代价差着几十倍的钱，
   * 而原来两端都没说。
   *
   * ⚠ 只在那样产物**已经出过**时才显示：还没出过的时候它是废话，
   * 而废话会把真正要紧的那句挤没。
   */
  const redo = (done, text) => (done ? h('div', { class: 'ed-redo' }, text) : null);

  const pages = {
    content: h('div', {},
      h('div', { class: 'ed-group' },
        h('h4', {}, '画面描述', h('span', {}, '出图用的')),
        desc,
        h('div', { class: 'muted', style: 'margin-top:6px' }, '写偏一句，重出十次也回不到对的画面。'),
        field('画面里的道具', propsBox,
          '只填**这一镜真的看得见**的。特写里看不见的东西填上去，'
          + '「道具消失又回来」那条检查会开始乱报 —— 而乱报的检查比没有更糟。'),
        redo(s.imagePath, '⚠ 这一镜已经出过图了。改完要重出这一镜的图才生效 —— 视频跟着图走，也得跟着重出。')),
      h('div', { class: 'ed-group' },
        h('h4', {}, '台词', h('span', {}, '配音用的')),
        field('说什么', line, '留空就是这一镜没人说话。'),
        field('谁说的', who, '决定用哪个角色的**声音**。'),
        // cap:line-kind
        field('台词类型', kindPick,
          '和「谁说的」是两件事：那个管声音用谁的，这个管**嘴动不动**。'
          + '心里话＝他自己的声音但嘴闭着；旁白＝画外叙述；画外音＝他在说话但不在这一镜画面里。'),
        fit,
        redo(s.audioPath, '⚠ 这一镜已经配过音了。改完要重新配音才生效。图和视频都不受影响。')),
      h('div', { class: 'ed-group' },
        h('h4', {}, '画外音效', h('span', {}, '听得见看不见的')),
        sfx,
        h('div', { class: 'muted', style: 'margin-top:6px' },
          '写进画面描述的话，出图模型会去画那个声音 ——「敲门声」通常会画出一扇开着的门。'))),

    camera: h('div', {},
      h('div', { class: 'ed-group' },
        h('h4', {}, '怎么拍', h('span', {}, '出视频用的')),
        // cap:shot-camera
        field('景别', chips(CAMERAS, camera, (v) => (camera = v))),
        field('运镜', chips(MOTIONS, motion, (v) => (motion = v))),
        field('时长（秒）', dur, '有台词的话，上一组里会告诉你够不够念。'),
        redo(s.videoPath, '⚠ 这一镜已经出过视频了。改完要重出视频才生效。图不受影响，不用重出。')),
      h('div', { class: 'ed-group' },
        h('h4', {}, '怎么进来', h('span', {}, '合成用的，不花钱')),
        // cap:shot-transition
        field('转场', (() => {
          const wrap = h('div', { class: 'chips' });
          for (const [val, label] of TRANS_PICK) {
            const b = h('button', {
              class: `chip ${val === transition ? 'on' : ''}`,
              onclick: () => {
                transition = val;
                for (const el of wrap.children) el.classList.remove('on');
                b.classList.add('on');
              }
            }, label);
            wrap.append(b);
          }
          return wrap;
        })(), '绝大多数镜都该是硬切。黑场和叠化只在真的换时间换地点时用 —— 满屏叠化是最典型的业余做法。叠化还会吃掉 0.5 秒。'))),

    // cap:shot-stage
    stage: h('div', {},
      h('div', { class: 'ed-group' },
        h('h4', {}, '排一下机位'),
        h('div', { class: 'muted', style: 'margin-bottom:10px' },
          '拖大圆点摆人、拖小圆点转身、拖「机」摆机位。'
          + '两人之间那条线是轴线，机位跨过去成片上两人就左右对调了。'
          + '排过位之后，景别和机位由几何算出来，不再是"中景"这种说不清的词。'),
        stageWrap)),

    adv: h('div', {},
      h('div', { class: 'ed-group' },
        h('h4', {}, '第几场'),
        // cap:shot-segment
        segIn,
        h('div', { class: 'muted', style: 'margin-top:6px' },
          '场次 = 同一时间同一地点的一段戏。跨场次不能锁末帧、不能拿邻镜当参考图，转场也只出现在场次之间。')),
      h('div', { class: 'ed-group' },
        h('h4', {}, '模型档位'),
        // cap:tier-routing
        (() => {
          const wrap = h('div', { class: 'chips' });
          for (const [val, label] of TIER_PICK) {
            const b = h('button', {
              class: `chip ${val === tier ? 'on' : ''}`,
              onclick: () => {
                tier = val;
                for (const el of wrap.children) el.classList.remove('on');
                b.classList.add('on');
              }
            }, label);
            wrap.append(b);
          }
          return wrap;
        })(),
        h('div', { class: 'muted', style: 'margin-top:6px' },
          '空镜和远景用便宜模型看不出差别 —— 这一档最省钱。判错了在这儿改。')))
  };

  const body = h('div', { class: 'ed-body' });
  const tabsRow = h('div', { class: 'ed-tabs' });
  let page = pages[jump] ? jump : 'content';
  const TABS = [
    ['content', '内容', false],
    ['camera', '镜头', false],
    ['stage', '预演台', true],
    ['adv', '高级', false]
  ];
  const show = (id) => {
    page = id;
    if (id === 'stage') buildStage();
    clear(body);
    body.append(pages[id]);
    for (const el of tabsRow.children) el.classList.toggle('on', el.dataset.page === page);
    body.scrollTop = 0;
  };
  for (const [id, label, flag] of TABS) {
    tabsRow.append(h('button', {
      class: 'ed-tab', 'data-page': id, onclick: () => show(id)
    }, label, flag && stageDraft?.cam ? h('span', { class: 'dot' }) : null));
  }

  const layer = h('div', { class: 'ed' });
  const close = () => layer.remove();

  const save = h('button', { class: 'btn primary' }, '保存');
  const doSave = async () => {
    save.disabled = true;
    try {
      // cap:shot-text cap:shot-dialogue cap:shot-camera
      await api(`/projects/${project.id}/shots/${s.id}`, {
        method: 'PATCH',
        body: {
          description: desc.value,
          // cap:shot-props
          props: propsBox.value,
          dialogue: line.value,
          speaker: who.value,
          lineKind,
          // cap:shot-sound
          sound: sfx.value,
          // cap:shot-transition
          transition,
          // cap:shot-segment
          segment: Number(segIn.value) || 1,
          camera,
          motion,
          tier,
          duration: Number(dur.value) || s.duration,
          ...(stageDraft ? { stage: stageDraft } : {})
        }
      });
      return true;
    } catch (err) {
      toast(err.message, 'err');
      save.disabled = false;
      return false;
    }
  };
  save.onclick = async () => {
    if (!(await doSave())) return;
    close();
    toast('已保存。重出这一镜才会按新的生成', 'ok');
    await reload();
  };

  /**
   * 「保存并重出这张图」。
   *
   * 改完描述之后十有八九就是要重出 —— 分两步做的话，人得先按保存、
   * 关掉这一层、找回刚才那张卡、再按重出。这里合成一个动作。
   *
   * 只出图不出视频是**故意的**：视频比图贵一个量级，正确的顺序是
   * 先出图看对不对，对了再出视频。
   */
  const saveRun = h('button', { class: 'btn', style: 'border-color:var(--beam);color:var(--beam)' }, '保存并重出这张图');
  saveRun.onclick = async () => {
    saveRun.disabled = true;
    if (!(await doSave())) {
      saveRun.disabled = false;
      return;
    }
    close();
    await reload();
    const fresh = (project.shots || []).find((x) => x.id === s.id) || s;
    regen(fresh, 'image');
  };

  layer.append(
    h('div', { class: 'ed-top' },
      h('div', { class: 'side' }, h('button', { class: 'btn sm', onclick: close }, '取消')),
      h('div', { class: 'mid' },
        h('b', {}, `第 ${s.index} 镜`),
        h('span', {}, `第 ${s.segment || 1} 场 · ${s.scene || '未标场景'}`)),
      h('div', { class: 'side', style: 'text-align:right' }, save)),
    tabsRow,
    body,
    h('div', { class: 'ed-foot' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, saveRun)),
      h('div', { class: 'ed-note' }, '保存不花钱；重出按镜数计费')));

  document.body.append(layer);
  show(page);
  return layer;
}

/**
 * 历史版本。重出写的是同一个路径，上一版原来直接被覆盖 ——
 * 而每一版都是真金白银出的，丢掉的不是文件，是已经花掉的钱。
 *
 * 按需拉：二十镜各拉一次目录列表的话，光是打开分镜页就要等。
 */
async function openVersions(s) {
  try {
    // cap:shot-versions
    const v = await api(`/projects/${project.id}/shots/${s.id}/versions`);
    const rows = [
      ...v.image.versions.map((x) => ({ ...x, kind: 'image', label: '图' })),
      ...v.video.versions.map((x) => ({ ...x, kind: 'video', label: '视频' }))
    ].sort((a, b) => (a.at < b.at ? 1 : -1));
    if (!rows.length) return toast('还没有历史版本 —— 重出一次之后，上一版就留在这儿', 'ok');
    const box = h('div', { class: 'sheet-box' });
    const { close } = openSheet(box, { bare: true });
    box.append(
      h('b', {}, `第 ${s.index} 镜的历史版本`),
      h('p', { class: 'muted', style: 'margin:6px 0 10px' },
        `留最近 ${rows.length} 版。换回某一版之后，现在这版也会被存起来 —— 换回去是可逆的。`),
      ...rows.map((x) => h('div', { class: 'row', style: 'margin-top:8px;align-items:center' },
        h('img', {
          src: media(x.path),
          style: 'width:56px;height:36px;object-fit:cover;border-radius:6px;background:#000',
          onerror: (e) => { e.target.style.display = 'none'; }
        }),
        h('span', { class: 'tag' }, `${x.label} v${x.n}`),
        h('span', { class: 'muted grow', style: 'font-size:12px' }, new Date(x.at).toLocaleString('zh-CN')),
        h('button', {
          class: 'btn sm',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              await api(`/projects/${project.id}/shots/${s.id}/versions/restore`, {
                method: 'POST', body: { kind: x.kind, n: x.n }
              });
              close();
              toast(`已换回${x.label} v${x.n}`, 'ok');
              await reload();
            } catch (err) {
              toast(err.message, 'err');
              e.target.disabled = false;
            }
          }
        }, '换回'))),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn sm grow', onclick: close }, '关闭')));
    return box;
  } catch (err) {
    return toast(err.message, 'err');
  }
}

/** 一个可以存到手机上的素材行 */
function assetRow(label, note, href) {
  return h('div', { class: 'row', style: 'padding:10px 0;border-bottom:1px solid var(--line-soft)' },
    h('div', { class: 'grow' },
      h('div', {}, label),
      note ? h('div', { class: 'muted', style: 'margin-top:2px' }, note) : null),
    h('a', {
      class: 'btn sm',
      href,
      download: '',
      target: '_blank',
      style: 'display:flex;align-items:center;text-decoration:none'
    }, '存到手机'));
}

/**
 * 成片 + 交给剪映的素材。
 *
 * 为什么不在这儿做精剪：剪映的转场、音乐库、花字、封面是几百人做了几年的东西，
 * 硬碰硬赢不了。我们该做的是**把素材备齐**，让你进剪映就能直接开工：
 *   成片        直接发出去就能用的那一版
 *   每镜片段    进剪映后按顺序拖进时间线，想换顺序、想剪掉半秒都在那边做
 *   字幕 SRT    剪映专业版可以直接导入，省掉一次语音识别
 *   每条配音    想重配某一句时用得上
 *
 * 手机上"存到相册"最稳的还是**长按视频 → 存储视频**，下载按钮在部分浏览器里
 * 会存进"文件"而不是相册 —— 所以两条路都写出来，不替用户猜。
 */
// cap:film-view cap:asset-pack
function paintFilm() {
  const out = project?.outputs;
  const v = Date.parse(project?.updatedAt || '') || 0;
  const shots = (project?.shots || []).slice().sort((a, b) => a.index - b.index);
  const clips = shots.filter((s) => s.videoPath);
  const voices = shots.filter((s) => s.audioPath);
  const sfxs = shots.filter((s) => s.sfxPath);
  // 有图没视频的那几镜 —— 素材包里缺的就是它们
  const missing = shots.filter((s) => !s.videoPath);

  /**
   * 成片体检。摆在成片页，因为决定发不发就是在这儿做的。
   * 手机上更需要它 —— 那几条警告是在电脑上跑的时候刷过去的，
   * 出门在外只看得到成片本身。
   */
  const qualityHost = h('div', {});
  // cap:quality-report
  api(`/projects/${project.id}/quality`).then((r) => {
    clear(qualityHost);
    qualityHost.append(h('div', { class: `card ${r.verdict === 'ready' ? '' : 'warn'}` },
      h('b', {}, `成片体检：${r.score} 分 · ${
        { ready: '可以发', fixable: '能发，但有几处值得改', 'not-ready': '先别发' }[r.verdict]}`),
      // 分数永远不单独出现 —— 人下一秒就要问"哪儿扣的分"
      ...(r.items.length
        ? r.items.map((i) => h('div', { style: 'margin-top:9px' },
          h('span', { class: `tag ${i.level === 'note' ? '' : 'warn'}` },
            { blocker: '会被看出来', warn: '质量风险', note: '可改进' }[i.level]),
          h('div', { style: 'margin-top:4px' }, i.what),
          h('div', { class: 'muted' }, i.why),
          h('div', { class: 'muted' }, `→ ${i.fix}`)))
        : [h('p', { class: 'muted', style: 'margin:6px 0 0' }, '四类检查都过了：产物齐、一致性达标、接缝对得上、分镜没有高危项。')])));
  }).catch(() => { /* 体检拉不到不该把成片页弄坏 */ });

  const head = out?.video
    ? [
        h('div', { class: 'card', style: 'padding:0;overflow:hidden' },
          h('video', {
            src: media(out.video, v),
            controls: true,
            playsinline: true,
            style: 'width:100%;display:block;background:#000;max-height:70vh'
          })),
        h('div', { class: 'card' },
          h('div', { class: 'row', style: 'margin-bottom:8px' },
            h('b', { class: 'grow' }, '成片'),
            out.seconds ? h('span', { class: 'muted' }, `${out.seconds}s`) : null),
          h('p', { class: 'muted' },
            '存到相册最稳的办法是长按上面的画面 → 存储视频；下面的按钮在有些浏览器里会存进「文件」而不是相册。'),
          assetRow('成片 mp4', out.durationPolicy === 'trim' ? '按分镜时长裁剪过' : '保留了完整片段', media(out.video, v)),
          out.subtitle ? assetRow('字幕 .srt', '剪映专业版可直接导入，省一次语音识别', media(out.subtitle, v)) : null)
      ]
    : [
        h('div', { class: 'card muted' },
          '还没有成片。流水线跑到最后一步「合成」之后，这里就能直接看。' +
          (clips.length ? `不过 ${clips.length} 段镜头片段已经在下面了，现在就能拿去剪映。` : ''))
      ];

  const material = clips.length || voices.length
    ? h('div', { class: 'card' },
        h('b', {}, '交给剪映的素材'),
        h('p', { class: 'muted', style: 'margin:6px 0 4px' },
          '精剪在剪映里做 —— 转场、音乐、花字那些它做得比我们好。这里负责把素材备齐：' +
          '每镜片段按顺序存下来，进剪映依次拖进时间线就是排好的初剪。'),
        // 二十镜就是四十来个文件，逐个点等于没做这个功能
        h('a', {
          class: 'btn primary block',
          style: 'display:flex;align-items:center;justify-content:center;text-decoration:none;margin:8px 0 4px',
          href: `/api/projects/${project.id}/export.zip${authKey ? `?k=${encodeURIComponent(authKey)}` : ''}`,
          download: ''
        }, `打包下载全部（${clips.length + voices.length + (out?.video ? 1 : 0)} 个文件）`),
        h('p', { class: 'muted', style: 'margin:0 0 8px' },
          '包里还有一张分镜表，写着每个片段是哪一镜、多长、说了什么 —— ' +
          '进剪映之后不用对着文件名猜。手机上会存进「文件」，在那儿解压再导入剪映。'),
        /**
         * **哪几镜还没出视频，必须说出来。**
         *
         * 少一镜的素材包看起来和齐了的一模一样：文件按序号排好、分镜表也在。
         * 人拖进剪映排完一条时间线，才发现中间缺了一镜 —— 那时候要么回来补出，
         * 要么将就着接上，而两条都是白干一遍。
         *
         * 这一条不报的代价全落在最后一步，那正是最贵的地方。
         */
        missing.length
          ? h('div', { class: 'card warn', style: 'margin:0 0 10px' },
            `第 ${missing.map((s) => s.index).join('、')} 镜还没出视频，这个包里没有它们的片段。`
            + '现在拿去剪映的话，时间线中间会缺一段 —— 先把这几镜出了再打包。')
          : null,
        ...clips.map((s) =>
          assetRow(
            `第 ${s.index} 镜`,
            `${Number(s.duration).toFixed(1)}s · ${(s.description || '').slice(0, 18)}`,
            media(s.videoPath, v)
          )),
        ...voices.map((s) =>
          assetRow(`第 ${s.index} 镜 配音`, `${s.speakerUsed || s.speaker || '旁白'}：${(s.dialogue || '').slice(0, 14)}`, media(s.audioPath, v))),
        // 音效也要能单独取走：进剪映之后音量、位置都可能想再调
        ...sfxs.map((s) =>
          assetRow(`第 ${s.index} 镜 音效`, s.sfxOf || s.sound || '', media(s.sfxPath, v))))
    : null;

  return [...head, qualityHost, material];
}

// ───────────────────────── 动作 ─────────────────────────

async function runStage(stageId, label, extra = {}) {
  if (job.running) return;
  job.running = true;
  job.stage = stageId;
  job.label = label;
  job.message = '正在提交…';
  job.fail = 0;
  job.shotId = null;
  job.shotIndex = null;
  job.reattached = false;
  // 自己开着流的时候不用轮询，两条一起跑只会互相打架
  job.streaming = true;
  stopJobPoll();
  paint();
  try {
    await stream(`/projects/${project.id}/stage/${stageId}`, extra, (ev) => {
      // 主动停下来不是失败 —— 记成失败会让人回头去查一个不存在的问题
      // 正在跑哪一镜 —— 分镜页上那一张要点亮，状态条上要写出来
      if (ev.type === 'shot' && ev.status === 'running' && ev.shotId) job.shotId = ev.shotId;
      if (ev.type === 'cancelled') {
        job.message = ev.message || '已停下';
      } else if (ev.type === 'error') {
        job.fail += 1;
        job.message = ev.message || '失败';
      } else if ((ev.type === 'shot' || ev.type === 'sheet') && ev.status === 'failed') {
        job.fail += 1;
        job.message = ev.message || '失败';
      } else if (ev.message) {
        job.message = ev.message;
      }
      updateLive();
    });
  } catch (err) {
    job.fail += 1;
    job.message = err.message;
  } finally {
    /**
     * ⚠ 流断了**不等于跑完了**。
     *
     * 手机锁个屏、切个应用、网抖一下，这条流就断。而服务器那边还在
     * 一镜一镜地出。这里无条件把 running 置成 false 的话，按钮立刻亮回来 ——
     * 人再点一次，撞上一段"这个项目已经在跑（321 秒前开始）"的长文案，
     * 而那句话本身就说明这一下压根不该点得动。
     *
     * 所以先问服务端：它说还在跑，就接着显示在跑（syncJob 会重开轮询）。
     */
    job.streaming = false;
    job.stopping = false;
    await syncJob();
    if (!job.running) {
      job.stage = '';
      job.shotId = null;
      job.shotIndex = null;
    }
    await reload();
  }
}

// cap:shot-regen
async function regen(shot, kind) {
  if (job.running) return;
  job.running = true;
  job.label = `第 ${shot.index} 镜${kind === 'video' ? '重出视频' : '重出图'}`;
  job.message = '正在提交…';
  job.fail = 0;
  paint();
  try {
    await stream(`/projects/${project.id}/shots/${shot.id}/regenerate`, { kind }, (ev) => {
      if (ev.type === 'error') {
        job.fail += 1;
        job.message = ev.message;
      } else if (ev.message) {
        job.message = ev.message;
      }
      updateLive();
    });
  } catch (err) {
    job.fail += 1;
    job.message = err.message;
  } finally {
    job.running = false;
    await reload();
  }
}

/**
 * 跑起来之后只重画**状态条那一块**。
 *
 * 整页重画在手机上代价更大：图和视频会重新加载一遍，正在播的那段会从头开始，
 * 滚动位置也丢了。而跑一步要十几分钟，这期间你多半正在翻分镜。
 */
function updateLive() {
  const old = document.querySelector('.live');
  if (old) old.replaceWith(paintLive());
}

async function reload() {
  /**
   * 顺手把全局设置捎回来。拿不到就算了 —— 少一句说明不该让整页打不开，
   * 而接缝那句话会退回默认模式的措辞（默认就是 lock）。
   */
  api('/settings').then((s) => { appSettings = s || {}; }).catch(() => {});
  const list = await api('/projects').catch(() => []);
  projects = list;
  const wanted = localStorage.getItem(PROJ_STORE);
  const pick = list.find((p) => p.id === wanted) || list[0];
  project = pick ? await api(`/projects/${pick.id}`).catch(() => null) : null;
  if (project) localStorage.setItem(PROJ_STORE, project.id);
  await syncJob();
  paint();
}

/**
 * ═══════════ 接回那份还在跑的活儿 ═══════════
 *
 * 手机上最容易撞的一个坑，用户的原话是：
 * "点击全跑了，手机切屏一会回来刷屏还是不动"。
 *
 * 事情是这样的：这份活儿跑在**服务器上**，关页面、切后台、断网都不影响它
 *（这是刻意的 —— 关掉浏览器就把出到一半的片子全丢掉，而且钱照花，
 *  是更糟的默认行为）。但那条进度流是跟着页面走的，一切屏就断了，
 * 而断了之后这一端**从来不问一句"现在还在跑吗"** ——
 * 于是回来看到的是一个静止的页面：进度条停在原处，没有转圈，什么都没有。
 *
 * 人只能判断成"卡死了"，然后再点一次「往后全跑」—— 撞上 409。
 * 那个 409 又只显示成光秃秃一行"HTTP 409"（那条也一起修了）。
 * 三件事叠在一起，看起来就是"手机端坏了"。
 *
 * 服务端本来就记着这份活儿（GET /projects/:id/job），只是没人问。
 */
async function syncJob() {
  if (!project) return;
  const live = await api(`/projects/${project.id}/job`).catch(() => null);
  if (!live) return;
  /**
   * 只在**我们没有自己那条流**的时候接管状态。
   * 正开着流的时候由 runStage 管，两边都写会互相打架 ——
   * 而打架的样子是状态条一会儿一个说法，比不更新还糟。
   */
  if (job.streaming) return;

  if (!live.running) {
    if (job.running) {
      job.running = false;
      job.reattached = false;
      job.shotId = null;
      job.shotIndex = null;
      job.message = live.note || '跑完了';
    }
    stopJobPoll();
    return;
  }
  job.running = true;
  job.reattached = true;
  job.stage = live.stage || '';
  job.label = live.stageLabel || live.stage || '运行中';
  job.message = live.note || '正在跑…';
  job.shotId = live.shotId || null;
  job.shotIndex = live.shotIndex || null;
  job.stopping = Boolean(live.cancelling);
  startJobPoll();
}

/**
 * 接回来之后要**接着看**。
 *
 * 流已经断了，重开一条会撞 409（那条口子一个项目只允许一份活儿），
 * 所以这里改成轮询 —— 三秒一次，只在页面可见时问，切后台就停。
 * 手机上后台定时器本来也不保证跑，与其假装在更新，不如回来时补一次。
 */
let jobTimer = null;
function startJobPoll() {
  if (jobTimer) return;
  jobTimer = setInterval(async () => {
    if (document.hidden) return;
    await syncJob();
    updateLive();
    // 跑完了要把画面也换过来，否则分镜页上还是旧的图
    if (!job.running) await reload();
  }, 3000);
}
function stopJobPoll() {
  if (!jobTimer) return;
  clearInterval(jobTimer);
  jobTimer = null;
}
// 切回来立刻补一次，别等那三秒 —— "回来时是不是马上有反应"就是这一下的差别
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  syncJob().then(() => {
    updateLive();
    paint();
  });
});

// ───────────────────────── 启动 ─────────────────────────

/** 口令存哪儿：服务器上和电脑版共用一份，局域网那条各存各的 */
function rememberKey(code) {
  try {
    localStorage.setItem(KEY_STORE, code);
    localStorage.setItem(PC_KEY_STORE, code);
  } catch {
    /* 隐私模式下写不进去，那就这一次有效 */
  }
}

/**
 * 两边存的口令互相当备份。
 *
 * 同样不看 mode：局域网那条路电脑版和手机版本来就不同源，读到的一定是空，
 * 白读一次没有代价；而依赖 mode 的话，探测一失败就得重新手输一遍。
 */
function savedKey() {
  try {
    return localStorage.getItem(KEY_STORE) || localStorage.getItem(PC_KEY_STORE) || '';
  } catch {
    return '';
  }
}

async function boot() {
  /**
   * 配色要在**任何网络请求之前**就位。
   * 放到后面的话，网慢时会先闪一屏深色再跳成浅色 ——
   * 那一下白闪比一直是深色更难受。
   */
  try {
    setTheme(localStorage.getItem(THEME_STORE) || 'auto');
  } catch {
    setTheme('auto');
  }

  /**
   * 先问清楚这台服务要的是配对码还是访问口令。
   *
   * ⚠ 这一问**必须有超时**。它只决定一句提示文案，却挡在整个界面前面 ——
   * 一旦这个请求既不成功也不失败（代理吞了、网络半死不活、中间有东西挂着），
   * 页面就永远停在"正在连接…"，用户看到的是一片死屏，
   * 而且完全没有线索：明明网是通的，应用也活着。
   *
   * 为一句文案赌上整个界面能不能打开，这笔账怎么算都不划算。两秒没回就往下走。
   */
  const probed = await Promise.race([
    fetch('/api/mode').then((r) => (r.ok ? r.json() : null)),
    new Promise((resolve) => setTimeout(() => resolve(null), 2000))
  ]).catch(() => null);
  // 建了账号就问用户名密码，没建就还是问那串码。探不到按老行为办
  mode = probed?.auth === 'account' ? 'account' : probed?.mode || 'lan';

  // 电脑上把带码的链接发到手机时，直接从地址里取，省得手敲
  const fromUrl = new URL(location.href).searchParams.get('k');
  if (fromUrl) {
    // ⚠ 不能转大写：服务器口令大小写混排，转一下就废了
    rememberKey(fromUrl);
    // 存下来之后就把它从地址栏抹掉：截图、分享、浏览器历史里都不该留着口令
    history.replaceState(null, '', location.pathname);
  }
  authKey = savedKey();
  if (!authKey) return paintPair();

  try {
    await api('/health');
  } catch (err) {
    localStorage.removeItem(KEY_STORE);
    authKey = '';
    return paintPair(
      err.status === 401
        ? mode === 'account'
          ? '登录过期了，重新登一次。'
          : mode === 'server'
            ? '口令不对，或者服务器上换过了 —— 重新填一次。'
            : '配对码失效了 —— 电脑上换过码，重新敲一次。'
        : err.message
    );
  }
  await reload();
  return undefined;
}

boot();


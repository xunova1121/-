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

const canInstall = window.isSecureContext && 'serviceWorker' in navigator;
if (canInstall) {
  navigator.serviceWorker.register('/m/sw.js').catch(() => {});
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
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* 半行，等下一块 */
      }
    }
  }
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
        }, h('span', { class: 'tab-dot' }, dot), label))
    )
  );
}

function paintLive() {
  if (!job.running && !job.fail && !job.message) return h('div', { class: 'live', hidden: true });
  return h('div', { class: `live ${job.fail ? 'bad' : job.running ? '' : 'good'}` },
    h('div', { class: 'row' },
      job.running ? h('span', { class: 'spin' }, '◐') : h('span', {}, job.fail ? '✕' : '✓'),
      h('b', { class: 'grow' }, job.label || (job.running ? '运行中' : '完成')),
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
    box.append(
      h('div', { class: `step ${st}` },
        h('span', { class: 'step-num' }, String(i + 1).padStart(2, '0')),
        h('span', { class: 'step-name' }, s.label),
        total > 1 ? h('span', { class: 'step-count' }, `${done}/${total}`) : null,
        h('span', { class: 'step-mark' }, st === 'done' ? '✓' : st === 'partial' ? '◗' : ''),
        h('button', {
          class: 'btn sm',
          disabled: job.running,
          // cap:run-stage
          onclick: () => runStage(s.id, s.label)
        }, st === 'pending' ? '开始' : '继续'),
        // 出门在外最想按的其实是这个：把剩下几步一次串完，回去直接看成片。
        // 从这一步往后跑，前面几步的产出原样保留 —— 不重跑、不重复计费
        h('button', {
          class: 'btn sm',
          disabled: job.running,
          title: '从这一步一路跑到合成',
          onclick: async () => {
            const rest = STEPS.length - i;
            // eslint-disable-next-line no-alert
            if (!confirm(`从「${s.label}」一路跑到合成，共 ${rest} 步。视频那步按镜数计费，可能是最大的一笔开销。确定？`)) return;
            // cap:run-from
            runStage('all', `${s.label} → 合成`, { from: s.id });
          }
        }, '往后全跑'))
    );
  });

  return [
    h('p', { class: 'muted', style: 'margin:2px 4px 10px' },
      '每一步都在电脑上跑，手机只是发个指令 —— 关掉这个页面也不影响它继续跑。'),
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
    styleCard()
  ];
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
  return out;
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
    h('div', { style: 'margin-top:10px' }, look),
    h('div', { class: 'row', style: 'margin-top:9px' }, save, redo, angleBtn));
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
function linkRangeCard(shots) {
  const from = h('input', { type: 'number', min: 1, value: '1', style: 'width:80px' });
  const to = h('input', { type: 'number', min: 1, value: String(shots.length) , style: 'width:80px' });
  const kind = h('select', { class: 'msel' },
    h('option', { value: 'continuous', selected: true }, '连续动作（动作不能断）'),
    h('option', { value: 'cut' }, '同场景换机位'),
    h('option', { value: 'new-scene' }, '换场景'));
  const status = h('div', { class: 'muted', style: 'margin-top:8px' });
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
  return h('div', { class: 'card' },
    h('b', {}, '整段标衔接'),
    h('p', { class: 'muted', style: 'margin:6px 0 10px' },
      '推门→进门→环视 这种连贯动作，标成「连续动作」会把上一镜的末帧锁成下一镜的首帧。'),
    h('div', { class: 'row' },
      h('span', { class: 'muted' }, '第'), from,
      h('span', { class: 'muted' }, '到'), to,
      h('span', { class: 'muted' }, '镜')),
    h('div', { style: 'margin-top:9px' }, kind),
    h('div', { class: 'row', style: 'margin-top:9px' }, go),
    status);
}

function paintShots() {
  const shots = (project?.shots || []).slice().sort((a, b) => a.index - b.index);
  if (!shots.length) return h('div', { class: 'card muted' }, '还没有分镜。先在流水线里跑到第 02 步。');
  const v = Date.parse(project.updatedAt || '') || 0;
  const portrait = /^9:16$|^3:4$/.test(project.aspectRatio || '');

  /**
   * 场次分隔条。手机上一屏只看得见一两镜，边界更容易被漏掉 ——
   * 而跨边界不能锁末帧、不能拿邻镜当参考，看不见的话人只会觉得
   * "这两镜怎么接不上"，而那条线正在眼皮底下。
   */
  const segs = project.segments || [];
  let lastSeg = null;
  const out = [linkRangeCard(shots)];

  for (const s of shots) {
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
    out.push(shotCardOf(s, v, portrait));
  }
  return out;
}

function shotCardOf(s, v, portrait) {
  {
    const c = s.consistency;
    return h('div', { class: 'card shot' },
      s.videoPath
        ? h('video', { class: `shot-media ${portrait ? 'portrait' : ''}`, src: media(s.videoPath, v), controls: true, preload: 'metadata', playsinline: true })
        : s.imagePath
          ? zoomable({ class: `shot-media ${portrait ? 'portrait' : ''}`, loading: 'lazy' }, media(s.imagePath, v), `第 ${s.index} 镜`)
          : h('div', { class: 'shot-media', style: 'display:flex;align-items:center;justify-content:center;color:var(--ink-faint);font-size:13px' }, '还没出图'),
      h('div', { class: 'shot-info' },
        h('div', { class: 'shot-no' }, `SH ${String(s.index).padStart(3, '0')} · ${Number(s.duration).toFixed(1)}s`),
        h('div', { class: 'shot-desc' }, s.description || '（无描述）'),
        s.dialogue ? h('div', { class: 'muted', style: 'margin-bottom:8px' }, `${s.speaker || '旁白'}：「${s.dialogue}」`) : null,
        h('div', { class: 'tags' },
          s.camera ? h('span', { class: 'tag' }, s.camera) : null,
          s.scene ? h('span', { class: 'tag' }, s.scene) : null,
          c?.score != null ? h('span', { class: `tag ${c.pass ? 'ok' : 'warn'}` }, `一致性 ${c.score}`) : null,
          s.imageSize && s.imageSize.ok === false
            ? h('span', { class: 'tag warn' }, `比例不符 ${s.imageSize.width}×${s.imageSize.height}`)
            : null,
          s.headMatch?.verdict === 'mismatch' ? h('span', { class: 'tag warn' }, '首帧没吃') : null,
          // 音效改过描述之后要能看出这条是旧的 —— 否则你以为改了，其实成片里还是那声旧的
          s.sfxPath
            ? h('span', { class: `tag ${s.sfxOf === s.sound ? '' : 'warn'}` },
                s.sfxOf === s.sound ? '有音效' : '音效已过时')
            : s.sound ? h('span', { class: 'tag' }, '待出音效') : null),
        h('div', { class: 'row' },
          h('button', {
            class: 'btn sm grow',
            disabled: job.running,
            onclick: () => regen(s, 'image')
          }, '重出这张图'),
          s.imagePath
            ? h('button', {
                class: 'btn sm grow',
                disabled: job.running,
                onclick: () => regen(s, 'video')
              }, '重出这段视频')
            : null),
        editRow(s)));
  }
}

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

function editRow(s) {
  const box = h('div', { class: 'editbox', style: 'display:none' });

  const desc = h('textarea', { rows: 3, class: 'mta' }, s.description || '');
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
  // 属于第几场。模型划边界是读剧本猜的，猜错很正常，得能改
  const segIn = h('input', { type: 'number', class: 'min', min: '1', max: '99', value: String(s.segment || 1) });

  /**
   * 默认折叠：不是每一镜都值得排位。空镜、过渡镜写句"全景"就够了，
   * 值得排的是对话戏和动作接续 —— 那两种地方越轴和景别跳最要命。
   */
  let stageDraft = s.stage || null;
  const previzBox = h('details', { class: 'previz-details' },
    h('summary', {}, stageDraft ? '已排位（点开调整）' : '排一下机位'));
  previzBox.addEventListener('toggle', () => {
    if (!previzBox.open || previzBox.dataset.built) return;
    previzBox.dataset.built = '1';
    // 上一镜的排位拿来比轴线 —— 越轴是两镜之间的事，单看一镜看不出来
    const prev = (project.shots || []).filter((x) => x.index < s.index).slice(-1)[0];
    if (!stageDraft) {
      // 接着上一镜排（同场次才接）—— 人不会在两镜之间瞬移，
      // 而且位置一变轴线就跟着转，越轴检查会开始乱报
      const sameSeg = prev && Number(prev.segment || 1) === Number(s.segment || 1);
      const names = (s.characters || []).slice(0, 4);
      stageDraft = (sameSeg && inheritStage(prev.stage, names)) || blankStage(names);
    }
    previzBox.append(previzPanel(stageDraft, { size: 300, prevStage: prev?.stage || null }).node);
  });
  // 怎么进入这一镜。默认硬切 —— 满屏叠化是最典型的业余做法
  let transition = s.transition || 'cut';
  const TRANS_PICK = [['cut', '硬切'], ['fade', '黑场'], ['dissolve', '叠化']];

  const save = h('button', { class: 'btn sm primary grow' }, '保存');
  save.onclick = async () => {
    save.disabled = true;
    try {
      // cap:shot-text cap:shot-dialogue cap:shot-camera
      await api(`/projects/${project.id}/shots/${s.id}`, {
        method: 'PATCH',
        body: {
          description: desc.value,
          dialogue: line.value,
          speaker: who.value,
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
      toast('已保存。重出这一镜才会按新的生成', 'ok');
      await reload();
    } catch (err) {
      toast(err.message, 'err');
      save.disabled = false;
    }
  };

  const toggle = h('button', {
    class: 'btn sm grow',
    onclick: () => {
      const open = box.style.display === 'none';
      box.style.display = open ? '' : 'none';
      toggle.textContent = open ? '收起' : '改这一镜';
    }
  }, '改这一镜');

  /**
   * 预演台要有**自己的按钮**，不能只藏在「改这一镜」里面。
   *
   * 原来要先点开编辑、再往下翻过描述/台词/音效/景别/时长/场次一大串
   * 才看得到那个折叠块。用户的原话是"没找到预演台"。
   * **功能找不到等于没做** —— 而且这种漏法比崩溃更隐蔽：
   * 功能在、测试绿、就是没人用得上。
   *
   * 排过位的镜按钮上带个点，扫一眼就知道哪几镜排过。
   */
  const stageBtn = h('button', {
    class: 'btn sm grow',
    onclick: () => {
      if (box.style.display === 'none') toggle.click();
      previzBox.open = true;
      previzBox.dispatchEvent(new Event('toggle'));
      previzBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, s.stage?.cam ? '预演台 ·' : '预演台');

  box.append(
    field('画面描述', desc, '这是出图和出视频的唯一输入 —— 写偏一句，重出十次也回不到对的画面。'),
    field('台词', line, '留空就是这一镜没人说话。'),
    field('谁说的', who, '决定用哪个角色的音色。选「旁白」就是画外音。'),
    field('画外音效', sfx, '听得见看不见的东西写这里。写进画面描述的话，出图模型会去画那个声音 ——「敲门声」通常会画出一扇开着的门。'),
    field('景别', chips(CAMERAS, camera, (v) => (camera = v))),
    field('运镜', chips(MOTIONS, motion, (v) => (motion = v))),
    field('时长（秒）', dur),
    // cap:shot-segment
    field('第几场', segIn, '场次 = 同一时间同一地点的一段戏。跨场次不能锁末帧、不能拿邻镜当参考图，转场也只出现在场次之间。'),
    // cap:shot-stage
    field('预演台（可选）', previzBox,
      '排一下机位：拖大圆点摆人、拖小圆点转身、拖「机」摆机位。'
      + '两人之间那条线是轴线，机位跨过去成片上两人就左右对调了。'
      + '排过位之后，景别和机位由几何算出来，不再是"中景"这种说不清的词。'),
    // cap:tier-routing
    field('模型档位', (() => {
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
    })(), '空镜和远景用便宜模型看不出差别 —— 这一档最省钱。判错了在这儿改。'),
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
    })(), '绝大多数镜都该是硬切。黑场和叠化只在真的换时间换地点时用 —— 满屏叠化是最典型的业余做法。叠化还会吃掉 0.5 秒。'),
    h('div', { class: 'row', style: 'margin-top:12px' }, save),
    h('div', { class: 'muted', style: 'margin-top:7px' },
      '保存只改文案，不重出 —— 一般是连着改好几镜再统一重出，改一个字就烧一次钱不划算。')
  );

  return [h('div', { class: 'row', style: 'margin-top:8px' }, toggle, stageBtn), box];
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

  return [...head, material];
}

// ───────────────────────── 动作 ─────────────────────────

async function runStage(stageId, label, extra = {}) {
  if (job.running) return;
  job.running = true;
  job.label = label;
  job.message = '正在提交…';
  job.fail = 0;
  paint();
  try {
    await stream(`/projects/${project.id}/stage/${stageId}`, extra, (ev) => {
      // 主动停下来不是失败 —— 记成失败会让人回头去查一个不存在的问题
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
    job.running = false;
    job.stopping = false;
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
  const list = await api('/projects').catch(() => []);
  projects = list;
  const wanted = localStorage.getItem(PROJ_STORE);
  const pick = list.find((p) => p.id === wanted) || list[0];
  project = pick ? await api(`/projects/${pick.id}`).catch(() => null) : null;
  if (project) localStorage.setItem(PROJ_STORE, project.id);
  paint();
}

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


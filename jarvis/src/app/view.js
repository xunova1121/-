/**
 * 界面杂项：欢迎页（电脑的快捷卡片 / 手机首页）、HUD 时钟、命令面板（Ctrl+K）、专注视图、全屏、
 * 自动更新提示、明暗主题、设置里的开关（问好、桌面背景、习惯学习、团队模式、情绪、动画）、开机自检动画。
 */
import { STANDALONE, MOBILE } from '../config.js';
import { displayName } from '../llm/config.js';
import { resolveTheme, toggled, THEMES } from '../core/theme.js';
import { createWeatherClient } from '../core/weather.js';
import { createHome } from '../ui/home.js';
import { initPalette } from '../ui/palette.js';
import * as habits from '../agent/habits.js';
import * as agentMemory from '../agent/memory.js';
import * as sessionsApi from '../agent/sessions.js';
import { PANES } from './panels.js';
import { $, body, DESKTOP, COMPACT, narrow, lowEnd, toast } from './env.js';

export function createView(app) {
  const QUICK = [
    { icon: '⌘', title: '写一个网页', desc: '写代码并在工作区实时预览', prompt: '帮我写一个网页' },
    { icon: '▤', title: '做汇报 PPT', desc: '结论先行，一页一个观点', prompt: '做一个PPT' },
    { icon: '⌕', title: '深度调研', desc: '多轮搜索、读网页，写带出处的报告', fill: '深度调研：' },
    { icon: '▦', title: '分析表格', desc: '上传 Excel / CSV，找趋势与异常', upload: true },
    { icon: '◎', title: '导入知识库', desc: 'PDF、Word、PPT 都能读', panel: 'knowledge' },
    { icon: 'ϟ', title: '安装技能', desc: '一键获得新的做事方法', panel: 'skills' },
    { icon: '◉', title: '记住偏好', desc: '告诉我你的习惯，越用越懂你', prompt: '记住我喜欢简洁的回答' }
  ];
  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  }
  let homeView;
  const homeWeather = createWeatherClient({ direct: MOBILE || STANDALONE });
  function renderWelcome() {
    if (document.querySelector('#transcript .msg')) return;
    if (COMPACT) {
      homeView?.destroy();
      document.querySelector('#transcript .wy-home')?.remove();
      homeView = createHome({
        weather: homeWeather,
        send: app.send,
        fill: (text) => {
          $('#prompt').value = text;
          $('#prompt').focus();
        },
        openPanel: app.showPanel
      });
      $('#transcript').prepend(homeView.root);
      $('#transcript').scrollTop = 0;
      return;
    }
    const cards = QUICK.map((q) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'quick';
      b.innerHTML = '<span class="quick-icon"></span><span class="quick-title"></span><span class="quick-desc"></span>';
      b.querySelector('.quick-icon').textContent = q.icon;
      b.querySelector('.quick-title').textContent = q.title;
      b.querySelector('.quick-desc').textContent = q.desc;
      b.addEventListener('click', () => {
        if (q.prompt) app.send(q.prompt);
        else if (q.fill) {
          $('#prompt').value = q.fill;
          $('#prompt').focus();
        } else if (q.panel) app.showPanel(q.panel);
        else if (q.upload) $('#btn-attach')?.click();
      });
      return b;
    });
    const w = document.createElement('div');
    w.className = 'welcome';
    const h = document.createElement('h1');
    h.textContent = `${greeting()}，我是未央`;
    const p = document.createElement('p');
    p.textContent = narrow.matches
      ? '交给我一个任务，或者试试下面这些。输入 / 可以点名技能。'
      : '交给我一个任务，或者试试下面这些。输入 / 可以点名技能，Ctrl + K 搜索任何操作。';
    const grid = document.createElement('div');
    grid.className = 'quick-grid';
    grid.append(...cards);
    if (COMPACT) {
      // 手机首页：会浮动的云朵 + 问候 + 日期，下面是“未央为你准备了”三条，可以换一换
      const hero = document.createElement('div');
      hero.className = 'welcome-hero';
      hero.setAttribute('aria-hidden', 'true');
      hero.innerHTML = '<i class="halo"></i><i class="halo b"></i><i class="cloud"></i>';
      const d = new Date();
      const pill = document.createElement('div');
      pill.className = 'welcome-pill';
      pill.textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]} · 有事交给我`;
      w.append(hero, h, pill, picksCard());
    } else w.append(h, p, grid);
    $('#transcript').prepend(w);
  }

  // 手机首页的推荐：每次显示 3 条，点“换一换”轮换
  const PICKS = [
    { t: '今天有哪些重点新闻', k: 'news', h: 210, prompt: '今天的重点新闻' },
    { t: '明天天气怎么样，要不要带伞', k: 'sun', h: 35, prompt: '明天天气怎么样，要带伞吗' },
    { t: '帮我写一份本周工作周报', k: 'doc', h: 255, fill: '帮我写一份本周工作周报，本周做了：' },
    { t: '做一个汇报 PPT', k: 'ppt', h: 15, prompt: '做一个PPT' },
    { t: '深度调研一个话题，带出处', k: 'search', h: 190, fill: '深度调研：' },
    { t: '分析一个 Excel 表格', k: 'table', h: 150, upload: true },
    { t: '写一个实时时钟网页', k: 'code', h: 280, prompt: '写一个实时时钟网页' },
    { t: '把一段话翻译成地道的英文', k: 'chat', h: 320, fill: '把这段话翻译成地道的英文：' },
    { t: '给我装一个新技能', k: 'spark', h: 45, panel: 'skills' },
    { t: '导入资料做成知识库', k: 'book', h: 170, panel: 'knowledge' }
  ];
  const PICK_ICON = {
    news: '<path d="M5 5h11v14H6a1 1 0 0 1-1-1z"/><path d="M16 9h3v9a1 1 0 0 1-1 1h-2M8 9h5M8 12h5M8 15h3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
    doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 15h5M10 18h3"/>',
    ppt: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M12 17v3M8 20h8M8 13l3-3 2 2 3-3"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
    table: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>',
    code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4M13 6l-2 12"/>',
    chat: '<path d="M5 6h14v9H10l-4 3v-3H5z"/><path d="M9 10h6"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M12 8l1.5 2.5L16 12l-2.5 1.5L12 16l-1.5-2.5L8 12l2.5-1.5z"/>',
    book: '<path d="M4 5c3-1 6-1 8 1v14c-2-2-5-2-8-1zM20 5c-3-1-6-1-8 1v14c2-2 5-2 8-1z"/>'
  };
  let pickAt = 0;
  function picksCard() {
    const card = document.createElement('section');
    card.className = 'picks';
    card.innerHTML =
      '<div class="picks-head"><b><svg viewBox="0 0 24 24"><path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/></svg>未央为你准备了</b><button type="button" class="picks-more"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.5-4M4 13a8 8 0 0 0 14.5 4M5 3v4h4M19 21v-4h-4"/></svg>换一换</button></div><div class="picks-list"></div>';
    const list = card.querySelector('.picks-list');
    const fill = () => {
      list.replaceChildren(
        ...[0, 1, 2].map((i) => {
          const q = PICKS[(pickAt + i) % PICKS.length];
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'pick';
          b.style.setProperty('--h', q.h);
          b.innerHTML = `<span class="pick-icon"><svg viewBox="0 0 24 24">${PICK_ICON[q.k]}</svg></span><span class="pick-t"></span><svg class="pick-go" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>`;
          b.querySelector('.pick-t').textContent = q.t;
          b.addEventListener('click', () => {
            if (q.prompt) app.send(q.prompt);
            else if (q.fill) {
              $('#prompt').value = q.fill;
              $('#prompt').focus();
            } else if (q.panel) app.showPanel(q.panel);
            else if (q.upload) $('#btn-attach')?.click();
          });
          return b;
        })
      );
    };
    card.querySelector('.picks-more').addEventListener('click', () => {
      pickAt = (pickAt + 3) % PICKS.length;
      list.classList.remove('swap');
      void list.offsetWidth;
      list.classList.add('swap');
      fill();
    });
    fill();
    return card;
  }

  const WEEK = '日一二三四五六';
  function tickClock() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    $('#hud-time').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    $('#hud-date').textContent = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} · 星期${WEEK[d.getDay()]}`;
  }
  tickClock();
  setInterval(tickClock, 1000);

  const PANE_TITLE = {
    sessions: '对话',
    workspace: '工作区',
    knowledge: '知识库',
    mind: '记忆与进化',
    skills: '技能',
    models: '模型与声音',
    system: '系统与定时任务',
    settings: '设置'
  };
  const palette = initPalette({
    commands: () => {
      const toggle = (id, title) => ({
        id: `t-${id}`,
        group: '开关',
        title: `${$(`#${id}`).checked ? '关闭' : '开启'}${title}`,
        run: () => $(`#${id}`).click()
      });
      return [
        ...QUICK.filter((q) => q.prompt || q.fill).map((q) => ({
          id: `q-${q.title}`,
          group: '常用任务',
          title: q.title,
          hint: q.desc,
          run: () => {
            if (q.prompt) app.send(q.prompt);
            else {
              $('#prompt').value = q.fill;
              $('#prompt').focus();
            }
          }
        })),
        ...app.skillsPanel.installed
          .filter((p) => p.enabled)
          .map((p) => ({
            id: `s-${p.name}`,
            group: '技能',
            title: `/${p.name}`,
            hint: p.description,
            run: () => {
              $('#prompt').value = `/${p.name} `;
              $('#prompt').focus();
            }
          })),
        ...PANES.map((p, i) => ({ id: `p-${p}`, group: '面板', title: `打开${PANE_TITLE[p]}`, keys: `Alt ${i + 1}`, run: () => app.showPanel(p) })),
        toggle('set-tts', '打字也朗读'),
        ...(!app.mic.hidden ? [toggle('set-voice', '直接对话'), toggle('set-wake', '唤醒词')] : []),
        toggle('set-face', '人脸跟随'),
        {
          id: 'focus',
          group: '开关',
          title: body.classList.contains('focus-view') ? '退出专注视图' : '进入专注视图',
          keys: 'Alt F',
          run: () => $('#btn-focus').click()
        },
        {
          id: 'theme',
          group: '开关',
          title: document.documentElement.dataset.theme === 'light' ? '切换为夜间界面' : '切换为白天界面',
          run: () => $('#btn-theme').click()
        },
        {
          id: 'team',
          group: '操作',
          title: '交给团队完成…',
          hint: '规划员拆步骤，多个角色分工执行，审核员把关',
          run: () => {
            $('#prompt').value = '/团队 ';
            $('#prompt').focus();
          }
        },
        {
          id: 'new',
          group: '操作',
          title: '新对话',
          hint: '开始一段新对话（之前的对话保存在“对话”面板里）',
          keys: 'Ctrl Shift O',
          run: () => app.newSession()
        },
        { id: 'sessions', group: '操作', title: '历史对话', hint: '查看、搜索之前的对话', run: () => app.showPanel('sessions') },
        { id: 'stop', group: '操作', title: '打断 / 停止当前任务', keys: 'Esc', run: () => app.interrupt() },
        { id: 'preview-voice', group: '操作', title: '试听当前声音', run: () => app.speaker.preview() },
        { id: 'fullscreen', group: '操作', title: '全屏', run: () => $('#btn-fullscreen').click() }
      ];
    }
  });
  palette.onFallback = (text) => app.send(text);
  $('#btn-palette').addEventListener('click', () => palette.open());
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $('#palette-kbd').textContent = '⌘K';
  $('#set-quality').addEventListener('change', (e) => {
    app.setSetting('quality', e.target.value);
    app.applyFpsCap();
  });

  function setFocusView(on) {
    app.setSetting('focusView', on);
    body.classList.toggle('focus-view', on);
    $('#set-focus').checked = on;
    $('#btn-focus').setAttribute('aria-pressed', String(on));
    app.applyFpsCap();
    app.updateStageMode();
  }
  $('#btn-focus').addEventListener('click', () => setFocusView(!app.settings.focusView));
  $('#btn-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });

  // 自动更新：顶栏显示下载进度 / “重启更新”（电脑）/ “安装新版本”（手机）/ “去下载”
  const APP_UPDATER = globalThis.__jarvisAppUpdater; // 手机 App（mobile/appUpdate.js）
  if (DESKTOP?.onUpdate || APP_UPDATER) {
    const pill = $('#update-pill');
    const note = $('#update-note');
    const show = (u) => {
      $('#row-version').hidden = false;
      $('#app-version').textContent = `当前 ${u.current ?? DESKTOP?.version ?? ''}`;
      pill.hidden = !['downloading', 'ready', 'available'].includes(u.state);
      pill.dataset.state = u.state;
      pill.style.setProperty('--p', `${u.state === 'downloading' ? (u.percent ?? 0) : 0}%`); // 下载进度条
      pill.textContent =
        u.state === 'downloading'
          ? `新版本下载中 ${u.percent ?? 0}%`
          : u.state === 'ready'
            ? u.mobile
              ? `安装新版本 ${u.version}`
              : `重启以更新到 ${u.version}`
            : u.state === 'available'
              ? u.mobile
                ? `新版本 ${u.version} · 下载`
                : `新版本 ${u.version} · 去下载`
              : '';
      note.textContent =
        u.hint ||
        ({
          checking: '正在检查…',
          latest: '已经是最新版本',
          downloading: u.mobile ? `正在后台下载 ${u.version ?? ''}（约 11 MB）` : `正在后台下载 ${u.version ?? ''}（只下载改动的部分）`,
          ready: u.mobile
            ? `${u.version} 已下载好，点顶栏的“安装新版本”，在系统界面点“安装”即可（对话和设置都保留）`
            : `${u.version} 已下载好，点顶栏的“重启以更新”或下次启动时自动安装`,
          available: u.mobile
            ? `有新版本 ${u.version}。正在用流量，点顶栏按钮下载（约 11 MB）`
            : `有新版本 ${u.version}。${u.manual ? '这个版本（免安装版 / Mac）不能自动安装，请到下载页下载' : ''}`,
          error: `检查更新失败：${u.error ?? ''}`,
          dev: u.mobile ? '调试版，不检查更新' : '从源码运行，不检查更新'
        }[u.state] ??
          '');
      if (u.state === 'ready' && !show.toldReady) {
        show.toldReady = true;
        toast(u.mobile ? `新版本 ${u.version} 已下载好，点顶栏“安装新版本”即可更新` : `新版本 ${u.version} 已下载好，点顶栏按钮重启即可更新`);
      }
    };
    if (APP_UPDATER) {
      // 上次闪退的记录（mobile/boot.js 存的）：显示在版本这一栏，方便截图
      let crash = '';
      try {
        crash = localStorage.getItem('jarvis.lastCrash') || '';
      } catch {
        /* 读不到就不显示 */
      }
      if (crash) {
        const p = Object.assign(document.createElement('p'), { className: 'muted small', textContent: `最近一次异常退出：\n${crash.slice(-800)}` });
        p.style.whiteSpace = 'pre-line';
        $('#row-version').append(p);
      }
      APP_UPDATER.onUpdate(show);
      show(APP_UPDATER.state);
      APP_UPDATER.start();
      pill.addEventListener('click', () => APP_UPDATER.act().catch((e) => toast(e.message)));
      $('#btn-update-check').addEventListener('click', () => APP_UPDATER.check().catch((e) => toast(e.message)));
    } else {
      DESKTOP.onUpdate(show);
      DESKTOP.invoke('updateState')
        .then((u) => show(u.packaged ? u : { ...u, state: 'dev' }))
        .catch(() => {});
      pill.addEventListener('click', () => {
        if (pill.dataset.state === 'ready') DESKTOP.invoke('updateInstall');
        else if (pill.dataset.state === 'available') DESKTOP.invoke('openReleases');
      });
      $('#btn-update-check').addEventListener('click', () =>
        DESKTOP.invoke('updateCheck')
          .then(show)
          .catch((e) => toast(e.message))
      );
    }
  }

  // 界面明暗
  const lightMql = matchMedia('(prefers-color-scheme: light)');
  function applyTheme() {
    const t = resolveTheme(app.settings.theme, { prefersLight: lightMql.matches });
    document.documentElement.dataset.theme = t;
    for (const b of document.querySelectorAll('#set-theme button')) b.setAttribute('aria-checked', String(b.dataset.v === app.settings.theme));
    $('#btn-theme').title = `${t === 'light' ? '白天' : '夜间'}界面（${THEMES[app.settings.theme]}）· 点击切换`;
  }
  function setTheme(mode) {
    app.setSetting('theme', mode);
    applyTheme();
  }
  // 桌面版：右上角系统按钮的底色 / 图标色 / 高度跟随顶栏
  function syncTitleBar() {
    if (!DESKTOP?.setTitleBar) return;
    requestAnimationFrame(() => {
      if (document.body.classList.contains('workbench')) {
        dispatchEvent(new Event('jarvis:sync-titlebar'));
        return;
      }
      const height = 32;
      DESKTOP.setTitleBar({ color: '#ffffff', symbolColor: '#72727d', height }).catch(() => {});
    });
  }
  new MutationObserver(syncTitleBar).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  addEventListener('load', syncTitleBar);
  applyTheme();
  syncTitleBar();
  lightMql.addEventListener?.('change', applyTheme);
  setInterval(() => {
    if (app.settings.theme === 'time') applyTheme();
  }, 60_000);
  $('#btn-theme').addEventListener('click', () => {
    setTheme(toggled(document.documentElement.dataset.theme));
    toast(document.documentElement.dataset.theme === 'light' ? '已切换为白天界面' : '已切换为夜间界面');
  });
  for (const b of document.querySelectorAll('#set-theme button')) b.addEventListener('click', () => setTheme(b.dataset.v));

  // 主动问好 / 桌面背景
  $('#set-greet').checked = app.settings.greetOnReturn !== false;
  $('#set-greet').addEventListener('change', (e) => app.setSetting('greetOnReturn', e.target.checked));
  if (DESKTOP) {
    $('#row-wallpaper').hidden = false;
    DESKTOP.invoke('wallpaperState')
      .then((r) => {
        $('#set-wallpaper').checked = r.on;
      })
      .catch(() => {});
    $('#set-wallpaper').addEventListener('change', async (e) => {
      try {
        const r = await DESKTOP.invoke('setWallpaper', { on: e.target.checked });
        toast(r.on ? '已开启全息陪伴桌面：可以摸摸未央，或直接打字聊天' : '已关闭桌面背景');
      } catch (err) {
        toast(err.message);
        e.target.checked = false;
      }
    });
  }
  if (DESKTOP) {
    $('#row-habits').hidden = false;
    DESKTOP.invoke('habitTrackingState')
      .then((r) => {
        $('#set-habits').checked = r.on;
      })
      .catch(() => {});
    app.renderHabits();
    $('#set-habits').addEventListener('change', async (e) => {
      try {
        const r = await DESKTOP.invoke('setHabitTracking', { on: e.target.checked });
        toast(r.on ? '开始学习你的使用习惯：只记录前台程序名和时间，数据只在这台电脑上' : '已暂停习惯学习');
      } catch (err) {
        toast(err.message);
        e.target.checked = false;
      }
    });
    $('#btn-habits-memorize').addEventListener('click', async () => {
      await habits.flush();
      await app.memorizeHabits({ manual: true });
      app.renderHabits();
    });
    $('#btn-habits-clear').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      if (b.dataset.armed !== '1') {
        b.dataset.armed = '1';
        b.textContent = '确认清除';
        setTimeout(() => {
          b.dataset.armed = '';
          b.textContent = '清除记录';
        }, 3000);
        return;
      }
      await habits.clear();
      b.dataset.armed = '';
      b.textContent = '清除记录';
      app.renderHabits();
      toast('已清除习惯记录（已写进记忆的习惯可在“记忆与进化”里删除）');
    });
  }
  for (const b of document.querySelectorAll('#set-team button')) {
    b.setAttribute('aria-checked', String(b.dataset.v === app.settings.teamMode));
    b.addEventListener('click', () => {
      app.setSetting('teamMode', b.dataset.v);
      for (const x of document.querySelectorAll('#set-team button')) x.setAttribute('aria-checked', String(x === b));
    });
  }
  $('#set-focus').addEventListener('change', (e) => setFocusView(e.target.checked));
  $('#set-motion').addEventListener('change', (e) => {
    app.setSetting('reducedMotion', e.target.value);
    app.applyMotionMode();
  });

  /** 开机序列：每次打开（同一标签页内刷新不重复）播放约 2 秒的系统自检；减少动画时跳过 */
  async function bootSequence() {
    let seen = false;
    try {
      seen = sessionStorage.getItem('jarvis.booted') === '1';
      sessionStorage.setItem('jarvis.booted', '1');
    } catch {
      /* 隐私模式 */
    }
    const boot = $('#boot');
    if (seen || COMPACT || body.classList.contains('reduced-motion') || !boot) {
      boot?.remove();
      return;
    }
    const all = await agentMemory.listAll().catch(() => null);
    const lines = [
      ['神经粒子核心', `${lowEnd ? 6000 : 14000} 粒子`],
      ['长期记忆', all ? `${all.memories.length} 条` : '在线'],
      ['习得技能 / 教训', all ? `${all.skills.length} / ${all.lessons.length}` : '在线'],
      ['对话历史', `${(await sessionsApi.list().catch(() => [])).length} 段`],
      ['模型链路', displayName(app.llmConfig)],
      ['系统', '全部就绪']
    ];
    $('#boot-lines').replaceChildren(
      ...lines.map(([k, v], i) => {
        const d = document.createElement('div');
        d.style.animationDelay = `${150 + i * 210}ms`;
        d.textContent = `> ${k} `;
        const b = document.createElement('b');
        b.textContent = v;
        d.append(b);
        return d;
      })
    );
    setTimeout(() => boot.classList.add('out'), 1900);
    setTimeout(() => boot.remove(), 2500);
  }

  return {
    renderWelcome,
    setFocusView,
    bootSequence,
    get palette() {
      return palette;
    }
  };
}

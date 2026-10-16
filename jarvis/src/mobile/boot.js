/**
 * 安卓 App 启动时的适配（在 main.js 的其他代码之前运行；其他版本里什么都不做）：
 *   网络：服务商不允许跨域时改走系统原生网络
 *   朗读：WebView 没有 speechSynthesis，用系统 TTS 补上
 *   听写：直接对话用系统语音识别
 *   同步：阿里云 OSS 请求走原生网络（可以设置 Date 头、没有跨域限制）
 */
import { MOBILE } from '../config.js';
import { wrapFetch, nativeFetcher } from './nativeFetch.js';
import { installSpeechShim } from './speechShim.js';
import { createNativeSaver } from './saveNative.js';
import { applyDisplayMode } from './renderHealth.js';
import { topColor } from './topColor.js';

if (MOBILE && globalThis.Capacitor?.isNativePlatform?.()) {
  const { CapacitorHttp } = await import('@capacitor/core');
  const native = nativeFetcher(CapacitorHttp);
  globalThis.__jarvisNativeFetch = native;
  globalThis.fetch = wrapFetch(globalThis.fetch.bind(globalThis), native, location.origin);
  try {
    const { registerPlugin } = await import('@capacitor/core');
    globalThis.__jarvisSpeech = registerPlugin('MobileSpeech');
    globalThis.__jarvisEdgeSpeech = registerPlugin('EdgeSpeech');
    globalThis.__jarvisBackgroundTask = registerPlugin('BackgroundTask');
    globalThis.__jarvisSpeech.addListener('dialog', ({ active }) => { globalThis.__jarvisSystemSpeechDialog = active; }); // 直接对话用系统语音识别（见 nativeVoice.js）
  } catch { /* 没有识别插件：走云端转写 */ }
  try {
    const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
    installSpeechShim(TextToSpeech);
    globalThis.__jarvisTTS = TextToSpeech; // 语音自检用
  } catch { /* 没有朗读插件：只显示文字 */ }
  try {
    // 返回键：先关抽屉 / 面板，再回到上一层，最后才退到后台（不直接退出）
    const { App } = await import('@capacitor/app');
    globalThis.__jarvisForeground = true;
    App.addListener('appStateChange', ({ isActive }) => {
      globalThis.__jarvisForeground = isActive;
      dispatchEvent(new CustomEvent('jarvis:foreground', { detail: { active:isActive } }));
      if (!isActive) globalThis.__jarvisTTS?.stop().catch(() => {});
    });
    App.addListener('backButton', () => {
      const picker=document.querySelector('.mp-sheet:not([hidden]) .x-btn');
      if(picker){picker.click();return;}
      const weather=document.querySelector('.weather-dialog[open]');
      if(weather){weather.close();return;}
      const image = document.querySelector('.image-preview[open]');
      if (image) { image.close(); return; }
      const companion = document.querySelector('.wy-companion[open]');
      if (companion) { companion.close(); return; }
      const b = document.body;
      if (b.classList.contains('workbench') && (b.classList.contains('weiyang-menu-open') || !b.classList.contains('side-closed') || b.classList.contains('wb-info-open'))) {
        window.dispatchEvent(new Event('weiyang:back')); return;
      }
      if (b.classList.contains('drawer-open')) return document.querySelector('.drawer-scrim')?.click();
      if (b.classList.contains('side-open')) return document.getElementById('btn-side-back')?.click();
      App.minimizeApp();
    });
  } catch { /* 没有 App 插件 */ }
  // 状态栏 / 手势条的图标颜色跟随明暗：浅色界面用深色图标，深色界面用浅色图标
  try {
    const { registerPlugin } = await import('@capacitor/core');
    const WindowColor = registerPlugin('WindowColor');
    let pending=0,last='';
    const apply = () => {
      if(pending)return;
      pending=requestAnimationFrame(()=>{
        pending=0;
        const holo=document.body.classList.contains('holo-open');
        const light=!holo&&document.documentElement.dataset.theme!=='dark';
        const fallback=light?'#FCFBFF':'#191923';
        const header=document.querySelector('.topbar');
        const color=holo?'#071426':topColor(getComputedStyle(header||document.body),topColor(getComputedStyle(document.body),fallback));
        const key=color+light;
        if(key===last)return;
        last=key;
        WindowColor.set({color,light}).catch(()=>{if(last===key)last='';});
      });
    };
    apply();
    new MutationObserver(apply).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    addEventListener('jarvis:chrome-ready',apply);
    addEventListener('load',apply);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){last='';apply();}});
  } catch { /* 旧版 Capacitor 没有 SystemBars */ }
  // 下载：WebView 里网页下载不起作用。存到“文档/Jarvis”，再弹出系统分享（用 WPS、微信等打开或发送）
  globalThis.__jarvisSaveFile = async (blob, name) => {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
    return createNativeSaver({ Filesystem, Directory, Share, toast: (t) => globalThis.__jarvisToast?.(t) })(blob, name);
  };

  // 自动更新：后台下载新版安装包，顶栏点“安装新版本”（见 appUpdate.js；界面在 main.js 里和电脑版共用）
  try {
    const [{ App }, { registerPlugin }, { createAppUpdater }] = await Promise.all([import('@capacitor/app'), import('@capacitor/core'), import('./appUpdate.js')]);
    const info = await App.getInfo();
    globalThis.__jarvisAppUpdater = createAppUpdater({
      current: info.version,
      plugin: registerPlugin('AppUpdate'),
      getText: async (url) => { const r = await native(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); },
      metered: () => navigator.connection?.type === 'cellular'
    });
    // 从后台切回 App 时也查一次（最多 30 分钟一次）：App 常驻后台时，不用等 6 小时的定时检查
    let lastResume = Date.now();
    App.addListener('resume', () => {
      if (Date.now() - lastResume < 30 * 60_000) return;
      lastResume = Date.now();
      globalThis.__jarvisAppUpdater.check({ auto: true }).catch(() => {});
    });
  } catch { /* 旧版 App 没有更新插件 */ }

  // 上次闪退的原因（原生层记下的）：存起来，设置里显示，打开后也提示一下
  try {
    const { registerPlugin } = await import('@capacitor/core');
    const crashLog = registerPlugin('CrashLog');
    globalThis.__jarvisRenderHealthPlugin = crashLog;
    let { text, safeDisplay } = await crashLog.take();
    if (typeof safeDisplay === 'boolean') applyDisplayMode(safeDisplay);
    if (text) {
      // 崩溃前在做什么（main.js 在执行每一步时记下的；正常结束会清空）
      let doing = '';
      try { doing = localStorage.getItem('jarvis.lastActivity') || ''; localStorage.removeItem('jarvis.lastActivity'); } catch { /* 读不到就不写 */ }
      if (doing) text = `${text.trim()}\n崩溃前正在：${doing}`;
      try { localStorage.setItem('jarvis.lastCrash', text.trim()); } catch { /* 存不了就只提示 */ }
      const last = text.trim().split('\n').filter((l) => !l.startsWith('崩溃前')).at(-1) ?? '';
      setTimeout(() => globalThis.__jarvisToast?.(`上次异常退出：${last.slice(15, 60)}（设置 → 模型 → 版本那一栏可以看详情）`), 4000);
    }
  } catch { /* 旧版 App 没有这个插件 */ }

  document.documentElement.classList.add('mobile-app');
}

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

if (MOBILE && globalThis.Capacitor?.isNativePlatform?.()) {
  const { CapacitorHttp } = await import('@capacitor/core');
  const native = nativeFetcher(CapacitorHttp);
  globalThis.__jarvisNativeFetch = native;
  globalThis.fetch = wrapFetch(globalThis.fetch.bind(globalThis), native, location.origin);
  try {
    const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
    globalThis.__jarvisSpeech = SpeechRecognition; // 直接对话用系统语音识别（见 nativeVoice.js）
  } catch { /* 没有识别插件：走云端转写 */ }
  try {
    const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
    installSpeechShim(TextToSpeech);
  } catch { /* 没有朗读插件：只显示文字 */ }
  try {
    // 返回键：先关抽屉 / 面板，再回到上一层，最后才退到后台（不直接退出）
    const { App } = await import('@capacitor/app');
    App.addListener('backButton', () => {
      const b = document.body;
      if (b.classList.contains('drawer-open')) return document.querySelector('.drawer-scrim')?.click();
      if (b.classList.contains('side-open')) return document.getElementById('btn-side-back')?.click();
      App.minimizeApp();
    });
  } catch { /* 没有 App 插件 */ }
  // 状态栏 / 手势条的图标颜色跟随明暗：浅色界面用深色图标，深色界面用浅色图标
  try {
    const { SystemBars } = await import('@capacitor/core');
    const apply = () => SystemBars?.setStyle?.({ style: document.documentElement.dataset.theme === 'dark' ? 'DARK' : 'LIGHT' }).catch(() => {});
    apply();
    new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch { /* 旧版 Capacitor 没有 SystemBars */ }
  // 下载：WebView 里网页下载不起作用。存到“文档/Jarvis”，再弹出系统分享（用 WPS、微信等打开或发送）
  globalThis.__jarvisSaveFile = async (blob, name) => {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    let where = '';
    try {
      await Filesystem.writeFile({ path: `Jarvis/${name}`, data, directory: Directory.Documents, recursive: true });
      where = `已保存到手机“文档/Jarvis/${name}”`;
    } catch { where = ''; }
    // 分享面板需要 App 自己目录里的文件
    const { uri } = await Filesystem.writeFile({ path: `share/${name}`, data, directory: Directory.Cache, recursive: true });
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: name, files: [uri], dialogTitle: '打开或发送' });
    } catch { /* 用户取消分享 */ }
    return where || `已准备好 ${name}（可在分享面板里选择保存位置）`;
  };
  document.documentElement.classList.add('mobile-app');
}

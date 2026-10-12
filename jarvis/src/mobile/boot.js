/**
 * 安卓 App 启动时的适配（在 main.js 的其他代码之前运行；其他版本里什么都不做）：
 *   网络：服务商不允许跨域时改走系统原生网络
 *   朗读：WebView 没有 speechSynthesis，用系统 TTS 补上
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
    const { TextToSpeech } = await import('@capacitor-community/text-to-speech');
    installSpeechShim(TextToSpeech);
  } catch { /* 没有朗读插件：只显示文字 */ }
  document.documentElement.classList.add('mobile-app');
}

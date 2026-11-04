import { privateStorage } from '../core/userStorage.js';
/**
 * 前端各模块共用的运行环境和小工具（这里不放会变的状态）：
 * 取页面元素、当前时间、是不是手机 / 桌面版、本机存储、提示条、通知桌面背景、崩溃前操作记录。
 */
import { MOBILE } from '../config.js';

export const $ = (s) => document.querySelector(s);
export const body = document.body;
export const now = () => performance.now();
/** 桌面版（Electron）由 preload 注入；网页版为 undefined */
export const DESKTOP = window.jarvisDesktop;
/** 手机 App：不放大舞台（不跑 WebGL 和舞台动画，省电、不卡），粒子缩成顶栏小球，工作进展进对话 */
export const COMPACT = MOBILE;
export const storage = (() => {
  try {
    return privateStorage(localStorage);
  } catch {
    return null;
  }
})();
/** 窄屏（手机、窄窗口） */
export const narrow = matchMedia('(max-width: 860px)');

// ---------------------------------------------------------------- 设备分级
export const lowEnd = (navigator.hardwareConcurrency || 8) <= 2 || (navigator.deviceMemory ?? 8) < 4;
export const isMobile = matchMedia('(pointer: coarse)').matches;
export const reducedMql = matchMedia('(prefers-reduced-motion: reduce)');

let toastTimer = 0;
let toastRevision = 0;
/** 底部提示条：几秒后自动消失（字多的停久一点） */
export function toast(text, action) {
  const revision = ++toastRevision;
  const el = $('#toast');
  el.textContent = text;
  if (action?.run && action.label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ghost sm toast-action';
    button.textContent = action.label;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await action.run();
        if (toastRevision === revision) toast('该设备已退出');
      } catch {
        if (toastRevision === revision) toast('退出设备未完成，请在服务器安全设置中重试');
      }
    });
    el.append(button);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      el.hidden = true;
    },
    Math.max(2600, String(text).length * 110)
  );
}

/** 桌面背景同步：主窗口在做什么，桌面上的粒子体就跟着做（桌面版开了背景模式时） */
export function wp(payload) {
  if (window.jarvisDesktop) window.jarvisDesktop.invoke('wallpaperEvent', payload).catch(() => {});
}

/** 手机：记下“正在做什么”（界面崩溃时下次打开能看到崩溃前在做什么） */
export function markActivity(what) {
  if (!MOBILE) return;
  try {
    storage?.setItem('jarvis.lastActivity', what ? `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${what}` : '');
  } catch {
    /* 存不了就算了 */
  }
}

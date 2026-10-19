/**
 * 键盘快捷键：
 *   Esc 打断   /  聚焦输入框   Alt+1..8 面板   Alt+F 专注视图   Alt+V 语音转文字   Ctrl+Shift+O 新对话
 *   按住空格：按下说话（降级模式、焦点不在输入框时）
 */
import { PANES } from './panels.js';
import { toast } from './env.js';

export function createShortcuts(app) {
  /** 注册快捷键（启动时调用） */
  function initShortcuts() {
    //   Esc 打断   /  聚焦输入框   Alt+1..6 面板   Alt+F 专注视图   Alt+V 直接对话
    //   Alt+O / Alt+H / Alt+W 光核 / 胸像 / 线框   按住空格：按下说话（降级模式、焦点不在输入框时）
    const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (app.interrupt()) {
          e.preventDefault();
          toast('已打断');
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyO') {
        e.preventDefault();
        app.newSession();
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const k = e.code;
        const n = /^Digit([1-8])$/.exec(k)?.[1];
        if (n) app.showPanel(PANES[n - 1]);
        else if (k === 'KeyF') app.setFocusView(!app.settings.focusView);
        else if (k === 'KeyV' && !app.mic.hidden) app.toggleDictation();
        else return;
        e.preventDefault();
        return;
      }
      if (typing(document.activeElement)) return;
      if (e.key === '/') {
        e.preventDefault();
        app.prompt.focus();
      } else if (e.code === 'Space' && app.voice.mode === 'ptt' && !e.repeat) {
        e.preventDefault();
        app.mic.classList.add('ptt-active');
        app.voice.pttStart();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && app.voice.mode === 'ptt' && app.mic.classList.contains('ptt-active')) {
        app.mic.classList.remove('ptt-active');
        app.voice.pttEnd();
      }
    });
  }

  return { initShortcuts };
}

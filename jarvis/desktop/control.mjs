/**
 * 看屏幕 → 操作鼠标键盘（“电脑操作”模式）：
 *   - 截屏时先把未央窗口藏起来，模型看到的就是用户的桌面
 *   - 模型给出的坐标以它看到的截图为准，这里按比例换算成屏幕坐标
 *   - 紧急停止：把鼠标甩到屏幕左上角，或按 Ctrl+Alt+Q（macOS：Cmd+Option+Q）
 *   - 输入文字走剪贴板粘贴，用完恢复用户原来的剪贴板
 */
import { createInput, pasteCombo } from './input.mjs';

export const STOP_HOTKEY = 'CommandOrControl+Alt+Q';
const MAX_W = 1440;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 截图坐标 → 屏幕坐标（Windows / Linux 为物理像素，macOS 为点） */
export function toScreen({ x, y, imgW, imgH }, display, platform, dipToScreenPoint = null) {
  if (!(imgW > 0 && imgH > 0)) throw new Error('缺少截图尺寸：请先截屏（computer_look）再操作');
  if (!(x >= 0 && y >= 0 && x <= imgW && y <= imgH)) throw new Error(`坐标 (${x}, ${y}) 超出截图范围 ${imgW}×${imgH}`);
  const b = display.bounds;
  const dip = { x: Math.round(b.x + (x / imgW) * b.width), y: Math.round(b.y + (y / imgH) * b.height) };
  if (platform === 'darwin') return dip;
  if (platform === 'win32' && dipToScreenPoint) return dipToScreenPoint(dip);
  return { x: Math.round(dip.x * display.scaleFactor), y: Math.round(dip.y * display.scaleFactor) };
}

/**
 * @param {object} d
 * @param {object} d.screen          electron.screen
 * @param {object} d.desktopCapturer
 * @param {object} d.clipboard
 * @param {() => object|null} d.getWin
 * @param {object} [d.systemPreferences]
 * @param {object} [d.input]         createInput() 的结果（测试可替换）
 * @param {string} [d.platform]
 */
export function createControl(d) {
  const platform = d.platform ?? process.platform;
  const input = d.input ?? createInput({ platform });
  let hidden = false;
  let stopped = false;
  let lastActionAt = 0;
  let lastPoint = null; // 上一个动作把鼠标放到的位置（自己点左上角时不算紧急停止）

  function checkPermission() {
    if (platform === 'darwin' && d.systemPreferences && !d.systemPreferences.isTrustedAccessibilityClient(false)) {
      d.systemPreferences.isTrustedAccessibilityClient(true); // 弹出系统授权提示
      throw new Error('需要授权：请在“系统设置 → 隐私与安全性 → 辅助功能”里打开“未央”，然后再试');
    }
  }

  /** 用户把鼠标甩到左上角 = 紧急停止 */
  function checkFailsafe() {
    if (stopped) throw new Error('用户已紧急停止电脑操作');
    const p = d.screen.getCursorScreenPoint();
    const b = d.screen.getPrimaryDisplay().bounds;
    const corner = (q) => q && q.x <= b.x + 2 && q.y <= b.y + 2;
    if (lastActionAt && corner(p) && !corner(lastPoint)) {
      stopped = true;
      throw new Error('用户把鼠标移到了屏幕左上角：已紧急停止电脑操作');
    }
  }

  async function hideSelf() {
    const w = d.getWin();
    if (w && w.isVisible() && !w.isMinimized()) {
      hidden = true;
      if (platform === 'darwin') w.hide(); else w.minimize();
      await sleep(350); // 等窗口动画结束
    }
  }

  return {
    /** 开始一次操作（每轮对话第一次截屏时）：清除上次的停止状态 */
    begin() { stopped = false; lastActionAt = 0; lastPoint = null; },

    async look() {
      checkPermission();
      if (stopped) throw new Error('用户已紧急停止电脑操作');
      await hideSelf();
      const disp = d.screen.getPrimaryDisplay();
      const w = Math.min(MAX_W, disp.size.width);
      const size = { width: w, height: Math.round(w * disp.size.height / disp.size.width) };
      const [src] = await d.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
      if (!src) throw new Error('无法截屏（macOS 需要在“系统设置 → 隐私与安全性 → 屏幕录制”里允许未央）');
      const img = src.thumbnail;
      const cur = d.screen.getCursorScreenPoint();
      const sz = img.getSize();
      return {
        base64: img.toPNG().toString('base64'), width: sz.width, height: sz.height,
        cursor: { x: Math.round((cur.x - disp.bounds.x) * sz.width / disp.bounds.width), y: Math.round((cur.y - disp.bounds.y) * sz.height / disp.bounds.height) }
      };
    },

    /**
     * @param {{ type: 'click'|'move'|'drag'|'scroll'|'key'|'type', x?, y?, toX?, toY?, imgW?, imgH?, button?, count?, direction?, amount?, keys?, text? }} a
     */
    async act(a) {
      checkPermission();
      checkFailsafe();
      await hideSelf();
      const disp = d.screen.getPrimaryDisplay();
      const map = (x, y) => toScreen({ x, y, imgW: a.imgW, imgH: a.imgH }, disp, platform, platform === 'win32' ? d.screen.dipToScreenPoint?.bind(d.screen) : null);
      if (a.type === 'type') {
        const text = String(a.text ?? '');
        if (!text) throw new Error('没有要输入的文字');
        const old = d.clipboard.readText();
        d.clipboard.writeText(text);
        await sleep(60);
        await input.run({ type: 'key', keys: pasteCombo(platform) });
        await sleep(250);
        d.clipboard.writeText(old);
        if (a.enter) await input.run({ type: 'key', keys: 'enter' });
      } else if (a.type === 'key') {
        await input.run({ type: 'key', keys: a.keys });
      } else {
        const p = map(a.x, a.y);
        const to = a.type === 'drag' ? map(a.toX, a.toY) : {};
        await input.run({ ...a, x: p.x, y: p.y, toX: to.x, toY: to.y });
        lastPoint = d.screen.getCursorScreenPoint();
      }
      lastActionAt = Date.now();
      await sleep(a.type === 'type' || a.type === 'key' ? 300 : 450); // 等界面反应过来再截下一张
      return { ok: true };
    },

    /** 一轮对话结束：把未央窗口放回来 */
    end() {
      const w = d.getWin();
      if (hidden && w) { w.show(); w.focus(); }
      hidden = false;
    },

    /** 紧急停止热键 */
    stop() { stopped = true; },
    close() { input.close(); }
  };
}

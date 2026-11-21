/**
 * 安卓返回键 / 侧滑返回（2026-11-18 用户：手指滑动是返回，现在直接退出了；检查所有页面）。
 *
 * 规则：永远先关“最上面的那一层”，一层一层往回退，回到对话首页后才考虑退到后台；
 * 首页再按一次返回只提示“再滑一次退到后台”，2 秒内再滑才真的退到后台（防误触）。
 * 从上到下的层级：
 *   1. 弹窗（任何打开的 <dialog>：图片预览、天气、全息、能力表、媒体、代码项目、本地模型选项……）
 *   2. 底部选择面板、菜单、命令面板（模型选择、模型库、排队菜单、斜杠菜单、命令面板）
 *   3. 全屏子页（智能体编辑器、PPT 模板库、智能体广场）
 *   4. 面板里的子视图（文件预览、技能详情）——回到面板的列表
 *   5. 工作台菜单/信息栏、抽屉菜单、侧边面板（设置、文件空间、对话列表等）——回到对话
 *   6. 对话首页：第一次提示，2 秒内第二次才退到后台
 * 返回值是这次做了什么，供测试核对。
 */
import { closeAgentOverlay } from '../ui/agentNavigation.js';

const visible = (doc, selector) => [...doc.querySelectorAll(selector)].find(el => !el.hidden && !el.closest('[hidden]'));
const escape = doc => doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

export function createBackNavigation({ doc = document, win = window, minimize, toast, now = () => Date.now() } = {}) {
  let armedAt = -Infinity;
  return function handleBack() {
    const body = doc.body;
    // 1. 弹窗：最后打开的在最上面
    const dialogs = [...doc.querySelectorAll('dialog[open]')];
    if (dialogs.length) {
      // 工作台本身是普通页面，它的 DOM 可能晚于已创建的预览弹窗。
      const top = dialogs.filter(dialog => dialog.id !== 'mobile-work-studio').at(-1) || dialogs.at(-1);
      const cancel = new Event('cancel', { cancelable: true });
      top.dispatchEvent(cancel);
      if (!cancel.defaultPrevented && top.open) top.close();
      return 'dialog';
    }
    // 2. 底部选择面板与菜单
    const pickerClose = visible(doc, '.mp-sheet .x-btn');
    if (pickerClose) { pickerClose.click(); return 'sheet'; }
    if (body.classList.contains('ml-modal-open') || visible(doc, '.composer-queue-menu') || visible(doc, '.palette-overlay') || visible(doc, '.slash-menu') || visible(doc, '.quick-menu')) {
      escape(doc);
      return 'menu';
    }
    // 3. 全屏子页
    if (closeAgentOverlay(doc)) return 'overlay';
    // 4. 面板里的子视图：先回到列表，不直接关整个面板
    const viewer = doc.getElementById('viewer');
    if (viewer && !viewer.hidden && !viewer.closest('[hidden]')) {
      viewer.hidden = true;
      const content = doc.getElementById('viewer-body');
      if (content) content.replaceChildren();
      return 'viewer';
    }
    const skill = doc.getElementById('skill-viewer');
    if (skill && !skill.hidden && !skill.closest('[hidden]')) { skill.hidden = true; return 'subview'; }
    // 5. 工作台菜单、抽屉、侧边面板：回到对话
    if (body.classList.contains('workbench') && (body.classList.contains('weiyang-menu-open') || !body.classList.contains('side-closed') || body.classList.contains('wb-info-open'))) {
      win.dispatchEvent(new Event('weiyang:back'));
      return 'workbench';
    }
    if (body.classList.contains('drawer-open')) { doc.querySelector('.drawer-scrim')?.click(); return 'drawer'; }
    if (body.classList.contains('side-open')) { doc.getElementById('btn-side-back')?.click(); return 'panel'; }
    // 6. 首页：二次确认
    if (now() - armedAt < 2000) { armedAt = -Infinity; minimize?.(); return 'minimize'; }
    armedAt = now();
    toast?.('再滑一次退到后台');
    return 'confirm';
  };
}

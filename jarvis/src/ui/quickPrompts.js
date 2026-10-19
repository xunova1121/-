/**
 * 常用指令：输入框旁边的闪电按钮，点开选一条，把开头写好放进输入框，接着补充内容再发。
 * 图标来自 Lucide（ISC 许可，https://lucide.dev）。
 */
export const QUICK_PROMPTS = [
  ['写周报', '帮我写一份本周工作周报（Word），本周做了：'],
  ['做 PPT', '帮我做一份汇报 PPT，主题是：'],
  ['写文档', '帮我写一份 Word 文档，内容是：'],
  ['做表格', '帮我做一个 Excel 表格，要有这些列：'],
  ['写邮件', '帮我写一封工作邮件，要点是：'],
  ['润色', '帮我润色下面这段文字，保持原意，更通顺：\n'],
  ['翻译成英文', '把下面这段翻译成英文：\n'],
  ['查资料', '帮我查一下最新的情况，注明出处：'],
  ['总结这段对话', '把我们这段对话总结成要点和待办事项']
];

/**
 * @param {{ button: HTMLElement, onPick: (text: string) => void }} o
 */
export function initQuickPrompts({ button, onPick }) {
  if (!button) return;
  let menu = null;
  const close = () => { menu?.remove(); menu = null; document.removeEventListener('pointerdown', outside, true); };
  const outside = (e) => { if (menu && !menu.contains(e.target) && !button.contains(e.target)) close(); };
  button.addEventListener('click', () => {
    if (menu) { close(); return; }
    menu = Object.assign(document.createElement('div'), { className: 'quick-menu', role: 'menu' });
    for (const [label, text] of QUICK_PROMPTS) {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label, role: 'menuitem' });
      b.addEventListener('click', () => { close(); onPick(text); });
      menu.append(b);
    }
    button.closest('form, .composer, body').append(menu);
    document.addEventListener('pointerdown', outside, true);
  });
}

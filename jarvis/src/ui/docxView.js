/**
 * Word 文档按真实样式预览：字体、字号、颜色、表格、图片、页眉页脚、分页都和 Word 里一致（docx-preview 排版）。
 * 渲染在 Shadow DOM 里，文档自带的样式不会影响界面，界面的样式也不会改动文档；手机上按屏幕宽度整页缩放，双击看原始大小。
 */
const PAGE_CSS = `
  :host { display: block; }
  .docx-wrapper { background: #e7e9ef !important; padding: 16px !important; }
  .docx-wrapper > section.docx { box-shadow: 0 2px 10px rgba(30, 35, 60, .18) !important; margin-bottom: 16px !important; }
`;

/**
 * @param {Blob} blob .docx 文件
 * @param {HTMLElement} host 放预览的容器
 */
export async function renderDocx(blob, host) {
  const { renderAsync } = await import('docx-preview');
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  const styles = document.createElement('div');
  const pages = document.createElement('div');
  const own = document.createElement('style');
  own.textContent = PAGE_CSS;
  root.replaceChildren(own, styles, pages);
  await renderAsync(await blob.arrayBuffer(), pages, styles, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    useBase64URL: true, // 图片直接内嵌，不用管理临时地址
    experimental: true // 制表位等
  });
  // 手机上整页缩小后字小：双击在“适合宽度”和“原始大小”（在预览框里左右滑动）之间切换
  let actual = false;
  const refit = () => (actual ? (pages.querySelector('.docx-wrapper').style.zoom = '') : fit(host, pages));
  host.addEventListener('dblclick', () => { actual = !actual; refit(); });
  fit(host, pages);
  return { fit: refit };
}

/** 页面比容器宽（手机）：整体缩小到正好放下，不出现横向滚动 */
function fit(host, pages) {
  const wrapper = pages.querySelector('.docx-wrapper');
  if (!wrapper) return;
  wrapper.style.zoom = '';
  const widest = Math.max(0, ...[...wrapper.querySelectorAll(':scope > section')].map((x) => x.offsetWidth));
  const need = widest + 32; // 两边各 16px 留白
  const have = host.clientWidth;
  if (need > have && have > 0) wrapper.style.zoom = String(Math.max(0.3, have / need));
}

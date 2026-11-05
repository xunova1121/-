/** 可编辑 PPTX 样板与原有“生成方案”分开：原生文件 + 真实渲染 + 许可随包。 */
import catalog from '../assets/ppt-sources/catalog.json';
import license from '../assets/ppt-sources/LICENSE.txt?raw';
import './pptSourceGallery.css';
const files = import.meta.glob('../assets/ppt-sources/*.pptx', { eager: true, query: '?url', import: 'default' });
const images = import.meta.glob('../assets/ppt-sources/*.jpg', { eager: true, query: '?url', import: 'default' });
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
export const pptSourceUrl = id => files[`../assets/ppt-sources/${id}.pptx`];
export function pptSourceGallery({ onImport }) {
  const root = el('section', { className: 'wy-ppt-sources', ariaLabel: '精选可编辑样板' });
  const grid = el('div', { className: 'wy-ppt-source-grid' });
  const message = el('p', { className: 'wy-ppt-source-status', role: 'status', ariaLive: 'polite' });
  let busy = false;
  for (const tpl of catalog) {
    const details = el('details', { className: 'wy-ppt-source-detail' });
    const img = (n) => el('img', { src: images[`../assets/ppt-sources/${tpl.id}-${n}.jpg`], alt: `${tpl.name} 第 ${n} 页实际渲染`, loading: 'lazy' });
    const use = el('button', { type: 'button', className: 'wy-ppt-source-use', textContent: '导入到工作区' });
    use.dataset.sourceId = tpl.id;
    use.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      root.querySelectorAll('.wy-ppt-source-use').forEach(b => { b.disabled = true; });
      message.textContent = '正在导入样板…';
      try {
        await onImport(tpl, pptSourceUrl(tpl.id));
        message.textContent = '已导入工作区。回到对话，补充要求后发送。';
      } catch (e) { message.textContent = e?.message || '导入未完成，请重试。'; }
      finally { busy = false; root.querySelectorAll('.wy-ppt-source-use').forEach(b => { b.disabled = false; }); }
    });
    const source = tpl.license === 'MIT'
      ? el('a', { href: tpl.source, target: '_blank', rel: 'noopener noreferrer', textContent: '开源版式出处 · MIT' })
      : el('p', { textContent: tpl.source });
    details.append(el('summary', {}, img(1), el('b', { textContent: tpl.name }), el('small', { textContent: `${tpl.pages} 页 · 原生文字与图形可编辑` })),
      el('div', { className: 'wy-ppt-source-slides' }, ...Array.from({ length: tpl.pages - 1 }, (_, i) => i + 2).map(img)),
      el('p', { textContent: '未央适配的示例样板。导入后可修改文字与内容；不是生成后的成品。' }), source, use);
    grid.append(details);
  }
  const rights = el('details', { className: 'wy-ppt-source-license' }, el('summary', { textContent: '版式来源与 MIT 授权' }), el('pre', { textContent: license }));
  root.append(el('h3', { textContent: '精选可编辑样板' }), el('p', { textContent: '先看看实际效果，再把喜欢的样板带进工作区。' }), grid, message, rights);
  return root;
}

import { studioNode as el, studioButton as button } from './studioHub.js';

/** 有界内存预览；云端Office使用真实PDF，本地结构预览明确标注，不伪装最终版式。 */
export function createStudioPreview(host) {
  const controller = new AbortController();
  const urls = [];
  let pdfDocument = null,
    loading = null,
    rendering = null;
  const check = () => controller.signal.throwIfAborted();
  function zoomControl() {
    const toggle = button('放大查看', () => {
      const zoomed = host.classList.toggle('is-zoomed');
      toggle.textContent = zoomed ? '适合宽度' : '放大查看';
    });
    host.append(toggle);
  }
  return {
    signal: controller.signal,
    close() {
      controller.abort();
      rendering?.cancel();
      if (pdfDocument) void pdfDocument.destroy().catch(() => {});
      else if (loading) void loading.destroy().catch(() => {});
      urls.forEach((url) => URL.revokeObjectURL(url));
      host.replaceChildren();
    },
    async show({ blob, format, rendered }) {
      check();
      host.replaceChildren();
      if (/^(png|jpe?g|webp|svg)$/.test(format)) {
        zoomControl();
        const url = URL.createObjectURL(blob);
        urls.push(url);
        host.append(el('img', { src: url, alt: '作品预览' }));
      } else if (format === 'pdf') {
        zoomControl();
        host.append(el('p', { textContent: rendered ? '服务器Office真实渲染 · 最多预览前20页' : 'PDF原件预览 · 最多显示前20页' }));
        const { loadPdfjs } = await import('../agent/docs.js');
        const pdfjs = await loadPdfjs();
        check();
        const data = new Uint8Array(await blob.arrayBuffer());
        check();
        loading = pdfjs.getDocument({ data });
        pdfDocument = await loading.promise;
        check();
        for (let n = 1; n <= Math.min(pdfDocument.numPages, 20); n++) {
          const page = await pdfDocument.getPage(n);
          check();
          const original = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, 1200 / original.width, 1600 / original.height) });
          const canvas = el('canvas', { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), ariaLabel: '第' + n + '页' });
          host.append(el('p', { textContent: `第${n}/${pdfDocument.numPages}页` }), canvas);
          rendering = page.render({ canvasContext: canvas.getContext('2d'), viewport });
          await rendering.promise;
          check();
          page.cleanup();
        }
      } else if (format === 'docx') {
        host.append(el('p', { textContent: '浏览器Word预览；最终分页请下载后用Office或WPS核对' }));
        const content = el('div');
        host.append(content);
        const { renderDocx } = await import('./docxView.js');
        check();
        const view = await renderDocx(blob, content);
        check();
        view?.fit?.();
      } else if (['pptx', 'xlsx'].includes(format)) {
        host.append(el('p', { textContent: '本地内容预览，非最终版式；下载后用Office/WPS查看，或连接服务器使用真实渲染。' }));
        const { inspectEditableDocument } = await import('../agent/structuredDocumentEdit.js');
        const result = await inspectEditableDocument(blob, format, { limit: 100 });
        check();
        host.append(
          ...result.objects.map((o) => el('p', { textContent: `${o.page ? '第' + o.page + '页' : o.sheet || ''} ${o.text || o.range || o.kind || ''}` }))
        );
      } else {
        const text = await blob.slice(0, 40000).text();
        check();
        host.append(el('pre', { textContent: text }));
      }
    }
  };
}

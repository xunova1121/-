import { loadPdfjs } from './docs.js';
import { documentError } from './documentPlan.js';

/** 真实PDF逐页结构检查；文字边界只是可疑项，不能冒充视觉模型审稿。 */
export async function inspectRenderedPdf(blob, { signal } = {}) {
  if (blob.size > 30e6) throw documentError('PDF超过30MB检查上限', 'DOCUMENT_SIZE');
  signal?.throwIfAborted();
  const pdfjs = await loadPdfjs();
  const loading = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
  const abort = () => { void loading.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const pdfDocument = await loading.promise;
    if (pdfDocument.numPages > 120) throw documentError('PDF超过120页检查上限', 'DOCUMENT_SIZE');
    const issues = [];
    for (let index = 1; index <= pdfDocument.numPages; index++) {
      signal?.throwIfAborted();
      const page = await pdfDocument.getPage(index);
      const content = await page.getTextContent();
      if (content.items.length > 10000) throw documentError('PDF单页内容过多', 'DOCUMENT_SIZE');
      const text = content.items.filter(item => typeof item.str === 'string' && item.str.trim());
      if (!text.length && issues.length < 20) issues.push({ level: 'warn', text: `真实PDF第${index}页无可提取文字，可能是图片页或空白页，需核对` });
      const [left, bottom, right, top] = page.view;
      const outside = text.some(item => {
        const [a, b, c, d, x, y] = item.transform;
        if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a < 0 || d < 0) return false;
        return x < left - 3 || x + item.width > right + 3 || y < bottom - 3 || y > top + 3;
      });
      if (outside && issues.length < 20) issues.push({ level: 'warn', text: `真实PDF第${index}页有文字接近或越过页面边界，需打开预览核对` });
      page.cleanup();
    }
    return { state: 'pdf_pages_checked_not_visual_reviewed', pages: pdfDocument.numPages, issues };
  } finally {
    signal?.removeEventListener('abort', abort);
    await loading.destroy();
    signal?.throwIfAborted();
  }
}

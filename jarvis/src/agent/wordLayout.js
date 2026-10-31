import { applyDocxTypography } from './docxTypography.js';
import { inspectRenderedPdf } from './pdfQuality.js';
import { requestedWordPages, checkWordPages } from './wordPageBudget.js';
import { throwControl } from '../core/networkRequest.js';

const distance = (budget, pages) => pages < budget.min ? budget.min - pages : budget.max !== null && pages > budget.max ? pages - budget.max : 0;
/** 最多初次加3次真实渲染；只改未锁定的正文行/段距，不改正文、字号、页边距、封面或插空白页。 */
export async function coordinateWordLayout(ctx, out, requirements, { signal, progress } = {}) {
  const budget = requestedWordPages(requirements, { wordContext: true });
  if (out.ext !== 'docx' || !out.info?.typographyProfile || !budget || !ctx.officeRender) return out;
  let renders = 0;
  const render = async candidate => {
    signal?.throwIfAborted();
    renders++;
    const rendered = await ctx.officeRender(candidate.blob, 'docx', { signal });
    signal?.throwIfAborted();
    const checked = rendered.available && rendered.blob ? await inspectRenderedPdf(rendered.blob, { signal }) : null;
    return { out: candidate, rendered, checked };
  };
  let best;
  try { best = await render(out); }
  catch (error) { throwControl(error, signal); return { ...out, wordLayout: { state: 'not_checked', renders, note: '真实分页协调未完成：' + String(error.message).slice(0, 160) } }; }
  const originalPages = best.checked?.pages;
  // 空白/图像页或可疑越界不能靠段距推断；不以假PDF或缺失字体效果推测分页已修好。
  const eligible = best.checked && !best.checked.issues.length && distance(budget, originalPages) > 0;
  const locked = out.info.typographyProfile.body || {};
  const compact = budget.max !== null && originalPages > budget.max;
  const choices = compact ? [[1.25, 4], [1.1, 2], [1, 0]] : [[1.75, 8], [2, 12], [2.5, 18]];
  if (eligible && (!locked.line || locked.after === undefined || locked.before === undefined)) {
    for (const [line, after] of choices) {
      signal?.throwIfAborted();
      progress?.('按真实PDF协调分页（' + renders + '/3），保留正文和指定字号…');
      const rule = { ...locked, ...(!locked.line && { line: { rule: 'auto', value: line } }), ...(locked.after === undefined && { after }), ...(locked.before === undefined && { before: 0 }) };
      const patched = await applyDocxTypography(out.blob, { body: rule }, { signal });
      if (!patched.changed) break;
      try {
        const candidate = await render({ ...out, blob: patched.blob });
        if (!candidate.checked || candidate.checked.issues.length) continue;
        if (distance(budget, candidate.checked.pages) < distance(budget, best.checked.pages)) best = candidate;
        if (checkWordPages(budget, best.checked.pages).state === 'passed') break;
      } catch (error) { throwControl(error, signal); break; }
    }
  }
  return { ...best.out, wordPreview: best.rendered, wordLayout: {
    state: !best.checked ? 'not_checked' : distance(budget, best.checked.pages) === 0 ? 'passed' : 'conflict',
    renders, originalPages: originalPages ?? null, actualPages: best.checked?.pages ?? null,
    note: best.checked && distance(budget, best.checked.pages) > 0 ? '分页与当前内容/明确样式约束仍有冲突；未删正文、改指定字号或插空白页' : '仅用真实PDF核对分页；正文和指定字体字号保持'
  } };
}

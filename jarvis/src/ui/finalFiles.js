/**
 * 回答末尾只摆最终版（用户 2026-11-02：“一下子产出那么多，哪个才是最终版……多的文档可以隐藏下拉，只给我最终版就行”）。
 * 规则：有正式文档（PPT/Word/Excel/PDF 等）时，每种格式只留最后一份作最终版；
 * 预览 PDF、页面总览图、检查报告、做文档时顺带生成的配图、同格式的旧版本都收进“其他文件”。没有正式文档（只出图 / 歌）时全部照常列出。
 */
const DOC = /\.(pptx|docx|xlsx|pdf|md|html|csv|txt)$/i;
const AUX = /\.预览\.pdf$|\.总览-\d+\.png$|检查报告|\.review\.|\.preview\./i;
export function pickFinalFiles(paths = []) {
  const docs = paths.filter((p) => DOC.test(p) && !AUX.test(p));
  if (!docs.length) return { final: [...paths], extra: [] };
  const latest = new Map();
  for (const p of docs) latest.set(p.match(DOC)[1].toLowerCase(), p);
  const final = paths.filter((p) => [...latest.values()].includes(p));
  return { final, extra: paths.filter((p) => !final.includes(p)) };
}
/** 把文件按钮区里的非最终版收进可展开的“其他文件（n）” */
export function foldExtraFiles(box) {
  if (!box || box.querySelector(':scope > .file-more')) return;
  const buttons = [...box.querySelectorAll(':scope > .file-link')];
  const { extra } = pickFinalFiles(buttons.map((b) => b.dataset.path));
  if (!extra.length) return;
  const more = document.createElement('details');
  more.className = 'file-more';
  more.append(Object.assign(document.createElement('summary'), { textContent: `其他文件（${extra.length}）：预览、配图、过程稿` }));
  for (const b of buttons) if (extra.includes(b.dataset.path)) more.append(b);
  box.append(more);
}

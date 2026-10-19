/**
 * 按片段修改文本：给出原文里的一段和替换内容，只改那一段，不用整个文件重写。
 * 原文片段必须一字不差地出现；出现多次时要么给更长的片段，要么明确 replace_all。
 * Windows 换行（\r\n）的文件也能按 \n 写的片段匹配，改完保持原来的换行。
 */

/**
 * @param {string} text  文件原文
 * @param {Array<{ old_text: string, new_text: string, replace_all?: boolean }>} edits
 * @returns {{ text: string, count: number }}
 */
export function applyEdits(text, edits) {
  const crlf = /\r\n/.test(text);
  let t = crlf ? text.replace(/\r\n/g, '\n') : text;
  let count = 0;
  for (const [i, e] of edits.entries()) {
    const label = edits.length > 1 ? `第 ${i + 1} 处修改：` : '';
    const oldText = String(e.old_text ?? '').replace(/\r\n/g, '\n');
    const newText = String(e.new_text ?? '').replace(/\r\n/g, '\n');
    if (!oldText) throw new Error(`${label}old_text 不能为空（要在文件末尾追加，请把最后几行作为 old_text）`);
    if (oldText === newText) throw new Error(`${label}old_text 和 new_text 一样，没有要改的`);
    const n = t.split(oldText).length - 1;
    if (n === 0) throw new Error(`${label}${notFound(t, oldText)}`);
    if (n > 1 && !e.replace_all) throw new Error(`${label}这段原文在文件里出现了 ${n} 次，请多带几行上下文让它唯一，或设 replace_all: true 全部替换`);
    t = e.replace_all ? t.split(oldText).join(newText) : t.replace(oldText, () => newText);
    count += e.replace_all ? n : 1;
  }
  return { text: crlf ? t.replace(/\n/g, '\r\n') : t, count };
}

/** 找不到时给提示：可能是空格 / 缩进不一致，指出最像的一行 */
function notFound(t, oldText) {
  const first = oldText.split('\n').find((l) => l.trim())?.trim() ?? '';
  const squeeze = (s) => s.replace(/\s+/g, '');
  const hit = first && t.split('\n').findIndex((l) => squeeze(l).includes(squeeze(first)));
  if (hit >= 0 && first) return `没有找到这段原文（第 ${hit + 1} 行内容相近，可能是空格或缩进不一样）。先用 read_file 看准原文再改`;
  return '没有找到这段原文，先用 read_file 看准原文再改（必须一字不差，包括空格和标点）';
}

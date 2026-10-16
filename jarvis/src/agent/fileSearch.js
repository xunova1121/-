/**
 * 工作区里找文件、搜内容（find_files / search_in_files 用）。
 * 先定位再读，比把所有文件列出来、一个个读省事得多。
 */

/** 通配符转正则：** 跨目录，* 不跨目录，? 一个字符 */
export function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++; if (pattern[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * @param {Array<{ path: string }>} files
 * @param {string} pattern  通配符（带 * ?）按完整路径或文件名匹配；不带就当关键词，文件名里包含就算
 */
export function matchFiles(files, pattern) {
  const p = String(pattern || '').trim().replace(/^\.?\//, '');
  if (!p) return [];
  if (/[*?]/.test(p)) {
    const re = globToRegex(p);
    return files.filter((f) => re.test(f.path) || (!p.includes('/') && re.test(f.path.split('/').pop())));
  }
  const words = p.toLowerCase().split(/\s+/).filter(Boolean);
  return files.filter((f) => words.every((w) => f.path.toLowerCase().includes(w)));
}

/**
 * 逐行搜：返回行号（从 1 开始）和那一行（太长就截在命中位置附近）
 * @returns {Array<{ line: number, text: string }>}
 */
export function searchLines(text, query, { regex = false } = {}) {
  let test;
  if (regex) {
    let re;
    try { re = new RegExp(query, 'i'); } catch (e) { throw new Error(`正则写错了：${e.message}`); }
    test = (l) => { const m = re.exec(l); return m ? m.index : -1; };
  } else {
    const q = String(query).toLowerCase();
    if (!q) return [];
    test = (l) => l.toLowerCase().indexOf(q);
  }
  const out = [];
  String(text).split(/\r?\n/).forEach((l, i) => {
    const at = test(l);
    if (at < 0) return;
    const start = Math.max(0, at - 60);
    out.push({ line: i + 1, text: `${start ? '…' : ''}${l.slice(start, start + 200).trim()}${l.length > start + 200 ? '…' : ''}` });
  });
  return out;
}

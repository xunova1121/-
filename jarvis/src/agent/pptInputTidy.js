/**
 * PPT 输入整理。表格整理成能画图的样子（用户 2026-11-05：“里程十强”表写成两半并排——排名|城市|里程|排名|城市|里程，
 * 画出来横轴是 1、2、3、4、5，城市名全丢，右边说明成了“排名：1 6，2 7……”，看不懂）。
 *   1. 表头左右两半重复（同一组列并排两次）：拆开上下接成一张长表
 *   2. 第一列是排名 / 序号、后面有文字列（城市、企业）：把文字列挪到第一列当横轴，排名列不当数据画
 */
const plain = (cells = []) => cells.map(run => run.text ?? '').join('').trim();
export const RANK_HEADER = /^(?:排名|排序|名次|序号|编号|位次|No\.?|#)$/i;

/** 表头左右两半一样：拆成上下接起来 */
function unfoldHalves(table) {
  const n = table.header.length;
  if (n < 4 || n % 2) return table;
  const half = n / 2, names = table.header.map(plain);
  if (!names.slice(0, half).every((h, i) => h && h === names[half + i])) return table;
  const right = table.rows.map(r => r.slice(half)).filter(r => r.some(c => plain(c)));
  return { ...table, header: table.header.slice(0, half), align: (table.align || []).slice(0, half), rows: [...table.rows.map(r => r.slice(0, half)), ...right] };
}

/** 第一列是排名、第二列是名称：两列对调 */
function nameFirst(table) {
  // 只认真正的名次（排名 / 名次 / 位次，值是整数）；“编号 赛事01”这类是记录的主键，列序不动
  if (table.header.length < 3 || !/^(?:排名|名次|位次)$/.test(plain(table.header[0])) || !table.rows.every(r => /^\d{1,3}$/.test(plain(r[0])))) return table;
  const k = table.header.findIndex((h, i) => i > 0 && table.rows.every(r => /[一-鿿A-Za-z]/.test(plain(r[i])) && !/^\s*[-+]?\d/.test(plain(r[i]))));
  if (k < 0) return table;
  const swap = (row) => { const out = [...row]; [out[0], out[k]] = [out[k], out[0]]; return out; };
  return { ...table, header: swap(table.header), align: swap(table.align || []), rows: table.rows.map(swap) };
}

export function chartFriendlyTable(table) {
  if (!table || table.type !== 'table') return table;
  return nameFirst(unfoldHalves(table));
}
/** 排名、序号这类列只是顺序，不当数据画进柱状图 */
export const rankColumn = (header) => RANK_HEADER.test(plain(header));

/**
 * 封面标题去掉文件名里的格式词（用户 2026-11-05：封面写成“全国城轨格局与南京定位_三页_政企汇报”）：
 * 下划线分开的尾巴里只是页数、风格、版本、PPT 字样的整段去掉；去完为空就保留原标题。
 */
const FORMAT_PART = /^(?:[一二三四五六七八九十\d]+页|政企汇报|汇报稿?|路演|PPT|pptx?|幻灯片|演示稿?|终稿|定稿|初稿|v\d+(?:\.\d+)*|第?\d+版|最终版?)$/i;
export function deckTitle(title = '') {
  const parts = String(title).split(/[_＿]+/).map(x => x.trim()).filter(Boolean);
  if (parts.length < 2) return String(title).trim();
  while (parts.length > 1 && FORMAT_PART.test(parts.at(-1))) parts.pop();
  return parts.join(' ');
}

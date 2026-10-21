import { openOfficePackage, xmlEscape, xmlUnescape } from './officePackage.js';
import { inspectWorkbook } from './documentQuality.js';
import { documentError } from './documentPlan.js';
import { duplicateRows } from './xlsxWriter.js';

/** 只改指定格XML，其他样式、图表和部件保持；不经ExcelJS全量重写用户模板。 */
export async function editSpreadsheet(blob, edits, { signal } = {}) {
  signal?.throwIfAborted();
  if (!Array.isArray(edits) || !edits.length || edits.length > 100) throw documentError('请提供1至100项单元格修改');
  const zip = await openOfficePackage(blob);
  const before = await inspectWorkbook(blob);
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  const relXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbookXml || !relXml) throw documentError('工作簿关系不完整', 'DOCUMENT_PACKAGE');
  const rels = new Map();
  for (const match of relXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const attr = (key) => match[0].match(new RegExp(`\\b${key}="([^"]*)"`))?.[1];
    if (attr('TargetMode') === 'External') continue;
    const target = attr('Target') || '';
    const resolved = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    if (!resolved.split('/').includes('..') && /^xl\/worksheets\/[^/]+\.xml$/.test(resolved)) rels.set(attr('Id'), resolved);
  }
  const sheets = new Map();
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*\/?\s*>/g)) {
    const sheetName = xmlUnescape(match[0].match(/\bname="([^"]*)"/)?.[1] || '');
    const relId = match[0].match(/\br:id="([^"]+)"/)?.[1];
    if (rels.has(relId)) sheets.set(sheetName, rels.get(relId));
  }
  const updated = new Map();
  const touched = new Set();
  for (const edit of edits) {
    signal?.throwIfAborted();
    const address = String(edit.cell || '').toUpperCase();
    const sheetPath = sheets.get(edit.sheet);
    if (!sheetPath || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) throw documentError('工作表或单元格地址无效', 'DOCUMENT_SCOPE');
    const key = `${edit.sheet}!${address}`;
    if (touched.has(key)) throw documentError('同一单元格不能在一批内修改两次');
    touched.add(key);
    const original = before.book.Sheets[edit.sheet]?.[address];
    if (Object.hasOwn(edit, 'expected')) {
      const actual = original?.f ? '=' + original.f : (original?.v ?? null);
      if (actual !== edit.expected) throw documentError(`${key}内容已变化，未保存本批修改`, 'DOCUMENT_CONFLICT');
    }
    let xml = updated.get(sheetPath) ?? (await zip.file(sheetPath)?.async('string'));
    if (!xml) throw documentError('找不到工作表内容', 'DOCUMENT_PACKAGE');
    const pattern = new RegExp(`<c\\b(?=[^>]*\\br="${address}")[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)`);
    const matched = xml.match(pattern);
    if (!matched) throw documentError(`${key}不是已有单元格；新增行列请重新生成或另存新表`, 'DOCUMENT_SCOPE');
    const style = matched[0].match(/\bs="(\d+)"/)?.[1];
    const attrs = ` r="${address}"${style ? ` s="${style}"` : ''}`;
    const cellXml = encodeCell(edit, attrs);
    xml = xml.replace(pattern, () => cellXml);
    updated.set(sheetPath, xml);
  }
  for (const [sheetPath, xml] of updated) zip.file(sheetPath, xml);
  // 修改输入会使其他公式缓存过期，清缓存并让Office打开时重算；不伪造计算结果。
  for (const item of zip.file(/^xl\/worksheets\/[^/]+\.xml$/)) {
    const xml = await item.async('string');
    zip.file(
      item.name,
      xml.replace(/<c\b[^>]*>[\s\S]*?<\/c>/g, (cell) => (/<f\b/.test(cell) ? cell.replace(/<v\b[^>]*>[\s\S]*?<\/v>/g, '') : cell))
    );
  }
  const calc = '<calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/>';
  zip.file(
    'xl/workbook.xml',
    /<calcPr\b/.test(workbookXml)
      ? workbookXml.replace(/<calcPr\b[^>]*(?:\/>|>[\s\S]*?<\/calcPr>)/, calc)
      : workbookXml.replace('</workbook>', calc + '</workbook>')
  );
  // 改了公式后旧依赖链不再可靠，移除链部件及其声明，让Office重新建立。
  zip.remove('xl/calcChain.xml');
  zip.file(
    'xl/_rels/workbook.xml.rels',
    relXml.replace(/<Relationship\b[^>]*\/?\s*>/g, (item) => (/\/calcChain"/.test(item) ? '' : item))
  );
  const types = await zip.file('[Content_Types].xml')?.async('string');
  if (types) zip.file('[Content_Types].xml', types.replace(/<Override\b[^>]*PartName="\/xl\/calcChain.xml"[^>]*\/?\s*>/g, ''));
  signal?.throwIfAborted();
  const result = new Blob([await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const after = await inspectWorkbook(result);
  const oldErrors = new Set(before.issues.filter((item) => item.level === 'error').map((item) => item.text));
  const newErrors = after.issues.filter((item) => item.level === 'error' && !oldErrors.has(item.text));
  if (newErrors.length)
    throw documentError(
      '修改会引入公式错误：' +
        newErrors
          .slice(0, 3)
          .map((item) => item.text)
          .join('；'),
      'DOCUMENT_FORMULA'
    );
  rejectDuplicates(after.book, touched);
  return { blob: result, changed: touched.size };
}

/**
 * 只能改已有格子、不能删行：新安排比原来行数少时，旧的尾行会留下，或者被模型写成和上一行一样（两行“18:00-19:30 晚餐”）。
 * 本批改到的行和别的行重复：整批不保存，告诉模型把多出来的行清空（value: null）再交。
 */
function rejectDuplicates(book, touched) {
  const bySheet = new Map();
  for (const key of touched) {
    const [sheet, address] = [key.slice(0, key.lastIndexOf('!')), key.slice(key.lastIndexOf('!') + 1)];
    if (!bySheet.has(sheet)) bySheet.set(sheet, new Set());
    bySheet.get(sheet).add(Number(address.match(/\d+$/)[0]));
  }
  for (const [sheet, rowsTouched] of bySheet) {
    const cells = book.Sheets[sheet] ?? {};
    const grid = [];
    for (const [address, cell] of Object.entries(cells)) {
      const m = address.match(/^([A-Z]+)(\d+)$/);
      if (!m) continue;
      const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      (grid[Number(m[2]) - 1] ??= [])[col] = cell.w ?? cell.v;
    }
    const rows = Array.from(grid, (r) => Array.from(r ?? [], (v) => v ?? ''));
    const hit = duplicateRows(rows, false).find(({ keep, drop }) => rowsTouched.has(keep + 1) || rowsTouched.has(drop + 1));
    if (!hit) continue;
    const [a, b] = [hit.keep + 1, hit.drop + 1].sort((x, y) => x - y);
    const text = rows[hit.keep].filter((v) => String(v).trim()).join(' | ').slice(0, 80);
    throw documentError(
      `改完后「${sheet}」第${a}行和第${b}行重复（${text}），本批未保存。新安排比原来行数少时，把多出来的行各格设为 value: null 清空，再整批重新提交`,
      'DOCUMENT_DUPLICATE'
    );
  }
}

function encodeCell(edit, attrs) {
  if (edit.formula !== undefined) {
    const formula = String(edit.formula).replace(/^=/, '');
    if (!formula || formula.length > 2000 || /\[|\]|\||WEBSERVICE\s*\(|HYPERLINK\s*\(/i.test(formula))
      throw documentError('公式为空、过长或包含外部访问', 'DOCUMENT_FORMULA');
    if (Object.hasOwn(edit, 'value')) throw documentError('value与formula只能提供一个');
    return `<c${attrs}><f>${xmlEscape(formula)}</f></c>`;
  }
  if (!Object.hasOwn(edit, 'value')) throw documentError('缺少value或formula');
  const value = edit.value;
  if (value === null) return `<c${attrs}/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c${attrs}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c${attrs} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value !== 'string' || value.length > 10000) throw documentError('单元格值必须是有限数值、短文字、布尔或null');
  // 文字即使以等号开头也保留为文字，公式必须显式传formula。
  return `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

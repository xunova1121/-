import { inspectPresentation, requiresEverySlideImage } from './presentationReceipt.js';
import { inspectLength } from './documentLength.js';
import { checkArtifact } from './artifactCheck.js';
import { openOfficePackage, orderedSlidePaths, xmlUnescape } from './officePackage.js';
import { checkFormulas } from './formulaCheck.js';
import { documentError } from './documentPlan.js';

/** 从真实工作簿读回，不拿生成前的Markdown当公式验收。最多50表/5万非空格。 */
export async function inspectWorkbook(blob) {
  const XLSX = await import('xlsx');
  const book = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array', cellFormula: true, sheetStubs: true });
  if (book.SheetNames.length > 50) throw documentError('工作簿超过50个工作表检查上限', 'DOCUMENT_SIZE');
  let cellCount = 0;
  let areaCount = 0;
  const sheets = book.SheetNames.map((sheetName) => {
    const sheet = book.Sheets[sheetName];
    if (sheet['!ref']) {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      areaCount += (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
      if (areaCount > 200000) throw documentError('工作簿使用范围过大，不能展开为无界文本', 'DOCUMENT_SIZE');
    }
    const cells = new Map();
    let rows = 0;
    let cols = 0;
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith('!')) continue;
      if (++cellCount > 50000) throw documentError('工作簿超过5万单元格检查上限', 'DOCUMENT_SIZE');
      const decoded = XLSX.utils.decode_cell(address);
      rows = Math.max(rows, decoded.r + 1);
      cols = Math.max(cols, decoded.c + 1);
      cells.set(address, cell.f ? { formula: cell.f, result: cell.v } : { value: cell.v });
    }
    return { name: sheetName, rows, cols, cells };
  });
  const cachedErrors = [];
  for (const sheetName of book.SheetNames) {
    for (const [address, cell] of Object.entries(book.Sheets[sheetName])) {
      if (cell?.t === 'e' && cachedErrors.length < 12) cachedErrors.push({ level: 'error', text: `${sheetName}!${address}含Excel错误值` });
    }
  }
  return { book, sheets, issues: [...checkFormulas(sheets), ...cachedErrors].slice(0, 24), cellCount };
}

/** 只报告实际执行的检查；输入来源和事实准确性不由Office结构推断。 */
export async function inspectDocument(blob, filePath, { info = {}, requiredText = [], signal, requirements = '' } = {}) {
  signal?.throwIfAborted();
  const format = String(filePath).split('.').pop().toLowerCase();
  const office = ['docx', 'pptx', 'xlsx'].includes(format);
  const zip = office ? await openOfficePackage(blob) : null;
  const workbook = format === 'xlsx' ? await inspectWorkbook(blob) : null;
  const validation = await checkArtifact(blob, filePath);
  const issues = [...(info.formulaIssues || []), ...(info.layoutIssues || [])];
  const wordCount = format === 'docx' ? await inspectLength(zip, requirements) : null;
  if (wordCount) {
    validation.wordCount = wordCount;
    if (!wordCount.passed) issues.push({ level: 'error', text: `真实Word主文档计数${wordCount.count}字，要求${wordCount.min}至${wordCount.max}字；${wordCount.scope}` });
  }
  if (info.missingImages?.length) issues.push({ level: 'error', text: `有${info.missingImages.length}张图片未读到，文件含占位内容` });
  if (format === 'xlsx') {
    const checked = workbook;
    issues.push(...checked.issues);
    validation.sheets = checked.sheets.length;
    validation.formulaCheck = 'static_checked_not_recalculated';
  }
  if (format === 'pptx') {
    const paths = await orderedSlidePaths(zip);
    validation.slides = paths.length;
    validation.presentation = await inspectPresentation(zip, { signal });
    if (requiresEverySlideImage(requirements) && validation.presentation.missingImagePages.length) issues.push({ level: 'error', text: `缺少内容配图的页：${validation.presentation.missingImagePages.join('、')}；请补图后交付，图标不算配图` });
    for (const [index, slidePath] of paths.entries()) {
      const xml = await zip.file(slidePath).async('string');
      const text = [...xml.matchAll(/<a:t\b[^>]*>([^<]*)<\/a:t>/g)].map((match) => xmlUnescape(match[1])).join('');
      if (text.length > 600) issues.push({ level: 'warn', text: `第${index + 1}页文字密度较高，请打开真实预览核对` });
    }
  }
  if (requiredText.length) {
    const { parseFile } = await import('./docs.js');
    const parsed = await parseFile(blob, filePath);
    // 读回解析器有截断上限，未命中只标待核查，不能冒称整份文件缺失。
    for (const text of requiredText.slice(0, 20)) {
      if (!parsed.text.includes(String(text))) issues.push({ level: 'warn', text: `读回片段未找到指定文字：${String(text).slice(0, 100)}` });
    }
  }
  signal?.throwIfAborted();
  const unique = [...new Map(issues.map((item) => [`${item.level}:${item.text}`, { level: item.level, text: String(item.text).slice(0, 240) }])).values()];
  return {
    ...validation,
    issues: unique.slice(0, 40),
    errors: unique.filter((item) => item.level === 'error').length,
    issueCount: unique.length,
    facts: 'not_verified',
    visual: 'not_checked',
    render: 'not_checked',
    pdfCheck: 'not_checked'
  };
}

export function qualitySummary(report) {
  const result = report.errors
    ? `发现${report.errors}项错误，需修改后交付`
    : report.issueCount
      ? `有${report.issueCount}项待核查`
      : '已执行的静态检查未发现问题';
  return `${result}；事实真实性未由结构检查证明；视觉检查：${report.visual}；真实转换：${report.render}`;
}

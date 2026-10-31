import { documentLinePreferences, stripDocumentLines } from './documentLineRules.js';
import * as ws from './workspace.js';
import { inspectDocument, qualitySummary } from './documentQuality.js';
import { throwControl } from '../core/networkRequest.js';
import { inspectRenderedPdf } from './pdfQuality.js';
import { documentError } from './documentPlan.js';
import { requestedWordPages, checkWordPages } from './wordPageBudget.js';
import { coordinateWordLayout } from './wordLayout.js';
import { directTypographyConflicts } from './docxTypography.js';
import { measureDocx } from './styleCheck.js';

/** 把短检查报告与真实产物放一起；正文只在工作区文件中，不进会话/检查点。 */
export async function deliverDocument(ctx, out, target, { progress, signal, checkpoint, issues = [], plan, generatorReview, requiredText = [], requirements = '', preservation = null, design = null } = {}) {
  let lineRules = {};
  if (out.ext === 'docx') {
    lineRules = await documentLinePreferences(ctx, requirements, signal);
    if (lineRules.noRules || lineRules.noUnderline) out = { ...out, blob: await stripDocumentLines(out.blob, { ...lineRules, signal }), wordPreview: null };
    out = await coordinateWordLayout(ctx, out, requirements, { signal, progress });
    const typographyIssues = await directTypographyConflicts(out.blob, out.info?.typographyProfile || {}, { signal });
    issues = [...issues, ...typographyIssues];
  }
  const validation = await inspectDocument(out.blob, target, { info: out.info, requiredText, signal, requirements });
  // 读回实际字号、横线、下划线：回答只能说文件里真的有的（见 styleCheck.js）
  if (['docx','pptx','xlsx'].includes(out.ext)) validation.styleFacts = await measureDocx(out.blob);
  if (lineRules.noRules && validation.styleFacts?.rules !== 0) issues.push({ level: 'error', text: '要求不要横线，但实际Word未确认横线为0；须修复后交付' });
  if (lineRules.noUnderline && validation.styleFacts?.underlines !== 0) issues.push({ level: 'error', text: '要求不要下划线，但实际Word未确认下划线为0；须修复后交付' });
  const effectiveStyle = validation.format === 'pptx' ? out.info?.style : validation.format === 'xlsx' ? out.info?.sheetStyle : null;
  if (design?.style && effectiveStyle) {
    const conflict = design.style !== effectiveStyle;
    validation.design = { requested: design.style, effective: effectiveStyle, state: conflict ? 'conflict' : 'applied' };
    if (conflict) issues = [...issues, { level: design.required || design.excluded?.includes(effectiveStyle) ? 'error' : 'warn', text: `公文主题固定稳重商务，与选择的${validation.format === 'pptx' ? 'PPT' : 'Excel'}风格冲突；请调整主题后再交付` }];
  }
  if (out.wordLayout) validation.wordLayout = out.wordLayout;
  if (out.info?.typographyProfile && Object.keys(out.info.typographyProfile).length) validation.typography = { profile: out.info.typographyProfile, scope: '正文和标题样式；原件直接格式、代码、页眉页脚独立格式保留' };
  const wordPages = validation.format === 'docx' ? requestedWordPages(requirements, { wordContext: true }) : null;
  if (wordPages) validation.wordPageBudget = checkWordPages(wordPages);
  if (validation.format === 'pptx' && out.info?.expectedSlides != null) {
    validation.expectedSlides = out.info.expectedSlides;
    if (validation.slides !== validation.expectedSlides) {
      validation.issues.push({ level: 'error', text: `PPT实际${validation.slides}页，要求${validation.expectedSlides}页` });
      validation.errors += 1;
      validation.issueCount += 1;
    }
  }
  validation.contentReview = ctx.documentContentReview || { business: 'not_checked' };
  if (preservation) validation.contentPreservation = preservation;
  if (out.officeVisual) validation.officeVisual = out.officeVisual;
  validation.generatorVisual = generatorReview ? 'generator_preview_reviewed' : 'not_checked';
  if (generatorReview?.problems?.length && !generatorReview.changed) {
    issues = [...issues, ...generatorReview.problems.slice(0, 10).map((text) => ({ level: 'warn', text: '生成器看图发现：' + String(text).slice(0, 160) }))];
  }
  const extra = issues.map((item) => ({ level: item.level, text: String(item.text).slice(0, 240) }));
  validation.issues = [...validation.issues, ...extra].slice(0, 40);
  validation.errors += extra.filter((item) => item.level === 'error').length;
  validation.issueCount += extra.length;
  signal?.throwIfAborted();
  const saved = await ws.write(target, out.blob);
  ctx.onFileChanged?.(saved.path);
  const separator = saved.path.lastIndexOf('/');
  const folder = saved.path.slice(0, separator + 1);
  const stem = saved.path.slice(separator + 1).replace(/\.[a-z0-9]+$/i, '');
  const reportPath = `${folder}文档检查/${stem}-${out.ext}.json`;
  const receipt = () =>
    checkpoint?.({
      type: 'artifact_validation',
      path: saved.path,
      validation: {
        format: validation.format,
        wordCount: validation.wordCount,
        structure: validation.structure,
        readback: validation.readback,
        render: validation.render,
        errors: validation.errors,
        slides: validation.slides,
        expectedSlides: validation.expectedSlides,
        pages: validation.pages,
        pdfPageMatch: validation.pdfPageMatch,
        wordPageBudget: validation.wordPageBudget,
        styleFacts: validation.styleFacts,
        officeVisual: validation.officeVisual,
        overviewPaths: validation.overviewPaths,
        presentation: validation.presentation
      }
    });
  const saveReport = async () => {
    const report = { version: 1, path: saved.path, checkedAt: new Date().toISOString(), templateId: plan?.templateId || null, ...validation };
    const record = await ws.write(reportPath, JSON.stringify(report, null, 2));
    ctx.onFileChanged?.(record.path);
    return record.path;
  };
  // 先留下已经落盘的产物回执；后续渲染被停止不能让半成品看起来从未生成。
  await receipt();
  let checkedPath;
  const notes = [];
  if (out.wordLayout) notes.push(out.wordLayout.note);
  if (['docx', 'pptx', 'xlsx'].includes(out.ext)) {
    const preview = await renderDocument(ctx, out, saved.path, { progress, signal });
    notes.push(...preview.notes);
    validation.render = preview.state;
    if (preview.overviewPaths?.length) validation.overviewPaths = preview.overviewPaths;
    if (preview.path) validation.previewPath = preview.path;
    if (preview.pdfCheck) {
      validation.pdfCheck = preview.pdfCheck.state;
      validation.pages = preview.pdfCheck.pages;
      validation.issues = [...validation.issues, ...preview.pdfCheck.issues].slice(0, 40);
      validation.issueCount += preview.pdfCheck.issues.length;
      validation.errors += preview.pdfCheck.issues.filter((issue) => issue.level === 'error').length;
      if (validation.format === 'pptx') {
        validation.pdfPageMatch = validation.pages === validation.slides ? 'passed' : 'failed';
        if (validation.pdfPageMatch === 'failed') {
          validation.issues.push({ level: 'error', text: `PPT为${validation.slides}页，真实PDF为${validation.pages}页，页数不一致` });
          validation.errors += 1;
          validation.issueCount += 1;
          notes.push('PPT和PDF页数不一致，文件已保留，请修复后再交付');
        }
      }
    }
    if (wordPages) {
      const checked = checkWordPages(wordPages, validation.pages);
      validation.wordPageBudget = checked;
      const goal = checked.max === null ? `至少${checked.min}页` : checked.min === checked.max ? `${checked.min}页` : `${checked.min}至${checked.max}页`;
      if (checked.state !== 'passed') {
        const text = checked.state === 'failed'
          ? `Word实际${checked.actual}页，要求${goal}；页数验收未通过，保留正文，请调整版式后重新检查`
          : `Word要求${goal}，尚无有效真实PDF页数，分页未校验`;
        validation.issues.push({ level: checked.state === 'failed' ? 'error' : 'warn', text });
        validation.issueCount += 1;
        if (checked.state === 'failed') validation.errors += 1;
        notes.push(text);
      } else notes.push(`Word真实总页数${checked.actual}，满足${goal}要求`);
    }
    await receipt();
  }
  checkedPath = await saveReport();
  if (validation.wordCount) notes.push(`实际文件字数${validation.wordCount.count}，要求${validation.wordCount.min}至${validation.wordCount.max}；${validation.wordCount.scope}；${validation.wordCount.passed ? '在范围内' : '不在范围内，须修改'}`);
  if (validation.presentation) notes.push(`真实逐页配图：${validation.presentation.imagePages}/${validation.slides}页有内容图片；缺图页：${validation.presentation.missingImagePages.join('、') || '无'}；图标和装饰不冒充配图；逐页表格/文本框及估算空白见报告`);
  const facts = validation.styleFacts;
  if (facts) notes.push(`读回实际：标题${facts.title}磅、正文${facts.body}磅；横线${facts.rules == null ? '未自动量取' : facts.rules + '条'}、下划线${facts.underlines}处`);
  notes.push(qualitySummary(validation), `检查报告：${checkedPath}`);
  return { ...saved, validation, notes, blob: out.blob };
}

async function renderDocument(ctx, out, filePath, { progress, signal }) {
  if (!ctx.officeRender) return { state: 'not_checked', notes: ['本端未做Office真实渲染；现有PPT预览及排版检查属于生成器检查'] };
  try {
    progress?.('生成Office真实预览…');
    signal?.throwIfAborted();
    const rendered = out.officePreview || out.wordPreview || await ctx.officeRender(out.blob, out.ext, { signal });
    signal?.throwIfAborted();
    if (!rendered.available) return { state: 'not_available', notes: [rendered.reason || '本端不支持Office真实渲染'] };
    if (!rendered.blob?.size || (await rendered.blob.slice(0, 5).text()) !== '%PDF-') throw documentError('Office未生成有效PDF', 'DOCUMENT_RENDER');
    const preview = await ws.write(filePath.slice(0, filePath.lastIndexOf('.')) + '.预览.pdf', rendered.blob);
    ctx.onFileChanged?.(preview.path);
    const overviewPaths = [];
    if (out.officeOverview) {
      for (const [index, sheet] of out.officeOverview.sheets.entries()) {
        const overview = await ws.write(filePath.replace(/\.[^.]+$/, '') + `.总览-${index + 1}.png`, sheet.blob);
        overviewPaths.push(overview.path); ctx.onFileChanged?.(overview.path); ctx.onImage?.(null, overview.path);
      }
    }
    let pdfCheck;
    const inspectionNotes = [];
    try {
      pdfCheck = await inspectRenderedPdf(rendered.blob, { signal });
      inspectionNotes.push(
        `真实PDF逐页检查${pdfCheck.pages}页；${pdfCheck.issues.length ? '发现可疑项，见检查报告' : '未发现可提取文字的页面边界问题'}；${out.officeVisual?.state === 'reviewed' ? '已进行真实页面模型视觉检查，仍可打开总览核对' : '视觉检查未通过或未运行'}`
      );
    } catch (error) {
      throwControl(error, signal);
      inspectionNotes.push('PDF逐页检查未完成：' + String(error.message).slice(0, 160));
    }
    return {
      state: out.officeVisual?.state === 'reviewed' ? 'office_visual_reviewed' : 'converted_not_visual_reviewed',
      overviewPaths,
      path: preview.path,
      pdfCheck,
      notes: [...overviewPaths.map(path => '真实页面总览：' + path), ...(out.officeVisual?.problems || []).map(text => '视觉待修：' + text), ...(out.officeVisual?.note ? [out.officeVisual.note] : []), '已用LibreOffice真实转换为PDF：' + preview.path + '；可打开核对实际分页，未宣称人工视觉验收通过', ...inspectionNotes]
    };
  } catch (error) {
    throwControl(error, signal);
    // 转换失败不能抹去可编辑文件；明确记录未完成，不伪装成视觉通过。
    return { state: 'failed', notes: ['Office真实预览未完成：' + String(error.message || '转换失败').slice(0, 240)] };
  }
}


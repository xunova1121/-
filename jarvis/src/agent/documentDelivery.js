import * as ws from './workspace.js';
import { inspectDocument, qualitySummary } from './documentQuality.js';
import { throwControl } from '../core/networkRequest.js';
import { inspectRenderedPdf } from './pdfQuality.js';
import { documentError } from './documentPlan.js';

/** 把短检查报告与真实产物放一起；正文只在工作区文件中，不进会话/检查点。 */
export async function deliverDocument(ctx, out, target, { progress, signal, checkpoint, issues = [], plan, generatorReview, requiredText = [], requirements = '', preservation = null } = {}) {
  const validation = await inspectDocument(out.blob, target, { info: out.info, requiredText, signal, requirements });
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
        pdfPageMatch: validation.pdfPageMatch
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
  if (['docx', 'pptx', 'xlsx'].includes(out.ext)) {
    const preview = await renderDocument(ctx, out, saved.path, { progress, signal });
    notes.push(...preview.notes);
    validation.render = preview.state;
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
    await receipt();
  }
  checkedPath = await saveReport();
  if (validation.wordCount) notes.push(`实际文件字数${validation.wordCount.count}，要求${validation.wordCount.min}至${validation.wordCount.max}；${validation.wordCount.scope}；${validation.wordCount.passed ? '在范围内' : '不在范围内，须修改'}`);
  notes.push(qualitySummary(validation), `检查报告：${checkedPath}`);
  return { ...saved, validation, notes };
}

async function renderDocument(ctx, out, filePath, { progress, signal }) {
  if (!ctx.officeRender) return { state: 'not_checked', notes: ['本端未做Office真实渲染；现有PPT预览及排版检查属于生成器检查'] };
  try {
    progress?.('生成Office真实预览…');
    signal?.throwIfAborted();
    const rendered = await ctx.officeRender(out.blob, out.ext, { signal });
    signal?.throwIfAborted();
    if (!rendered.available) return { state: 'not_available', notes: [rendered.reason || '本端不支持Office真实渲染'] };
    if (!rendered.blob?.size || (await rendered.blob.slice(0, 5).text()) !== '%PDF-') throw documentError('Office未生成有效PDF', 'DOCUMENT_RENDER');
    const preview = await ws.write(filePath.slice(0, filePath.lastIndexOf('.')) + '.预览.pdf', rendered.blob);
    ctx.onFileChanged?.(preview.path);
    let pdfCheck;
    const inspectionNotes = [];
    try {
      pdfCheck = await inspectRenderedPdf(rendered.blob, { signal });
      inspectionNotes.push(
        `真实PDF逐页检查${pdfCheck.pages}页；${pdfCheck.issues.length ? '发现可疑项，见检查报告' : '未发现可提取文字的页面边界问题'}；未进行视觉模型审稿`
      );
    } catch (error) {
      throwControl(error, signal);
      inspectionNotes.push('PDF逐页检查未完成：' + String(error.message).slice(0, 160));
    }
    return {
      state: 'converted_not_visual_reviewed',
      path: preview.path,
      pdfCheck,
      notes: ['已用LibreOffice真实转换为PDF：' + preview.path + '；可打开核对实际分页，未宣称人工视觉验收通过', ...inspectionNotes]
    };
  } catch (error) {
    throwControl(error, signal);
    // 转换失败不能抹去可编辑文件；明确记录未完成，不伪装成视觉通过。
    return { state: 'failed', notes: ['Office真实预览未完成：' + String(error.message || '转换失败').slice(0, 240)] };
  }
}


/** 分层稿共享交付入口：一份源稿驱动海报和Demo，不调用生图、修图或升级图片分辨率。 */
import JSZip from 'jszip';
import { loadLayerDesign, claimLayerOutputBase, saveDesignFile } from './layeredDesignSource.js';
import { composeLayeredSvg } from './layeredDesignSvg.js';
import { composeLayeredPptx } from './layeredDesignPptx.js';
import { createLayeredHtml, mobileCardsPreviewSvg } from './layeredDesignHtml.js';
import { imageColors, lintLayerDesign } from './layeredDesignLint.js';
import { checkLayerCopy, checkLayerOverlap, checkLayerContrast, reviewLayeredDesign, applyDesignState, DESIGN_REVIEW_KEYS } from './layeredDesignQuality.js';
import { DESIGN_LIMITS, designError } from './layeredDesignInput.js';
import { checkDesignPresentation, phonePreviewSvg } from './layeredDesignPresentation.js';
import { renderVisualScene } from './visualSceneRaster.js';
import { assertPosterPng } from './posterDeliveryTool.js';
import { throwControl } from '../core/networkRequest.js';
import { posterContent, posterCompositionIssues } from './posterContent.js';
import { protectOverlayText, fixTextContrast } from './layeredDesignScrim.js';
import { designThinkingIssues } from './posterContent.js';

function assetsReceipt(design, assets) {
  return design.layers.filter(n => n.type === 'image').map(node => {
    const image = assets.get(node.asset), scale = (node.fit === 'contain' ? Math.min : Math.max)(node.w / image.width, node.h / image.height);
    return { id: node.asset, width: image.width, height: image.height, scale: Math.round(scale * 1000) / 1000, upscaled: scale > 1, detail: 'not_checked' };
  });
}
function recordFailure(receipt, error, phase, signal) {
  throwControl(error, signal);
  // 不把文件内容、服务商原始响应或子进程路径送回对话上下文。
  const code = /^(?:POSTER|VISUAL|DESIGN)_[A-Z_]+$/.test(error?.code || '') ? error.code : 'DESIGN_' + phase.toUpperCase() + '_FAILED';
  receipt.errors.push({ code, phase, message: '此阶段未通过；已生成文件保留，未重画或额外调用图片模型' });
}
function checkGeometry(design, svg, receipt) {
  receipt.copyCheck = checkLayerCopy(design, svg);
  receipt.layoutCheck = checkLayerOverlap(design);
  receipt.presentation = checkDesignPresentation(design);
  if (receipt.copyCheck.status !== 'passed') receipt.errors.push({ code: 'DESIGN_COPY_MISMATCH', phase: 'copy' });
  if (receipt.layoutCheck.status !== 'passed') receipt.errors.push({ code: 'DESIGN_TEXT_OVERLAP', phase: 'layout' });
  if (receipt.presentation.status === 'failed') receipt.errors.push({ code: 'DESIGN_PRESENTATION_UNREADABLE', phase: 'presentation', message: '整张按目标宽度显示时字太小或图文失衡；请按presentation.failed增大字号/文字区、减少主视觉占比或拆版，不能只改对比度后宣称完成' });
  // 每个快照都执行完整文本/边界归一化；它们不参与“初始PNG已看过”的结论。
  for (const state of design.states) {
    const checked = checkLayerOverlap(applyDesignState(design, state));
    if (checked.status !== 'passed') receipt.errors.push({ code: 'DESIGN_STATE_OVERLAP', phase: 'layout' });
    if (checkDesignPresentation(applyDesignState(design, state)).status === 'failed') receipt.errors.push({ code: 'DESIGN_STATE_UNREADABLE', phase: 'presentation' });
  }
}
async function packageDesign(design, assets, artifacts, receipt, signal) {
  const archive = new JSZip(), source = structuredClone(design);
  for (const entry of source.assets) {
    const image = assets.get(entry.id), ext = image.mime === 'image/jpeg' ? 'jpg' : image.mime.split('/')[1];
    entry.path = `assets/${entry.id}.${ext}`;
    archive.file(entry.path, image.bytes);
  }
  for (const [format, blob] of artifacts) archive.file(`design.${format}`, await blob.arrayBuffer());
  archive.file('design.design.json', JSON.stringify(source, null, 2));
  archive.file('README.txt', `打开design.html可离线演示。手机使用语义卡片，电脑保留原构图。\n实际格式：${[...artifacts.keys()].join('、')}。PNG为初始视图${design.width}×${design.height}，不是后续交互截图。\nSVG为可编辑矢量；PPTX文字、卡片和图表线段可编辑，图片和图标为独立对象，字体不嵌入。\n重新编辑：把design.design.json及assets目录按相对路径导入未央工作区，source_path引用该JSON；保留素材原字节及摘要。\n数据：${design.dataMode}；${design.source}；${design.asOf}。不代表已接入实时数据。\n字体：${receipt.fontCheck}；原文一致：${receipt.copyCheck.status}；实际像素对比：${receipt.contrast.status}；初始视觉：${receipt.visual}；交互运行：未实测。\n导出像素不证明底图细节；各快照及设备显示仍需核对。`);
  const bytes = await archive.generateAsync({ type: 'uint8array', compression: 'STORE' });
  throwControl(null, signal);
  if (bytes.length > 80e6) throw designError('离线打包超过80MB，请减少素材或快照', 'DESIGN_PACKAGE_SIZE');
  return new Blob([bytes], { type: 'application/zip' });
}

export async function deliverLayeredDesign(input, ctx = {}, options = {}, demo = false) {
  const { signal } = options;
  const defaultSize = demo ? [3840, 2160] : [1080, 1920];
  const { design, assets, preflight } = await loadLayerDesign(input, { signal, defaultSize, autoHeight: options.autoPosterHeight });
  if (design.illustrated || options.requiresRichVisual) {
    design.illustrated = true;
    options = { ...options, requiresRichVisual: true };
  }
  const { base, release } = await claimLayerOutputBase(input, design, signal);
  // 新自由稿（海报交付会话内）必须先写构思（2026-11-17 用户：要有独立思考；实际出现直接套“上图下面板”）
  const requireConcept = Boolean(options.posterAttempt && !input.source_path && Array.isArray(input.design?.layers));
  try { return await deliverLoadedDesign({ design, assets, base, preflight, requireConcept }, ctx, options, demo); }
  finally { release(); }
}

async function deliverLoadedDesign({ design, assets, base, preflight, requireConcept = false }, ctx, options, demo) {
  const { signal, progress, checkpoint } = options;
  // 叠加版式：压在照片上的字按真实像素量，看不清才加局部遮罩（layeredDesignScrim.js）
  let overlay;
  try { overlay = await protectOverlayText(design, { compose: d => composeLayeredSvg(d, assets), raster: ctx.renderVisualScene || renderVisualScene, signal }); }
  catch (error) { throwControl(error, signal); overlay = { status: 'not_checked', scrims: [] }; }
  // 纯色底上看不清的字：自动换成能看清的颜色（只改颜色）
  let recolor = { status: 'skipped', recolored: [] };
  try { recolor = await fixTextContrast(design, { compose: d => composeLayeredSvg(d, assets), raster: ctx.renderVisualScene || renderVisualScene, signal }); }
  catch (error) { throwControl(error, signal); }
  const source = new Blob([JSON.stringify(design, null, 2)], { type: 'application/json' });
  if (source.size > DESIGN_LIMITS.source) throw designError('归一化源稿超过180KB，请拆版');
  progress?.('正在编排独立文字、图标、图片与内容卡片…');
  const svg = composeLayeredSvg(design, assets);
  const receipt = { kind: demo ? 'visual_demo' : 'poster', title: design.title, status: 'partial', width: design.width, height: design.height,
    files: [], textRendering: 'program', fontCheck: 'not_checked', visual: 'not_checked', interaction: 'not_checked',
    dataMode: design.dataMode, designVersion: 'layered-1', assets: assetsReceipt(design, assets), contrast: { status: 'not_checked' },
    editing: { layouts: ['editorial', 'magazine', 'campaign', 'timeline', 'newspaper', 'celebration', 'dashboard', 'free'],
      guidance: '可以自由构图：design.layout=free配合layers逐个指定文字/图片/图标的坐标。换结构用source_path+design，保留palette与原素材；局部改字用changes。无需手改SVG。' },
    notes: ['同一分层源稿生成各格式；文字不由生图模型画，图标为独立矢量对象', '文案原样保留，不证明文案中的事实或错别字已被编辑校正', '4K仅表示导出画布；素材放大倍率单独记录，未自动付费重画/放大'], errors: [] };
  if (overlay.status !== 'skipped') receipt.overlayText = overlay;
  if (recolor.recolored.length) { receipt.recolored = recolor.recolored; receipt.notes.push(`纯色底上看不清的${recolor.recolored.length}段文字已自动换成能看清的颜色（${recolor.recolored.map(r => r.id).join('、')}）；原文、字号和位置未改`); }
  if (overlay.scrims.length) receipt.notes.push(`文字压在照片上、按真实像素量看不清的${overlay.scrims.length}处，已在字后加局部渐变遮罩（不透明度${overlay.level}）；未改原文、字号和位置`);
  checkGeometry(design, svg, receipt);
  if (options.requiresRichVisual) receipt.contentCheck = posterContent(design);
  if (options.requiresRichVisual) {
    receipt.compositionIssues = posterCompositionIssues(design);
    receipt.errors.push(...receipt.compositionIssues.map(issue => ({ ...issue, phase: 'composition' })));
  }
  // 构思与数据图表：出图前就提出，不算一次试排（posterAttempt 下有错误会在渲染前返回）
  const thinking = designThinkingIssues(design, { requireConcept });
  receipt.errors.push(...thinking.map(issue => ({ ...issue, phase: 'composition' })));
  receipt.compositionIssues = [...(receipt.compositionIssues || []), ...thinking];
  if (receipt.contentCheck?.status === 'failed') receipt.errors.push({ code: 'DESIGN_ILLUSTRATION_MISSING', phase: 'composition', message: '图文并茂需实际主题图片或有来源图表，图标/数字卡片不能代替。源稿保留；不编造时间走势，不自动付费重画。' });
  const issues = [
    ...(receipt.presentation.failed || []).map(item => ({ code: 'DESIGN_PRESENTATION_UNREADABLE', ...item,
      ...(item.minimum && { field: 'fontSize', minimumFontSize: Math.ceil(item.minimum * design.width / receipt.presentation.previewWidth * 1000) / 1000 }) })),
    ...(receipt.layoutCheck.failed || []).map(ids => ({ code: 'DESIGN_TEXT_OVERLAP', ids, field: 'position', message: '这两个文字区域重叠，需调整位置' })),
    ...(receipt.compositionIssues || []),
    ...(receipt.contentCheck?.status === 'failed' ? [{ code: 'DESIGN_ILLUSTRATION_MISSING', field: 'design.assets', message: '需可见主题图片/有来源图表，图标和数字不算配图' }] : [])
  ];
  receipt.preflight = { status: receipt.errors.length ? 'failed' : 'passed', issueCount: issues.length,
    issues: issues.slice(0, 32), adjustments: preflight?.adjustments || [] };
  const artifacts = new Map();
  const deliver = async (format, blob, render = 'not_checked') => {
    const path = await saveDesignFile(`${base}.${format}`, blob, ctx, signal);
    artifacts.set(format, blob);
    receipt.files.push({ format, path, readback: 'passed', structure: 'passed', render });
    return path;
  };
  try {
    const path = await saveDesignFile(`${base}.design.json`, source, ctx, signal);
    if (!/\.design\.json$/i.test(path)) throw designError('文件夹并发改名改变了源稿后缀，未当成可复用完成稿', 'DESIGN_SOURCE_NAME');
    receipt.designPath = path;
  }
  catch (error) { recordFailure(receipt, error, 'source', signal); }
  try { await deliver('svg', new Blob([svg], { type: 'image/svg+xml' })); }
  catch (error) { recordFailure(receipt, error, 'svg', signal); }
  if (options.posterAttempt && receipt.errors.length) return JSON.stringify(receipt);
  options.beginPosterAttempt?.();
  if (!options.posterAttempt) {
    try { await deliver('pptx', await composeLayeredPptx(design, assets)); }
    catch (error) { recordFailure(receipt, error, 'pptx', signal); }
  }
  const raster = ctx.renderVisualScene || renderVisualScene;
  let png;
  let previewPng;
  try {
    progress?.('正在核验真实字体、中文字形与最终PNG像素…');
    const rendered = await raster(svg, { signal });
    await assertPosterPng(rendered.blob, design.width, design.height);
    if (rendered.fontCheck?.status !== 'passed') throw designError('字体/字形尚未通过核验', 'POSTER_FONT_CHECK_UNAVAILABLE');
    png = rendered.blob; receipt.fontCheck = 'passed';
    const path = await deliver('png', png, 'passed');
    ctx.onImage?.(URL.createObjectURL(png), path);
    progress?.('正在按实际背景像素检查文字可读性…');
    receipt.contrast = await checkLayerContrast(design, svg, raster, signal);
    if (receipt.contrast.status !== 'passed') receipt.errors.push({ code: receipt.contrast.status === 'failed' ? 'DESIGN_CONTRAST_LOW' : 'DESIGN_CONTRAST_UNCHECKED', phase: 'contrast' });
  } catch (error) { recordFailure(receipt, error, 'render', signal); }
  if (png && design.reading === 'phone') {
    try {
      const preview = phonePreviewSvg(svg, design), rendered = await raster(preview.svg, { signal });
      await assertPosterPng(rendered.blob, preview.width, preview.height);
      if (rendered.fontCheck?.status !== 'passed') throw designError('手机整图预览字体未核验', 'POSTER_FONT_CHECK_UNAVAILABLE');
      previewPng = rendered.blob;
      receipt.phonePreview = { path: await saveDesignFile(`${base}.phone.png`, previewPng, ctx, signal), width: preview.width, height: preview.height, readback: 'passed', render: 'passed' };
    } catch (error) { recordFailure(receipt, error, 'phone_preview', signal); }
  } else if (png && demo) {
    // Demo 在手机上是卡片流：按同样分组和字号排一张预览，和电脑版一起自审（不是浏览器截图）
    try {
      const preview = mobileCardsPreviewSvg(design, assets);
      if (preview.height <= 12000) {
        const rendered = await raster(preview.svg, { signal });
        await assertPosterPng(rendered.blob, preview.width, preview.height);
        previewPng = rendered.blob;
        receipt.phonePreview = { kind: 'mobile_cards', path: await saveDesignFile(`${base}.phone.png`, previewPng, ctx, signal), width: preview.width, height: preview.height, readback: 'passed', render: 'passed' };
      } else receipt.notes.push('手机卡片预览超过12000像素高，未生成；手机版仍可在HTML里查看');
    } catch (error) { recordFailure(receipt, error, 'phone_preview', signal); }
  }
  // 设计规则体检：颜色、对齐线、字号层级、主图主色（只给建议）
  if (png) {
    try {
      const hero = design.layers.filter(n => n.type === 'image').sort((a, b) => b.w * b.h - a.w * a.h)[0];
      receipt.designLint = lintLayerDesign(design, hero ? await imageColors(assets.get(hero.asset), raster, signal) : []);
    } catch (error) { throwControl(error, signal); receipt.designLint = lintLayerDesign(design); }
  }
  if (demo) {
    try {
      progress?.('正在生成同源离线Demo和手机可读布局…');
      const html = await createLayeredHtml({ design, assets, png });
      if (new TextEncoder().encode(html).length > 60e6) throw designError('离线HTML超过60MB', 'DESIGN_PACKAGE_SIZE');
      await deliver('html', new Blob([html], { type: 'text/html' }));
      await deliver('zip', await packageDesign(design, assets, artifacts, receipt, signal));
    } catch (error) { recordFailure(receipt, error, 'demo', signal); }
  }
  receipt.visualReport = await reviewLayeredDesign(ctx, design, png, { ...options, previewPng, previewKind: receipt.phonePreview?.kind });
  receipt.visual = receipt.visualReport.status;
  if (receipt.contentCheck) {
    const checks = receipt.visualReport.checks || {};
    receipt.contentCheck.semantic = ['visualsPresent', 'relatedToTopic', 'integrated'].some(k => checks[k] === false) ? 'failed'
      : ['visualsPresent', 'relatedToTopic', 'integrated'].every(k => checks[k] === true) ? 'passed' : 'not_checked';
    if (receipt.contentCheck.semantic !== 'passed') receipt.errors.push({ code: 'DESIGN_ILLUSTRATION_UNVERIFIED', phase: 'visual', message: '图文并茂尚未通过实际成品复核，保留候选，不承诺验收通过' });
  }
  if (receipt.visual === 'failed') receipt.errors.push({ code: 'DESIGN_VISUAL_NEEDS_REVIEW', phase: 'visual' });
  // 设计自审：前两次试排里主次、融合、留白或构思没做到，就带着改法整体再排一次；第三次只提示，不再返工（最多两轮）
  const review = receipt.visualReport.design;
  if (review) {
    receipt.designReview = review;
    const weak = DESIGN_REVIEW_KEYS.filter(k => review[k] === false);
    if (weak.length && options.designReviewBlocking?.())
      receipt.errors.push({ code: 'DESIGN_LAYOUT_NEEDS_WORK', phase: 'design', weak, suggestions: review.suggestions,
        message: '设计自审未通过（' + weak.join('/') + '）：按suggestions整体调整构图再出一次，不删字、不缩小正文' });
    else if (weak.length) receipt.notes.push('设计自审仍有可改进处（' + weak.join('/') + '），已到自审轮数上限，交付当前稿');
  }
  if (design.concept) receipt.concept = design.concept;
  else if (!demo) receipt.notes.push('本稿没写设计构思（design.concept）；下次先写构思再排图层');
  if (options.posterAttempt && png && !receipt.errors.length) {
    try { await deliver('pptx', await composeLayeredPptx(design, assets)); }
    catch (error) { recordFailure(receipt, error, 'pptx', signal); }
  }
  receipt.files.sort((a, b) => ['png', 'svg', 'pptx', 'html', 'zip'].indexOf(a.format) - ['png', 'svg', 'pptx', 'html', 'zip'].indexOf(b.format));
  const required = demo ? ['png', 'svg', 'pptx', 'html', 'zip'] : ['png', 'svg', 'pptx'];
  receipt.status = receipt.designPath && required.every(format => artifacts.has(format)) && !receipt.errors.length ? 'complete' : 'partial';
  receipt.editableLayers = design.layers.filter(n => !n.decorative).slice(0, 16).map(n => ({ id: n.id, type: n.type }));
  await checkpoint?.({ type: 'artifact_validation', path: receipt.designPath || `${base}.svg`, validation: { kind: receipt.kind, readback: receipt.designPath ? 'passed' : 'failed', render: png ? 'passed' : 'failed', visual: receipt.visual, business: 'not_checked', errors: receipt.errors.length } });
  return JSON.stringify(receipt);
}

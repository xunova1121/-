/** 分层稿共享交付入口：一份源稿驱动海报和Demo，不调用生图、修图或升级图片分辨率。 */
import JSZip from 'jszip';
import { loadLayerDesign, claimLayerOutputBase, saveDesignFile } from './layeredDesignSource.js';
import { composeLayeredSvg } from './layeredDesignSvg.js';
import { composeLayeredPptx } from './layeredDesignPptx.js';
import { createLayeredHtml } from './layeredDesignHtml.js';
import { checkLayerCopy, checkLayerOverlap, checkLayerContrast, reviewLayeredDesign, applyDesignState } from './layeredDesignQuality.js';
import { DESIGN_LIMITS, designError } from './layeredDesignInput.js';
import { renderVisualScene } from './visualSceneRaster.js';
import { assertPosterPng } from './posterDeliveryTool.js';
import { throwControl } from '../core/networkRequest.js';

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
  if (receipt.copyCheck.status !== 'passed') receipt.errors.push({ code: 'DESIGN_COPY_MISMATCH', phase: 'copy' });
  if (receipt.layoutCheck.status !== 'passed') receipt.errors.push({ code: 'DESIGN_TEXT_OVERLAP', phase: 'layout' });
  // 每个快照都执行完整文本/边界归一化；它们不参与“初始PNG已看过”的结论。
  for (const state of design.states) {
    const checked = checkLayerOverlap(applyDesignState(design, state));
    if (checked.status !== 'passed') receipt.errors.push({ code: 'DESIGN_STATE_OVERLAP', phase: 'layout' });
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
  const { design, assets } = await loadLayerDesign(input, { signal, defaultSize });
  const { base, release } = await claimLayerOutputBase(input, design, signal);
  try { return await deliverLoadedDesign({ design, assets, base }, ctx, options, demo); }
  finally { release(); }
}

async function deliverLoadedDesign({ design, assets, base }, ctx, options, demo) {
  const { signal, progress, checkpoint } = options;
  const source = new Blob([JSON.stringify(design, null, 2)], { type: 'application/json' });
  if (source.size > DESIGN_LIMITS.source) throw designError('归一化源稿超过180KB，请拆版');
  progress?.('正在编排独立文字、图标、图片与内容卡片…');
  const svg = composeLayeredSvg(design, assets);
  const receipt = { kind: demo ? 'visual_demo' : 'poster', status: 'partial', width: design.width, height: design.height,
    files: [], textRendering: 'program', fontCheck: 'not_checked', visual: 'not_checked', interaction: 'not_checked',
    dataMode: design.dataMode, designVersion: 'layered-1', assets: assetsReceipt(design, assets), contrast: { status: 'not_checked' },
    notes: ['同一分层源稿生成各格式；文字不由生图模型画，图标为独立矢量对象', '文案原样保留，不证明文案中的事实或错别字已被编辑校正', '4K仅表示导出画布；素材放大倍率单独记录，未自动付费重画/放大'], errors: [] };
  checkGeometry(design, svg, receipt);
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
  try { await deliver('pptx', await composeLayeredPptx(design, assets)); }
  catch (error) { recordFailure(receipt, error, 'pptx', signal); }
  const raster = ctx.renderVisualScene || renderVisualScene;
  let png;
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
  if (demo) {
    try {
      progress?.('正在生成同源离线Demo和手机可读布局…');
      const html = await createLayeredHtml({ design, assets, png });
      if (new TextEncoder().encode(html).length > 60e6) throw designError('离线HTML超过60MB', 'DESIGN_PACKAGE_SIZE');
      await deliver('html', new Blob([html], { type: 'text/html' }));
      await deliver('zip', await packageDesign(design, assets, artifacts, receipt, signal));
    } catch (error) { recordFailure(receipt, error, 'demo', signal); }
  }
  receipt.visualReport = await reviewLayeredDesign(ctx, design, png, options);
  receipt.visual = receipt.visualReport.status;
  if (receipt.visual === 'failed') receipt.errors.push({ code: 'DESIGN_VISUAL_NEEDS_REVIEW', phase: 'visual' });
  receipt.files.sort((a, b) => ['png', 'svg', 'pptx', 'html', 'zip'].indexOf(a.format) - ['png', 'svg', 'pptx', 'html', 'zip'].indexOf(b.format));
  const required = demo ? ['png', 'svg', 'pptx', 'html', 'zip'] : ['png', 'svg', 'pptx'];
  receipt.status = receipt.designPath && required.every(format => artifacts.has(format)) && !receipt.errors.length ? 'complete' : 'partial';
  receipt.editableLayers = design.layers.filter(n => !n.decorative).slice(0, 16).map(n => ({ id: n.id, type: n.type }));
  await checkpoint?.({ type: 'artifact_validation', path: receipt.designPath || `${base}.svg`, validation: { kind: receipt.kind, readback: receipt.designPath ? 'passed' : 'failed', render: png ? 'passed' : 'failed', visual: receipt.visual, business: 'not_checked', errors: receipt.errors.length } });
  return JSON.stringify(receipt);
}

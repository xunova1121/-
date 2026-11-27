/** 原图填字共享交付；原图只解码/缩放，不重画、不遮罩、不经过SVG。 */
import JSZip from 'jszip';
import { loadCanvasText, claimCanvasName, saveCanvasFile } from './imageTextSource.js';
import { browserCanvasRenderer } from './imageTextRaster.js';
import { createImageTextEditor } from './imageTextEditor.js';
import { composeImageTextPptx } from './imageTextPptx.js';
import { imageData } from './imageRegion.js';
import { assertPosterPng } from './posterDeliveryTool.js';
import { throwControl } from '../core/networkRequest.js';
import { reviewCanvasText } from './imageTextReview.js';

async function packageCanvas(design, original, html, artifacts, signal) {
  const archive = new JSZip(),
    source = structuredClone(design),
    ext = original.mime === 'image/jpeg' ? 'jpg' : original.mime.split('/')[1];
  source.image.path = `assets/original.${ext}`;
  archive.file(source.image.path, original.bytes);
  archive.file('design.canvas.json', JSON.stringify(source, null, 2));
  archive.file('design.html', html);
  for (const [format, blob] of artifacts) archive.file(`design.${format}`, await blob.arrayBuffer());
  archive.file(
    'README.txt',
    '打开design.html离线查看、拖动文字框、修改文字及导出PNG/源稿。原图字节在assets目录；将design.canvas.json与assets一起导入未央可继续导出PPTX。文字为真实字体，不使用SVG或遮挡面板。需设备安装覆盖全文的中文字体，字体不嵌入。原文保留不代表文案事实或错别字已经编辑校正；像素尺寸不证明原图细节，手机/微信分享仍需核对原文件。'
  );
  const bytes = await archive.generateAsync({ type: 'uint8array', compression: 'STORE' });
  throwControl(null, signal);
  if (bytes.length > 80e6) throw Object.assign(new Error('填字离线包超过80MB'), { code: 'CANVAS_PACKAGE_SIZE' });
  return new Blob([bytes], { type: 'application/zip' });
}
function failure(receipt, error, phase, signal) {
  throwControl(error, signal);
  const code = /^(?:CANVAS|POSTER)_[A-Z_]+$/.test(error?.code || '')
    ? error.code
    : 'CANVAS_' + phase.toUpperCase() + '_FAILED';
  receipt.errors.push({ code, phase, message: '未通过此项检查；保留原图和已保存的源稿，不自动重画或加遮挡面板' });
}
export async function deliverCanvasText(input, ctx = {}, options = {}, demo = false) {
  const { signal, progress, checkpoint } = options,
    renderer = ctx.canvasRenderer || browserCanvasRenderer;
  const original = await loadCanvasText(input, ctx, renderer, options),
    { design } = original;
  const { base, release } = await claimCanvasName(input, design, signal);
  try {
    const receipt = {
      kind: demo ? 'visual_demo' : 'poster',
      renderer: 'canvas',
      designVersion: 'canvas-image-text-1',
      status: 'partial',
      width: design.width,
      height: design.height,
      files: [],
      textRendering: 'program',
      fontCheck: 'not_checked',
      visual: 'not_checked',
      interaction: 'not_checked',
      dataMode: 'provided',
      detection: design.detection,
      image: {
        width: design.image.width,
        height: design.image.height,
        hash: design.image.hash,
        upscaled: design.width > design.image.width || design.height > design.image.height
      },
      errors: [],
      notes: [
        '原图完整保留，仅Canvas真实字体排字；没有SVG或覆盖面板',
        '文案原样保留不保证文案事实或绝对无错字；字体、版式、底图像素与审美分别验收',
        '可在HTML拖动/缩放文字框；源稿重导出同步PPTX；画布尺寸不证明底图原生细节'
      ]
    };
    const artifacts = new Map();
    const save = async (format, blob, render = 'not_checked') => {
      const path = await saveCanvasFile(`${base}.${format}`, blob, ctx, signal);
      receipt.files.push({ format, path, readback: 'passed', structure: 'passed', render });
      artifacts.set(format, blob);
      await checkpoint?.({
        type: 'artifact_validation',
        path,
        validation: {
          kind: receipt.kind,
          readback: 'passed',
          render,
          visual: 'not_checked',
          business: 'not_checked',
          errors: receipt.errors.length
        }
      });
    };
    receipt.designPath = await saveCanvasFile(
      `${base}.canvas.json`,
      new Blob([JSON.stringify(design, null, 2)], { type: 'application/json' }),
      ctx,
      signal
    );
    const data = await imageData(original.blob),
      dataUri = `data:${data.mime};base64,${data.data}`;
    const html = createImageTextEditor(design, dataUri);
    await save('html', new Blob([html], { type: 'text/html' }));
    progress?.('正在按底图卡槽排字，核对中文、可读字号和底图像素…');
    let rendered;
    try {
      options.beginPosterAttempt?.();
      rendered = await renderer.render(original.blob, design, { signal });
      receipt.fontCheck = rendered.fontCheck?.status === 'passed' ? 'passed' : 'not_checked';
      receipt.layout = {
        status: rendered.layout?.status || 'not_checked',
        issues: rendered.layout?.errors || [],
        minimumBodyPixels: rendered.layout?.minimumBodyPixels
      };
      receipt.contrast = rendered.layout?.contrast || { status: 'not_checked' };
      receipt.backgroundCheck = rendered.backgroundCheck || { status: 'not_checked' };
      if (
        receipt.fontCheck !== 'passed' ||
        rendered.layout?.status !== 'passed' ||
        rendered.backgroundCheck?.status !== 'passed' ||
        design.detection.confidence < 0.8
      ) {
        receipt.errors.push({
          code: 'CANVAS_NEEDS_LAYOUT',
          phase: 'layout',
          message: '文字区、字体、全文排版或底图保护未通过，请在HTML调整位置/文案后复用.canvas.json；未输出最终PNG'
        });
      } else {
        await assertPosterPng(rendered.blob, design.width, design.height);
        await save('png', rendered.blob, 'passed');
        const width = rendered.layout.previewWidth,
          height = Math.ceil((design.height * width) / design.width);
        await assertPosterPng(rendered.previewBlob, width, height);
        receipt.phonePreview = {
          path: await saveCanvasFile(`${base}.phone.png`, rendered.previewBlob, ctx, signal),
          width,
          height,
          readback: 'passed'
        };
        artifacts.set('phone.png', rendered.previewBlob);
        try {
          await save('pptx', await composeImageTextPptx(design, dataUri, rendered.layout, rendered.fontCheck.family));
        } catch (error) {
          failure(receipt, error, 'pptx', signal);
        }
      }
    } catch (error) {
      failure(receipt, error, 'render', signal);
    }
    receipt.visualReport = await reviewCanvasText(
      ctx,
      design,
      original.blob,
      artifacts.get('png'),
      artifacts.get('phone.png'),
      options
    );
    receipt.visual = receipt.visualReport.status;
    if (options.requiresRichVisual) {
      const checks = receipt.visualReport.checks || {}, keys = ['visualsPresent', 'relatedToTopic', 'integrated'];
      const semantic = keys.some(k => checks[k] === false) ? 'failed' : keys.every(k => checks[k] === true) ? 'passed' : 'not_checked';
      receipt.contentCheck = { status: checks.visualsPresent === true ? 'passed' : checks.visualsPresent === false ? 'failed' : 'not_checked', semantic, basis: '实际原图、成品及手机预览复核；不改变原图或加遮挡面板' };
      if (semantic !== 'passed') receipt.errors.push({ code: 'CANVAS_ILLUSTRATION_UNVERIFIED', phase: 'visual' });
    }
    if (receipt.visual === 'failed')
      receipt.errors.push({
        code: 'CANVAS_VISUAL_NEEDS_REVIEW',
        phase: 'visual',
        message: '成品视觉检查提出问题，保留候选/源稿调整，不自动重画'
      });
    try {
      await save('zip', await packageCanvas(design, original, html, artifacts, signal));
    } catch (error) {
      failure(receipt, error, 'zip', signal);
    }
    if (!receipt.errors.length && ['png', 'pptx', 'html', 'zip'].every((format) => artifacts.has(format)))
      receipt.status = 'complete';
    await checkpoint?.({
      type: 'artifact_validation',
      path: receipt.designPath,
      validation: {
        kind: receipt.kind,
        readback: 'passed',
        render: artifacts.has('png') ? 'passed' : 'failed',
        visual: receipt.visual,
        business: 'not_checked',
        errors: receipt.errors.length
      }
    });
    return JSON.stringify(receipt);
  } finally {
    release();
  }
}

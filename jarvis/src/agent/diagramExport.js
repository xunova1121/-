import * as workspace from './workspace.js';
import { sceneSvg } from './diagramSceneSvg.js';
import { validateScene } from './diagramScene.js';
import { validateSvg } from './svgPreview.js';
import { reviewDiagram } from './diagramReview.js';
import { makeDiagramPptx } from './diagramPptx.js';
import { makeDiagramPdf } from './diagramPdf.js';
import { throwControl } from '../core/networkRequest.js';

export async function diagramDigest(value) {
  const blob = value instanceof Blob ? value : new Blob([value]);
  if (blob.size > 20e6) throw Object.assign(new Error('图形产物超过20MB'), { code: 'DIAGRAM_SIZE', kind: 'input' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (globalThis.crypto?.subtle)
    return 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  let a = 2166136261,
    b = 5381;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 16777619);
    b = Math.imul(b, 33) ^ byte;
  }
  return 'checksum:' + (a >>> 0).toString(16) + (b >>> 0).toString(16);
}

export function diagramFormats(input, request = '') {
  const formats = input.formats || [
    'svg',
    'png',
    ...(/PPT|pptx/i.test(request + input.path) ? ['pptx'] : []),
    ...(/PDF/i.test(request + input.path) ? ['pdf'] : [])
  ];
  if (!Array.isArray(formats) || formats.length > 4 || formats.some((format) => !['svg', 'png', 'pdf', 'pptx'].includes(format)))
    throw Object.assign(new Error('图形导出格式只支持SVG/PNG/PDF/PPTX'), { code: 'DIAGRAM_FORMAT', kind: 'input' });
  return [...new Set(['svg', 'png', ...formats])];
}

/** 一次准备、一张实际PNG、多格式只转换；失败产物留存并分别报告，不能改走另一套生成器。 */
export async function deliverDiagram(ctx, { scene, svg, path, formats, pptxMode = 'display', signal, checkpoint, progress, retrieval, reusePreview }) {
  throwControl(null, signal);
  if (scene) {
    validateScene(scene);
    svg = sceneSvg(scene);
  }
  const checked = validateSvg(svg);
  const frame = scene || {
    version: 1,
    title: path.split('/').at(-1),
    width: checked.width,
    height: checked.height,
    fontFace: 'Microsoft YaHei',
    fontFamily: 'Microsoft YaHei, Noto Sans CJK SC, sans-serif',
    elements: []
  };
  const designHash = await diagramDigest(scene ? JSON.stringify(scene) : svg);
  const written = await workspace.write(path.replace(/\.(?:svg|png|pdf|pptx)$/i, '') + '.svg', svg);
  const sourcePath = written.path;
  if ((await workspace.readText(sourcePath)) !== svg) throw Object.assign(new Error('SVG写入后读回不一致'), { code: 'DIAGRAM_READBACK', kind: 'api' });
  const base = sourcePath.replace(/\.svg$/i, '');
  const artifacts = [];
  const save = async (target, blob, format, consistency = 'shared_design') => {
    throwControl(null, signal);
    const result = await workspace.write(target, blob);
    const hash = await diagramDigest(blob);
    if ((await diagramDigest(await workspace.readBlob(result.path))) !== hash)
      throw Object.assign(new Error('图形产物读回不一致'), { code: 'DIAGRAM_READBACK', kind: 'api' });
    const record = { path: result.path, format, hash, designHash, consistency };
    artifacts.push(record);
    ctx.onFileChanged?.(result.path);
    await checkpoint?.({
      type: 'artifact_validation',
      path: result.path,
      validation: { format, structure: 'passed', readback: 'passed', render: 'not_checked', consistency, designHash, errors: 0 }
    });
    return record;
  };
  ctx.onFileChanged?.(sourcePath);
  artifacts.push({ path: sourcePath, format: 'svg', designHash, hash: await diagramDigest(svg), consistency: 'shared_design' });
  let designPath = null;
  if (scene) {
    const master = await workspace.write(base + '.diagram.json', JSON.stringify(scene));
    designPath = master.path;
    if ((await workspace.readText(designPath)) !== JSON.stringify(scene))
      throw Object.assign(new Error('设计稿读回不一致'), { code: 'DIAGRAM_READBACK', kind: 'api' });
    ctx.onFileChanged?.(designPath);
  }
  await checkpoint?.({
    type: 'artifact_validation',
    path: sourcePath,
    validation: {
      format: 'svg',
      structure: 'passed',
      readback: 'passed',
      render: 'not_checked',
      visual: 'not_checked',
      business: 'not_checked',
      designHash,
      errors: 0
    }
  });
  if (reusePreview && (
    reusePreview.sourceHash !== await diagramDigest(svg) ||
    (reusePreview.designHash && reusePreview.designHash !== designHash) ||
    (reusePreview.previewHash && reusePreview.previewHash !== await diagramDigest(await workspace.readBlob(reusePreview.previewPath)))
  ))
    throw Object.assign(new Error('候选预览与设计稿或PNG摘要不符，禁止导出'), { code: 'DIAGRAM_PREVIEW_CHANGED', kind: 'input' });
  if (reusePreview?.designHash && reusePreview.render === 'passed' && reusePreview.visual !== 'failed') {
    const selectedPng = await workspace.readBlob(reusePreview.previewPath);
    const delivered = await workspace.write(base + '-预览.png', selectedPng);
    if (await diagramDigest(await workspace.readBlob(delivered.path)) !== reusePreview.previewHash)
      throw Object.assign(new Error('选中预览复制后读回不一致'), { code: 'DIAGRAM_READBACK', kind: 'api' });
    reusePreview = { ...reusePreview, previewPath: delivered.path };
    ctx.onFileChanged?.(delivered.path);
  }
  const preview = reusePreview || (await reviewDiagram(ctx, { path: sourcePath, svg, previewPath: base + '-预览.png', signal, progress, retrieval }));
  if (preview.render !== 'passed' || preview.sourceChanged || preview.visual === 'failed')
    return {
      designHash,
      designPath,
      sourcePath,
      preview,
      artifacts,
      errors: [{ format: 'png', code: preview.errorCode || 'DIAGRAM_RENDER', message: preview.note || '视觉检查未通过，停止派生其他格式' }]
    };
  const png = await workspace.readBlob(preview.previewPath);
  const previewHash = await diagramDigest(png);
  artifacts.push({ path: preview.previewPath, format: 'png', hash: previewHash, designHash, consistency: 'shared_render' });
  const errors = [];
  let editable = null;
  for (const format of formats.filter((format) => ['pdf', 'pptx'].includes(format))) {
    try {
      progress?.('正在从同一设计稿导出' + format.toUpperCase() + '…');
      const blob = format === 'pdf' ? await makeDiagramPdf(frame, png) : await makeDiagramPptx(frame, { png });
      await save(base + '.' + format, blob, format, 'shared_render');
      if (format === 'pptx' && pptxMode === 'editable') {
        if (!scene) throw Object.assign(new Error('旧SVG没有结构化设计稿，只能提供一致的展示PPT'), { code: 'DIAGRAM_EDITABLE_SOURCE', kind: 'capability' });
        const native = await makeDiagramPptx(scene, { editable: true });
        const held = await workspace.write('文档检查/' + base.split('/').at(-1) + '-可编辑.pptx', native);
        editable = { state: 'not_checked', note: '未提供真实PPT渲染对照环境，可编辑版未交付' };
        if (ctx.compareDiagramPpt) editable = await ctx.compareDiagramPpt(native, png, { signal });
        if (editable.passed) await save(base + '-可编辑.pptx', native, 'pptx', 'render_compared');
        else
          errors.push({
            format: 'pptx-editable',
            code: 'DIAGRAM_EDITABLE_UNVERIFIED',
            message: '可编辑版对照未通过，保留在' + held.path + '；请使用同画面展示版'
          });
      }
    } catch (error) {
      throwControl(error, signal);
      errors.push({ format, code: error.code || error.name, message: String(error.message).slice(0, 200) });
    }
  }
  const manifest = {
    version: 1,
    designHash,
    designPath,
    sourcePath,
    previewHash,
    artifacts,
    editable,
    errors,
    visual: preview.visual,
    note: '共享渲染表示画面来自同一PNG，不等于业务内容已核实；可编辑PPT必须另经渲染比较'
  };
  const manifestFile = await workspace.write(base + '.exports.json', JSON.stringify(manifest, null, 2));
  ctx.onFileChanged?.(manifestFile.path);
  return { ...manifest, preview, manifestPath: manifestFile.path };
}

export function createExportDiagramTool(ctx) {
  return {
    name: 'export_diagram',
    description:
      '把已确认的.diagram.json设计稿或已有SVG统一导出PNG/PDF/PPT；不重写内容、不让PPT单独排版。PPT默认展示版与PNG同画面；editable另做原生图形并经真实渲染对照才交付。',
    input_schema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string' },
        formats: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['svg', 'png', 'pdf', 'pptx'] } },
        pptxMode: { type: 'string', enum: ['display', 'editable'] }
      },
      required: ['sourcePath', 'formats'],
      additionalProperties: false
    },
    run: async ({ sourcePath, formats, pptxMode }, options = {}) => {
      const source = await workspace.readBlob(sourcePath);
      if (source.size > 2e6) throw Object.assign(new Error('设计稿超过2MB'), { code: 'DIAGRAM_SIZE', kind: 'input' });
      const isScene = /\.diagram\.json$/i.test(sourcePath);
      const scene = isScene ? validateScene(JSON.parse(await source.text())) : null;
      const svg = scene ? sceneSvg(scene) : await source.text();
      const designHash = await diagramDigest(scene ? JSON.stringify(scene) : svg);
      let reusePreview = null;
      const manifestPath = sourcePath.replace(/(?:\.diagram\.json|\.svg)$/i, '.exports.json');
      try {
        const manifestBlob = await workspace.readBlob(manifestPath);
        if (manifestBlob.size <= 100000) {
          const manifest = JSON.parse(await manifestBlob.text());
          const pngRecord = manifest.artifacts?.find((item) => item.format === 'png');
          if (manifest.designHash === designHash && pngRecord && (await diagramDigest(await workspace.readBlob(pngRecord.path))) === manifest.previewHash)
            reusePreview = {
              render: 'passed',
              visual: manifest.visual,
              previewPath: pngRecord.path,
              sourceHash: await diagramDigest(svg),
              note: '设计与PNG摘要一致，复用已确认预览，不重新换字体或调用模型'
            };
        }
      } catch (error) {
        throwControl(error, options.signal);
      }
      const result = await deliverDiagram(ctx, {
        scene,
        svg,
        path: sourcePath.replace(/\.diagram\.json$/i, '.svg'),
        formats: diagramFormats({ formats }),
        pptxMode,
        ...options,
        reusePreview
      });
      return '已从同一设计稿导出图形，按各格式状态交付：\n' + JSON.stringify(result);
    }
  };
}

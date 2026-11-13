import * as workspace from './workspace.js';
import { imageData } from './imageRegion.js';
import { imageFormat } from './imageFormat.js';
import { renderSvg, validateSvg } from './svgPreview.js';
import { imageFingerprint } from './visualEvidence.js';
import { throwControl } from '../core/networkRequest.js';
import { assertDiagramTarget } from './diagramTarget.js';

export async function diagramPreview(ctx, svg, options = {}) {
  validateSvg(svg);
  if (ctx.renderSvg) return ctx.renderSvg(svg, options);
  // 保留旧注入接口供桌面扩展使用，但必须解码并核对真实PNG字节。
  if (ctx.renderDiagram) {
    const image = await ctx.renderDiagram(svg, options);
    if (image?.data) return new Blob([Uint8Array.from(atob(image.data), (letter) => letter.charCodeAt(0))], { type: image.mime });
  }
  return renderSvg(svg, options);
}

/** PNG与源图绑定，不凭文件名推断是同一版；最多一次视觉审查，无额外生成请求。 */
export async function reviewDiagram(ctx, { path, svg, previewPath, signal, progress, visual = true, retrieval }) {
  const result = { render: 'not_checked', visual: 'not_checked', note: '', sourcePath: path, sourceHash: await imageFingerprint(new Blob([svg])) };
  try {
    progress?.('正在把指定源图渲染为真实PNG…');
    const blob = await diagramPreview(ctx, svg, { signal });
    if ((await imageFormat(blob))?.ext !== 'png') throw Object.assign(new Error('渲染结果不是真正PNG'), { code: 'SVG_RENDER_INVALID', kind: 'api' });
    if (previewPath) {
      const written = await workspace.write(previewPath, blob);
      const saved = await workspace.readBlob(written.path);
      const expected = new Uint8Array(await blob.arrayBuffer());
      const actual = new Uint8Array(await saved.arrayBuffer());
      if (expected.length !== actual.length || !expected.every((value, index) => actual[index] === value))
        throw Object.assign(new Error('PNG写入后读回不一致'), { code: 'SVG_PREVIEW_READBACK', kind: 'api' });
      result.previewPath = written.path;
      ctx.onFileChanged?.(written.path);
    }
    result.render = 'passed';
    if (visual && ctx.visionLlm) {
      progress?.('正在检查真实预览的文字、连线和层次…');
      retrieval?.consume('model');
      const response = await ctx.visionLlm({
        system:
          '检查实际图形预览的文字溢出、重叠、连线穿字、过密与层级可读性。不要把外侧走线本身当错误；只有实际影响理解才指出。不能核实业务真实性。只返回JSON：{"passed":true或false,"issues":[具体问题及位置]}；看不清则passed=false。',
        prompt: '核对本次提供的真实渲染图，不引用旧图的检查结论。',
        images: [await imageData(blob)],
        signal
      });
      let verdict;
      try {
        verdict = JSON.parse(String(response).replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        /* 格式异常不能当视觉通过。 */
      }
      if (typeof verdict?.passed !== 'boolean' || !Array.isArray(verdict.issues)) result.note = '视觉审查返回格式无效，未完成视觉验收。';
      else {
        result.visual = verdict.passed && !verdict.issues.length ? 'passed' : 'failed';
        result.note = verdict.issues
          .slice(0, 8)
          .map((item) => String(item).slice(0, 160))
          .join('；');
      }
    } else if (visual) result.note = 'PNG已渲染，未配置看图模型，未进行视觉验收。';
    if ((await workspace.exists(path)) && (await workspace.readText(path)) !== svg) {
      result.visual = 'not_checked';
      result.sourceChanged = true;
      result.note = '源文件在检查期间发生变化，预览仅对应回执中的sourceHash，不能作为当前版本的视觉验收。';
    }
  } catch (error) {
    throwControl(error, signal);
    result.errorCode = String(error.code || error.name || 'SVG_RENDER').slice(0, 80);
    result.note =
      result.render === 'passed' ? '预览已保留，但视觉检查失败，不能声称验收通过。' : '渲染未完成，源文件保留；' + String(error.message).slice(0, 180);
  }
  return result;
}

export function createRenderDiagramTool(ctx) {
  return {
    name: 'render_diagram',
    description:
      '读取指定已有SVG源文件，真正转换为PNG预览，并用已配置看图模型检查。也识别误标成.jpg的SVG；必须先定位用户所指的确切版本，不自动选择最新文件，不靠改后缀冒充转换。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        previewPath: { type: 'string', description: '输出PNG路径，默认源图同目录的“名称-预览.png”' },
        visual: { type: 'boolean', description: '默认做一次视觉审查；只转格式时可设false' }
      },
      required: ['path'],
      additionalProperties: false
    },
    run: async ({ path, previewPath, visual = true }, { signal, checkpoint, progress, retrieval, rawRequestText } = {}) => {
      throwControl(null, signal);
      assertDiagramTarget(path, rawRequestText);
      const source = await workspace.readBlob(path);
      if (source.size > 2e6 || (await imageFormat(source))?.ext !== 'svg')
        throw Object.assign(new Error('指定文件不是2MB以内的SVG内容'), { code: 'SVG_INPUT', kind: 'input' });
      const target = previewPath || path.replace(/\.[^/.]+$/, '') + '-预览.png';
      if (!/\.png$/i.test(target) || workspace.normalize(target) === workspace.normalize(path))
        throw Object.assign(new Error('预览需另存.png，不得覆盖源文件'), { code: 'SVG_PREVIEW_PATH', kind: 'input' });
      const receipt = await reviewDiagram(ctx, { path, svg: await source.text(), previewPath: target, signal, progress, visual, retrieval });
      await checkpoint?.({
        type: 'artifact_validation',
        path,
        validation: {
          format: 'svg',
          readback: 'passed',
          render: receipt.render,
          visual: receipt.visual,
          business: 'not_checked',
          errors: receipt.render !== 'passed' || receipt.visual === 'failed' ? 1 : 0
        }
      });
      if (receipt.render !== 'passed') throw Object.assign(new Error(receipt.note), { code: receipt.errorCode || 'SVG_RENDER', kind: 'capability' });
      ctx.onPreview?.(receipt.previewPath);
      return '指定源图已转换为真实PNG；视觉与业务状态分别报告：\n' + JSON.stringify(receipt);
    }
  };
}

import * as workspace from './workspace.js';
import { parseFile } from './docs.js';
import { layoutDiagram } from './diagramModel.js';
import { diagramSvg } from './diagramSvg.js';
import { rasterize } from './slidePreview.js';
import { throwControl } from '../core/networkRequest.js';

async function checkSources(sources, signal) {
  const checks = [];
  for (const source of sources) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const blob = await workspace.readBlob(source.path);
    if (blob.size > 10e6) throw Object.assign(new Error('来源文件超过10MB，请先分段提取相关材料'), { code: 'DIAGRAM_SOURCE_SIZE', kind: 'input' });
    const parsed = await parseFile(blob, source.path, { limit: 120000 });
    const excerpt = String(source.excerpt || '').trim();
    const matched = Boolean(excerpt && parsed.text.replace(/\s+/g, '').includes(excerpt.replace(/\s+/g, '')));
    checks.push({ path: source.path, matched, truncated: parsed.chars > 120000 });
  }
  return checks;
}

export function createDiagramTool(ctx) {
  return {
    name: 'create_diagram',
    description: '制作原生可编辑SVG架构图/分层关系图：先从原材料提取层级、节点和关系，再传入结构。默认输入层级从底到顶，突出emphasis层；不调用艺术画图、不顺带制作Word/PPT。sources逐条给原文摘录核对，缺证据只交草稿。',
    input_schema: { type: 'object', properties: {
      path: { type: 'string', description: '输出.svg路径' }, title: { type: 'string', maxLength: 80 }, direction: { type: 'string', enum: ['bottom-up', 'top-down'] },
      layers: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { title: { type: 'string', maxLength: 48 }, emphasis: { type: 'boolean' }, nodes: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: { id: { type: 'string', maxLength: 64 }, title: { type: 'string', maxLength: 48 }, detail: { type: 'string', maxLength: 160 } }, required: ['id', 'title'], additionalProperties: false } } }, required: ['title', 'nodes'], additionalProperties: false } },
      edges: { type: 'array', maxItems: 100, items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false } },
      sources: { type: 'array', maxItems: 4, items: { type: 'object', properties: { path: { type: 'string', maxLength: 400 }, excerpt: { type: 'string', maxLength: 240 } }, required: ['path', 'excerpt'], additionalProperties: false } }
    }, required: ['path', 'title', 'layers'], additionalProperties: false },
    run: async (input, { signal, checkpoint, progress } = {}) => {
      if (!/\.svg$/i.test(input.path)) throw Object.assign(new Error('可编辑图输出需使用.svg后缀，不冒充Office文件'), { code: 'DIAGRAM_FORMAT', kind: 'input' });
      const model = layoutDiagram(input);
      progress?.('正在核对材料和图形结构…');
      const sources = await checkSources(input.sources || [], signal);
      const svg = diagramSvg(model);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await workspace.write(input.path, svg);
      const readback = await workspace.readText(result.path);
      if (readback !== svg) throw Object.assign(new Error('图形写入后读回不一致'), { code: 'DIAGRAM_READBACK', kind: 'api' });
      ctx.onFileChanged?.(result.path);
      await checkpoint?.({ type: 'artifact_validation', path: result.path, validation: { format: 'svg', readback: 'passed', structure: 'passed', render: 'not_checked', visual: 'not_checked', business: 'not_checked', errors: 0 } });
      let render = 'not_checked';
      let visual = 'not_checked';
      let preview = null;
      let reviewNote = '';
      try {
        progress?.('正在渲染架构图预览…');
        preview = ctx.renderDiagram ? await ctx.renderDiagram(svg, { signal }) : await rasterize(svg);
        if (preview) render = 'passed';
        if (preview && ctx.visionLlm) {
          progress?.('正在检查文字遮挡、层级与连线…');
          const verdict = await ctx.visionLlm({ system: '检查架构图实际预览，只检查文字溢出、遮挡、节点重叠、连线穿字和层级可读性，不检查材料业务真伪。只能返回JSON：{"passed":true或false,"issues":[具体问题]}。看不清或无法判断则passed=false。', prompt: '请检查这张实际渲染图。', images: [preview], signal });
          const parsed = JSON.parse(String(verdict).replace(/^```(?:json)?\s*|\s*```$/g, ''));
          if (typeof parsed.passed === 'boolean' && Array.isArray(parsed.issues)) {
            visual = parsed.passed && !parsed.issues.length ? 'passed' : 'failed';
            reviewNote = parsed.issues.slice(0, 8).map(item => String(item).slice(0, 120)).join('；');
          }
        }
      } catch (error) {
        throwControl(error, signal);
        reviewNote = '渲染或视觉检查未完成，不能声称视觉验收通过。';
      }
      const business = sources.length && sources.every(source => source.matched && !source.truncated) ? 'source_excerpts_matched' : 'not_checked';
      const validation = { format: 'svg', readback: 'passed', structure: 'passed', render, visual, business, errors: visual === 'failed' ? 1 : 0 };
      await checkpoint?.({ type: 'artifact_validation', path: result.path, validation });
      ctx.onPreview?.(result.path);
      return `已生成可编辑SVG：${result.path}\n${JSON.stringify({ validation, sources, note: reviewNote })}\n源文件只含原生文字、形状和连线，没有嵌入整张不可编辑图片。原文摘录匹配不等于业务内容全面核实；未做的检查须如实说明。`;
    }
  };
}

import * as workspace from './workspace.js';
import { parseFile } from './docs.js';
import { layoutDiagram } from './diagramModel.js';
import { diagramSvg } from './diagramSvg.js';
import { reviewDiagram } from './diagramReview.js';

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
    description: '制作精确的可编辑分层架构图，同时尝试输出真实PNG预览和视觉审查。先整理层级与支撑关系，默认输入从底到顶、emphasis突出核心；总体图只传必要主关系，详细业务流另画，不堆所有连线。sources摘录核对不等于业务全核实。',
    input_schema: { type: 'object', properties: {
      path: { type: 'string', description: '输出.svg路径' }, title: { type: 'string', maxLength: 80 }, direction: { type: 'string', enum: ['bottom-up', 'top-down'] },
      layers: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { title: { type: 'string', maxLength: 48 }, emphasis: { type: 'boolean' }, nodes: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: { id: { type: 'string', maxLength: 64 }, title: { type: 'string', maxLength: 48 }, detail: { type: 'string', maxLength: 160 } }, required: ['id', 'title'], additionalProperties: false } } }, required: ['title', 'nodes'], additionalProperties: false } },
      edges: { type: 'array', maxItems: 100, items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false } },
      sources: { type: 'array', maxItems: 4, items: { type: 'object', properties: { path: { type: 'string', maxLength: 400 }, excerpt: { type: 'string', maxLength: 240 } }, required: ['path', 'excerpt'], additionalProperties: false } }
    }, required: ['path', 'title', 'layers'], additionalProperties: false },
    run: async (input, { signal, checkpoint, progress, retrieval } = {}) => {
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
      const preview = await reviewDiagram(ctx, { path: result.path, svg, previewPath: result.path.replace(/\.svg$/i, '-预览.png'), signal, progress, retrieval });
      const { render, visual } = preview;
      const business = sources.length && sources.every(source => source.matched && !source.truncated) ? 'source_excerpts_matched' : 'not_checked';
      const validation = { format: 'svg', readback: 'passed', structure: 'passed', render, visual, business, errors: visual === 'failed' ? 1 : 0 };
      await checkpoint?.({ type: 'artifact_validation', path: result.path, validation });
      ctx.onPreview?.(result.path);
      return `已生成可编辑SVG：${result.path}\n${JSON.stringify({ validation, sources, preview })}\n源文件只含原生文字、形状和连线，没有嵌入整张不可编辑图片。原文摘录匹配不等于业务内容全面核实；未做的检查须如实说明。`;
    }
  };
}

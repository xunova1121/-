import * as workspace from './workspace.js';
import { parseFile } from './docs.js';
import { DIAGRAM_PLANNING, planDiagramContent } from './diagramPlanning.js';
import { layoutDiagram } from './diagramModel.js';
import { diagramScene } from './diagramScene.js';
import { deliverDiagram, diagramFormats } from './diagramExport.js';

async function checkSources(sources, signal) {
  const checks = [];
  const materials = [];
  for (const source of sources) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const blob = await workspace.readBlob(source.path);
    if (blob.size > 10e6) throw Object.assign(new Error('来源文件超过10MB，请先分段提取相关材料'), { code: 'DIAGRAM_SOURCE_SIZE', kind: 'input' });
    const parsed = await parseFile(blob, source.path, { limit: 120000 });
    const excerpt = String(source.excerpt || '').trim();
    const matched = Boolean(excerpt && parsed.text.replace(/\s+/g, '').includes(excerpt.replace(/\s+/g, '')));
    materials.push({ path: source.path, text: parsed.text });
    checks.push({ path: source.path, matched, truncated: parsed.chars > 120000 });
  }
  return { checks, materials };
}

export function createDiagramTool(ctx) {
  return {
    name: 'create_diagram',
    description: DIAGRAM_PLANNING + ' 架构图唯一制作入口：先明确读者、主结论、层级和主关系，形成可复用.diagram.json设计稿；SVG/PNG/PDF/PPT全部从同稿导出，不能让普通PPT工具重画。PPT默认展示版同画面，editable原生版须渲染对照。修改或换格式用export_diagram复用设计稿；总体与详细流程分开表达。',
    input_schema: { type: 'object', properties: {
      path: { type: 'string', description: '输出路径，支持.svg/.png/.pdf/.pptx；会保留同名SVG及设计稿' }, title: { type: 'string', maxLength: 80 }, direction: { type: 'string', enum: ['bottom-up', 'top-down'] },
      formats: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['svg', 'png', 'pdf', 'pptx'] } },
      pptxMode: { type: 'string', enum: ['display', 'editable'] },
      design: { type: 'object', properties: { theme: { type: 'string', enum: ['navy', 'jade', 'charcoal'] }, message: { type: 'string', maxLength: 100 }, audience: { type: 'string', maxLength: 80 } }, additionalProperties: false },
      layers: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { title: { type: 'string', maxLength: 48 }, emphasis: { type: 'boolean' }, nodes: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: { id: { type: 'string', maxLength: 64 }, title: { type: 'string', maxLength: 48 }, detail: { type: 'string', maxLength: 160 } }, required: ['id', 'title'], additionalProperties: false } } }, required: ['title', 'nodes'], additionalProperties: false } },
      edges: { type: 'array', maxItems: 100, items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false } },
      contentPlan: { type: 'object', properties: { facts: { type: 'array', maxItems: 80, items: { type: 'object', properties: { text: { type: 'string', maxLength: 160 }, source: { type: 'string', maxLength: 400 }, excerpt: { type: 'string', maxLength: 240 } }, required: ['text', 'source', 'excerpt'], additionalProperties: false } }, recommendations: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 160 } } }, additionalProperties: false },
      sources: { type: 'array', maxItems: 4, items: { type: 'object', properties: { path: { type: 'string', maxLength: 400 }, excerpt: { type: 'string', maxLength: 240 } }, required: ['path', 'excerpt'], additionalProperties: false } }
    }, required: ['path', 'title', 'layers'], additionalProperties: false },
    run: async (input, { signal, checkpoint, progress, retrieval, rawRequestText } = {}) => {
      if (!/\.(svg|png|pdf|pptx)$/i.test(input.path)) throw Object.assign(new Error('图形输出需使用SVG/PNG/PDF/PPTX后缀'), { code: 'DIAGRAM_FORMAT', kind: 'input' });
      const model = layoutDiagram(input);
      progress?.('正在核对材料和图形结构…');
      const { checks: sources, materials } = await checkSources(input.sources || [], signal);
      const contentPlan = planDiagramContent(input, materials, rawRequestText);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      let contentPlanPath;
      if (input.contentPlan) {
        const target = '文档检查/架构内容/' + crypto.randomUUID() + '.json';
        contentPlanPath = (await workspace.write(target, JSON.stringify(contentPlan))).path;
      }
      const scene = diagramScene(model, input.design);
      const result = await deliverDiagram(ctx, { scene, path: input.path, formats: diagramFormats(input, rawRequestText), pptxMode: input.pptxMode, signal, checkpoint, progress, retrieval });
      const { preview } = result;
      const { render, visual } = preview;
      const business = sources.length && sources.every(source => source.matched && !source.truncated) ? 'source_excerpts_matched' : 'not_checked';
      const validation = { format: 'svg', readback: 'passed', structure: 'passed', render, visual, business, designHash: result.designHash, errors: result.errors?.length || (visual === 'failed' ? 1 : 0) };
      await checkpoint?.({ type: 'artifact_validation', path: result.sourcePath, validation });
      ctx.onPreview?.(result.sourcePath);
      return `已生成可编辑SVG：${result.sourcePath}\n${JSON.stringify({ validation, sources, contentPlan: { path: contentPlanPath, coverage: contentPlan.coverage, factCount: contentPlan.facts.length, recommendationCount: contentPlan.recommendations.length }, ...result })}\nSVG为原生图形；展示PPT与PDF复用同一PNG，展示PPT不冒充原生可编辑版。原文摘录匹配不等于业务全面核实，未做的检查及失败格式须如实说明。`;
    }
  };
}

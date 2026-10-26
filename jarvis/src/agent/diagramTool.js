import { chooseDiagram } from './diagramCandidates.js';
import { SECTION_KINDS } from './diagramSections.js';
import { DIAGRAM_ICONS } from './diagramCards.js';
import * as workspace from './workspace.js';
import { checkSources } from './diagramSources.js';
import { DIAGRAM_PLANNING, planDiagramContent } from './diagramPlanning.js';
import { layoutDiagram } from './diagramModel.js';
import { diagramScene } from './diagramScene.js';
import { deliverDiagram, diagramFormats } from './diagramExport.js';


export function createDiagramTool(ctx) {
  return {
    name: 'create_diagram',
    description: DIAGRAM_PLANNING + ' 架构图唯一制作入口：重要交付或明确要求比较优化时用quality=compare，按真实PNG比较并最多一次间距修复；缺看图模型如实not_checked。先明确读者、主结论、层级和主关系，形成可复用.diagram.json设计稿；SVG/PNG/PDF/PPT全部从同稿导出，不能让普通PPT工具重画。PPT默认展示版同画面，editable原生版须渲染对照。修改或换格式用export_diagram复用设计稿；总体与详细流程分开表达。业务端用icon、accent(orange/blue/green)、2～5条bullets、badge；同层相邻节点流程可用edge.label(最多12字)，不能给跨层边加label。政企总体图优先gov-blue主题；kind=grid放8～18个纯标题模块，band用一个节点组成反馈/安全通栏，columns放2～4栏(可带subtitle/detail)。同一平台的层用相同group连续排列，形成共同标题与容器；新组合默认从上到下，旧普通层仍默认从下到上，可用direction明确指定。字段不会静默丢弃，普通cards层仍最多12节点。',
    input_schema: { type: 'object', properties: {
      path: { type: 'string', description: '输出路径，支持.svg/.png/.pdf/.pptx；会保留同名SVG及设计稿' }, title: { type: 'string', maxLength: 80 }, direction: { type: 'string', enum: ['bottom-up', 'top-down'] },
      formats: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['svg', 'png', 'pdf', 'pptx'] } },
      pptxMode: { type: 'string', enum: ['display', 'editable'] },
      quality: { type: 'string', enum: ['standard', 'compare'], description: 'compare生成紧凑/舒展真实预览，最多一次间距修复；未配置视觉模型不能算通过，默认standard保持旧流程' },
      design: { type: 'object', properties: { theme: { type: 'string', enum: ['navy', 'jade', 'charcoal', 'gov-blue'] }, message: { type: 'string', maxLength: 100 }, audience: { type: 'string', maxLength: 80 } }, additionalProperties: false },
      layers: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { title: { type: 'string', maxLength: 48 }, kind: { type: 'string', enum: SECTION_KINDS }, group: { type: 'string', maxLength: 48 }, emphasis: { type: 'boolean' }, nodes: { type: 'array', minItems: 1, maxItems: 18, items: { type: 'object', properties: { id: { type: 'string', maxLength: 64 }, title: { type: 'string', maxLength: 48 }, detail: { type: 'string', maxLength: 160 }, subtitle: { type: 'string', maxLength: 48 }, icon: { type: 'string', enum: DIAGRAM_ICONS }, accent: { type: 'string', enum: ['orange', 'blue', 'green'] }, badge: { type: 'string', maxLength: 28 }, bullets: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'object', properties: { text: { type: 'string', maxLength: 80 }, icon: { type: 'string', enum: DIAGRAM_ICONS } }, required: ['text'], additionalProperties: false } } }, required: ['id', 'title'], additionalProperties: false } } }, required: ['title', 'nodes'], additionalProperties: false } },
      edges: { type: 'array', maxItems: 100, items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string', maxLength: 12 } }, required: ['from', 'to'], additionalProperties: false } },
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
      let scene = diagramScene(model, input.design);
      const candidate = input.quality === 'compare' ? await chooseDiagram(ctx, scene, { signal, checkpoint, progress, retrieval }) : null;
      if (candidate) scene = candidate.scene;
      const result = await deliverDiagram(ctx, { scene, path: input.path, formats: diagramFormats(input, rawRequestText), pptxMode: input.pptxMode, signal, checkpoint, progress, retrieval, reusePreview: candidate?.preview });
      const { preview } = result;
      const { render, visual } = preview;
      const business = sources.length && sources.every(source => source.matched && !source.truncated) ? 'source_excerpts_matched' : 'not_checked';
      const validation = { format: 'svg', readback: 'passed', structure: 'passed', render, visual, business, designHash: result.designHash, errors: result.errors?.length || (visual === 'failed' ? 1 : 0) };
      await checkpoint?.({ type: 'artifact_validation', path: result.sourcePath, validation });
      ctx.onPreview?.(result.sourcePath);
      return `已生成可编辑SVG：${result.sourcePath}\n${JSON.stringify({ validation, sources, candidateStatePath: candidate?.statePath, contentPlan: { path: contentPlanPath, coverage: contentPlan.coverage, factCount: contentPlan.facts.length, recommendationCount: contentPlan.recommendations.length }, ...result })}\nSVG为原生图形；展示PPT与PDF复用同一PNG，展示PPT不冒充原生可编辑版。原文摘录匹配不等于业务全面核实，未做的检查及失败格式须如实说明。`;
    }
  };
}

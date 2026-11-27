import { loadArchitecture, projectArchitecture } from './architectureProjection.js';
import { resumeArchitectureReview } from './architectureResume.js';
import { chooseDiagram } from './diagramCandidates.js';
import { SECTION_KINDS } from './diagramSections.js';
import { DIAGRAM_ICONS } from './diagramCards.js';
import * as workspace from './workspace.js';
import { checkSources } from './diagramSources.js';
import { DIAGRAM_PLANNING, planDiagramContent, strictArchitecture } from './diagramPlanning.js';
import { layoutDiagram } from './diagramModel.js';
import { layoutWithRepair, tidyLabels } from './diagramRepair.js';
import { diagramScene } from './diagramScene.js';
import { deliverDiagram, diagramFormats, diagramDigest } from './diagramExport.js';

export function createDiagramTool(ctx, { requireArchitecture = false } = {}) {
  return {
    name: 'create_diagram',
    description:
      DIAGRAM_PLANNING +
      ' 架构图唯一制作入口：重要交付或明确要求比较优化时用quality=compare，按真实PNG比较并最多一次间距修复；缺看图模型如实not_checked。先明确读者、主结论、层级和主关系，形成可复用.diagram.json设计稿；SVG/PNG/PDF/PPT全部从同稿导出，不能让普通PPT工具重画。PPT默认展示版同画面，editable原生版须渲染对照。修改或换格式用export_diagram复用设计稿；总体与详细流程分开表达。业务端用icon、accent(orange/blue/green)、2～5条bullets、badge；同层相邻节点流程可用edge.label(最多12字)，不能给跨层边加label。政企总体图优先gov-blue主题；kind=grid放8～18个纯标题模块，band用一个节点组成反馈/安全通栏，columns放2～4栏(可带subtitle/detail)。同一平台的层用相同group连续排列，形成共同标题与容器；新组合默认从上到下，旧普通层仍默认从下到上，可用direction明确指定。字段不会静默丢弃，普通cards层仍最多12节点。',
    input_schema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['overview', 'workflow', 'dataflow', 'relations'],
          description: '底稿默认overview组成与闭环；workflow仅业务及反馈；dataflow仅数据传输；relations为全关系调试视图。各视图不混画，回执记录委派关系'
        },
        architecturePath: { type: 'string', maxLength: 400, description: '已有业务底稿路径优先复用；技术性not_checked可在此恢复一次，明确failed不能绕过，正式交付仍须结构和语义通过' },
        draft: { type: 'boolean', description: '仅生成黑白逻辑草图，不作为正式交付' },
        diagramType: {
          type: 'string',
          enum: ['architecture', 'workflow', 'dataflow', 'general'],
          description: '默认architecture；流程/数据流/一般图形不能借此绕过用户明确要求的架构审查'
        },
        path: { type: 'string', description: '输出路径，支持.svg/.png/.pdf/.pptx；会保留同名SVG及设计稿' },
        title: { type: 'string', maxLength: 80 },
        direction: { type: 'string', enum: ['bottom-up', 'top-down'] },
        formats: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['svg', 'png', 'pdf', 'pptx'] } },
        pptxMode: { type: 'string', enum: ['display', 'editable'] },
        quality: {
          type: 'string',
          enum: ['standard', 'compare'],
          description: 'compare生成紧凑/舒展真实预览，最多一次间距修复；未配置视觉模型不能算通过，默认standard保持旧流程'
        },
        design: {
          type: 'object',
          properties: {
            theme: { type: 'string', enum: ['navy', 'jade', 'charcoal', 'gov-blue'] },
            message: { type: 'string', maxLength: 100 },
            audience: { type: 'string', maxLength: 80 }
          },
          additionalProperties: false
        },
        layers: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 48 },
              kind: { type: 'string', enum: SECTION_KINDS.filter(kind => kind !== 'catalog') },
              group: { type: 'string', maxLength: 48 },
              role: {
                type: 'string',
                description: '按实际职责选择，标题以对应职责名开头，可用｜追加原文分组；不强迫凑齐所有层',
                enum: ['interface', 'application', 'capability', 'data', 'acquisition', 'infrastructure', 'system', 'security']
              },
              emphasis: { type: 'boolean' },
              nodes: {
                type: 'array',
                minItems: 1,
                maxItems: 18,
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', maxLength: 64 },
                    title: { type: 'string', maxLength: 48 },
                    detail: { type: 'string', maxLength: 160 },
                    subtitle: { type: 'string', maxLength: 48 },
                    icon: { type: 'string', enum: DIAGRAM_ICONS },
                    accent: { type: 'string', enum: ['orange', 'blue', 'green'] },
                    badge: { type: 'string', maxLength: 28 },
                    bullets: {
                      type: 'array',
                      minItems: 2,
                      maxItems: 5,
                      items: {
                        type: 'object',
                        properties: { text: { type: 'string', maxLength: 80 }, icon: { type: 'string', enum: DIAGRAM_ICONS } },
                        required: ['text'],
                        additionalProperties: false
                      }
                    }
                  },
                  required: ['id', 'title'],
                  additionalProperties: false
                }
              }
            },
            required: ['title', 'nodes'],
            additionalProperties: false
          }
        },
        edges: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              label: { type: 'string', maxLength: 12 },
              type: { type: 'string', enum: ['supports', 'dataflow', 'workflow', 'feedback', 'integration'] }
            },
            required: ['from', 'to'],
            additionalProperties: false
          }
        },
        contentPlan: {
          type: 'object',
          properties: {
            facts: {
              type: 'array',
              maxItems: 80,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', maxLength: 160 },
                  source: { type: 'string', maxLength: 400 },
                  excerpt: { type: 'string', maxLength: 240 }
                },
                required: ['text', 'source', 'excerpt'],
                additionalProperties: false
              }
            },
            recommendations: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 160 } }
          },
          additionalProperties: false
        },
        sources: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            properties: { path: { type: 'string', maxLength: 400 }, excerpt: { type: 'string', maxLength: 240 } },
            required: ['path', 'excerpt'],
            additionalProperties: false
          }
        }
      },
      required: ['path'],
      additionalProperties: false
    },
    run: async (input, { signal, checkpoint, progress, retrieval, rawRequestText } = {}) => {
      if (!/\.(svg|png|pdf|pptx)$/i.test(input.path))
        throw Object.assign(new Error('图形输出需使用SVG/PNG/PDF/PPTX后缀'), { code: 'DIAGRAM_FORMAT', kind: 'input' });
      // 'strict'：用户明确要逐条核对需求原文时才强制先走架构底稿；平时直接画（见 diagramPlanning.js）
      const strict = requireArchitecture === true || (requireArchitecture === 'strict' && strictArchitecture(rawRequestText));
      // 来自架构底稿投影的集成关系（带 relationId / semanticRouting）不能丢掉类型冒充普通箭头；
      // 普通画图里模型自己标的 integration 由 diagramRepair 按普通连线画
      const projected = input.semanticRouting !== undefined || input.edges?.some(edge => edge.type === 'integration' && (edge.relationId || edge.meaning));
      if ((strict || projected) && !input.architecturePath && input.edges?.some(edge => edge.type === 'integration'))
        throw Object.assign(new Error('应用集成须通过已审架构底稿投影，不能以普通有向连线替代'), { code: 'ARCHITECTURE_PLAN_REQUIRED', kind: 'input' });
      if (strict && !input.architecturePath && (!input.diagramType || input.diagramType === 'architecture' || /架构/.test(rawRequestText || '')))
        throw Object.assign(new Error('先调用plan_architecture理顺业务关系并取得architecturePath，再生成架构图；不能跳过底稿改用自由图片'), {
          code: 'ARCHITECTURE_PLAN_REQUIRED',
          kind: 'input'
        });
      if (strict && input.draft && !/草图|示意|关系稿|先.{0,8}(?:理顺|关系|逻辑)/.test(rawRequestText || ''))
        throw Object.assign(new Error('用户未要求逻辑草图，不能用draft绕过正式架构的业务审查'), { code: 'ARCHITECTURE_DRAFT_ONLY', kind: 'input' });
      let architecture = input.architecturePath ? await loadArchitecture(input.architecturePath, signal) : null;
      if (architecture && !input.draft) architecture = await resumeArchitectureReview(ctx, architecture, { signal, retrieval, progress, rawRequestText });
      if (architecture) input = projectArchitecture(architecture, { ...input, view: input.view || 'overview' });
      if (input.draft && !/草图|示意/.test(input.path)) input.path = input.path.replace(/(\.[^/.]+)$/, '-逻辑草图$1');
      if (architecture && !input.draft) input = { ...input, formats: input.formats || ['svg', 'png', 'pdf', 'pptx'], pptxMode: input.pptxMode || 'editable' };
      // 普通画图：版式参数不合规则时程序就地调整（层类型、箭头文字、分组），不让模型反复重填；严格模式和架构底稿照原规则
      let repairNotes = [];
      let model;
      if (strict || architecture || projected) {
        // 严格模式也先整理空标签、超长分组名这类纯格式问题（不碰内容和关系），免得整张图在排版前被拦
        ({ input, notes: repairNotes } = tidyLabels(input));
        model = layoutDiagram(input);
      }
      else ({ model, input, notes: repairNotes } = layoutWithRepair(input, { architecture: !['workflow', 'dataflow', 'general'].includes(input.diagramType) }));
      if (input.draft) model.monochrome = true;
      progress?.('正在核对材料和图形结构…');
      const direct = await checkSources(input.sources || [], signal);
      const sources = input.sources?.length ? direct.checks : architecture?.sourceChecks || [];
      const materials = input.sources?.length ? direct.materials : architecture?.materials || [];
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
      if (architecture)
        scene.architecture = {
          planPath: architecture.path,
          planHash: architecture.planHash,
          reviewPath: architecture.reviewPath,
          semantic: architecture.report.semantic,
          structure: architecture.report.structure,
          draft: Boolean(input.draft),
          view: input.view,
          relationCoverage: input.relationCoverage,
          sceneHash: await diagramDigest(JSON.stringify(scene))
        };
      const result = await deliverDiagram(ctx, {
        scene,
        path: input.path,
        formats: diagramFormats(input, rawRequestText),
        pptxMode: input.pptxMode,
        signal,
        checkpoint,
        progress,
        retrieval,
        reusePreview: candidate?.preview
      });
      const { preview } = result;
      const { render, visual } = preview;
      const business = sources.length && sources.every((source) => source.matched && !source.truncated) ? 'source_excerpts_matched' : 'not_checked';
      const validation = {
        format: 'svg',
        readback: 'passed',
        structure: 'passed',
        render,
        visual,
        business,
        designHash: result.designHash,
        errors: result.errors?.length || (visual === 'failed' ? 1 : 0)
      };
      await checkpoint?.({ type: 'artifact_validation', path: result.sourcePath, validation });
      ctx.onPreview?.(result.sourcePath);
      return `${input.draft ? '仅生成逻辑草图，非正式交付' : '已生成可编辑SVG'}：${result.sourcePath}\n${JSON.stringify({ validation, sources, ...(repairNotes.length && { layoutAdjusted: repairNotes }), architecture: architecture ? { path: architecture.path, reviewPath: architecture.reviewPath, semantic: architecture.report.semantic, structure: architecture.report.structure, draft: Boolean(input.draft), view: input.view, availableViews: ['overview', ...(architecture.plan.relations.some((link) => ['workflow', 'feedback'].includes(link.type)) ? ['workflow'] : []), ...(architecture.plan.relations.some((link) => link.type === 'dataflow') ? ['dataflow'] : [])].filter((view) => view !== input.view) } : undefined, candidateStatePath: candidate?.statePath, contentPlan: { path: contentPlanPath, coverage: contentPlan.coverage, factCount: contentPlan.facts.length, recommendationCount: contentPlan.recommendations.length }, ...result })}\nSVG为原生图形；展示PPT与PDF复用同一PNG，展示PPT不冒充原生可编辑版。layoutAdjusted是程序为符合版式自动做的调整，交付时简要告诉用户。原文摘录匹配不等于业务全面核实，未做的检查及失败格式须如实说明。只有primaryEditablePath实际存在且editable.passed=true，才可称可编辑PPT已完成；展示版是图片，不能冒充逐对象编辑。architecture.availableViews只是可另行生成的视图，未生成文件不能说已交付；总览中的dataflow_view关系需用同底稿view=dataflow另行呈现。`;
    }
  };
}

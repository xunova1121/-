import * as ws from './workspace.js';
import { createDocumentNavigation } from './documentNavigation.js';
import { workflowMaterials, compileArchitectureContent, WORKFLOW_CONTENT_PROMPT, requestedArchitectureViews } from './architectureWorkflowInput.js';
import { createArchitecturePlanTool } from './architectureTool.js';
import { createArchitecturePackageTool } from './architecturePackage.js';
import { diagramDigest } from './diagramExport.js';
import { throwControl } from '../core/networkRequest.js';
import { withWebDeadline } from './retrievalBudget.js';
const invalid = (message) => Object.assign(new Error(message), { code: 'ARCHITECTURE_WORKFLOW', kind: 'input' });
/** 文件管理状态；不把正文/草稿写入会话。最多3次内容模型尝试，无自动网络重试。 */
export function createArchitectureWorkflowTool(ctx) {
  const read = ctx.readDocument || createDocumentNavigation().read;
  return {
    name: 'build_architecture',
    description:
      '从原始文件自动制作政企总体架构及业务闭环/数据流：程序负责读取、原文绑定、审查、蓝色布局、同稿四格式导出与状态保存。模型只整理业务内容。首次传files/request/directory；继续只传jobPath，不选择草稿类型或索引。业务/原生PPT门槛不降低。',
    input_schema: {
      type: 'object',
      properties: {
        files: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', maxLength: 400 } },
        request: { type: 'string', maxLength: 4000 },
        directory: { type: 'string', maxLength: 200 },
        views: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { type: 'string', enum: ['overview', 'workflow', 'dataflow'] } },
        jobPath: { type: 'string', maxLength: 400 }
      },
      additionalProperties: false
    },
    run: async (args, execution = {}) => {
      throwControl(null, execution.signal);
      let state, jobPath;
      if (args.jobPath) {
        if (Object.keys(args).some((k) => k !== 'jobPath') || !/^文档检查\/架构任务\/[\w-]+\.json$/.test(args.jobPath))
          throw invalid('继续时仅使用回执里的jobPath');
        jobPath = args.jobPath;
        const blob = await ws.readBlob(jobPath);
        if (blob.size > 50000) throw invalid('任务状态超过50KB');
        state = JSON.parse(await blob.text());
        if (state.version !== 1 || !state.files || !state.directory) throw invalid('任务状态无效');
      } else {
        if (
          typeof args.request !== 'string' ||
          !args.request.trim() ||
          args.request.length > 4000 ||
          typeof args.directory !== 'string' ||
          args.directory.length > 200 ||
          !args.directory ||
          args.directory.startsWith('/') ||
          args.directory.split('/').some((x) => !x || x === '.' || x === '..') ||
          args.directory.includes('\\')
        )
          throw invalid('需明确任务要求和合法相对交付目录');
        state = {
          version: 1,
          stage: 'content',
          attempts: 0,
          files: args.files,
          request: args.request,
          directory: args.directory,
          views: requestedArchitectureViews(args.request, args.views),
          lastError: null
        };
        jobPath = '文档检查/架构任务/' + crypto.randomUUID() + '.json';
      }
      if (
        !Array.isArray(state.views) ||
        !state.views.length ||
        state.views.length > 3 ||
        new Set(state.views).size !== state.views.length ||
        state.views.some((view) => !['overview', 'workflow', 'dataflow'].includes(view))
      )
        throw invalid('视图参数无效');
      const save = async () => {
        await ws.write(jobPath, JSON.stringify(state));
        await execution.checkpoint?.({ type: 'file', path: jobPath });
      };
      const { sources, materials } = await workflowMaterials(state.files, read, execution.signal);
      const hash = await diagramDigest(JSON.stringify(materials));
      if (state.materialHash && state.materialHash !== hash) throw invalid('原件已变化，请新建任务，不能续用旧内容');
      state.materialHash = hash;
      await save();
      try {
        if (state.stage === 'content') {
          if (state.attempts >= 3) throw invalid('内容整理已达3次上限，保留任务和诊断，不继续收费重试');
          const llm = ctx.reasonLlm || ctx.llm;
          if (!llm) throw invalid('未配置业务理解模型');
          state.attempts++;
          await save();
          execution.retrieval?.consume('model');
          execution.progress?.('正在理解原始材料的系统职责、业务关系和需求；程序负责后续步骤…');
          let previousContent = null;
          if (state.contentPath) {
            const previous = await ws.readBlob(state.contentPath);
            if (previous.size > 320000) throw invalid('历史业务内容超限');
            previousContent = JSON.parse(await previous.text());
          }
          const response = await withWebDeadline(
            (signal) =>
              llm({
                system: WORKFLOW_CONTENT_PROMPT,
                prompt: JSON.stringify({
                  request: state.request,
                  materials: materials.map((m, i) => ({ material: i, text: m.text })),
                  correction: state.lastError,
                  previousContent
                }),
                signal,
                nativeSearch: false,
                allowWebSearch: false,
                maxWebSearches: 0,
                maxRetries: 0,
                maxTransientRetries: 0,
                maxPartialRetries: 0
              }),
            { signal: execution.signal, timeoutMs: 120000 }
          );
          if (typeof response !== 'string' || response.length > 80000) throw invalid('业务内容超过8万字符或不是JSON');
          const content = JSON.parse(response.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
          const contentPath = jobPath.replace(/\.json$/, '.content.json');
          await ws.write(contentPath, JSON.stringify(content));
          state.contentPath = contentPath;
          await save();
          const input = compileArchitectureContent(content, sources, materials);
          if (state.views.includes('workflow') && !input.relations.some((row) => ['workflow', 'feedback'].includes(row.type)))
            throw invalid('已要求业务闭环，但内容未登记业务流/反馈关系；应核原文补齐内容，不进入导出阶段');
          if (state.views.includes('dataflow') && !input.relations.some((row) => row.type === 'dataflow'))
            throw invalid('已要求数据流，但内容未登记数据流关系；应核原文补齐内容，不进入导出阶段');
          const receipt = JSON.parse(
            await createArchitecturePlanTool({ ...ctx, readDocument: read }).run(input, { ...execution, rawRequestText: state.request })
          );
          state.architecturePath = receipt.architecturePath;
          if (!receipt.readyForRender) {
            state.lastError = { code: 'ARCHITECTURE_REVIEW', issues: receipt.reviewIssues, note: receipt.reviewNote };
            await save();
            return JSON.stringify({
              jobPath,
              stage: 'content',
              ready: false,
              attemptsRemaining: 3 - state.attempts,
              review: state.lastError,
              note: '底稿仍未通过审查；只用jobPath继续，未生成正式图。'
            });
          }
          state.stage = 'export';
          state.lastError = null;
          await save();
        }
        const result = JSON.parse(
          await createArchitecturePackageTool(ctx).run({ architecturePath: state.architecturePath, directory: state.directory, views: state.views }, execution)
        );
        if (result.status !== 'complete') throw invalid('导出尚未完成');
        state.stage = 'complete';
        state.manifestPath = result.manifestPath;
        await save();
        return JSON.stringify({ jobPath, ...result, note: '实际文件与同稿/原生PPT门槛通过，客户业务及视觉仍需核对。' });
      } catch (error) {
        throwControl(error, execution.signal);
        state.lastError = {
          code: String(error.code || error.name).slice(0, 80),
          message: String(error.message).slice(0, 2500),
          diagnostics: error.diagnostics?.slice(0, 8)
        };
        await save();
        throw Object.assign(error, {
          statePath: jobPath,
          message: `${error.message}；任务保留：${jobPath}，仅用build_architecture({jobPath})继续，不切换修订工具。`
        });
      }
    }
  };
}

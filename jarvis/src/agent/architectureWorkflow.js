import { architectureContentResponse } from './architectureResponse.js';
import { applyArchitectureCorrections } from './architectureContentContract.js';
import { validateArchitectureContent } from './architectureContentValidation.js';
import { setWorkflowReview, continueWorkflowReview } from './architectureWorkflowReview.js';
import { workflowStop, saveWorkflowFailure } from './architectureWorkflowFailure.js';
import * as ws from './workspace.js';
import { createDocumentNavigation } from './documentNavigation.js';
import { workflowMaterials, compileArchitectureContent, requestedArchitectureViews } from './architectureWorkflowInput.js';
import { createArchitecturePlanTool } from './architectureTool.js';
import { createArchitecturePackageTool } from './architecturePackage.js';
import { diagramDigest } from './diagramExport.js';
import { throwControl } from '../core/networkRequest.js';
import { loadWorkflowContent, saveWorkflowContent, mapWorkflowDiagnostics } from './architectureWorkflowIntegrity.js';
const invalid = (message) => Object.assign(new Error(message), { code: 'ARCHITECTURE_WORKFLOW', kind: 'input' });
/** 文件管理状态；不把正文/草稿写入会话。最多3次内容模型尝试，无自动网络重试。 */
export function createArchitectureWorkflowTool(ctx) {
  const read = ctx.readDocument || createDocumentNavigation().read;
  return {
    name: 'build_architecture',
    isStatefulResume: (args) =>
      args && Object.keys(args).length === 1 && typeof args.jobPath === 'string' && /^文档检查\/架构任务\/[\w-]+\.json$/.test(args.jobPath),
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
        let blob;
        try { blob=await ws.readBlob(jobPath); } catch(error) {
          throwControl(error,execution.signal);
          throw Object.assign(invalid('任务状态不存在或读取失败，请使用实际回执的jobPath，不猜路径'),{diagnostics:[{field:'jobPath',stage:'source',action:'使用已保存的真实架构任务路径；不存在的任务不能反复续接。'}]});
        }
        if (blob.size > 50000) throw invalid('任务状态超过50KB');
        try { state = JSON.parse(await blob.text()); } catch(error) {
          if (!(error instanceof SyntaxError)) throw error;
          throw invalid('任务状态不是有效JSON，不能当作可恢复任务');
        }
        if (state.version !== 1 || !state.files || !state.directory) throw invalid('任务状态无效');
      } else {
        const directory = typeof args.directory === 'string' ? args.directory.replace(/\/+$/, '') : args.directory;
        if (
          typeof args.request !== 'string' ||
          !args.request.trim() ||
          args.request.length > 4000 ||
          typeof args.directory !== 'string' ||
          args.directory.length > 200 ||
          !directory ||
          directory.startsWith('/') ||
          directory.split('/').some((x) => !x || x === '.' || x === '..') ||
          directory.includes('\\')
        )
          throw invalid('需明确任务要求和合法相对交付目录');
        state = {
          version: 1,
          stage: 'content',
          attempts: 0,
          files: args.files,
          request: args.request,
          directory,
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
        await ws.writeArchitectureState(jobPath, JSON.stringify(state), { signal: execution.signal });
        await execution.checkpoint?.({ type: 'file', path: jobPath });
      };
      const { sources, materials } = await workflowMaterials(state.files, read, execution.signal);
      const hash = await diagramDigest(JSON.stringify(materials));
      if (state.materialHash && state.materialHash !== hash) throw invalid('原件已变化，请新建任务，不能续用旧内容');
      if (state.terminalFailure) throw workflowStop(state, (state.terminalFailure.phase === 'integrity' ? '架构内容完整性核验失败，本任务停止续接' : state.stage === 'review' ? '业务审查恢复已达上限' : '内容整理已达3次上限') + '；任务保留：' + jobPath);
      state.materialHash = hash;
      await save();
      try {
        // 在模型读取、业务审查或导出之前核对，外部改写不能成为新的可信基线。
        const previousContent = await loadWorkflowContent(state, jobPath);
        if (state.stage === 'content') {
          const response = await architectureContentResponse(ctx, state, jobPath, materials, save, execution);
          // 同一模型等待期间也可能有目录同步/外部编辑，完成后再次校验。
          await loadWorkflowContent(state, jobPath);
          const { content, adapters, correctionAudit } = applyArchitectureCorrections(response, previousContent, { strictTopology: true });
          await saveWorkflowContent(state, jobPath, content, adapters, correctionAudit, execution);
          await save();
          const compilation = { relationIntents: content.relations.flatMap((row, index) => row.intent || row.data ? [{ index, ...(row.intent && { intent: row.intent }), ...(row.type && { type: row.type }), ...(row.data && { data: row.data }) }] : []) };
          const input = compileArchitectureContent(content, sources, materials, { onRequirementMap: mapping => {
            state.requirementSourceIndices = [];
            for (const row of mapping) for (const index of row.outputIndices) state.requirementSourceIndices[index] = row.sourceIndex;
            compilation.requirementGroups = mapping.filter(row => row.outputIndices.length > 1).map(({ sourceIndex, outputIndices }) => ({ sourceIndex, outputIndices }));
          } });
          await save();
          if (state.views.includes('workflow') && !input.relations.some((row) => ['workflow', 'feedback'].includes(row.type)))
            throw invalid('已要求业务闭环，但内容未登记业务流/反馈关系；应核原文补齐内容，不进入导出阶段');
          if (state.views.includes('dataflow') && !input.relations.some((row) => row.type === 'dataflow'))
            throw invalid('已要求数据流，但内容未登记数据流关系；应核原文补齐内容，不进入导出阶段');
          // 用原校验器一次收齐字段问题，不能为只修一个错反复消耗整份理解请求。
          try { validateArchitectureContent(input, materials, state.request); }
          catch (error) { error.diagnostics = mapWorkflowDiagnostics(error.diagnostics, state.requirementSourceIndices); throw error; }
          let receipt;
          try {
            receipt = JSON.parse(await createArchitecturePlanTool({ ...ctx, readDocument: read }).run(input, { ...execution, rawRequestText: state.request, architectureCompilation: compilation, workflowMaterialHash: hash }));
          } catch (error) { error.diagnostics = mapWorkflowDiagnostics(error.diagnostics, state.requirementSourceIndices); throw error; }
          await loadWorkflowContent(state, jobPath);
          setWorkflowReview(state, receipt);
          if (!receipt.readyForRender) {
            if (state.stage === 'content' && state.attempts >= 3) throw workflowStop(state, '业务审查指出实质问题，但内容整理已达3次上限');
            await save();
            return JSON.stringify({
              jobPath,
              stage: state.stage,
              ready: false,
              attemptsRemaining: 3 - state.attempts,
              review: state.lastError,
              note: '底稿仍未通过审查；只用jobPath继续，未生成正式图。'
            });
          }
          await save();
        }
        if (state.stage === 'review') {
          const review = await continueWorkflowReview(ctx, state, execution);
          await loadWorkflowContent(state, jobPath);
          await save();
          if (!review.readyForRender) {
            if (state.stage === 'review') throw workflowStop(state, '同一底稿业务审查恢复未完成；不重新改写已通过结构检查的内容');
            if (state.attempts >= 3) throw workflowStop(state, '业务审查指出实质问题，但内容整理已达3次上限');
            return JSON.stringify({ jobPath, stage: 'content', ready: false, attemptsRemaining: 3 - state.attempts, review: state.lastError, note: '业务审查明确未通过，按真实意见修内容，不冒充技术故障' });
          }
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
        error = await saveWorkflowFailure(error, state, jobPath, save, execution);
        throw Object.assign(error, {
          statePath: jobPath,
          message: `${error.message}；任务保留：${jobPath}；` + (state.terminalFailure?.phase === 'integrity' ? '完整性故障已终止本任务，已有原稿和真实诊断保留。' : error.terminal ? '恢复额度已用尽，本任务不再自动续跑，已有文件和真实诊断保留。' : '仅用build_architecture({jobPath})继续，不切换修订工具。')
        });
      }
    }
  };
}

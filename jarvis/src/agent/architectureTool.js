import { resolveArchitectureEvidence, bindEvidenceSources } from './architectureEvidence.js';
import { architectureSourceSchema } from './architectureEvidenceTool.js';
import { reviewArchitecture, architectureReviewStatus } from './architectureReview.js';
import { diagramDigest } from './diagramExport.js';
import * as workspace from './workspace.js';
import { ARCHITECTURE_KINDS, ARCHITECTURE_RELATIONS, makeArchitecturePlan, architectureMarkdown } from './architecturePlan.js';
import { checkSources } from './diagramSources.js';
import { throwControl } from '../core/networkRequest.js';
import { architectureSources } from './architectureSources.js';
const text = (maxLength) => ({ type: 'string', maxLength });
const proof = {
  evidenceId: { ...text(120), description: 'prepare_architecture_evidence返回的原文编号；推荐只填编号，由程序回填路径和摘录，不手写编号' },
  source: { ...text(400), description: '工作区原文件完整路径或user，不能填章节标题、result_id或来源概括；程序会读取声明的文件' },
  excerpt: { ...text(400), description: '该原文件内连续的逐字摘录，不能改写；超过读取范围时在sources声明唯一章节边界' },
  assumption: text(240)
};
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const list = (items, maxItems) => ({ type: 'array', items, maxItems });
export function createArchitecturePlanTool(ctx) {
  return {
    name: 'plan_architecture',
    description:
      '重要架构图先生成业务关系底稿：逐对象明确类型、职责、输入输出，区分包含/支撑/数据流/业务流/反馈。首次先用prepare_architecture_evidence读取相关采购章节，sources沿用回执，逐项引用evidenceId，不手抄source/excerpt；旧手填参数仍兼容。完整规划须读完相关范围，原始需求逐项映射，关系不确定须写假设；不会自动判定业务正确。已有底稿的技术性审查未完成交create_diagram恢复一次，不要重建；业务failed才按具体意见修正。回执给路径及短审查状态，用read_file按需读，不把原文塞进对话。',
    input_schema: object(
      {
        title: text(80),
        sources: architectureSourceSchema,
        entities: list(
          object(
            {
              id: text(64),
              title: text(48),
              kind: { type: 'string', enum: ARCHITECTURE_KINDS },
              responsibility: text(160),
              inputs: list(text(100), 8),
              outputs: list(text(100), 8),
              ...proof
            },
            ['id', 'title', 'kind', 'responsibility', 'inputs', 'outputs']
          ),
          60
        ),
        relations: list(
          object({ from: text(64), to: text(64), type: { type: 'string', enum: ARCHITECTURE_RELATIONS }, meaning: text(120), ...proof }, [
            'from',
            'to',
            'type',
            'meaning'
          ]),
          100
        ),
        requirements: list(
          object({ text: { ...text(240), description: '原始需求原文；使用evidenceId时可省略以沿用该片段全文' }, entities: list(text(64), 12), evidenceId: proof.evidenceId, source: proof.source, excerpt: proof.excerpt }, ['entities']),
          80
        )
      },
      ['title', 'entities', 'relations', 'requirements']
    ),
    run: async (input, { signal, checkpoint, rawRequestText, progress, retrieval, architectureRevision, previousUserEvidence } = {}) => {
      throwControl(null, signal);
      progress?.('正在整理业务职责、关系及原文映射…');
      const sources = architectureSources(input);
      const { materials, checks } = await checkSources(sources, signal,ctx.readDocument);
      const resolved = await resolveArchitectureEvidence(input, materials, checks, signal);
      const plan = makeArchitecturePlan(resolved, materials.map((item, index) => ({ ...item, truncated: checks[index].truncated, scope: checks[index].scope })), rawRequestText, previousUserEvidence);
      plan.sources = bindEvidenceSources(sources, checks, materials, resolved);
      plan.materialHashes = await Promise.all(materials.map(async (item) => ({ path: item.path, hash: await diagramDigest(item.text) })));
      plan.layoutProfile = 'business-v2';
      if (architectureRevision) {
        const contentHash = await diagramDigest(JSON.stringify({ entities: plan.entities, relations: plan.relations, requirements: plan.requirements }));
        if (contentHash === architectureRevision.contentHash) throw Object.assign(new Error('规范化后没有实质变更，不能重复审查'), { code: 'ARCHITECTURE_REVISION', kind: 'input', diagnostics: [{ stage: 'review', field: 'changes', action: '按具体审查意见修改底稿，不反复请求通过' }] });
        plan.revision = architectureRevision;
      }
      const base = '文档检查/架构底稿/' + crypto.randomUUID();
      throwControl(null, signal);
      const saved = await workspace.write(base + '.architecture.json', JSON.stringify(plan));
      await checkpoint?.({ type: 'file', path: saved.path });
      let review;
      try {
        progress?.('正在审查业务归属、支撑方向与数据流…');
        review = await reviewArchitecture(ctx, plan, { signal, retrieval, materials, rawRequestText, previousUserEvidence });
      } catch (error) {
        throw Object.assign(error, { statePath: saved.path });
      }
      const reviewFile = await workspace.write(base + '.review.json', JSON.stringify({ ...review, planHash: await diagramDigest(JSON.stringify(plan)) }));
      const markdown = await workspace.write(base + '.md', architectureMarkdown({ ...plan, semantic: review.semantic }));
      for (const path of [reviewFile.path, markdown.path]) {
        ctx.onFileChanged?.(path);
        await checkpoint?.({ type: 'file', path });
      }
      const reviewStatus = architectureReviewStatus(review, reviewFile.path);
      progress?.(reviewStatus.readyForRender ? '底稿与业务审查通过，可以生成架构图' : '底稿已保存，业务审查尚未通过：' + reviewStatus.reviewNote);
      return JSON.stringify({
        architecturePath: saved.path,
        relationTablePath: markdown.path,
        entityCount: plan.entities.length,
        relationCount: plan.relations.length,
        requirementCount: plan.requirements.length,
        coverage: plan.coverage,
        semantic: review.semantic,
        structure: review.structure,
        reviewPath: reviewFile.path,
        issueCount: review.issueCount,
        note: plan.note,
        ...reviewStatus
      });
    }
  };
}

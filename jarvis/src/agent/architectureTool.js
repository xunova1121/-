import { reviewArchitecture, architectureReviewStatus } from './architectureReview.js';
import { diagramDigest } from './diagramExport.js';
import * as workspace from './workspace.js';
import { ARCHITECTURE_KINDS, ARCHITECTURE_RELATIONS, makeArchitecturePlan, architectureMarkdown } from './architecturePlan.js';
import { checkSources } from './diagramSources.js';
import { throwControl } from '../core/networkRequest.js';
import { architectureSources } from './architectureSources.js';
const text = (maxLength) => ({ type: 'string', maxLength });
const proof = {
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
      '重要架构图先生成业务关系底稿：逐对象明确类型、职责、输入输出，区分包含/支撑/数据流/业务流/反馈。先完整读取相关采购章节，原始需求逐项映射，关系不确定须写假设；不会自动判定业务正确。已有底稿的技术性审查未完成交create_diagram恢复一次，不要重建；业务failed才按具体意见修正。回执给路径及短审查状态，用read_file按需读，不把原文塞进对话。',
    input_schema: object(
      {
        title: text(80),
        sources: list(object({ path: text(400), excerpt: text(240), sectionStart: text(300), sectionEnd: text(300) }, ['path', 'excerpt']), 4),
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
          object({ text: text(240), entities: list(text(64), 12), source: proof.source, excerpt: proof.excerpt }, ['text', 'entities', 'source', 'excerpt']),
          80
        )
      },
      ['title', 'entities', 'relations', 'requirements']
    ),
    run: async (input, { signal, checkpoint, rawRequestText, progress, retrieval } = {}) => {
      throwControl(null, signal);
      progress?.('正在整理业务职责、关系及原文映射…');
      const sources = architectureSources(input);
      const { materials, checks } = await checkSources(sources, signal);
      const plan = makeArchitecturePlan(input, materials.map((item, index) => ({ ...item, truncated: checks[index].truncated, scope: checks[index].scope })), rawRequestText);
      plan.sources = checks.map((item, index) => ({ ...item, excerpt: sources[index].excerpt }));
      plan.materialHashes = await Promise.all(materials.map(async (item) => ({ path: item.path, hash: await diagramDigest(item.text) })));
      const base = '文档检查/架构底稿/' + crypto.randomUUID();
      throwControl(null, signal);
      const saved = await workspace.write(base + '.architecture.json', JSON.stringify(plan));
      await checkpoint?.({ type: 'file', path: saved.path });
      let review;
      try {
        progress?.('正在审查业务归属、支撑方向与数据流…');
        review = await reviewArchitecture(ctx, plan, { signal, retrieval, materials, rawRequestText });
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

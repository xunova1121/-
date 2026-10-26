import { reviewArchitecture } from './architectureReview.js';
import { diagramDigest } from './diagramExport.js';
import * as workspace from './workspace.js';
import { ARCHITECTURE_KINDS, ARCHITECTURE_RELATIONS, makeArchitecturePlan, architectureMarkdown } from './architecturePlan.js';
import { checkSources } from './diagramSources.js';
import { throwControl } from '../core/networkRequest.js';
const text = (maxLength) => ({ type: 'string', maxLength });
const proof = { source: text(400), excerpt: text(400), assumption: text(240) };
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const list = (items, maxItems) => ({ type: 'array', items, maxItems });
export function createArchitecturePlanTool(ctx) {
  return {
    name: 'plan_architecture',
    description:
      '重要架构图先生成业务关系底稿：逐对象明确类型、职责、输入输出，区分包含/支撑/数据流/业务流/反馈。先完整读取相关采购章节，原始需求逐项映射，关系不确定须写假设；不会自动判定业务正确。回执只给文件路径，用read_file按需读，不把原文塞进对话。',
    input_schema: object(
      {
        title: text(80),
        sources: list(object({ path: text(400), excerpt: text(240) }, ['path', 'excerpt']), 4),
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
          object({ text: text(240), entities: list(text(64), 12), source: text(400), excerpt: text(400) }, ['text', 'entities', 'source', 'excerpt']),
          80
        )
      },
      ['title', 'entities', 'relations', 'requirements']
    ),
    run: async (input, { signal, checkpoint, rawRequestText, progress, retrieval } = {}) => {
      throwControl(null, signal);
      progress?.('正在整理业务职责、关系及原文映射…');
      const { materials, checks } = await checkSources(input.sources || [], signal);
      const plan = makeArchitecturePlan(input, materials, rawRequestText);
      plan.sources = checks;
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
        note: plan.note
      });
    }
  };
}

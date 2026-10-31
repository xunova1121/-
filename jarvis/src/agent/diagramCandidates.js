import * as workspace from './workspace.js';
import { validateScene, sceneElements } from './diagramScene.js';
import { sceneSvg } from './diagramSceneSvg.js';
import { reviewDiagram } from './diagramReview.js';
import { diagramDigest } from './diagramExport.js';
import { imageData } from './imageRegion.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';

/** 只扩展纵向留白，文字、颜色、拓扑和图标大小均不改；不让模型重写业务内容。 */
export function spaceDiagram(scene, factor = 1.12) {
  if (![1.08, 1.12].includes(factor)) throw Object.assign(new Error('仅支持有界间距修复'), { code: 'DIAGRAM_SPACING', kind: 'input' });
  validateScene(scene);
  const result = structuredClone(scene);
  result.height = Math.ceil(result.height * factor);
  for (const item of sceneElements(result)) {
    if (item.type === 'group') {
      if (item.bounds) {
        item.bounds.y *= factor;
        item.bounds.height *= factor;
      }
      continue;
    }
    if (Number.isFinite(item.y)) item.y *= factor;
    if (item.type === 'rect') item.height *= factor;
    for (const point of item.points || item.lines || []) point.y *= factor;
  }
  return validateScene(result);
}

async function compare(ctx, candidates, options) {
  if (!ctx.visionLlm) return { state: 'not_checked', selected: 0, issues: [], note: '未配置看图模型，使用原版；候选预览不等于视觉通过。' };
  const images = [];
  for (const item of candidates) images.push(await imageData(await workspace.readBlob(item.preview.previewPath)));
  options.retrieval?.consume('model');
  try {
    const response = await withWebDeadline(
      (signal) =>
        ctx.visionLlm({
          system:
            '比较提供的真实架构图预览，只查文字重叠、图标碰字、连线穿字、拥挤和层次可读性，不核实业务。图片按0开始编号。仅返回JSON：{"selected":0,"passed":true,"issues":[]}。issues最多8条，每条{"kind":"spacing或other","detail":"具体位置和问题"}。看不清不能通过。不得建议删除内容。',
          prompt: `本次有${images.length}张预览，请选更清楚的一张；不存在的图片编号不得选择。`,
          images,
          signal,
          nativeSearch: false,
          maxWebSearches: 0,
          maxRetries: 0
        }),
      { signal: options.signal, timeoutMs: 45000 }
    );
    if (typeof response !== 'string' || response.length > 6000) throw new Error('invalid');
    const verdict = JSON.parse(response.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (
      !Number.isInteger(verdict.selected) ||
      !candidates[verdict.selected] ||
      typeof verdict.passed !== 'boolean' ||
      !Array.isArray(verdict.issues) ||
      verdict.issues.length > 8 ||
      verdict.issues.some(
        (issue) => !['spacing', 'other'].includes(issue?.kind) || typeof issue.detail !== 'string' || !issue.detail.trim() || issue.detail.length > 240
      )
    )
      throw new Error('invalid');
    return { state: verdict.passed && !verdict.issues.length ? 'passed' : 'failed', selected: verdict.selected, issues: verdict.issues };
  } catch (error) {
    throwControl(error, options.signal);
    return { state: 'not_checked', selected: 0, issues: [], note: '视觉比较未完成，未声称通过。', errorCode: String(error.code || error.name).slice(0, 80) };
  }
}

/** 最多2个候选、1次间距修复、2次45秒视觉请求；完整状态只写工作区。 */
export async function chooseDiagram(ctx, scene, options = {}) {
  const root = '文档检查/架构候选/' + crypto.randomUUID();
  const statePath = root + '/workflow.json';
  const state = { version: 1, state: 'running', candidates: [], reviews: [] };
  const candidates = [];
  const save = async () => {
    await workspace.writeArchitectureState(statePath, JSON.stringify(state));
    await options.checkpoint?.({ type: 'file', path: statePath });
  };
  const render = async (candidateScene) => {
    throwControl(null, options.signal);
    const base = root + '/candidate-' + candidates.length;
    const svg = sceneSvg(candidateScene);
    const path = (await workspace.write(base + '.svg', svg)).path;
    await workspace.write(base + '.diagram.json', JSON.stringify(candidateScene));
    const preview = await reviewDiagram(ctx, { ...options, path, svg, previewPath: base + '.png', visual: false });
    const item = { scene: candidateScene, preview };
    candidates.push(item);
    const record = { path, render: preview.render };
    if (preview.render === 'passed' && !preview.sourceChanged) {
      item.preview = {
        ...preview,
        sourceHash: await diagramDigest(svg),
        designHash: await diagramDigest(JSON.stringify(candidateScene)),
        previewHash: await diagramDigest(await workspace.readBlob(preview.previewPath))
      };
      Object.assign(record, { previewPath: preview.previewPath, designHash: item.preview.designHash, previewHash: item.preview.previewHash });
    }
    state.candidates.push(record);
    await save();
    return item;
  };
  await save();
  try {
    options.progress?.('正在生成紧凑版与舒展版真实预览…');
    await render(scene);
    await render(spaceDiagram(scene));
    const ready = candidates.filter((item) => item.preview.render === 'passed' && !item.preview.sourceChanged);
    if (!ready.length) throw Object.assign(new Error('候选渲染均未完成，源稿已保留'), { code: 'DIAGRAM_CANDIDATE_RENDER', kind: 'capability' });
    let verdict = await compare(ctx, ready, options);
    state.reviews.push(verdict);
    let selected = ready[verdict.selected];
    if (verdict.state === 'failed' && verdict.issues.length && verdict.issues.every((issue) => issue.kind === 'spacing')) {
      options.progress?.('正在对选中版修复间距并重新验收…');
      const fixed = await render(spaceDiagram(selected.scene, 1.08));
      if (fixed.preview.render === 'passed' && !fixed.preview.sourceChanged) {
        verdict = await compare(ctx, [fixed], options);
        state.reviews.push(verdict);
        selected = fixed;
      }
    }
    state.state = verdict.state;
    state.selectedPath = state.candidates.find((item) => item.designHash === selected.preview.designHash)?.path;
    await save();
    return {
      scene: selected.scene,
      preview: { ...selected.preview, visual: verdict.state, note: verdict.note || verdict.issues.map((issue) => issue.detail).join('；') },
      statePath
    };
  } catch (error) {
    state.state = 'interrupted';
    state.errorCode = String(error.code || error.name || 'DIAGRAM_CANDIDATES').slice(0, 80);
    await save();
    throw Object.assign(error, { statePath });
  }
}

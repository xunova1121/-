import { it, expect, vi, beforeEach } from 'vitest';
import * as workspace from '../src/agent/workspace.js';
import { diagramScene, sceneElements } from '../src/agent/diagramScene.js';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { platformSpec } from '../e2e/fixtures/diagram-platform.mjs';
import { spaceDiagram, chooseDiagram } from '../src/agent/diagramCandidates.js';
import { checkpointEvent } from '../shared/taskCheckpoint.js';
import { deliverDiagram } from '../src/agent/diagramExport.js';
vi.mock('../src/agent/diagramReview.js', () => ({
  reviewDiagram: vi.fn(async (_ctx, args) => {
    await workspace.write(args.previewPath, new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }));
    return { render: 'passed', visual: 'not_checked', previewPath: args.previewPath };
  })
}));
const scene = () => diagramScene(layoutDiagram(platformSpec), platformSpec.design);
const verdict = (selected, passed, issues = []) => JSON.stringify({ selected, passed, issues });
beforeEach(() => vi.clearAllMocks());
it('舒展只改纵坐标和容器高度，文字/图标/正交线保留，原稿不变', () => {
  const original = scene();
  const before = JSON.stringify(original);
  const fixed = spaceDiagram(original);
  const elements = sceneElements(original);
  const next = sceneElements(fixed);
  expect(JSON.stringify(original)).toBe(before);
  expect(fixed.height).toBeGreaterThan(original.height);
  expect(next.map((item) => item.lines?.map((line) => line.text))).toEqual(elements.map((item) => item.lines?.map((line) => line.text)));
  for (let index = 0; index < elements.length; index++) {
    if (elements[index].type === 'icon') expect(next[index].width).toBe(next[index].height);
    if (elements[index].type === 'path') expect(next[index].points.map((point) => point.x)).toEqual(elements[index].points.map((point) => point.x));
  }
  expect(() => spaceDiagram(original, 2)).toThrow(/有界/);
});
it('无看图模型保持not_checked、两个候选且检查点没有场景/图片正文', async () => {
  const checkpoint = vi.fn();
  const result = await chooseDiagram({}, scene(), { checkpoint });
  expect(result.preview.visual).toBe('not_checked');
  const state = JSON.parse(await workspace.readText(result.statePath));
  expect(state.candidates).toHaveLength(2);
  expect(state.selectedPath).toBe(state.candidates[0].path);
  expect(JSON.stringify(checkpoint.mock.calls)).not.toMatch(/elements|base64|images/);
  const saved = checkpoint.mock.calls.reduce((state, [event]) => checkpointEvent(state, event), {});
  expect(saved.files).toContain(result.statePath);
});
it('实际图像提交比较，预算先扣；一次修复后必须重审且最多两次模型调用', async () => {
  const consume = vi.fn();
  const visionLlm = vi
    .fn()
    .mockImplementationOnce(async (args) => {
      expect(consume).toHaveBeenCalledTimes(1);
      expect(args.images).toHaveLength(2);
      expect(args.maxRetries).toBe(0);
      return verdict(1, false, [{ kind: 'spacing', detail: '第二层要点拥挤' }]);
    })
    .mockResolvedValueOnce(verdict(0, true));
  const result = await chooseDiagram({ visionLlm }, scene(), { retrieval: { consume } });
  expect(result.preview.visual).toBe('passed');
  expect(visionLlm).toHaveBeenCalledTimes(2);
  const state = JSON.parse(await workspace.readText(result.statePath));
  expect(state.candidates).toHaveLength(3);
  expect(state.reviews).toHaveLength(2);
});
it('不能修的内容/路线问题不删除内容也不空转；失败仍如实失败', async () => {
  const visionLlm = vi.fn().mockResolvedValue(verdict(0, false, [{ kind: 'other', detail: '跨层关系不清楚' }]));
  const result = await chooseDiagram({ visionLlm }, scene());
  expect(result.preview.visual).toBe('failed');
  expect(visionLlm).toHaveBeenCalledTimes(1);
  expect(result.scene).toEqual(scene());
});
it('越界编号、无效JSON、超大意见均不能算通过', async () => {
  for (const response of [verdict(8, true), '{}', 'x'.repeat(6001)]) {
    const result = await chooseDiagram({ visionLlm: vi.fn().mockResolvedValue(response) }, scene());
    expect(result.preview.visual).toBe('not_checked');
  }
});
it('停止和预算传播且留有界恢复指针', async () => {
  for (const error of [Object.assign(new Error('stop'), { name: 'AbortError' }), Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' })]) {
    try {
      await chooseDiagram({ visionLlm: vi.fn().mockRejectedValue(error) }, scene());
      expect.fail('应抛出');
    } catch (caught) {
      expect(caught).toBe(error);
      expect(caught.statePath).toMatch(/workflow.json$/);
      expect(JSON.parse(await workspace.readText(caught.statePath)).state).toBe('interrupted');
    }
  }
});
it('候选PNG被改动后禁止同稿导出，不借旧视觉通过', async () => {
  const result = await chooseDiagram({}, scene());
  await workspace.write(result.preview.previewPath, new Blob(['changed']));
  await expect(
    deliverDiagram({}, { scene: result.scene, path: '候选防串版.svg', formats: ['svg', 'png'], reusePreview: result.preview })
  ).rejects.toMatchObject({ code: 'DIAGRAM_PREVIEW_CHANGED' });
});

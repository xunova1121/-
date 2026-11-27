import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createArchitectureEvidenceTool } from '../src/agent/architectureEvidenceTool.js';
import { loadArchitectureSubmission, validateArchitectureSubmission } from '../src/agent/architectureSubmission.js';
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'submission-'));
  useBackend(createFileStore(dir));
});
afterEach(() => {
  useBackend(null);
  fs.rmSync(dir, { recursive: true, force: true });
});
async function sample() {
  await ws.write('虚构采购.md', '平台包含监测模块，接入监测记录。');
  const receipt = JSON.parse(await createArchitectureEvidenceTool().run({ sources: [{ path: '虚构采购.md' }] }));
  const id = receipt.items[0].evidenceId;
  return {
    id,
    input: {
      title: '虚构架构',
      sources: receipt.sources,
      entities: [
        { id: 'p', title: '平台', kind: 'system', responsibility: '承载模块', inputs: [], outputs: [], evidenceId: id },
        { id: 'm', title: '监测模块', kind: 'application', responsibility: '接收记录', inputs: [], outputs: [], evidenceId: id }
      ],
      relations: [{ from: 'p', to: 'm', type: 'contains', meaning: '平台包含模块' }],
      requirements: [{ entities: ['p', 'm'], evidenceId: id, text: '编造采购内容' }]
    }
  };
}
it('一次报告57条关系缺证据和需求改写，完整清单与输入落盘，不启动模型', async () => {
  const { input } = await sample();
  input.relations = Array.from({ length: 57 }, () => ({ ...input.relations[0] }));
  const llm = vi.fn();
  let error;
  try {
    await createArchitecturePlanTool({ llm }).run(input);
  } catch (e) {
    error = e;
  }
  expect(error.diagnostics).toHaveLength(58);
  expect(error.diagnostics.at(-1).field).toBe('requirements[0].text');
  expect(llm).not.toHaveBeenCalled();
  const files = await ws.list('文档检查/架构输入');
  expect(JSON.parse(await ws.readText(files.find((f) => f.path.endsWith('.submission.json')).path))).toMatchObject({ state: 'invalid', input });
  expect(JSON.parse(await ws.readText(files.find((f) => f.path.endsWith('.issues.json')).path))).toHaveProperty('total', 58);
});
it('局部修补后仍经原审查，材料变化重新拒绝而不复用旧成功', async () => {
  const { id, input } = await sample();
  const llm = vi.fn(async () => '{"passed":true,"issues":[]}');
  await expect(createArchitecturePlanTool({ llm }).run(input)).rejects.toBeTruthy();
  const draftPath = (await ws.list('文档检查/架构输入')).find((f) => f.path.endsWith('.submission.json')).path;
  const corrections = [
    { group: 'relations', index: 0, evidenceId: id },
    { group: 'requirements', index: 0, text: '平台包含监测模块' }
  ];
  const result = JSON.parse(await createArchitecturePlanTool({ llm }).run({ draftPath, corrections }));
  expect(JSON.parse(await ws.readText(result.architecturePath))).toHaveProperty('semantic', 'not_checked');
  expect(llm).toHaveBeenCalledTimes(1);
  await ws.write('虚构采购.md', '材料发生变化。');
  await expect(createArchitecturePlanTool({ llm }).run({ draftPath, corrections })).rejects.toHaveProperty('code', 'ARCHITECTURE_EVIDENCE');
  expect(llm).toHaveBeenCalledTimes(1);
});
it('有依据的设计推导仍是假设；混填、伪号、无假设声明均拒绝', async () => {
  const { id, input } = await sample();
  input.entities[1] = { ...input.entities[1], evidenceId: undefined, assumption: '建议设统一接口', basisEvidenceId: id };
  input.relations[0].evidenceId = id;
  delete input.requirements[0].text;
  const result = JSON.parse(await createArchitecturePlanTool({}).run(input));
  const plan = JSON.parse(await ws.readText(result.architecturePath));
  expect(plan.entities[1]).toMatchObject({ evidence: 'assumption', basis: { evidenceId: id, source: '虚构采购.md' } });
  for (const patch of [{ basisEvidenceId: 'ev:fake' }, { evidenceId: id }, { assumption: undefined }]) {
    const changed = structuredClone(input);
    Object.assign(changed.entities[1], patch);
    await expect(createArchitecturePlanTool({}).run(changed)).rejects.toBeTruthy();
  }
});
it('限制草稿路径、补丁位置与参数混用，停止信号不得吞掉', async () => {
  await expect(loadArchitectureSubmission({ draftPath: '上传/任意.json', corrections: [] })).rejects.toBeTruthy();
  const { input } = await sample();
  await expect(createArchitecturePlanTool({}).run(input)).rejects.toBeTruthy();
  const draftPath = (await ws.list('文档检查/架构输入')).find((f) => f.path.endsWith('.submission.json')).path;
  await expect(loadArchitectureSubmission({ draftPath, corrections: [{ group: 'relations', index: 99 }] })).rejects.toBeTruthy();
  await expect(loadArchitectureSubmission({ draftPath, title: '替换', corrections: [] })).rejects.toBeTruthy();
  const controller = new AbortController();
  controller.abort();
  await expect(validateArchitectureSubmission(input, [], [], { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
});

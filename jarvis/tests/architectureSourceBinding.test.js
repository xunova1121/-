import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { architectureSources } from '../src/agent/architectureSources.js';
import { makeArchitecturePlan } from '../src/agent/architecturePlan.js';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
const original = '配置数据服务，支撑研判处置。';
const input = () => ({
  title: '合成平台',
  entities: [
    {
      id: 'data',
      title: '数据服务',
      kind: 'capability',
      responsibility: '提供数据',
      inputs: ['事件'],
      outputs: ['事件'],
      source: '采购.md',
      excerpt: original
    },
    { id: 'app', title: '研判处置', kind: 'application', responsibility: '研判处置', inputs: ['事件'], outputs: ['工单'], source: '采购.md', excerpt: original }
  ],
  relations: [{ from: 'data', to: 'app', type: 'supports', meaning: '提供数据', source: '采购.md', excerpt: original }],
  requirements: [{ text: '研判处置', entities: ['app'], source: '采购.md', excerpt: original }]
});
let folder;
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-sources-'));
  useBackend(createFileStore(folder));
});
afterEach(() => {
  useBackend(null);
  fs.rmSync(folder, { recursive: true, force: true });
});
it('未填sources但依据给出真实路径时，程序补读原件再审查，正式SVG实际落盘', async () => {
  await ws.write('采购.md', original);
  const value = input();
  expect(architectureSources(value)).toEqual([{ path: '采购.md', excerpt: original }]);
  const receipt = JSON.parse(await createArchitecturePlanTool({ llm: async () => '{"passed":true,"issues":[]}' }).run(value, { rawRequestText: '制作架构图' }));
  expect(receipt.semantic).toBe('passed');
  const saved = JSON.parse(await ws.readText(receipt.architecturePath));
  expect(saved.sources[0]).toMatchObject({ path: '采购.md', matched: true, truncated: false });
  const diagram = createDiagramTool({}, { requireArchitecture: true });
  await diagram.run({ path: '合成架构.svg', architecturePath: receipt.architecturePath, formats: ['svg'] }, { rawRequestText: '制作架构图' });
  expect(await ws.readText('合成架构.svg')).toContain('研判处置');
  expect(await ws.readText('采购.md')).toBe(original);
});
it('章节标题不能冒充source，摘录错字仍拒绝，并精确指出对象及字段', () => {
  const value = input();
  value.entities[0].source = '采购需求 项目建设目标';
  expect(architectureSources(value).map((item) => item.path)).toEqual(['采购.md']);
  try {
    makeArchitecturePlan(value, [{ path: '采购.md', text: original }]);
    throw Error('应拒绝');
  } catch (error) {
    expect(error.diagnostics[0]).toMatchObject({ field: 'entities[0].source', stage: 'source' });
  }
  value.entities[0].source = '采购.md';
  value.entities[0].excerpt = '编造的文字';
  try {
    makeArchitecturePlan(value, [{ path: '采购.md', text: original }]);
    throw Error('应拒绝');
  } catch (error) {
    expect(error.diagnostics[0]).toMatchObject({ field: 'entities[0].excerpt', stage: 'excerpt' });
  }
  value.entities[0].excerpt = original;
  value.requirements[0].text = '改写概括';
  try {
    makeArchitecturePlan(value, [{ path: '采购.md', text: original }]);
    throw Error('应拒绝');
  } catch (error) {
    expect(error.diagnostics[0]).toMatchObject({ field: 'requirements[0].text', stage: 'fact' });
  }
});
it('显式章节范围不被自动补读覆盖，真实文件缺失不伪装已读，来源上限不截断', async () => {
  const value = input();
  value.sources = [{ path: '采购.md', excerpt: '章节', sectionStart: '正文唯一标题' }];
  expect(architectureSources(value)).toBe(value.sources);
  await expect(createArchitecturePlanTool({}).run(input())).rejects.toHaveProperty('code', 'DIAGRAM_SOURCE_READ');
  const many = input();
  many.entities = Array.from({ length: 5 }, (_, i) => ({ source: i + '.md', excerpt: '合成' }));
  expect(() => architectureSources(many)).toThrow(/最多4个/);
});
it('停止信号继续上抛，不变成来源错误或继续生成', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await expect(createArchitecturePlanTool({}).run(input(), { signal: ctrl.signal })).rejects.toHaveProperty('name', 'AbortError');
});

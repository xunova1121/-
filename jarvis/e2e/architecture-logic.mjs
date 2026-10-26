import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { architectureSpec, architectureLayout } from './fixtures/architecture-plan.mjs';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import * as workspace from '../src/agent/workspace.js';
import { renderSvg } from '../server/svgRender.mjs';
const output = path.resolve(process.argv[2] || '/tmp/architecture-logic');
await fs.mkdir(output, { recursive: true });
const ctx = { renderSvg, llm: async () => JSON.stringify({ passed: true, issues: [] }) };
const request = '建设示范业务闭环，统一权限与审计';
const view = process.env.ARCHITECTURE_VIEW || 'overview';
const plan = JSON.parse(await createArchitecturePlanTool(ctx).run(architectureSpec, { rawRequestText: request }));
assert.equal(plan.semantic, 'passed');
const response = await createDiagramTool(ctx, { requireArchitecture: true }).run(
  { ...structuredClone(architectureLayout), view, architecturePath: plan.architecturePath, path: '示范逻辑.svg', formats: ['svg', 'png'] },
  { rawRequestText: '制作架构图' }
);
const receipt = JSON.parse(response.split('\n')[1]);
assert.equal(receipt.preview.render, 'passed');
assert.equal(receipt.architecture.semantic, 'passed');
const scene = JSON.parse(await workspace.readText(receipt.designPath));
assert.equal(scene.architecture.planHash, JSON.parse(await workspace.readText(plan.reviewPath)).planHash);
for (const item of receipt.artifacts)
  await fs.writeFile(path.join(output, path.basename(item.path)), new Uint8Array(await (await workspace.readBlob(item.path)).arrayBuffer()));
for (const file of [receipt.designPath, plan.architecturePath, plan.reviewPath, plan.relationTablePath])
  await fs.writeFile(path.join(output, path.basename(file)), new Uint8Array(await (await workspace.readBlob(file)).arrayBuffer()));
await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log('业务底稿→关系审查→分层投影→真实SVG/PNG及摘要绑定：5/5；语义模型为假接口，非客户验收');

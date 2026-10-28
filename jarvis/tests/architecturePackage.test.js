import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
const state = vi.hoisted(() => ({ run: vi.fn(), load: vi.fn() }));
vi.mock('../src/agent/diagramTool.js', () => ({ createDiagramTool: () => ({ run: state.run }) }));
vi.mock('../src/agent/architectureProjection.js', () => ({ loadArchitecture: state.load }));
import { createArchitecturePackageTool } from '../src/agent/architecturePackage.js';
let folder;
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-package-')); useBackend(createFileStore(folder));
  state.load.mockReset(); state.run.mockReset();
  state.load.mockResolvedValue({ planHash: 'plan-v1', plan: { relations: [{ type: 'workflow' }, { type: 'dataflow' }] } });
  state.run.mockImplementation(async input => {
    const hash = 'design-' + input.view;
    const artifacts = ['svg', 'png', 'pdf', 'pptx'].map(format => ({ format, path: input.path + '.' + format, designHash: hash, hash: 'file-' + format }));
    return '已生成\n' + JSON.stringify({ architecture: { semantic: 'passed' }, editable: { passed: true }, designHash: hash, artifacts });
  });
});
afterEach(() => { useBackend(null); fs.rmSync(folder, { recursive: true, force: true }); });
it('自动交付有登记关系的三视图，清单逐一登记真实回执而非availableViews', async () => {
  const result = JSON.parse(await createArchitecturePackageTool({}).run({ architecturePath: '计划.architecture.json', directory: '交付/合成' }));
  expect(result.status).toBe('complete'); expect(result.completedViews.map(item => item.view)).toEqual(['overview', 'workflow', 'dataflow']);
  expect(result.files).toHaveLength(12); expect(state.run).toHaveBeenCalledTimes(3);
  expect(JSON.parse(await ws.readText(result.manifestPath)).planHash).toBe('plan-v1');
});
it('缺少专题关系不编造输出，非法目录和重复视图拒绝', async () => {
  const tool = createArchitecturePackageTool({});
  for (const directory of ['../外部', '/tmp/文件', 'x//y', 'x\\y']) await expect(tool.run({ architecturePath: 'x', directory })).rejects.toHaveProperty('code', 'ARCHITECTURE_PACKAGE');
  await expect(tool.run({ architecturePath: 'x', directory: '合成', views: ['overview', 'overview'] })).rejects.toHaveProperty('code', 'ARCHITECTURE_PACKAGE');
  state.load.mockResolvedValue({ planHash: 'plan-v1', plan: { relations: [] } });
  await expect(tool.run({ architecturePath: 'x', directory: '合成', views: ['dataflow'] })).rejects.toHaveProperty('code', 'ARCHITECTURE_PACKAGE');
  expect(state.run).not.toHaveBeenCalled();
});
it('第二视图失败只保留已完成文件清单，不把available或partial说成complete', async () => {
  state.run.mockImplementationOnce(async input => '已生成\n' + JSON.stringify({ architecture: { semantic: 'passed' }, editable: { passed: true }, designHash: 'v1', artifacts: ['svg','png','pdf','pptx'].map(format => ({ format, path: input.path + format, designHash: 'v1' })) }));
  state.run.mockRejectedValueOnce(Object.assign(new Error('渲染失败'), { code: 'DIAGRAM_RENDER' }));
  await expect(createArchitecturePackageTool({}).run({ architecturePath: 'x', directory: '合成' })).rejects.toHaveProperty('statePath', '合成/交付清单.json');
  const manifest = JSON.parse(await ws.readText('合成/交付清单.json'));
  expect(manifest.status).toBe('partial'); expect(manifest.completedViews).toHaveLength(1); expect(manifest.failedView).toBe('workflow');
});
it('底稿中途变更拒绝合并，停止信号原样抛出', async () => {
  state.load.mockResolvedValueOnce({ planHash: 'v1', plan: { relations: [] } });
  state.load.mockResolvedValueOnce({ planHash: 'v2', plan: { relations: [] } });
  await expect(createArchitecturePackageTool({}).run({ architecturePath: 'x', directory: '合成' })).rejects.toHaveProperty('code', 'ARCHITECTURE_PACKAGE');
  const ctrl = new AbortController(); ctrl.abort();
  await expect(createArchitecturePackageTool({}).run({}, { signal: ctrl.signal })).rejects.toHaveProperty('name', 'AbortError');
});
it('再次调用只复用实际摘要一致的完成视图，不再运行生成器', async () => {
  const { diagramDigest } = await import('../src/agent/diagramExport.js');
  state.load.mockResolvedValue({ path: '稿.architecture.json', planHash: 'same', report: { structure: 'passed', semantic: 'passed' }, plan: { relations: [] } });
  state.run.mockImplementation(async input => {
    const artifacts = [];
    for (const format of ['svg','png','pdf','pptx']) {
      const target = input.path.replace('.svg','') + (format === 'pptx' ? '-可编辑' : '') + '.' + format;
      const blob = new Blob(['合成文件:' + format]); await ws.write(target, blob);
      artifacts.push({path:target,format,hash:await diagramDigest(blob),designHash:'same-design'});
    }
    return '已生成\n' + JSON.stringify({architecture:{semantic:'passed'},editable:{passed:true},designHash:'same-design',artifacts});
  });
  const tool = createArchitecturePackageTool({});
  await tool.run({architecturePath:'稿.architecture.json',directory:'复用'});
  const next = JSON.parse(await tool.run({architecturePath:'稿.architecture.json',directory:'复用'}));
  expect(next.reusedViews).toEqual(['overview']);expect(state.run).toHaveBeenCalledTimes(1);expect(next.status).toBe('complete');
});

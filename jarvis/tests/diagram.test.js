import { it, expect, vi } from 'vitest';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramSvg } from '../src/agent/diagramSvg.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { mediaRequirement } from '../src/agent/actionDelivery.js';
import * as workspace from '../src/agent/workspace.js';
const input = { path: '架构验收.svg', title: '业务架构', layers: [
  { title: '设备层', nodes: [{ id: 'sensor', title: '雷达与无人机' }] },
  { title: '数据与AI中台', nodes: [{ id: 'data', title: '数据清洗' }] },
  { title: '三大AI端', emphasis: true, nodes: [{ id: 'warn', title: '预警端', detail: '识别违法、分析轨迹' }, { id: 'command', title: '指挥端', detail: '就近派单、闭环跟踪' }, { id: 'enforce', title: '执法端', detail: '法条、文书、裁量' }] },
  { title: '应用层', nodes: [{ id: 'app', title: '大屏、PC、移动端' }] }
], edges: [{ from: 'sensor', to: 'data' }, { from: 'data', to: 'warn' }, { from: 'warn', to: 'app' }] };
it('自下而上层级，突出核心，原生可编辑文字和图形', () => {
  const model = layoutDiagram(input);
  expect(model.layers.map(layer => layer.title)).toEqual(['应用层', '三大AI端', '数据与AI中台', '设备层']);
  expect(model.layers[1].emphasis).toBe(true);
  const svg = diagramSvg(model);
  expect(svg).toContain('<text');
  expect(svg).toContain('data-from="sensor"');
  expect(svg).not.toMatch(/<image|<foreignObject|<script/);
  expect(mediaRequirement('画一张可编辑架构图')).toMatchObject({ tool: 'create_diagram' });
});
it('拒绝重复ID、悬空连线、超限和长文字溢出，不丢节点', () => {
  expect(() => layoutDiagram({ ...input, edges: [{ from: 'missing', to: 'app' }] })).toThrow();
  expect(() => layoutDiagram({ ...input, layers: [{ title: '重复', nodes: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }] })).toThrow();
  const long = layoutDiagram({ title: '长文', layers: [{ title: '一层', nodes: Array.from({ length: 4 }, (_, index) => ({ id: String(index), title: '节点', detail: '超长'.repeat(80) })) }] });
  expect(() => diagramSvg(long)).toThrow(/版面容量/);
  const escaped = diagramSvg(layoutDiagram({ title: '<script>恶意</script>', layers: [{ title: '层', nodes: [{ id: 'x', title: 'A&B' }] }] }));
  expect(escaped).not.toContain('<script>');
  expect(escaped).toContain('A&amp;B');
});
it('没有渲染环境只交SVG，不伪造视觉/业务通过，不生成多余Office', async () => {
  const changed = [];
  const events = [];
  const text = await createDiagramTool({ onFileChanged: path => changed.push(path) }).run(input, { checkpoint: event => events.push(event) });
  expect(changed).toEqual(['架构验收.svg']);
  expect(text).not.toContain('docx');
  expect(events[0].validation).toMatchObject({ structure: 'passed', readback: 'passed', render: 'not_checked', visual: 'not_checked', business: 'not_checked' });
});
it('读取来源原文匹配摘录，真实渲染图交视觉，失败保留半成品', async () => {
  await workspace.write('架构来源.md', '预警端识别违法，指挥端就近派单。');
  const visionLlm = vi.fn(async ({ images }) => { expect(images[0].data).toBe('fixture'); return '{"passed":false,"issues":["连线有遮挡"]}'; });
  const events = [];
  const text = await createDiagramTool({ renderDiagram: async () => ({ mime: 'image/png', data: 'fixture' }), visionLlm }).run({ ...input, path: '架构视觉失败.svg', sources: [{ path: '架构来源.md', excerpt: '预警端识别违法' }] }, { checkpoint: event => events.push(event) });
  expect(visionLlm).toHaveBeenCalledTimes(1);
  expect(events.at(-1).validation).toMatchObject({ render: 'passed', visual: 'failed', errors: 1, business: 'source_excerpts_matched' });
  expect(text).toContain('连线有遮挡');
  expect(await workspace.exists('架构视觉失败.svg')).toBe(true);
});
it('开始前停止不写文件，检查期间停止不吞', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(createDiagramTool({}).run({ ...input, path: '架构停止.svg' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(await workspace.exists('架构停止.svg')).toBe(false);
});
it('参考Word材料不等于要求交Word，明确PPT交付仍保留', async () => {
  const { taskContract } = await import('../src/agent/taskContract.js');
  expect(taskContract('按照上传/招标文件.docx画一张架构图，只需要图').formats).toEqual([]);
  expect(mediaRequirement('按照上传/招标文件.docx画一张架构图')).toMatchObject({ tool: 'create_diagram' });
  expect(taskContract('用PPT制作架构图').formats).toEqual(['pptx']);
  expect(mediaRequirement('用PPT制作架构图')).toBeNull();
});

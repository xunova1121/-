/** 2026-11-17 用户：检查业务图、流程图的工具是否对。以前流程图只能画成分层架构图，新增独立流程图工具 */
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { normalizeFlowchart, layoutFlowchart, composeFlowchartSvg, composeFlowchartPptx, checkFlowchart, countCrossings } from '../src/agent/flowchart.js';
import { createFlowchartTool } from '../src/agent/flowchartTool.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { collection, useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';

beforeEach(async () => { useBackend(null); for (const name of ['files', 'kv', 'sessions']) await collection(name).clear(); });
const leave = () => ({ title: '请假审批流程', kind: 'swimlane', lanes: [{ id: 'emp', title: '员工' }, { id: 'mgr', title: '部门经理' }, { id: 'hr', title: '人事部' }],
  nodes: [{ id: 's', text: '开始', type: 'start', lane: 'emp' }, { id: 'a', text: '填写请假申请', lane: 'emp' }, { id: 'b', text: '经理审批', type: 'decision', lane: 'mgr' },
    { id: 'c', text: '请假超过3天？', type: 'decision', lane: 'mgr' }, { id: 'd', text: '人事复核并备案', lane: 'hr' }, { id: 'e', text: '通知员工结果', type: 'document', lane: 'hr' }, { id: 'z', text: '结束', type: 'end', lane: 'emp' }],
  edges: [{ from: 's', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c', label: '同意' }, { from: 'b', to: 'a', label: '退回修改' },
    { from: 'c', to: 'd', label: '是' }, { from: 'c', to: 'e', label: '否' }, { from: 'd', to: 'e' }, { from: 'e', to: 'z' }] });
const inside = (p, b) => p[0] > b.x + 1 && p[0] < b.x + b.w - 1 && p[1] > b.y + 1 && p[1] < b.y + b.h - 1;

describe('流程图引擎', () => {
  it('泳道图：节点都在自己的泳道里，按步骤从上到下，退回线标为回头线', () => {
    const flow = normalizeFlowchart(leave()), layout = layoutFlowchart(flow);
    for (const node of flow.nodes) {
      const box = layout.boxes.get(node.id), lane = layout.lanes.find(l => l.id === node.lane);
      expect(box.x).toBeGreaterThanOrEqual(lane.x); expect(box.x + box.w).toBeLessThanOrEqual(lane.x + lane.w);
    }
    expect(layout.boxes.get('a').y).toBeGreaterThan(layout.boxes.get('s').y);
    expect(layout.boxes.get('z').y).toBeGreaterThan(layout.boxes.get('e').y);
    expect(layout.edges.find(e => e.from === 'b' && e.to === 'a').back).toBe(true);
    expect(checkFlowchart(flow, layout)).toMatchObject({ status: 'passed', crossings: 0, backEdges: 1 });
  });
  it('连线不穿过起止以外的任何节点（跨两步的“否”不能压在中间节点上）', () => {
    const flow = normalizeFlowchart(leave()), layout = layoutFlowchart(flow);
    for (const edge of layout.edges.filter(e => !e.back)) {
      const others = [...layout.boxes.entries()].filter(([id]) => id !== edge.from && id !== edge.to).map(([, b]) => b);
      for (const [k, q] of edge.points.slice(1).entries()) {
        const p = edge.points[k];
        for (let t = 0; t <= 20; t++) {
          const pt = [p[0] + (q[0] - p[0]) * t / 20, p[1] + (q[1] - p[1]) * t / 20];
          expect(others.some(b => inside(pt, b))).toBe(false);
        }
      }
    }
  });
  it('思维导图从左到右展开；交叉计数能数出真实交叉', () => {
    const flow = normalizeFlowchart({ title: '新品上市', kind: 'mindmap', nodes: [{ id: 'r', text: '新品上市' }, { id: 'a', text: '调研' }, { id: 'b', text: '推广' }], edges: [{ from: 'r', to: 'a' }, { from: 'r', to: 'b' }] });
    const layout = layoutFlowchart(flow);
    expect(flow.direction).toBe('LR');
    expect(layout.boxes.get('a').x).toBeGreaterThan(layout.boxes.get('r').x + layout.boxes.get('r').w);
    expect(countCrossings([{ points: [[0, 0], [10, 10]] }, { points: [[0, 10], [10, 0]] }])).toBe(1);
  });
  it('结构问题如实报告：判断只有一个出口、出口没写条件、结束后还有连线', () => {
    const flow = normalizeFlowchart({ title: 't', nodes: [{ id: 's', text: '开始', type: 'start' }, { id: 'q', text: '是否通过', type: 'decision' }, { id: 'z', text: '结束', type: 'end' }, { id: 'x', text: '归档' }],
      edges: [{ from: 's', to: 'q' }, { from: 'q', to: 'z' }, { from: 'z', to: 'x' }] });
    expect(checkFlowchart(flow, layoutFlowchart(flow)).issues.map(i => i.code)).toEqual(['FLOW_DECISION_BRANCHES', 'FLOW_END_HAS_OUTPUT']);
  });
  it('不合规输入直接报错，不截字、不丢节点', () => {
    const base = leave();
    expect(() => normalizeFlowchart({ ...base, nodes: base.nodes.map(n => n.id === 'a' ? { ...n, text: '字'.repeat(41) } : n) })).toThrow(/超过40字/);
    expect(() => normalizeFlowchart({ ...base, nodes: base.nodes.map(n => n.id === 'a' ? { ...n, lane: 'boss' } : n) })).toThrow(/泳道/);
    expect(() => normalizeFlowchart({ ...base, edges: [...base.edges, { from: 'a', to: 'nope' }] })).toThrow(/已有节点/);
    expect(() => normalizeFlowchart({ ...base, nodes: [...base.nodes, { id: 'lonely', text: '孤立', lane: 'hr' }] })).toThrow(/没有任何连线/);
  });
  it('SVG通过视觉白名单并真实渲染；PPTX用PowerPoint自带流程图形状', async () => {
    const flow = normalizeFlowchart(leave()), layout = layoutFlowchart(flow), svg = composeFlowchartSvg(flow, layout);
    for (const t of ['请假审批流程', '部门经理', '退回修改', '请假超过3天？']) expect(svg).toContain(t);
    const png = await renderVisualScene(svg, {});
    expect(png.fontCheck.status).toBe('passed');
    const zip = await JSZip.loadAsync(await (await composeFlowchartPptx(flow, layout)).arrayBuffer());
    const slide = await zip.file('ppt/slides/slide1.xml').async('string');
    for (const shape of ['flowChartDecision', 'flowChartTerminator', 'flowChartDocument', 'flowChartProcess']) expect(slide).toContain(shape);
    expect(slide).toContain('填写请假申请');
    expect(slide).toContain('type="triangle"');
  }, 60000);
});

describe('create_flowchart 工具', () => {
  it('交付PNG/SVG/PPTX/源稿，回执带结构检查和交叉数；用源稿改图另存不覆盖', async () => {
    const tool = createFlowchartTool({ renderVisualScene });
    const first = JSON.parse(await tool.run({ ...leave(), path: '流程/请假' }));
    expect(first.status).toBe('complete');
    expect(first.files.map(f => f.format)).toEqual(['json', 'svg', 'png', 'pptx']);
    expect(first.sourcePath).toBe('流程/请假.flow.json');
    expect(first.checks).toMatchObject({ status: 'passed', crossings: 0 });
    expect(first.visual).toBe('not_checked');
    const revised = JSON.parse(await tool.run({ source_path: first.sourcePath, title: '请假审批流程（修订）' }));
    expect(revised.sourcePath).not.toBe(first.sourcePath);
    expect(JSON.parse(await ws.readText(revised.sourcePath)).nodes).toHaveLength(7);
    expect(JSON.parse(await ws.readText(first.sourcePath)).title).toBe('请假审批流程');
  }, 60000);
});

describe('画图类请求调对工具（2026-11-17 复查）', () => {
  it('业务图/流程图/泳道图/思维导图调出流程图和架构图工具，不混进海报工具；PPT含架构图同时给文档和画图工具；交互Demo调出Demo工具', async () => {
    const { taskToolCore } = await import('../src/agent/taskToolProfile.js');
    for (const text of ['帮我画一个业务图', '画一张业务流程图', '画一张泳道图', '做个思维导图', '画个系统架构图', '做个组织架构图']) {
      const tools = taskToolCore({}, text);
      expect(tools.has('create_flowchart')).toBe(true);
      expect(tools.has('create_diagram')).toBe(true);
      expect(tools.has('make_poster')).toBe(false);
    }
    const ppt = taskToolCore({}, '做一个汇报PPT，里面要有架构图');
    expect(ppt.has('create_document')).toBe(true);
    expect(ppt.has('create_diagram')).toBe(true);
    expect(taskToolCore({}, '做一个产品介绍PPT').has('create_diagram')).toBe(false);
    expect(taskToolCore({}, '做个交互Demo展示我们的系统').has('create_visual_demo')).toBe(true);
    expect(taskToolCore({}, '做一个产品原型页面').has('create_visual_demo')).toBe(true);
  });
  it('画图说明最前面写清各工具分工', async () => {
    const { DIAGRAM_PLANNING } = await import('../src/agent/diagramPlanning.js');
    expect(DIAGRAM_PLANNING.startsWith('【先选对工具】')).toBe(true);
    for (const word of ['create_flowchart', 'export_diagram', 'build_architecture', 'create_architecture_package', '内部步骤', '时序图、甘特图、ER图']) expect(DIAGRAM_PLANNING).toContain(word);
  });
  it('流程图结果进入成果索引，主文件和源稿都能找到', async () => {
    const { recordWorkAttempt, listWorkRecords } = await import('../src/agent/workLedger.js');
    await collection('sessions').put({ id: 'flow-session', messages: [] });
    const output = await createFlowchartTool({ renderVisualScene }).run({ ...leave(), path: '流程/索引' });
    await recordWorkAttempt({ tool: 'create_flowchart', args: {}, output, ok: true, sessionId: 'flow-session', scope: {}, callId: 'f1' });
    const records = (await listWorkRecords({ kind: 'diagram' })).items;
    expect(records[0].files).toEqual(expect.arrayContaining(['流程/索引.png', '流程/索引.flow.json', '流程/索引.pptx']));
  }, 60000);
});

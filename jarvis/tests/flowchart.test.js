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
    // 同批新增“先想表达什么”放在最前，工具分工紧随其后
    expect(DIAGRAM_PLANNING.indexOf('【先选对工具】')).toBeGreaterThan(DIAGRAM_PLANNING.indexOf('【先想表达什么】'));
    expect(DIAGRAM_PLANNING.indexOf('【先选对工具】')).toBeLessThan(400);
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

describe('借鉴 diagram-design 的设计规矩（MIT，思路重写）', () => {
  const branches = () => normalizeFlowchart(leave());
  it('同一节点同一边的多条连线各自分开接，间距≥8像素；判断的两个分支从不同方向出', () => {
    const flow = branches(), layout = layoutFlowchart(flow);
    const points = new Map();
    layout.edges.forEach(e => {
      for (const [id, p] of [[e.from, e.points[0]], [e.to, e.points.at(-1)]]) { if (!points.has(id)) points.set(id, []); points.get(id).push(p); }
    });
    for (const list of points.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
      expect(Math.hypot(list[i][0] - list[j][0], list[i][1] - list[j][1])).toBeGreaterThanOrEqual(8);
    const [yes, no] = ['是', '否'].map(label => layout.edges.find(e => e.label === label).points[0]);
    expect(yes[0] !== no[0] && yes[1] !== no[1]).toBe(true);
    expect(checkFlowchart(flow, layout).crossings).toBe(0);
  });
  it('不同连线不叠成一条：中段水平/竖直线不重合', () => {
    const layout = layoutFlowchart(branches()), segs = [];
    layout.edges.forEach((e, i) => e.points.slice(1).forEach((q, k) => segs.push({ i, a: e.points[k], b: q })));
    for (const s of segs) for (const t of segs) {
      if (s.i >= t.i) continue;
      const h = s.a[1] === s.b[1] && t.a[1] === t.b[1] && Math.abs(s.a[1] - t.a[1]) < 1;
      const v = s.a[0] === s.b[0] && t.a[0] === t.b[0] && Math.abs(s.a[0] - t.a[0]) < 1;
      const [k, j] = h ? [0, 0] : [1, 1];
      if (h || v) expect(Math.min(Math.max(s.a[k], s.b[k]), Math.max(t.a[j], t.b[j])) - Math.max(Math.min(s.a[k], s.b[k]), Math.min(t.a[j], t.b[j]))).toBeLessThanOrEqual(1);
    }
  });
  it('重点最多2个并用强调色；超过9个节点提示拆图，不判失败', () => {
    const base = leave();
    const focused = normalizeFlowchart({ ...base, nodes: base.nodes.map(n => (n.id === 'b' ? { ...n, focus: true } : n)) });
    expect(composeFlowchartSvg(focused)).toContain('stroke="#2563EB" stroke-width="3"');
    expect(() => normalizeFlowchart({ ...base, nodes: base.nodes.map((n, i) => (i < 3 ? { ...n, focus: true } : n)) })).toThrow(/最多2个/);
    const many = { title: '长流程', nodes: Array.from({ length: 11 }, (_, i) => ({ id: 'n' + i, text: '第' + i + '步', type: i ? i === 10 ? 'end' : 'process' : 'start' })), edges: Array.from({ length: 10 }, (_, i) => ({ from: 'n' + i, to: 'n' + (i + 1) })) };
    const flow = normalizeFlowchart(many), checks = checkFlowchart(flow, layoutFlowchart(flow));
    expect(checks.status).toBe('passed');
    expect(checks.advice.map(a => a.code)).toEqual(['FLOW_TOO_DENSE', 'FLOW_NO_FOCUS']);
  });
  it('画图说明先问要表达什么；严格流程的内部工具标明不单独用；海报自审带“AI味”清单', async () => {
    const { DIAGRAM_PLANNING } = await import('../src/agent/diagramPlanning.js');
    expect(DIAGRAM_PLANNING.startsWith('【先想表达什么】')).toBe(true);
    const { createTools } = await import('../src/agent/tools.js');
    const tools = createTools({});
    for (const name of ['plan_architecture', 'prepare_architecture_evidence', 'revise_architecture_plan']) expect(tools.find(t => t.name === name).description.startsWith('【内部步骤】')).toBe(true);
    const { reviewLayeredDesign } = await import('../src/agent/layeredDesignQuality.js');
    const { planLayerDesign } = await import('../src/agent/layeredDesignLayout.js');
    let system = '';
    await reviewLayeredDesign({ visionLlm: async ({ system: s }) => { system = s; return '{}'; } }, planLayerDesign({ title: 't', design: { layout: 'free', layers: [{ id: 'title', type: 'text', text: 't', x: 80, y: 80, w: 600, h: 100, fontSize: 60 }] } }), new Blob([new Uint8Array(4)], { type: 'image/png' }));
    for (const word of ['暗底配青紫发光', '所有卡片一模一样', '超大圆角']) expect(system).toContain(word);
  });
});

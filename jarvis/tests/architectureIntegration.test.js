import { expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { ARCHITECTURE_RELATIONS, architectureMarkdown, makeArchitecturePlan } from '../src/agent/architecturePlan.js';
import { compileArchitectureRelations } from '../src/agent/architectureRelations.js';
import { inspectArchitecture, reviewArchitecture } from '../src/agent/architectureReview.js';
import { projectArchitecture } from '../src/agent/architectureProjection.js';
import { architectureBusinessSummary } from '../src/agent/architectureBusiness.js';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene, sceneElements, validateScene } from '../src/agent/diagramScene.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';
import { makeDiagramPptx } from '../src/agent/diagramPptx.js';
import { inspectNativeDiagram } from '../src/agent/diagramPptxStructure.js';

const excerpt = '示范应用平台与协作业务系统进行应用级集成。';
const proof = { source: '虚构材料.md', excerpt };
const entity = (id, kind = 'system') => ({ id, title: id, kind, responsibility: '承担本系统登记的业务职责', inputs: [], outputs: [], ...proof });
function fixture() {
  return { title: '虚构系统应用集成', entities: [entity('应用平台'), entity('协作系统')],
    relations: [{ from: '应用平台', to: '协作系统', type: 'integration', meaning: '应用级集成', ...proof }],
    requirements: [{ text: excerpt, entities: ['应用平台', '协作系统'], ...proof }] };
}
const make = input => makeArchitecturePlan(input || fixture(), [{ path: proof.source, text: excerpt }]);
const bundle = plan => ({ plan: plan || make(), report: { structure: 'passed', semantic: 'passed' } });
function scene(view = 'overview', value = bundle()) {
  const input = projectArchitecture(value, { view });
  return diagramScene(layoutDiagram(input), input.design);
}

it('明确应用集成可用有源无向关系表达，不凭空补传输对象或支撑方向', () => {
  const plan = make();
  expect(ARCHITECTURE_RELATIONS).toContain('integration');
  expect(createArchitecturePlanTool({}).input_schema.properties.relations.items.properties.type.enum).toContain('integration');
  expect(plan.relations[0]).toMatchObject({ type: 'integration', evidence: 'excerpt_matched', ...proof });
  expect(plan.entities.every(item => !item.inputs.length && !item.outputs.length)).toBe(true);
  expect(inspectArchitecture(plan).structure).toBe('passed');
  expect(architectureBusinessSummary(plan)).toMatchObject({ workflowCount: 0, feedbackCount: 0 });
  expect(architectureMarkdown(plan)).toContain('应用平台 — 协作系统 [integration]');
  expect(compileArchitectureRelations(fixture().relations, fixture().entities)).toEqual(fixture().relations);
});

it('无向集成保留原材料检查：缺来源、错摘录或仅假设均不能通过', () => {
  const noMaterial = fixture();
  expect(() => makeArchitecturePlan(noMaterial, [])).toThrow('依据未出现在实际读取材料');
  const changed = fixture(); changed.relations[0].excerpt = '虚构并不存在的集成关系';
  expect(() => make(changed)).toThrow('依据未出现在实际读取材料');
  const assumed = fixture(); assumed.relations[0] = { from: '应用平台', to: '协作系统', type: 'integration', meaning: '应用级集成', assumption: '为方便出图假设集成' };
  expect(() => make(assumed)).toThrow('须引用材料');
});

it('用户明确给出的集成要求同样逐字核验，不把真实用户原话误当假设', () => {
  const value = fixture();
  for (const group of ['entities', 'relations', 'requirements']) for (const row of value[group]) row.source = 'user';
  const plan = makeArchitecturePlan(value, [], excerpt);
  expect(plan.relations[0]).toMatchObject({ source: 'user', excerpt, evidence: 'excerpt_matched', type: 'integration' });
  expect(() => makeArchitecturePlan(value, [], '用户没有提出两个系统的集成')).toThrow('依据未出现在实际读取材料');
});

it('集成限制为不同系统/应用/共用能力，硬件、界面和数据不能借它绕过原规则', () => {
  for (const kind of ['interface', 'data', 'acquisition', 'infrastructure', 'security']) {
    const value = fixture(); value.entities[1].kind = kind;
    expect(() => make(value), kind).toThrow('应用集成仅连接');
  }
  for (const kind of ['application', 'capability']) {
    const value = fixture(); value.entities[1].kind = kind;
    expect(inspectArchitecture(make(value)).structure).toBe('passed');
  }
  const self = fixture(); self.relations[0].to = self.relations[0].from;
  expect(() => make(self)).toThrow('自身');
  const duplicate = fixture(); duplicate.relations.push({ ...duplicate.relations[0], from: '协作系统', to: '应用平台' });
  expect(() => make(duplicate)).toThrow('同类型关系重复');
  for (const field of ['intent', 'data']) {
    const value = fixture(); value.relations[0][field] = field === 'intent' ? 'usage' : '未经登记的数据';
    expect(() => make(value)).toThrow('不能混填');
  }
});

it('新增语义不放宽原dataflow端口与supports方向规则，也不冒充业务流/数据流专题', () => {
  const data = make(); data.relations[0].type = 'dataflow';
  expect(inspectArchitecture(data)).toMatchObject({ structure: 'failed', issues: [expect.objectContaining({ kind: 'flow' })] });
  const support = fixture(); support.entities[0].kind = 'application'; support.entities[1].kind = 'capability'; support.relations[0].type = 'supports';
  expect(inspectArchitecture(make(support)).structure).toBe('failed');
  for (const view of ['workflow', 'dataflow']) expect(() => projectArchitecture(bundle(), { view })).toThrow('没有登记此视图');
  const overview = projectArchitecture(bundle(), { view: 'overview' });
  expect(overview.relationCoverage).toEqual([{ id: 'relation-0', type: 'integration', display: 'undirected_link' }]);
  expect(overview.edges).toHaveLength(1);
  expect(overview.edges[0]).toMatchObject({ type: 'integration', meaning: '应用级集成', relationId: 'relation-0' });
});

it('有真实专题关系时集成线仍逐项登记为总览范围，不被算成专题箭头或静默删关系', () => {
  const text = excerpt + '受理业务向办理业务派单，并传输事项数据。';
  const raw = fixture(); raw.entities.push(...['受理业务', '办理业务'].map(id => ({ ...entity(id, 'application'), inputs: ['事项数据'], outputs: ['事项数据'] })));
  raw.relations.push(...['workflow', 'dataflow'].map(type => ({ from: '受理业务', to: '办理业务', type, meaning: type === 'workflow' ? '派单' : '传输事项数据', source: proof.source, excerpt: text })));
  const value = bundle(makeArchitecturePlan(raw, [{ path: proof.source, text }]));
  for (const view of ['workflow', 'dataflow']) {
    const projected = projectArchitecture(value, { view });
    expect(projected.edges.map(edge => edge.type)).toEqual([view]);
    expect(projected.relationCoverage).toHaveLength(3);
    expect(projected.relationCoverage[0]).toEqual({ id: 'relation-0', type: 'integration', display: 'overview_view' });
  }
});

it('集成仍须独立语义审查，引用只提及系统名称不能被程序自动宣称通过', async () => {
  const llm = vi.fn(async () => '{"passed":false,"issues":[{"target":"relation:0","kind":"dependency","detail":"材料未明确登记集成关系"}]}');
  const result = await reviewArchitecture({ llm }, make(), { materials: [{ path: proof.source, text: '仅介绍两个示范系统名称' }] });
  expect(result.semantic).toBe('failed');
  expect(llm).toHaveBeenCalledTimes(1);
  expect(llm.mock.calls[0][0].system).toContain('不能推断传输数据、发送方向');
  expect(() => projectArchitecture({ plan: make(), report: result }, {})).toThrow('业务关系审查未通过');
  expect(() => projectArchitecture({ plan: make(), report: { structure: 'passed', semantic: 'not_checked' } }, {})).toThrow('语义审查未完成');
});

it('总览和关系图只画无箭头虚线，恶意arrow覆盖或重开设计稿均不能改成有向关系', () => {
  for (const view of ['overview', 'relations']) {
    const value = scene(view), paths = sceneElements(value).filter(item => item.relationType === 'integration');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ arrow: false, dash: 'dash', from: '应用平台', to: '协作系统' });
    const svg = sceneSvg(JSON.parse(JSON.stringify(value)));
    expect(svg).toContain('stroke-dasharray="6 4"');
    expect(svg).not.toContain('marker-end=');
    expect(svg).toContain('不表示数据流或依赖方向');
    paths[0].arrow = true;
    expect(() => validateScene(value)).toThrow('必须保持无箭头虚线');
  }
  const projected = projectArchitecture(bundle(), { view: 'overview' });
  projected.edges[0].arrow = true;
  expect(sceneElements(diagramScene(layoutDiagram(projected), projected.design)).find(item => item.relationType === 'integration').arrow).toBe(false);
});

it('新集成语义不能经旧低层有向连线入口丢类型后冒充普通箭头', async () => {
  const projected = projectArchitecture(bundle(), { view: 'overview' });
  const ordinary = { ...projected, semanticRouting: false };
  expect(() => layoutDiagram(ordinary)).toThrow('应用集成需使用已审架构底稿');
  await expect(createDiagramTool({}).run({ ...ordinary, path: '虚构低层.svg' })).rejects.toHaveProperty('code', 'ARCHITECTURE_PLAN_REQUIRED');
});

it('原生可编辑PPT沿用同一无向虚线及真实双端锚点，不生成箭头或整图贴图', async () => {
  const value = scene(), blob = await makeDiagramPptx(value, { editable: true });
  const info = await inspectNativeDiagram(blob);
  expect(info.nodeGroups).toBe(2);
  expect(info.connectors).toBeGreaterThan(0);
  expect(info.anchoredEnds).toBe(info.connectors * 2);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  const connectors = [...xml.matchAll(/<p:cxnSp>[\s\S]*?<\/p:cxnSp>/g)].map(match => match[0]);
  expect(connectors).toHaveLength(info.connectors);
  for (const connector of connectors) {
    expect(connector).toContain('<a:prstDash val="dash"/>');
    expect(connector).not.toMatch(/<a:(?:headEnd|tailEnd)\b[^>]*type="(?:triangle|stealth|arrow)"/);
  }
  expect(Object.keys(zip.files).filter(file => /^ppt\/slides\/slide\d+\.xml$/.test(file))).toHaveLength(1);
}, 15000);

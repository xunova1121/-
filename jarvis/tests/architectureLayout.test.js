import { it, expect } from 'vitest';
import { businessArchitectureLayout } from '../src/agent/architectureLayout.js';
import { architectureInput, projectArchitecture } from '../src/agent/architectureProjection.js';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene } from '../src/agent/diagramScene.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';
const entity = (id, kind) => ({ id, title: id, kind, responsibility: '已登记职责', inputs: [], outputs: [] });
const plan = () => ({ title: '合成业务架构', layoutProfile: 'business-v2', entities: [entity('platform', 'system'), entity('pc', 'interface'), entity('app', 'application'), entity('cap', 'capability'), entity('data', 'data'), entity('cloud', 'infrastructure'), entity('security', 'security')], relations: ['app', 'cap', 'data'].map(to => ({ from: 'platform', to, type: 'contains', meaning: '内部组成' })), requirements: [] });
it('新默认版式按系统分组、展示独立、安全通栏，不改写职责与对象', () => {
  const value = plan(); const before = JSON.stringify(value);
  const input = businessArchitectureLayout(value);
  expect(input.view).toBe('overview');
  expect(input.layers.filter(layer => layer.group).map(layer => layer.role)).toEqual(['application', 'capability', 'data']);
  expect(input.layers.at(-1).kind).toBe('band');
  const projected = projectArchitecture({ plan: value, report: { structure: 'passed', semantic: 'passed' } }, {});
  const model = layoutDiagram(projected);
  const svg = sceneSvg(diagramScene(model, projected.design));
  for (const node of model.nodes) expect(svg).toContain('id="node-' + node.id + '"');
  expect(JSON.stringify(value)).toBe(before);
  expect(new Set(projected.layers.flatMap(layer => layer.nodes.map(node => node.id))).has('app')).toBe(true);
});
it('旧底稿保留原默认，显式版式不被新自动版式覆盖', () => {
  const legacy = plan(); delete legacy.layoutProfile;
  expect(architectureInput(legacy, {}).layers.some(layer => layer.role === 'system')).toBe(true);
  const manual = { layers: [{ title: '业务应用', role: 'application', nodes: [] }] };
  expect(architectureInput(plan(), manual).layers).toEqual(manual.layers);
});
it('跨系统关系端点保留独立系统节点，不能为容器好看隐藏连接对象', () => {
  const value = plan();
  value.relations.push({ from: 'platform', to: 'cloud', type: 'dataflow', meaning: '监控信息' });
  const result = businessArchitectureLayout(value);
  expect(result.layers.flatMap(layer => layer.nodes).some(item => item.id === 'platform')).toBe(true);
});
it('密集对象分排但不丢对象，超单图容量清楚拒绝而不缩字删关系', () => {
  const value = { title: '密集架构', entities: Array.from({ length: 30 }, (_, i) => entity('cap' + i, 'capability')), relations: [] };
  const result = businessArchitectureLayout(value);
  expect(result.layers.flatMap(layer => layer.nodes)).toHaveLength(30);
  expect(result.layers).toHaveLength(3);
  expect(() => businessArchitectureLayout({ ...value, entities: Array.from({ length: 100 }, (_, i) => entity('cap' + i, 'capability')) })).toThrow(/8层/);
});
it('密集业务总览按真实主线排序，其他模块入网格，保留全部对象与原稿', () => {
  const value = { title: '合成密集业务', layoutProfile: 'business-v2', entities: [entity('platform', 'system'), ...['warning', 'handling', 'dispatch', ...Array.from({length:8},(_,i)=>'module'+i)].map(id=>entity(id,'application'))], relations: [] };
  value.relations = [
    ...value.entities.slice(1).map(item=>({from:'platform',to:item.id,type:'contains',meaning:'系统内部组成'})),
    {from:'warning',to:'dispatch',type:'workflow',meaning:'分级派单'},
    {from:'dispatch',to:'handling',type:'workflow',meaning:'签收处置'},
    {from:'handling',to:'warning',type:'feedback',meaning:'结果回流'}
  ];
  const before=JSON.stringify(value);
  const projected=projectArchitecture({plan:value,report:{structure:'passed',semantic:'passed'}},{});
  const hero=projected.layers.find(layer=>layer.kind==='cards');
  const grid=projected.layers.find(layer=>layer.kind==='grid');
  expect(hero.nodes.map(item=>item.id)).toEqual(['warning','dispatch','handling']);
  expect(grid.nodes).toHaveLength(8);
  const svg=sceneSvg(diagramScene(layoutDiagram(projected),projected.design));
  for(const item of value.entities.slice(1))expect(svg).toContain('id="node-'+item.id+'"');
  expect(projected.design.audience).toContain('职责见业务底稿');
  expect(projected.relationCoverage).toHaveLength(value.relations.length);
  expect(JSON.stringify(value)).toBe(before);
  const workflow=projectArchitecture({plan:value,report:{structure:'passed',semantic:'passed'}},{view:'workflow'});
  expect(workflow.layers.flatMap(layer=>layer.nodes).map(node=>node.id)).toEqual(['warning','dispatch','handling']);
  expect(workflow.layers.flatMap(layer=>layer.nodes).every(node=>node.detail==='已登记职责')).toBe(true);
});
it('网格仅用于总览组成，外部支撑发起方不能被归入无正文网格', () => {
  const value={title:'密集模块',entities:[entity('platform','system'),...Array.from({length:11},(_,i)=>entity('m'+i,'application'))],relations:[]};
  value.relations=value.entities.slice(1).map(item=>({from:'platform',to:item.id,type:'contains',meaning:'组成'}));
  value.relations.push({from:'m0',to:'m1',type:'supports',meaning:'提供能力'});
  const result=businessArchitectureLayout(value);
  expect(result.layers.find(layer=>layer.kind==='cards').nodes[0].id).toBe('m0');
  expect(result.layers.find(layer=>layer.kind==='grid').nodes.some(item=>item.id==='m0')).toBe(false);
  expect(businessArchitectureLayout(value,{view:'dataflow'}).layers.some(layer=>layer.kind==='grid')).toBe(false);
});
it('总览容量超限时仍可独立生成有界专题，不提前用全图层数误拒绝', () => {
  const roles=['application','capability','data','acquisition','infrastructure','interface','security'];
  const value={title:'跨系统专题',layoutProfile:'business-v2',entities:[],relations:[]};
  for(const group of ['one','two']){
    value.entities.push(entity(group,'system'));
    for(const role of roles){const id=group+'-'+role;value.entities.push(entity(id,role));value.relations.push({from:group,to:id,type:'contains',meaning:'系统组成'});}
  }
  value.relations.push({from:'one-application',to:'two-application',type:'workflow',meaning:'协同办理'});
  expect(()=>businessArchitectureLayout(value)).toThrow(/8层/);
  const projected=projectArchitecture({plan:value,report:{structure:'passed',semantic:'passed'}},{view:'workflow'});
  expect(projected.layers).toHaveLength(2);
  expect(layoutDiagram(projected).nodes.map(item=>item.id)).toEqual(['one-application','two-application']);
  expect(projected.relationCoverage).toHaveLength(value.relations.length);
});
it('显式网格进入业务专题后还原已审职责，不变成只有标题的卡片', () => {
  const value={title:'网格专题',entities:[entity('platform','system'),...Array.from({length:8},(_,i)=>entity('m'+i,'application'))],relations:[]};
  value.relations=value.entities.slice(1).map(item=>({from:'platform',to:item.id,type:'contains',meaning:'组成'}));
  value.relations.push({from:'m0',to:'m1',type:'workflow',meaning:'办理'});
  const projected=projectArchitecture({plan:value,report:{structure:'passed',semantic:'passed'}},{view:'workflow',layers:[{title:'业务应用',role:'application',kind:'grid',group:'platform',nodes:value.entities.slice(1).map(item=>({id:item.id,title:item.title}))}]});
  expect(projected.layers[0].kind).toBe('cards');
  expect(projected.layers[0].nodes.map(item=>item.detail)).toEqual(['已登记职责','已登记职责']);
});
it('低中高三种密度都实际生成无重叠场景，主线输入输出来自原稿且不丢对象', () => {
  for(const count of [3,11,18]){
    const apps=Array.from({length:count},(_,i)=>({...entity('业务模块'+i,'application'),inputs:['业务输入'],outputs:['业务输出']}));
    const value={title:'密度验证',layoutProfile:'business-v2',entities:[entity('platform','system'),...apps],relations:apps.map(item=>({from:'platform',to:item.id,type:'contains',meaning:'组成'}))};
    value.relations.push({from:apps[0].id,to:apps[1].id,type:'workflow',meaning:'业务推进'},{from:apps[1].id,to:apps[2].id,type:'workflow',meaning:'现场处理'});
    const projected=projectArchitecture({plan:value,report:{structure:'passed',semantic:'passed'}},{});
    const model=layoutDiagram(projected);
    expect(model.nodes).toHaveLength(count);
    const svg=sceneSvg(diagramScene(model,projected.design));
    for(const item of apps)expect(svg).toContain('id="node-'+item.id+'"');
    if(count>=11){expect(svg).toContain('网格列名称');expect(svg).toContain('输入：业务输入');expect(svg).toContain('输出：业务输出');}
  }
});

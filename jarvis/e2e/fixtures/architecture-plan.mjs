/** 虚构园区，专门验证职责分层、两系统边界与闭环；不含客户项目材料。 */
const make = (id, title, kind, responsibility, inputs = [], outputs = []) => ({
  id,
  title,
  kind,
  responsibility,
  inputs,
  outputs,
  assumption: '虚构验收项目的推荐设计，非客户事实'
});
const entities = [
  make('platform', '示范协同管理平台', 'system', '统一承载业务与共用服务'),
  make('sensing', '示范感知接入子系统', 'system', '采集现场事件并向管理平台交换数据'),
  make('pc', '管理工作台', 'interface', '查看进展并处理任务', ['处置结果'], ['操作指令']),
  make('mobile', '移动作业端', 'interface', '接收工单与现场回传', ['工单'], ['现场回传']),
  make('alert', '预警研判', 'application', '接收识别结果，人工核验形成线索', ['识别结果', '处置结果'], ['线索']),
  make('dispatch', '指挥调度', 'application', '核对线索，匹配人员并派单', ['线索'], ['工单']),
  make('field', '现场处置', 'application', '签收工单、现场核验、审核后归档', ['工单'], ['处置结果']),
  make('ai', '识别服务', 'capability', '提供目标识别和场景判断', ['事件'], ['识别结果']),
  make('gis', '空间服务', 'capability', '提供地图与位置服务', ['位置'], ['空间图层']),
  make('events', '事件与证据数据', 'data', '管理事件、处置结果及证据关联', ['事件', '处置结果'], ['事件', '处置结果']),
  make('sensors', '现场感知接入', 'acquisition', '对现场信号编号、接入和质量检查', ['现场信号'], ['事件']),
  make('cloud', '运行资源', 'infrastructure', '为服务与接入提供计算、存储和网络'),
  make('security', '统一权限与审计', 'security', '贯穿各层，控制访问、操作留痕和数据保护')
];
const relation = (from, to, type, meaning) => ({ from, to, type, meaning, assumption: '虚构验收项目的关系假设' });
const relations = [
  ...['pc', 'mobile', 'alert', 'dispatch', 'field', 'ai', 'gis', 'events'].map((id) => relation('platform', id, 'contains', '平台内部对象')),
  relation('sensing', 'sensors', 'contains', '感知子系统接入职责'),
  relation('sensors', 'events', 'dataflow', '上报事件'),
  relation('events', 'ai', 'dataflow', '提供事件'),
  relation('ai', 'alert', 'dataflow', '识别结果'),
  relation('alert', 'dispatch', 'workflow', '提交线索'),
  relation('dispatch', 'field', 'workflow', '派发工单'),
  relation('field', 'alert', 'feedback', '处置反馈'),
  relation('field', 'events', 'dataflow', '保存处置结果'),
  relation('gis', 'dispatch', 'supports', '空间支撑'),
  relation('cloud', 'gis', 'supports', '运行承载'),
  relation('cloud', 'sensors', 'supports', '接入承载'),
  relation('field', 'pc', 'dataflow', '展示处置结果')
];
export const architectureSpec = {
  title: '示范园区协同系统总体架构',
  entities,
  relations,
  requirements: [
    {
      text: '建设示范业务闭环，统一权限与审计',
      entities: ['alert', 'dispatch', 'field', 'security'],
      source: 'user',
      excerpt: '建设示范业务闭环，统一权限与审计'
    }
  ]
};
const node = (id) => {
  const item = entities.find((item) => item.id === id);
  return { id, title: item.title, detail: item.responsibility };
};
export const architectureLayout = {
  direction: 'top-down',
  design: { theme: 'gov-blue', message: '业务职责清楚 · 系统边界明确 · 线索到处置形成闭环' },
  layers: [
    { title: '用户与展示', kind: 'columns', role: 'interface', nodes: ['pc', 'mobile'].map((id) => ({ ...node(id), icon: 'layout-grid' })) },
    {
      title: '业务应用',
      role: 'application',
      group: '示范协同管理平台',
      nodes: ['alert', 'dispatch', 'field'].map((id, index) => ({
        ...node(id),
        icon: ['triangle-alert', 'chart-column', 'clipboard-check'][index],
        accent: ['orange', 'blue', 'green'][index]
      }))
    },
    {
      title: '共用能力',
      role: 'capability',
      group: '示范协同管理平台',
      kind: 'columns',
      nodes: ['ai', 'gis'].map((id) => ({ ...node(id), icon: id === 'ai' ? 'cpu' : 'map-pin' }))
    },
    { title: '数据资源', role: 'data', group: '示范协同管理平台', nodes: [{ ...node('events'), icon: 'database' }] },
    { title: '感知与接入', role: 'acquisition', group: '示范感知接入子系统', nodes: [{ ...node('sensors'), icon: 'target' }] },
    { title: '基础设施', role: 'infrastructure', nodes: [{ ...node('cloud'), icon: 'cpu' }] },
    { title: '贯穿保障', role: 'security', kind: 'band', emphasis: true, nodes: [node('security')] }
  ]
};

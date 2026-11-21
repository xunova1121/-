/** 总体架构为虚构示范材料，数量只用于确定性验收，非客户数据。 */
import { cardSpec } from './diagram-cards.mjs';
const platform = '示范园区智慧协同管理平台';
const modules = [
  '统一门户',
  '资源驾驶舱',
  '事件预警',
  '对象管理',
  '巡查监管',
  '指挥调度',
  '队伍管理',
  '信息采集',
  '智能识别',
  '移动作业',
  '装备管理',
  '档案查询'
];
export const platformSpec = {
  title: '示范园区智慧协同总体架构图',
  direction: 'top-down',
  design: { theme: 'gov-blue', message: '统一平台统筹 · 三端协同处置 · 感知与现场一体联动', audience: '政企项目方案沟通' },
  layers: [
    {
      title: '界面展示层',
      kind: 'columns',
      nodes: [
        { id: 'screen', title: '大屏｜态势与指挥', icon: 'chart-column' },
        { id: 'pc', title: 'PC｜研判与派单', icon: 'layout-grid' },
        { id: 'mobile', title: '手机｜取证与回传', icon: 'clipboard-check' }
      ]
    },
    { ...structuredClone(cardSpec.layers[0]), title: '业务应用层｜串联发现、研判、派单、处置与归档', kind: 'cards' },
    { title: '闭环反馈', kind: 'band', nodes: [{ id: 'feedback', title: '事件回溯 · 结果归档 · 数据回流 · 策略优化 → 支撑下一次研判与调度' }] },
    { title: '业务模块｜承载日常管理', kind: 'grid', group: platform, nodes: modules.map((title, index) => ({ id: 'module-' + index, title })) },
    {
      title: '平台能力｜提供共用服务',
      kind: 'columns',
      group: platform,
      nodes: [
        { id: 'service', title: '业务能力中心', icon: 'network', subtitle: 'GIS / 事件 / 流程 / 检索', detail: '统一编排业务服务与任务流程' },
        { id: 'data', title: '数据能力', icon: 'database', subtitle: '接入 / 治理 / 共享', detail: '统一数据口径和资源目录' },
        { id: 'ai', title: 'AI服务', icon: 'cpu', subtitle: '算法库 / 调度 / 场景识别', detail: '辅助研判，关键结论人工复核' },
        { id: 'monitor', title: '运行监测', icon: 'chart-column', subtitle: '服务监测 / 接口对接', detail: '记录运行状态和异常事件' }
      ]
    },
    {
      title: '感知与协同｜接入设备、联动现场',
      kind: 'columns',
      group: platform,
      nodes: [
        { id: 'fence', title: '示范电子围栏', icon: 'map-pin', subtitle: '规则管理 / 目标监测', detail: '基于授权范围配置监测规则' },
        { id: 'fusion', title: '多源感知融合', icon: 'layers', subtitle: '视频 / 传感 / 轨迹', detail: '形成可追溯的关联线索' },
        { id: 'comms', title: '融合通信', icon: 'network', subtitle: '音视频联络 / 现场协同', detail: '联通指挥与现场工作队伍' },
        { id: 'location', title: '移动定位', icon: 'target', subtitle: '位置回传 / 状态查询', detail: '按授权查看位置与任务进度' }
      ]
    },
    {
      title: '基础设施｜稳定承载、统一连接',
      kind: 'columns',
      nodes: [
        { id: 'terminal', title: '终端感知层', icon: 'target', subtitle: '采集目标、设备与现场数据', detail: '8套示范传感设备；按编号关联线索' },
        { id: 'transport', title: '网络传输层', icon: 'network', subtitle: '连接感知、平台与现场', detail: '按现场条件选用有线或无线链路' },
        { id: 'cloud', title: '云基础设施层', icon: 'cpu', subtitle: '承载应用、数据与AI服务', detail: '计算与存储、数据库、中间件' }
      ]
    },
    {
      title: '安全保障',
      kind: 'band',
      emphasis: true,
      nodes: [{ id: 'security', title: '边界与网络安全 · 应用与数据安全 · 身份权限与审计 · 标准规范贯穿各层' }]
    }
  ],
  edges: structuredClone(cardSpec.edges)
};

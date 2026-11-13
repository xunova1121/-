/** 虚构验收素材，不含客户项目内容或真实设备清单。 */
export const cardSpec = {
  title: '示范园区协同处置架构',
  direction: 'top-down',
  design: { theme: 'navy', message: '统一线索 · 协同派单 · 现场闭环' },
  layers: [
    {
      title: '业务应用层 | 三端协同',
      emphasis: true,
      nodes: [
        {
          id: 'notice',
          title: '预警研判端',
          icon: 'triangle-alert',
          accent: 'orange',
          badge: '发现与研判',
          bullets: [
            { text: '接入8套示范传感设备', icon: 'target' },
            { text: '分析轨迹与事件线索', icon: 'trending-up' },
            { text: '关联历史记录与重点对象', icon: 'users' },
            { text: '人工确认后形成线索包', icon: 'clipboard-check' }
          ]
        },
        {
          id: 'dispatch',
          title: '指挥调度端',
          icon: 'chart-column',
          accent: 'blue',
          badge: '派单与跟踪',
          bullets: [
            { text: '一张图汇聚事件与资源', icon: 'layout-grid' },
            { text: '匹配附近可用工作队伍', icon: 'network' },
            { text: '人工确认后下达任务', icon: 'clipboard-list' },
            { text: '跟踪签收与处置进度', icon: 'clock' }
          ]
        },
        {
          id: 'field',
          title: '现场处置端',
          icon: 'scale',
          accent: 'green',
          badge: '取证与归档',
          bullets: [
            { text: '现场核验与图片取证', icon: 'search' },
            { text: '查询规则与相关案例', icon: 'book-open' },
            { text: '辅助整理材料和文书', icon: 'file-text' },
            { text: '人工审核后回传归档', icon: 'database' }
          ]
        }
      ]
    }
  ],
  edges: [
    { from: 'notice', to: 'dispatch', label: '结构化线索' },
    { from: 'dispatch', to: 'field', label: '任务工单' }
  ]
};

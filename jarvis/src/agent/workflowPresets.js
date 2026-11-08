/** 现成的工作流（编排层）：在“我的智能体”里一键套用，再按需要改；不是内置智能体，不改广场里的 8 个 */
export const WORKFLOW_PRESETS = Object.freeze([
  {
    id: 'qingshi', name: '请示流水线',
    steps: [
      { title: '整理要点', task: '把用户给的事由、依据、请求事项、金额和时间整理成要点清单；缺的写“待补充”，不要编' },
      { title: '起草请示', task: '按要点起草请示：一文一事、只写一个主送机关、结尾“妥否，请批示”', agentId: 'gongwen-writer', check: 'gongwen' },
      { title: '生成 Word', task: '把通过体检的请示生成公文格式的 Word 文件，并列出待补充的内容', agentId: 'gongwen-writer' }
    ]
  },
  {
    id: 'weekly', name: '周报',
    steps: [
      { title: '汇总本周', task: '从用户给的记录里整理本周完成的工作、关键数字和遇到的问题，数字写清单位' },
      { title: '写成周报', task: '按“本周完成 / 数据 / 问题与风险 / 下周计划”写成周报，结论先行', check: 'numbers' },
      { title: '生成 Word', task: '生成一页 Word 周报', agentId: 'gongwen-writer' }
    ]
  },
  {
    id: 'research-ppt', name: '调研到 PPT',
    steps: [
      { title: '查资料', task: '围绕用户的主题查证资料，列出关键事实、数字和来源', agentId: 'deep-researcher', check: 'numbers' },
      { title: '列提纲', task: '按“结论 → 现状 → 问题 → 建议”列出 PPT 提纲，每页一句判断，逐页标出版式（上图下文、左右分栏或多图）及配图意图；先确定版式再配图。此步只提供方案，不生成PPT，等待用户确认', review: true },
      { title: '做 PPT', task: '按提纲和查到的资料做成可编辑 PPT，数字注明来源', agentId: 'ppt-maker' }
    ]
  }
]);

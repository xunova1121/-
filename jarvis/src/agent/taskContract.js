/** 合约只提取明确交付类型，完整要求仍由需求账本保存，不用它猜用户意图。 */
export function taskContract(text = '') {
  const value = String(text).slice(0, 8000);
  const creating = /生成|制作|创建|编写|写一|做一|导出|保存为|开发|实现|修复|修改|重构/.test(value);
  const formats = creating ? [
    [/PPT|pptx|幻灯片|演示文稿/i, 'pptx'],
    [/Word|docx|文字文档/i, 'docx'],
    [/Excel|xlsx|电子表格/i, 'xlsx']
  ].filter(([pattern]) => pattern.test(value)).map(([, format]) => format) : [];
  return { formats, coding: creating && /代码|程序|脚本|JavaScript|TypeScript|Python|应用|网页|网站|接口/i.test(value),
    calculation: /\d/.test(value) && /盈亏|收益率|孕周|多少天|相差|日期差|百分比|合计|加起来/.test(value),
    researching: /查|搜索|核实|调研|研究|最新|今天|行情/.test(value),
    criteria: [...(formats.length ? ['实际文件存在且可读回', '分别报告结构、内容、渲染和未解决问题'] : []),
      ...(creating && /代码|程序|脚本|网页|网站/.test(value) ? ['先读现状与项目规则', '修改后运行适用测试，区分未执行与通过'] : [])] };
}

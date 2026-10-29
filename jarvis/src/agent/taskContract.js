import { mediaRequirement } from './actionDelivery.js';
/** 合约只提取明确交付类型，完整要求仍由需求账本保存，不用它猜用户意图。 */
/** 带数字的方案比较（“选哪个 / 哪个划算 / 值不值”，题里本来就要求有数字）：也要用工具算，第一轮 30 题实测决策题结论对、差额算错 */
const CHOICE_MATH = /选哪个|哪个(?:更)?(?:划算|便宜|省钱|合适|好)|划不划算|(?:更|还是[^，,。？?]{0,12})划算|合算|值不值|哪种方案更/;

export function taskContract(text = '') {
  const value = String(text).slice(0, 8000);
  // “把结果更新到那个 Excel 里”也是要交文件：以前没认出来，模型口头说“已更新”就收尾了
  const creating =
    !/^(?:解释|介绍|讨论|了解|如何|怎么)/.test(value.trim()) &&
    /生成|制作|创建|编写|写(?:一|Word|PPT|Excel)|做一|只做|做成|改为|换成|导出|保存为|开发|实现|修复|修改|重构|更新到|更新进|更新那|改到|写进|写入|填进|填入|加到|加进/.test(value);
  const diagram = /架构图|流程图|关系图|组织图|拓扑图/.test(value) && /画|生成|制作|做|重画/.test(value);
  const formats = creating
    ? [
        [/PPT|pptx|幻灯片|演示文稿/i, 'pptx'],
        [/Word|docx|文字文档/i, 'docx'],
        [/Excel|xlsx|电子表格/i, 'xlsx']
      ]
        .filter(([pattern]) => {
          if (diagram && !value.split(/[，,。；;\n]/).some(clause => pattern.test(clause) && /(?:输出|导出|生成|制作|做成|交付|保存为|用).{0,8}(?:PPT|Word|Excel|pptx|docx|xlsx)|(?:PPT|Word|Excel|pptx|docx|xlsx).{0,3}(?:格式|版本)/i.test(clause))) return false;
          const latest = value
            .split(/[,，;；。\\n]|但是|而是|只要|只做/)
            .filter((clause) => pattern.test(clause))
            .at(-1);
          return latest && !/不要|不用|取消|不做|别做|不需要/.test(latest);
        })
        .map(([, format]) => format)
    : [];
  const codeOnly = /代码|函数|JavaScript|TypeScript|Python/i.test(value) && /不运行|不执行|直接展示|只给代码/.test(value);
  // 用户贴进来的长文（交接记录、报告原文）里顺带出现“计算”“百分比”不算要算数：长文只看开头是不是在请你算
  const askText = value.length > 600 ? value.slice(0, 200) : value;
  const calculation = !codeOnly && (value.length <= 600 || /计算|核算|验算|算一下|算出|求出|合计|加起来/.test(askText)) && (!formats.length || /计算|核算|验算|算出|算式|求出|数值校验/.test(value)) && /\d/.test(value) && (/计算|算式|净重|货款|净盈利|手续费|相隔|权重|盈亏|收益率|孕周|多少天|相差|日期差|百分比|合计|加起来/.test(value) || CHOICE_MATH.test(value));
  // 用户要她记住（不是在问“记住了吗”）：必须真的调用记忆工具；问有没有记住：必须先查
  const asking =
    /(?:记住|记下|记进去|放进记忆|记到记忆|记得)(?:了)?(?:吗|么|没有|没)[？?]?\s*$/m.test(value) || /有没有(?:记|放进)|你有(?:记|放进)[^。！!]*[吗么]/.test(value);
  const remembering = !asking && /记住|记下来|记下这|记到记忆|放进记忆|别忘了|长点记性/.test(value);
  const media = mediaRequirement(value);
  return {
    media,
    formats,
    remembering,
    askingMemory: asking,
    coding: creating && /代码|程序|脚本|JavaScript|TypeScript|Python|应用|网页|网站|接口/i.test(value) && (!formats.length || /(?:同时|另外|并且|还要|以及|并).{0,12}(?:开发|实现|编写|提供|生成|运行|测试).{0,12}(?:代码|程序|脚本|JavaScript|TypeScript|Python|网页|网站|接口代码)/i.test(value)),
    calculation,
    researching: /查|搜索|核实|调研|研究|最新|今天|行情/.test(value),
    criteria: [
      ...(media ? [`实际调用${media.tool}并取得${media.label}文件回执，排队或口头承诺不算完成`] : []),
      ...(calculation ? ['先用verify_numbers或代码核对数值和日期基准，再给结论'] : []),
      ...(/日K|K线|最高价|最低价/i.test(value) ? ['历史日K优先get_stock_kline，明确证券代码、日期、复权和返回范围，不用搜索摘要冒充日K数据'] : []),
      ...(formats.length ? ['实际文件存在且可读回', '分别报告结构、内容、渲染和未解决问题'] : []),
      ...(creating && /代码|程序|脚本|网页|网站/.test(value)
        ? ['先读现状与项目规则，execution_capabilities核对实际执行环境', '修改后运行适用测试，区分未执行与通过']
        : [])
    ]
  };
}

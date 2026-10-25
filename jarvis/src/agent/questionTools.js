/** 仅对自包含、短且明确的基础问题裁工具；不确定时沿用完整能力。 */
const EXTERNAL = /今天|现在|最新|实时|天气|新闻|行情|收盘|赛程|比分|官网|渠道|链接|查找|搜索|查询|核实|联网|资料|附件|图片|文件|文档|方案|报告|表格|Excel|Word|PPT|代码|脚本|运行|打开|安装|提醒|定时|记住|记得|我家|我的|我住|我叫|之前|刚才|上次|这个|那个|上述|这些|前面|接着|继续|孕|医疗|药|合同|法律/i;
const UNITS = /^(?:请问|请告诉我|告诉我|请)?[\d一二三四五六七八九十百千万两点.]+\s*(?:公斤|千克|克|吨|米|厘米|毫米|千米|公里|升|毫升|小时|分钟|秒)\s*(?:等于|是|换算成|换成|有|为)\s*(?:多少|几)?\s*(?:公斤|千克|克|吨|米|厘米|毫米|千米|公里|升|毫升|小时|分钟|秒)/;
const BASIC = /月亮|月球|太阳|地球|光合作用|水蒸气|蒸发|凝结|浮力|重力|圆周率|三角形|质数|偶数|奇数|智能体|数据库|知识库|人工智能|机器学习|二进制/;
const QUESTION = /为什么|为何|什么是|是什么|解释|介绍|区别|原理|定义/;

export const BASIC_ANSWER_PROMPT = '你是未央。直接回答当前基础问题，遵守用户的格式、数量和否定要求。不编造来源、执行或工具核验；有计算校验工具时先核对再给结果。不要输出内部分析或表情标签。';

export function questionToolProfile(text, { images = [], history = [] } = {}) {
  const value = String(text).trim();
  if (!value || value.length > 220 || images.length || EXTERNAL.test(value)) return null;
  // 代词追问和工具续传不凭短句猜成新常识题。
  if (history.at(-1)?.role === 'tool' || /^(?:它|他|她|那|这|再|还有|然后)/.test(value)) return null;
  if (UNITS.test(value) || BASIC.test(value) && QUESTION.test(value)) return 'knowledge';
  const numbers = value.match(/\d+(?:\.\d+)?/g) || [];
  if (numbers.length >= 2 && /计算|算式|净重|货款|单价|毛重|筐重|皮重|净盈利|手续费|相隔|相差|多少天|合计|权重|百分比|[+×÷=]/.test(value)) return 'calculation';
  return null;
}

export function toolsForQuestion(tools, profile) {
  if (!profile) return tools;
  return profile === 'calculation' ? tools.filter(tool => tool.name === 'verify_numbers') : [];
}

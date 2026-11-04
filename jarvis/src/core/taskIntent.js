/** 前后端共用任务判断。只读用户原话，不把助手的“已完成”或工具正文当新指令。 */
import { isResponseRevision } from './responseRevision.js';
const CODE = /代码|编程|函数|变量|bug\b|调试|脚本|编译|html|css|javascript|typescript|python|java\b|golang|rust\b|sql\b|正则|前端|后端|部署|docker|git\b|网页|网站|小程序|```/i;
const SOURCE = /(?:^|\n)\s*(?:(?:async\s+)?function\s+\w+\s*\(|(?:const|let|var)\s+\w+\s*=|def\s+\w+\s*\(|(?:print|console\.log)\s*\(|(?:import|from)\s+[\w.]+\s+(?:import|as)|<(!doctype|html|svg)\b)/i;
const BUILD = /(?:创建|做|制作|搭建|开发|实现|编写|写)[^。！？\n]{0,60}(?:电商(?:项目|平台|系统|商城)?|商城|网站|网页|HTML|CSS|小程序)/i;
const DOCUMENT = /(?:写|做|制作|生成|修改|整理)[^。！？\n]{0,35}(?:文档|报告|方案|说明书|PPT|Word|Excel|幻灯片|表格)/i;
const WRITE = /(写|起草|撰写|帮我写|生成)(一|个|篇|份|封)?.{0,6}(报告|文档|文章|周报|日报|月报|总结|邮件|方案|计划书?|简历|ppt|幻灯片|文案|合同|论文|稿|通知|公告|说明书|演讲)|润色|改写|翻译|摘要|纪要|扩写|缩写|word|ppt/i;
const REASON = /调研|研究|分析|对比|比较|推理|证明|为什么|评估|权衡|策略|战略|规划|方案设计|数学|计算|推导|决策|利弊|深度|^\/团队/;
const WORK = /查|搜|天气|新闻|行情|股价|金价|汇率|比分|赛程|计算|换算|文件|文档|表格|笔记|备忘录|便笺|图片|画图|唱歌|歌曲|提醒|定时|记住|记下|保存|删除|移动|重命名|上传|下载|修改|创建|制作|生成|安排|整理|起名|取名/;
const CANCEL = /^(?:先|暂时)?(?:不做了|不用做了|不要做了|取消(?:任务)?|停止|停下|算了)[吧。！!\s]*$/;
const STATUS = /^(?:进度|好了吗|做好了吗|怎么样了|为什么停止|咋回事|怎么回事|又超时了|怎么又失败了)[？?。！!\s]*$/;
const FOLLOW = /^(?:(?:继续|恢复|接着|重新做|重做|再做一版|改一下|再改一下|写一个吧|做一个吧|就是继续|还有那|还有呢|再来一个|换一个|再换一个)[吧呀呢。！!\s]*|(?:继续|接着|重新|重做|把它|把这个|将它|将这个|改成|换成)[\s\S]{0,100})$/;

export const isTaskFollowup = text => !isResponseRevision(text) && FOLLOW.test(String(text || '').trim());
export const isTaskStatus = text => STATUS.test(String(text || '').trim());
export function isCodeRequest(text) {
  const value = String(text || '');
  if (SOURCE.test(value)) return true;
  // 报告谈到 API/接口、费用异常，不能仅凭名词切到代码模型。
  if (DOCUMENT.test(value) && !/代码|编程|调试|修复.{0,20}(?:bug|函数)|```/i.test(value)) return false;
  return CODE.test(value) || BUILD.test(value) || /(?:修复|实现|调试|开发|对接|调用).{0,30}(?:API|接口)|(?:程序|代码).{0,15}(?:报错|异常)|(?:API|接口).{0,15}(?:报错|401|403|500)/i.test(value);
}

export function classifyTaskText(text, { images = 0 } = {}) {
  const value = String(text || '');
  if (images > 0) return 'vision';
  if (isCodeRequest(value)) return 'code';
  if (WRITE.test(value) || DOCUMENT.test(value)) return 'write';
  if (/API|接口/i.test(value) && /收费|扣费|计费|价格|是什么|什么意思/.test(value)) return 'chat';
  if (REASON.test(value) || value.length > 400) return 'reason';
  return 'chat';
}

function explicitTask(text, ts = 0) {
  const modelTask = classifyTaskText(text);
  return { category: modelTask === 'code' ? 'code' : modelTask !== 'chat' || WORK.test(text) ? 'work' : 'chat', modelTask, goal: text.slice(0, 2400), goalTs: ts, truncated: text.length > 2400, cancelled: CANCEL.test(text) };
}

function domain(text) {
  if (isCodeRequest(text)) return 'code';
  for (const [name, pattern] of [['weather', /天气/], ['news', /新闻/], ['market', /行情|股价|金价|汇率/], ['sports', /比分|赛程/], ['document', /Word|Excel|PPT|文档|报告/i], ['music', /唱歌|歌曲/], ['image', /画图|生成图片/]]) {
    if (pattern.test(text)) return name;
  }
  return null;
}

function continuesTask(text, previous) {
  if (!isTaskFollowup(text) || !previous || previous.cancelled) return false;
  const nextDomain = domain(text);
  return !nextDomain || nextDomain === domain(previous.goal);
}

/** 每会话只保存一个 ≤2400 字的目标索引；完整要求仍在原会话/需求账本，不另存正文副本。 */
export function taskStateFromMessages(messages = [], previous = null) {
  let state = previous?.version === 1 ? { ...previous } : null;
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    if (state?.seenTs && message.ts && message.ts <= state.seenTs) continue;
    const text = message.content.trim();
    if (!text || isTaskStatus(text)) continue;
    if (continuesTask(text, state)) {
      state.seenTs = message.ts || state.seenTs;
      continue;
    }
    state = { version: 1, ...explicitTask(text, message.ts || 0), seenTs: message.ts || 0 };
  }
  return state;
}

/** 任务识别结果用于选模型、工具与时限；不授予文件操作/对外发布权限。 */
export function resolveTaskIntent(text, { history = [], state = null, images = 0 } = {}) {
  const value = String(text || '').trim();
  const previous = taskStateFromMessages(history, state);
  // “继续查天气”等明确新领域不能继承旧代码工作；纯“重新做”则必须接原目标。
  const current = explicitTask(value);
  const inherit = continuesTask(value, previous);
  const chosen = inherit ? previous : current;
  return {
    ...chosen,
    modelTask: images > 0 ? 'vision' : isTaskStatus(value) ? 'chat' : chosen.modelTask,
    category: isTaskStatus(value) ? 'chat' : chosen.category,
    inherited: inherit,
    statusOnly: isTaskStatus(value),
    reason: inherit ? '沿用本对话上一项任务' : current.category === 'code' ? '代码或网站任务' : current.category === 'work' ? '当前工作要求' : '日常交流与问答',
    requirementText: inherit ? `${chosen.goal}\n\n本轮要求：${value}${chosen.truncated ? '\n较早目标索引不完整，需要细节时读取本会话原文和需求账本。' : ''}` : value
  };
}

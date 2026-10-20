import { createLookupWindow } from './lookupWindow.js';
import { needsComputer } from '../llm/router.js';
/** 普通信息查询的总时限：包含上下文、模型等待/重试、检索和收尾；不是只计网页耗时。 */
export const LOOKUP_TOTAL_MS = 60_000;
export const COMPLEX = /深度|深入|全面|详细|长篇|长文|\d+\s*[千万元]?\s*字|调研|研究报告|生成|制作|创作|画|设计|样式|效果图|界面|网页|网站|PPT|Word|Excel|文档|报告|方案|论文|逐项|逐一|交叉核[验对]|多来源核[验对]|(?:写|生成|制作|编制|导出|保存为|整理成).{0,16}(?:报告|文档|论文|PPT|Word|Excel|文件)|代码|编程|开发|安装|部署/i;
export function isQuickLookup(text = '', images = []) {
  const value = String(text);
  return !images.length && value.length <= 500 && !COMPLEX.test(value) && !/(?:生成|制作|写|修改|重构|运行|执行|整理|翻译|总结|分析|评审|帮我做|接着做|继续|恢复|发送|删除|移动|重命名|创建|启动|打开|下载|上传|记住|记下|保存|安排|提醒|定时|设计|调整|新增|修复)/.test(value);
}
/** “继续”继承原问题的查询类别，不因按钮文案绕过普通查询期限。 */
export function lookupRequirement(text, history = []) {
  const continuation = value => /^(?:继续|恢复|接着)(?:[：:，,。\s]|$)/.test(String(value || '').trim());
  if (!continuation(text) || COMPLEX.test(String(text))) return text;
  return [...history].reverse().find(m => m.role === 'user' && !continuation(m.content))?.content || text;
}
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

export async function withLookupDeadline(options, run, { totalMs = LOOKUP_TOTAL_MS } = {}) {
  const text = lookupRequirement(options.requirementText ?? options.userText, options.history);
  if(text !== (options.requirementText ?? options.userText)) options = { ...options, requirementText: text };
  const hasComputer=options.tools?.some(t=>t.name==='computer_look'||t.name==='computer_search');
  if(options.computerTask||hasComputer&&needsComputer(text,{history:options.history||[]}))return run(options.computerTask?options:{...options,computerTask:true});
  if (!isQuickLookup(text, options.images)) return run(options);
  const ctrl = new AbortController();
  let timer, closed = false, partial = '', finishWait;
  let deadlineDisabled = false;
  const waiting = new Promise((_, reject) => { finishWait = reject; });
  const isTask=note=>COMPLEX.test(String(note))||hasComputer&&needsComputer(note,{history:options.history||[]});
  const disable = (note) => { if (isTask(note)) { clearTimeout(timer); timer = null; deadlineDisabled = true; } };
  const userAbort = () => { ctrl.abort(); finishWait(abortError()); };
  const forwarded = {
    ...options, signal: ctrl.signal,
    lookupControl: createLookupWindow({ totalMs, disabled: () => deadlineDisabled || options.inbox?.some(isTask) }),
    onTaskUpdate: (note) => { disable(note); options.onTaskUpdate?.(note); },
    lookupDeadline: true,
    emit: (event) => {
      if (closed || ctrl.signal.aborted) return;
      if (event.type === 'text') partial += String(event.delta || '');
      options.emit?.(event);
    }
  };
  if (options.signal?.aborted) throw abortError();
  options.signal?.addEventListener('abort', userAbort, { once: true });
  timer = setTimeout(() => {
    // 生成中用户已追加文档/开发任务：保留任务，不把尚未读入的补充误当普通查询截断。
    if (options.inbox?.some(isTask)) { disable('调研'); return; }
    const error = Object.assign(new Error(`本轮对话已等待 ${Math.round(totalMs / 1000)} 秒，尚未取得完整可靠结果，已停止继续搜索和重试。已显示的内容可能不完整，未核实信息不能当作结论。`), {
      name: 'LookupTimeoutError', code: 'LOOKUP_TIMEOUT', partialText: partial
    });
    ctrl.abort(error); finishWait(error);
  }, totalMs);
  try {
    return await Promise.race([waiting, Promise.resolve().then(() => {
      if (ctrl.signal.aborted) throw abortError();
      return run(forwarded);
    })]);
  } finally {
    closed = true; clearTimeout(timer); options.signal?.removeEventListener('abort', userAbort);
  }
}



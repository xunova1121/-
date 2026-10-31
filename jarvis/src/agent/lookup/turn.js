import { lookupComplaint } from '../newsIntent.js';
import { isResponseRevision } from '../../core/responseRevision.js';
import { createLookupClock, LOOKUP_TOTALS, LOOKUP_TARGETS } from './clock.js';
import { lookupIntent } from './intent.js';
import { lookupClosingNote } from './answer.js';
import { reviewOutcome } from '../reviewOutcome.js';
import { needsComputer } from '../../llm/router.js';
import { followsImage } from '../../core/imageFollowup.js';
import { creativeWithoutLookup } from '../../core/imageFollowup.js';
/** 普通信息查询的总时限：包含上下文、模型等待/重试、检索和收尾；不是只计网页耗时。 */
export const LOOKUP_TOTAL_MS = 60_000;
export const COMPLEX = /深度|深入|全面|详细|长篇|长文|\d+\s*[千万元]?\s*字|调研|研究报告|生成|制作|创作|画|设计|样式|效果图|界面|网页|网站|PPT|Word|Excel|文档|报告|方案|论文|查原文|核实原文|核对原文|原文核实|逐条核[实验对]|逐项|逐一|交叉核[验对]|多来源核[验对]|(?:写|生成|制作|编制|导出|保存为|整理成).{0,16}(?:报告|文档|论文|PPT|Word|Excel|文件)|代码|编程|开发|安装|部署/i;
/** 要她自己动脑的（描述、发散、想象、出主意、讲讲……）：不是查资料，不套普通查询的 60 秒时限 */
const THINKING = /OCR|识图|读数|重新看|描述|描写|发散|想象|联想|脑暴|头脑风暴|构思|创意|灵感|点子|故事|编[个一段首]|作诗|写诗|诗歌|歌词|唱|讲讲|说说|聊聊|展开|思考|想法|出主意|主意|建议|怎么看|看法|观点|推理|推演|讨论|规划|计划|这[个张幅]图|图里|图中|照片里|画面/;
export function isQuickLookup(text = '', images = []) {
  const value = String(text);
  return !isResponseRevision(value) && !images.length && value.length <= 500 && !COMPLEX.test(value) && !THINKING.test(value) && !/(?:生成|制作|写|修改|重构|运行|执行|整理|翻译|总结|分析|评审|帮我做|接着做|继续|恢复|发送|删除|移动|重命名|创建|启动|打开|下载|上传|记住|记下|保存|安排|提醒|定时|设计|调整|新增|修复)/.test(value);
}
/** “继续”继承原问题的查询类别，不因按钮文案绕过普通查询期限。 */
export function lookupRequirement(text, history = []) {
  const continuation = value => /^(?:继续|恢复|接着)(?:[：:，,。\s]|$)/.test(String(value || '').trim());
  if (!continuation(text) || COMPLEX.test(String(text))) return text;
  return [...history].reverse().find(m => m.role === 'user' && !continuation(m.content) && !lookupComplaint(m.content))?.content || text;
}
/** 这些工具是在“做东西”（画图、唱歌、写文件）：一旦调用，说明不是普通查询，解除 60 秒时限 */
const MAKING_TOOLS = new Set(['generate_image', 'sing_song', 'create_document', 'write_file', 'plan_architecture', 'create_diagram', 'export_diagram', 'render_diagram', 'inspect_image', 'read_image_text']);
/** 普通问题一分钟没查完时，回答结尾的提示；用户回“再查”就放宽重查 */
import { MORE_TIME_ASK } from './messages.js';
export { MORE_TIME_ASK } from './messages.js';
export const MORE_TIME_MS = 3 * 60_000;
const MORE = /^(?:再查|再查查|再查一?下|再查一会儿?|继续查|接着查|多查|查全|再找找|再搜搜?)/;
const YES = /^(?:要|好|好的|可以|行|嗯|查吧|查)[。！!，, ]*$/;
/**
 * 用户是不是在说“再查一会儿”：返回要重查的原问题，不是就返回 null
 * 明说“再查”的都算；只回“要 / 好的”的，上一条回答得是带了再查提示的才算
 */
export function moreTimeRequest(text, history = []) {
  const value = String(text || '').trim();
  const lastReply = [...history].reverse().find((m) => m.role === 'assistant');
  if (!MORE.test(value) && !(YES.test(value) && String(lastReply?.content || '').includes(MORE_TIME_ASK))) return null;
  const i = history.lastIndexOf(lastReply);
  const asked = history.slice(0, i < 0 ? history.length : i).reverse().find((m) => m.role === 'user' && !lookupComplaint(m.content) && !MORE.test(String(m.content).trim()) && !YES.test(String(m.content).trim()));
  return asked ? String(asked.content) : null;
}
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

export async function withLookupDeadline(options, run, { totalMs = LOOKUP_TOTAL_MS, profiles = false } = {}) {
  if (options.codeWork?.enabled) return run(options); // 代码任务有独立硬期限，不叠普通查询时限。
  // “再查”：按原问题重查，不再套一分钟时限（联网最多 3 分钟）
  const again = moreTimeRequest(options.userText, options.history);
  if (again) {
    const task = `${again}（上次一分钟内没查完，用户要求再查一会儿：全面一些，多看几个来源、读原文核实；上次已经查到的不用重复，直接补充和更正）`;
    return run({ ...options, userText: `${options.userText}\n\n${task}`, requirementText: task, retrievalText: again, timeBudgetMs: options.timeBudgetMs ?? MORE_TIME_MS });
  }
  const text = lookupRequirement(options.requirementText ?? options.userText, options.history);
  if(text !== (options.requirementText ?? options.userText)) options = { ...options, requirementText: text };
  const hasComputer=options.tools?.some(t=>t.name==='computer_look'||t.name==='computer_search');
  if(options.computerTask||hasComputer&&needsComputer(text,{history:options.history||[]}))return run(options.computerTask?options:{...options,computerTask:true});
  if (followsImage(text, options.history || [], new Map((options.history || []).filter(message => message.images?.length || message.thumbs?.length).map(message => [message.ts, true])))) return run(options);
  if (!isQuickLookup(text, options.images)) return run(options);
  const intent = lookupIntent(text, { history: options.history });
  if (profiles && intent.lookup) totalMs = LOOKUP_TOTALS[intent.kind] || totalMs;
  const ctrl = new AbortController();
  let timer, closed = false, partial = '', finishWait;
  let deadlineDisabled = false;
  const waiting = new Promise((_, reject) => { finishWait = reject; });
  const isTask=note=>COMPLEX.test(String(note))||creativeWithoutLookup(note)||hasComputer&&needsComputer(note,{history:options.history||[]});
  const release = () => { clearTimeout(timer); timer = null; deadlineDisabled = true; };
  const disable = (note) => { if (isTask(note)) release(); };
  const userAbort = () => { ctrl.abort(); finishWait(abortError()); };
  // 未分类的通用问题保留原20秒主备切换；不能在15秒先中止，吞掉已配置备用模型。
  const control = createLookupClock({ totalMs, phased: profiles && intent.lookup && intent.kind !== 'general', now: options.clockNow || Date.now, disabled: () => deadlineDisabled || options.inbox?.some(isTask) });
  if (profiles && intent.lookup) options.emit?.({ type: 'diagnostic', phase: 'lookup_budget', kind: intent.kind, targetMs: LOOKUP_TARGETS[intent.kind], hardLimitMs: totalMs });
  // 模型自己判断这不是一问一答（need_more_time），或调用了画图等工具：解除时限
  control.release = release;
  control.released = () => deadlineDisabled;
  const forwarded = {
    ...options, signal: ctrl.signal,
    lookupControl: control,
    onTaskUpdate: (note) => { disable(note); options.onTaskUpdate?.(note); },
    lookupDeadline: true,
    emit: (event) => {
      if (closed || ctrl.signal.aborted) return;
      if (event.type === 'text') { partial += String(event.delta || ''); if (String(event.delta || '').trim()) control.wrote(); }
      // “加图片炫酷一点”这类话看着像闲聊，模型却去画图了：画图、唱歌要几分钟，不能按普通查询截断
      if (event.type === 'tool_start' && MAKING_TOOLS.has(event.name)) release();
      options.emit?.(event);
    }
  };
  if (options.signal?.aborted) throw abortError();
  options.signal?.addEventListener('abort', userAbort, { once: true });
  const expire = () => {
    // 生成中用户已追加文档/开发任务：保留任务，不把尚未读入的补充误当普通查询截断。
    if (options.inbox?.some(isTask)) { disable('调研'); return; }
    // 正在写答案：让它写完（宽限有上限；比内层多等 3 秒，内层能先正常收尾）
    if (control.writing(3_000)) { timer = setTimeout(expire, 1_000); return; }
    const error = Object.assign(new Error(`本轮对话已等待 ${Math.round(totalMs / 1000)} 秒，尚未取得完整可靠结果，已停止继续搜索和重试。已显示的内容可能不完整，未核实信息不能当作结论。`), {
      name: 'LookupTimeoutError', code: 'LOOKUP_TIMEOUT', partialText: partial
    });
    ctrl.abort(error); finishWait(error);
  };
  timer = setTimeout(expire, totalMs);
  // 一分钟内一个字都没答出来（资料都没核实到）：不交白卷，自动多查一会儿（联网最多 3 分钟），不用用户回“再查”
  // 模型压根没响应（到点硬停）的不算：那是连接问题，再等也没用
  const extend = () => {
    closed = true; release();
    options.emit?.({ type: 'tool_progress', text: '一分钟内没查到能核实的结果，再多查一会儿…' });
    const task = `${text}（一分钟内没查到能核实的结果，自动再查一会儿：多看几个来源、读原文核实；查不到就如实说没查到）`;
    return run({ ...options, userText: `${options.userText}\n\n${task}`, requirementText: task, retrievalText: text, timeBudgetMs: options.timeBudgetMs ?? MORE_TIME_MS });
  };
  try {
    const result = await Promise.race([waiting, Promise.resolve().then(() => {
      if (ctrl.signal.aborted) throw abortError();
      return run(forwarded);
    })]);
    if (!profiles && result?.needsMoreTime && !options.signal?.aborted) return await extend();
    return result;
  } catch (error) {
    if (!profiles || !['LOOKUP_TIMEOUT', 'LOOKUP_ANSWER_TIMEOUT'].includes(error.code) || options.signal?.aborted) throw error;
    // 到点先交本轮真实回执或已写出的文字；不再静默启动180秒的另一轮。
    closed = true;
    ctrl.abort(error);
    const delivery = !partial.trim() && control.delivery?.();
    const fallback = partial.trim() ? '' : delivery?.text || control.fallback?.() || '';
    const text = partial || fallback || '本轮查询未能在时限内取得可核实的结果，可以稍后重试。';
    const report = control.review?.() || {};
    const complete = Boolean(delivery?.complete && fallback);
    const outcome = report.request ? reviewOutcome(report, { interrupted: !complete, answer: text }) : { outcome: complete ? 'not_checked' : 'partial', warnings: complete ? [] : ['查询已到总时限，保留本轮已取得内容。'] };
    const note = lookupClosingNote({ answer: text, quickStop: !complete, warnings: outcome.warnings, recovery: control.recovery?.() || delivery?.recovery });
    if (!partial) options.emit?.({ type: 'text', delta: text });
    if (note) options.emit?.({ type: 'text', delta: note });
    const review = { ...report, ...outcome, request: undefined };
    options.emit?.({ type: 'task_review', review });
    options.emit?.({ type: 'state', value: 'done' });
    return { text: text + note, review };
  } finally {
    closed = true; clearTimeout(timer); options.signal?.removeEventListener('abort', userAbort);
  }
}

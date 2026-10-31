import { todayNewsIntent } from '../newsIntent.js';
import { createQueryLedger } from '../retrievalQuality.js';
/** 普通问题快查；报告、多项核验和明确的深度研究保留较长预算。预算从首次联网开始。 */
export const QUICK_RETRIEVAL_MS = 45_000;
export const DEEP_RETRIEVAL_MS = 8 * 60_000;
export const VERIFICATION_MS = 3 * 60_000;
export const strictVerification = text => /逐[项一条].{0,12}(?:核[实验对]|查证|查原文)|(?:核[实验对]|查证).{0,12}逐[项一条]|查原文|核实原文|核对原文|原文核实|打开.{0,8}原文.{0,8}(?:核实|核对)/.test(String(text));
export function extensiveRetrieval(text = '') {
  return strictVerification(text) || /深度|深入|全面|调研|研究报告|逐项|逐一|多来源|交叉核[验对]|报告|方案|文档|论文|PPT|Word|Excel|代码|编程|开发|文件|保存|对比|比较|这几|这些|每场|多场|清单|架构图|流程图|示意图|拓扑图|画图|海报|research|report|document|code|diagram/i.test(String(text));
}
/** 预算类别的中文名（报错给用户看） */
const KIND_LABEL = { search: '搜索', read: '读网页', model: '模型调用' };
export function createRetrievalBudget(text, { now = Date.now, timeBudgetMs, clock = null } = {}) {
  if (clock?.retrieval) return clock.retrieval;
  const resources = { search: 0, read: 0, model: 0 };
  const news = todayNewsIntent(text);
  // 次数只是防失控兜底；检索仍从首次联网起共用45秒，不按工具种类另开时钟。
  const limits = { search: 12, read: news ? 8 : 10, model: 3 };
  const totalLimit = limits.search + limits.read;
  let strict = strictVerification(text);
  let extensive = extensiveRetrieval(text), started = null, calls = 0, failed = 0, reason = '';
  const duration = () => timeBudgetMs ?? (strict ? VERIFICATION_MS : extensive ? DEEP_RETRIEVAL_MS : QUICK_RETRIEVAL_MS);
  const check = () => {
    if (!reason && started !== null) {
      if ((clock && clock.retrievalRemaining() <= 0 || duration() > 0 && now() - started >= duration())) reason = '本轮联网检索已达到时间预算';
      else if (!extensive && calls >= totalLimit) reason = `普通查询已达到 ${totalLimit} 次联网检索兜底预算`;
      else if (!extensive && failed >= 3) reason = '连续 3 次联网检索没有取得有效资料';
    }
    return reason;
  };
  const budget = {
    registerQuery: createQueryLedger(),
    begin() { if (check()) return false; if (started === null) { started = now(); clock?.beginRetrieval?.(); } calls++; return true; },
    consume(kind) {
      // 整轮已收尾时，写清是哪一类先用完、这次哪一步没执行（用户 2026-10-29：读网页却报“search 调用已达到预算”，看不懂）
      if (reason || started !== null && (clock && clock.retrievalRemaining() <= 0 || duration()>0 && now()-started>=duration())) throw Object.assign(new Error(`${reason || '本轮联网检索已达到时间预算'}，这次${KIND_LABEL[kind] || kind}没有执行`), {code:'RETRIEVAL_BUDGET'});
      const limit = (strict ? { search:20, read:16 } : !extensive ? limits : {})[kind];
      // 某一类用完：整轮检索就此收尾（主循环下一步会让模型直接用已有资料回答，而不是换个工具接着查）
      if (limit && resources[kind] >= limit) { reason ||= `${strict ? '逐项核验' : '普通查询'}的${KIND_LABEL[kind] || kind}（${kind}）预算已用完（${limit}次）`; throw Object.assign(new Error(reason), { code:'RETRIEVAL_BUDGET' }); }
      if (kind in resources) resources[kind]++;
    },
    get active() { return started !== null; },
    get resources() { return {...resources}; },
    end(ok) { failed = ok ? 0 : failed + 1; },
    upgrade(text) { if (extensiveRetrieval(text)) extensive = true; if (strictVerification(text)) strict = true; },
    close(why) { reason ||= why; },
    get extensive() { return extensive; },
    get reason() { return check(); },
    /** 还能联网几次（发请求前用：模型自带的联网搜索按这个限次数，不等搜完再扣） */
    get left() { return check() ? 0 : extensive ? Infinity : Math.max(0, Math.min(limits.search - resources.search, totalLimit - calls)); },
    get remaining() {
      const remaining = started === null || duration() <= 0 ? Infinity : Math.max(0, duration() - (now() - started));
      return Math.min(remaining, clock?.retrievalRemaining() ?? Infinity);
    },
    get note() { return `（系统提示：${check() || '联网检索已停止'}。${extensive ? '不要再调用联网工具；可以继续读写文件、生成文档和运行验证。' : '不要再调用工具，不要继续联网搜索。'}现在用已经取得的资料回答，区分已核实和未核实，列出已有来源；没有确切结果就如实说还没有确切结果，不要编造，也不要把检索失败说成问题没有答案。）`; }
  };
  if (clock) clock.retrieval = budget;
  return budget;
}


// 正式发布：普通查询预留收尾，预算不足时不再发起新请求。
/** 总时限不变，提前结束检索，给最后整理保留15秒；所有阶段共用同一时钟。 */
export const SUMMARY_RESERVE_MS = 15_000;
export const QUICK_MODEL_ATTEMPTS = 3;

/** 到点时正在写答案：只要还在连续出字（两段之间不超过 WRITING_GAP_MS），最多再宽限 WRITING_GRACE_MS，把话写完 */
export const WRITING_GRACE_MS = 30_000;
export const WRITING_GAP_MS = 6_000;
const RECHECK_MS = 1_000;

export function createLookupClock({ totalMs, now = Date.now, disabled = () => false, phased = false }) {
  const started = now();
  let lastText = -Infinity;
  let retrievalStarted = null;
  const reserve = phased ? SUMMARY_RESERVE_MS : Math.min(SUMMARY_RESERVE_MS, Math.max(1, totalMs / 4));
  const remaining = () => (disabled() ? Infinity : Math.max(0, totalMs - (now() - started)));
  return {
    startedAt: started, totalMs, phased,
    remaining,
    beginRetrieval: () => { retrievalStarted ??= now(); },
    retrievalRemaining: () => {
      const left = remaining();
      if (!phased || !Number.isFinite(left)) return Math.max(0, left - reserve);
      // 模型先决定地点/工具的等待不吃掉来源额度；整轮硬截止仍不延长。
      const used = retrievalStarted === null ? 0 : now() - retrievalStarted;
      return Math.max(0, Math.min(left - 1000, totalMs - reserve - used));
    },
    /** 收到一段答案文字 */
    wrote: () => { lastText = now(); },
    /** 还在写、且没超出宽限（slack：外层总时限比内层多等一会儿，让内层先体面收尾） */
    writing: (slack = 0) => now() - lastText < WRITING_GAP_MS && now() - started < totalMs + WRITING_GRACE_MS + slack
  };
}

/** 即使上游忽略取消也按阶段返回；取消只作用于当前模型请求。 */
export function modelWindow(control, closing, controller) {
  let timer;
  let onAbort;
  let output = false;
  const expired = new Promise((resolve, reject) => {
    onAbort = () => reject(controller.signal.reason || Object.assign(new Error('已停止'), { name: 'AbortError' }));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    // 普通查询：取数收住后仍给模型独立首字窗口，不能拿取数期限截断正常回答。
    const delay = control?.phased ? Math.min(FIRST_OUTPUT_MS, control.remaining() - 1000) : closing ? control?.remaining() - 1000 : control?.retrievalRemaining();
    if (!Number.isFinite(delay)) return;
    const expire = () => {
      if (!Number.isFinite(control.remaining())) return;
      if (control.phased && output && control.remaining() > 1000) {
        timer = setTimeout(expire, control.remaining() - 1000); return;
      }
      // 正在写答案：先不掐，过一秒再看
      if (control.writing?.()) { timer = setTimeout(expire, RECHECK_MS); return; }
      const error = Object.assign(new Error(closing ? '答案整理时间已用完' : '已预留时间整理现有资料'), {
        name: 'LookupPhaseError',
        kind: 'timeout',
        code: control.phased ? 'LOOKUP_ANSWER_TIMEOUT' : closing ? 'LOOKUP_SUMMARY_TIMEOUT' : 'LOOKUP_RETRIEVAL_END'
      });
      controller.abort(error);
      reject(error);
    };
    if (delay <= 0) expire();
    else timer = setTimeout(expire, delay);
  });
  // 允许请求前已过期；即使调用方尚未进入race也不产生未处理拒绝。
  expired.catch(() => {});
  return {
    // 受内容约束而暂缓展示的正文也算在写；仍须通过原审查才显示。
    output: () => { output = true; control?.wrote?.(); },
    race: (work) =>
      controller.signal.aborted
        ? Promise.reject(controller.signal.reason)
        : Promise.race([
            typeof work === 'function'
              ? Promise.resolve().then(() => {
                  if (controller.signal.aborted) throw controller.signal.reason;
                  return work();
                })
              : work,
            expired
          ]),
    dispose: () => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  };
}

/** 速度目标只作统计，绝不能用于中止请求。 */
export const LOOKUP_TARGETS = Object.freeze({ weather: 5000, sports_live: 10000, news: 20000, sports_news: 20000, market: 15000, general: 45000 });
export const FIRST_OUTPUT_MS = 15_000;
/** 天气含API及两级免费备用共14秒+15秒首字；行情8秒取数+15秒首字。 */
export const LOOKUP_TOTALS = Object.freeze({ weather: 40000, sports_live: 40000, news: 45000, sports_news: 45000, market: 35000, general: 60000 });

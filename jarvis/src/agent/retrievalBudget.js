import { createQueryLedger } from './retrievalQuality.js';
/** 普通问题快查；报告、多项核验和明确的深度研究保留较长预算。预算从首次联网开始。 */
export const QUICK_RETRIEVAL_MS = 45_000;
export const DEEP_RETRIEVAL_MS = 8 * 60_000;
export const VERIFICATION_MS = 3 * 60_000;
export const strictVerification = text => /逐[项一条].{0,12}(?:核[实验对]|查证|查原文)|(?:核[实验对]|查证).{0,12}逐[项一条]|查原文|核实原文|核对原文/.test(String(text));
export function extensiveRetrieval(text = '') {
  return strictVerification(text) || /深度|深入|全面|调研|研究报告|逐项|逐一|多来源|交叉核[验对]|报告|方案|文档|论文|PPT|Word|Excel|代码|编程|开发|文件|保存|对比|比较|这几|这些|每场|多场|清单|架构图|流程图|示意图|拓扑图|画图|海报|research|report|document|code|diagram/i.test(String(text));
}
/** 预算类别的中文名（报错给用户看） */
const KIND_LABEL = { search: '搜索', read: '读网页', model: '模型调用' };
export function createRetrievalBudget(text, { now = Date.now, timeBudgetMs } = {}) {
  const resources = { search: 0, read: 0, model: 0 };
  let strict = strictVerification(text);
  let extensive = extensiveRetrieval(text), started = null, calls = 0, failed = 0, reason = '';
  const duration = () => timeBudgetMs ?? (strict ? VERIFICATION_MS : extensive ? DEEP_RETRIEVAL_MS : QUICK_RETRIEVAL_MS);
  const check = () => {
    if (!reason && started !== null) {
      if (duration() > 0 && now() - started >= duration()) reason = '本轮联网检索已达到时间预算';
      else if (!extensive && calls >= 6) reason = '普通查询已达到 6 次联网检索预算';
      else if (!extensive && failed >= 3) reason = '连续 3 次联网检索没有取得有效资料';
    }
    return reason;
  };
  return {
    registerQuery: createQueryLedger(),
    begin() { if (check()) return false; if (started === null) started = now(); calls++; return true; },
    consume(kind) {
      // 整轮已收尾时，写清是哪一类先用完、这次哪一步没执行（用户 2026-10-29：读网页却报“search 调用已达到预算”，看不懂）
      if (reason || started !== null && duration()>0 && now()-started>=duration()) throw Object.assign(new Error(`${reason || '本轮联网检索已达到时间预算'}，这次${KIND_LABEL[kind] || kind}没有执行`), {code:'RETRIEVAL_BUDGET'});
      const limit = (strict ? { search:20, read:16 } : !extensive ? { search:6, read:4, model:3 } : {})[kind];
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
    get left() { return check() ? 0 : extensive ? Infinity : Math.max(0, 6 - calls); },
    get remaining() { return started === null || duration() <= 0 ? Infinity : Math.max(0, duration() - (now() - started)); },
    get note() { return `（系统提示：${check() || '联网检索已停止'}。${extensive ? '不要再调用联网工具；可以继续读写文件、生成文档和运行验证。' : '不要再调用工具，不要继续联网搜索。'}现在用已经取得的资料回答，区分已核实和未核实，列出已有来源；没有确切结果就如实说还没有确切结果，不要编造，也不要把检索失败说成问题没有答案。）`; }
  };
}

/** 覆盖请求及正文读取；即使某个平台忽略 signal，也及时返回，并阻止后续重试。 */
export async function withWebDeadline(work, { signal, timeoutMs = 12_000 } = {}) {
  const ctrl = new AbortController();
  let timer, rejectAbort;
  const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    const error = signal?.aborted
      ? Object.assign(new Error('已停止读取网页'), { name: 'AbortError' })
      : Object.assign(new Error('网页请求超时，请换一个来源'), { name: 'TimeoutError' });
    ctrl.abort(error); rejectAbort(error);
  };
  if (signal?.aborted) abort();
  else { signal?.addEventListener('abort', abort, { once: true }); timer = setTimeout(abort, Math.max(1, timeoutMs)); }
  try { return await Promise.race([cancelled, Promise.resolve().then(() => { if (ctrl.signal.aborted) throw ctrl.signal.reason; return work(ctrl.signal); })]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}



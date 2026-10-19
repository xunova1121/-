/** 普通问题快查；报告、多项核验和明确的深度研究保留较长预算。预算从首次联网开始。 */
export const QUICK_RETRIEVAL_MS = 45_000;
export const DEEP_RETRIEVAL_MS = 8 * 60_000;
export function extensiveRetrieval(text = '') {
  return /深度|深入|全面|调研|研究报告|逐项|逐一|多来源|交叉核[验对]|报告|方案|文档|论文|PPT|Word|Excel|代码|编程|开发|文件|保存|对比|比较|这几|这些|每场|多场|清单|research|report|document|code/i.test(String(text));
}
export function createRetrievalBudget(text, { now = Date.now, timeBudgetMs } = {}) {
  const resources = { search: 0, read: 0, model: 0 };
  let extensive = extensiveRetrieval(text), started = null, calls = 0, failed = 0, reason = '';
  const duration = () => timeBudgetMs ?? (extensive ? DEEP_RETRIEVAL_MS : QUICK_RETRIEVAL_MS);
  const check = () => {
    if (!reason && started !== null) {
      if (duration() > 0 && now() - started >= duration()) reason = '本轮联网检索已达到时间预算';
      else if (!extensive && calls >= 6) reason = '普通查询已达到 6 次联网检索预算';
      else if (!extensive && failed >= 3) reason = '连续 3 次联网检索没有取得有效资料';
    }
    return reason;
  };
  return {
    begin() { if (check()) return false; if (started === null) started = now(); calls++; return true; },
    consume(kind) {
      if (reason || started !== null && duration()>0 && now()-started>=duration()) throw Object.assign(new Error(reason || '本轮联网检索已达到时间预算'), {code:'RETRIEVAL_BUDGET'});
      const limit = { search:6, read:4, model:3 }[kind];
      if (!extensive && limit && resources[kind] >= limit) throw Object.assign(new Error(`普通查询的${kind}调用已达到预算`), { code:'RETRIEVAL_BUDGET' });
      if (kind in resources) resources[kind]++;
    },
    get resources() { return {...resources}; },
    end(ok) { failed = ok ? 0 : failed + 1; },
    upgrade(text) { if (extensiveRetrieval(text)) extensive = true; },
    close(why) { reason ||= why; },
    get extensive() { return extensive; },
    get reason() { return check(); },
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



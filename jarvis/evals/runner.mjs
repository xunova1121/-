import { evalError, safeFailure, retainSnapshot, pollWait } from './task-diagnostics.mjs';
import { reliabilityCases } from './reliability-cases.mjs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import { cases } from './cases.mjs';

/** 真实服务器接口；密钥只通过环境变量传入，不写报告、不跟随重定向。 */
export function serverAPI(base, token, fetchImpl = fetch) {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw evalError('服务器地址格式不正确', 'EVAL_PROTOCOL');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw evalError('远端评测必须使用HTTPS，避免明文发送登录令牌', 'EVAL_PROTOCOL');
  return async (route, body, { signal } = {}) => {
    const timeout = AbortSignal.timeout(10_000);
    try {
      const response = await fetchImpl(new URL(url.pathname.replace(/\/$/, '') + route, url.origin), {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) })
      });
      if (!response.ok) throw evalError(`服务器接口HTTP ${response.status}`, 'EVAL_HTTP', 'api', response.status);
      try { return await response.json(); }
      catch (error) {
        if (signal?.aborted || timeout.aborted) throw error;
        throw evalError('服务器响应不是JSON', 'EVAL_INVALID_JSON');
      }
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('评测已停止'), { name: 'AbortError' });
      if (timeout.aborted) throw evalError('评测接口等待超时', 'EVAL_REQUEST_TIMEOUT', 'timeout');
      throw error;
    }
  };
}

export const terminal = s => ['done', 'error', 'stopped'].includes(s);

/** 不自动重发POST。每题独立会话；超时或协议失败时停止已知任务。 */
export async function runCase(api, item, { runId = randomUUID(), now = Date.now, wait = pollWait, signal, sessionId = null, evaluationId = null } = {}) {
  const started = now(), requestId = `eval_${randomUUID()}`;
  const workspace = `evals/${runId}/${item.id}`;
  const prompt = item.prompt.replaceAll('{{workspace}}', workspace);
  let phase = 'submit';
  let accepted = null, info = null, noteSent = false, stopRequested = null, owned = false;
  const result = { id: item.id, category: item.category, prompt, rubric: item.rubric, requestId,
    workspace, targetMs: item.targetMs, timeoutMs: item.timeoutMs,
    status: 'not_started', quality: 'not_reviewed', cost: null, costReason: '接口尚未提供完整计费数据' };
  try {
    if (signal?.aborted) { result.status='client_cancelled'; result.quality='execution_failed'; return result; }
    accepted = await api('/api/tasks', { text: prompt, requestId, ...(sessionId && { sessionId }), ...(evaluationId && { evaluationId }) }, { signal });
    if (!/^[\w-]{1,80}$/.test(accepted?.id || '') || !/^[\w-]{1,80}$/.test(accepted?.sessionId || '') || accepted.joined || (sessionId && accepted.sessionId !== sessionId)) throw evalError('服务器未创建独立评测任务', 'EVAL_PROTOCOL');
    owned = true;
    result.taskId = accepted.id; result.sessionId = accepted.sessionId;
    for (;;) {
      if (signal?.aborted) { result.status='client_cancelled'; break; }
      if (now() - started >= item.timeoutMs) { result.status = 'client_timeout'; break; }
      phase = 'poll';
      const observed = await api(`/api/tasks/${accepted.id}`, undefined, { signal });
      if (!observed || !['queued', 'running', 'done', 'error', 'stopped'].includes(observed.status)) throw evalError('任务状态协议不完整', 'EVAL_PROTOCOL');
      info = observed;
      retainSnapshot(result, info);
      if (now() - started >= item.timeoutMs) { result.status = 'client_timeout'; break; }
      if (terminal(info.status)) { result.status = info.status; break; }
      if (item.note && !noteSent && info.status === 'running') {
        const added = await api(`/api/tasks/${accepted.id}/notes`, { text: item.note, requestId: `eval_note_${randomUUID()}` });
        if (added.id !== accepted.id || !added.joined) throw evalError('补充要求未绑定原任务', 'EVAL_PROTOCOL');
        noteSent = true;
      }
      await wait(500, signal);
    }
    result.timing = info?.timing ?? null;
    result.usage = info?.usage ?? null;
    result.review = info?.review ?? null;
    result.outcome = info?.review?.outcome ?? 'not_checked';
    result.usageReason = result.usage ? null : '接口未提供完整Token用量，不能记成零';
    result.clientTotalMs = now() - started;
    result.withinTarget = result.status === 'done' && result.clientTotalMs <= item.targetMs;
    result.note = item.note ? { text: item.note, sent: noteSent } : null;
    if (item.note && !noteSent) result.protocolIssue = '任务在追加前结束，本次未覆盖中途补充，不能算该场景验收通过';
    if (terminal(info?.status)) {
      phase = 'read_session';
      const session = await api(`/api/sessions/${accepted.sessionId}`, undefined, { signal });
      result.answer = [...(session.messages || [])].reverse().find(m => m.role === 'assistant')?.content || '';
      result.files = info.files || [];
      result.artifactReview = result.files.length ? 'not_checked' : 'no_artifacts';
    }
    if (result.status !== 'done') result.quality = 'execution_failed';
  } catch (error) {
    result.failure = safeFailure(error, phase);
    retainSnapshot(result, info);
    if (signal?.aborted) result.status = 'client_cancelled';
    else if (owned && now() - started >= item.timeoutMs && !terminal(info?.status)) result.status = 'client_timeout';
    else result.status = owned ? 'transport_or_protocol_error' : 'submission_unknown';
    result.quality = 'execution_failed';
    result.executionStatus = terminal(info?.status) ? info.status : null;
    result.error = owned ? '连接或任务协议失败，未自动重试' : '独立任务提交未确认，请按请求编号检查服务端；不要直接重发';
  } finally {
    retainSnapshot(result, info);
    if (owned && !terminal(info?.status)) {
      try { stopRequested = (await api(`/api/tasks/${accepted.id}/stop`, {})).ok === true; }
      catch (error) { stopRequested = false; result.cleanupFailure = safeFailure(error, 'stop'); }
      result.stopRequested = stopRequested;
      if (!stopRequested) result.cleanupWarning = '停止未确认，请按任务编号到服务器检查';
    }
  }
  result.clientTotalMs = now() - started;
  return result;
}

export function summarize(results) {
  const quantile = (xs, p) => xs.length ? [...xs].sort((a,b)=>a-b)[Math.max(0, Math.ceil(xs.length * p)-1)] : null;
  const times = results.map(r=>r.clientTotalMs).filter(Number.isFinite);
  const first = results.map(r=>r.timing?.firstTextMs).filter(Number.isFinite);
  const passed = results.filter(r=>r.status === 'done' && !r.protocolIssue && r.quality === 'passed');
  return { count: results.length, executionDone: results.filter(r=>r.status==='done').length,
    executionFailed: results.filter(r=>r.status!=='done').length,
    verifiedPassed: passed.length, pendingReview: results.filter(r=>r.quality==='not_reviewed').length,
    protocolIssues: results.filter(r=>r.protocolIssue).length,
    clientTotalP50Ms: quantile(times,0.5), clientTotalP95Ms: quantile(times,0.95), firstTextP50Ms: quantile(first,0.5),
    note: '耗时包含失败任务；执行完成不等于答案正确；cost=null表示未知，不是免费。' };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const catalog=args.includes('--suite=reliability') ? reliabilityCases : cases;
  const ids = args.find(a=>a.startsWith('--ids='))?.slice(6).split(',');
  const selected = ids ? ids.map(id=>{ const c=catalog.find(x=>x.id===id); if(!c) throw new Error(`未知题号：${id}`); return c; }) : args.includes('--all') ? catalog : catalog.slice(0,3);
  if (new Set(selected.map(c=>c.id)).size !== selected.length) throw new Error('题号不可重复');
  if (!args.includes('--live')) {
    console.log(JSON.stringify({ mode:'plan_only', totalCases:catalog.length, selected,
      instructions:'仅预览，不调用模型。显式加--live执行；默认只选3题，用--ids=指定题号。令牌通过JARVIS_EVAL_TOKEN设置。' }, null, 2));
    return;
  }
  if (!env.JARVIS_EVAL_URL || !env.JARVIS_EVAL_TOKEN) throw new Error('缺少JARVIS_EVAL_URL或JARVIS_EVAL_TOKEN');
  const api = serverAPI(env.JARVIS_EVAL_URL, env.JARVIS_EVAL_TOKEN);
  const cfg = await api('/api/server/config');
  if (!cfg.provider || cfg.provider === 'mock') throw new Error('必须配置真实模型，演示模型不能充当能力评测');
  const status = await api('/api/server/status');
  if (status.running || status.tasks?.length) throw new Error('服务器有正在运行或排队的任务，稍后单独评测，避免干扰实际使用');
  if (!status.features?.taskRequestIds || !status.features?.taskNotes) throw new Error('服务器过旧，请先更新任务去重与补充接口');
  const out = args.find(a=>a.startsWith('--out='))?.slice(6) || `weiyang-eval-${Date.now()}.json`;
  const runId = randomUUID();
  const report = { schemaVersion:1, runId, startedAt:new Date().toISOString(), provider:cfg.provider,
    model: cfg.models?.[cfg.provider] || 'provider_default', results:[], limitations:[
      '通过用户真实服务器路径执行，需另测手机显示、网络往返与语音声学体验。',
      '实时题按执行日复核；文档需要下载、渲染与人工检查，文件名不等于交付合格。',
      '首次文字可能是过程说明，不一定是最终答案；模型耗时包含原生搜索与重试。',
      '工具耗时包含工具内部辅助模型和子任务，并行工具取时间并集；分项不能简单相加。'
    ] };
  // 提交前写可读报告，输出目录不可写时不消耗模型额度。
  await fs.writeFile(out, JSON.stringify(report,null,2), { mode:0o600, flag:'wx' });
  const ctrl=new AbortController();const stop=()=>ctrl.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try { for (const item of selected) {
    const r = await runCase(api,item,{runId,signal:ctrl.signal}); report.results.push(r); report.summary=summarize(report.results);
    await fs.writeFile(out,JSON.stringify(report,null,2),{mode:0o600});
    console.log(`${item.id}: ${r.status}，${r.clientTotalMs}ms，质量待按验收标准复核`);
    if (ctrl.signal.aborted || r.status==='submission_unknown' || r.cleanupWarning) break;
  } } finally { process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop); }
  report.finishedAt=new Date().toISOString(); await fs.writeFile(out,JSON.stringify(report,null,2),{mode:0o600});
  console.log(`报告已保存：${out}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(()=>{console.error('评测未完成：请检查参数、配置、连接和报告；未输出凭据或响应正文。');process.exitCode=1;});
}

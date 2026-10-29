/**
 * 30 题联合复测的统计：调用明细、时间拆分、Token 与费用、两次是否稳定、分组 / 按模型、零容忍、失败原因、和上一轮逐题比。
 * 只用数字和评审结论；回答原文留在私有报告里，不进摘要。
 */
import { DIMENSIONS, FAILURE_REASONS } from './joint-rubric.mjs';

const sum = (values) => (values.length && values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) : null);
const mean = (values) => {
  const ok = values.filter(Number.isFinite);
  return ok.length ? Math.round((ok.reduce((a, b) => a + b, 0) / ok.length) * 10) / 10 : null;
};

/**
 * 一次运行（含追问各轮）的用量
 * @param {object[]} turns runCase 的结果
 * @param {Record<string, {input:number, output:number, cached?:number}>} prices 元 / 百万 Token，按模型名
 */
export function runMetrics(turns, prices = {}) {
  const timings = turns.map((t) => t.timing || {});
  const calls = timings.flatMap((t) => t.calls || []);
  const byPurpose = {};
  for (const c of calls) {
    const key = `${c.kind}:${c.purpose}`;
    const row = (byPurpose[key] ??= { calls: 0, ms: 0 });
    row.calls++;
    row.ms += c.ms || 0;
  }
  const rewrites = {};
  for (const t of timings) for (const [rule, n] of Object.entries(t.rewrites || {})) rewrites[rule] = (rewrites[rule] || 0) + n;
  const pick = (field) => sum(timings.map((t) => t[field]));
  const totalMs = turns.reduce((s, t) => s + (t.clientTotalMs || 0), 0);
  const split = { queueMs: pick('queueMs'), modelMs: pick('modelMs'), toolMs: pick('toolMs'), contextMs: pick('contextMs') };
  const known = Object.values(split).every(Number.isFinite);
  // 剩下的时间：程序自己的处理、等待网络、转 PDF 之外的杂项（模型和工具基本不重叠）
  split.otherMs = known ? Math.max(0, totalMs - split.queueMs - split.modelMs - split.toolMs - split.contextMs) : null;
  const detailKnown = timings.length && timings.every((t) => t.callDetailVersion >= 1);
  const tokens = detailKnown && timings.every((t) => t.tokens) ? timings.reduce((s, t) => ({ input: s.input + t.tokens.input, output: s.output + t.tokens.output, cached: s.cached + (t.tokens.cached || 0) }), { input: 0, output: 0, cached: 0 }) : null;
  // 费用：每次调用按它用的模型价格算；有一次没有用量或没有价格，合计就是 null
  const costs = calls.map((c) => {
    const p = prices[c.model];
    if (!p || !c.usage || !Number.isFinite(c.usage.input) || !Number.isFinite(c.usage.output)) return null;
    const cached = Math.min(c.usage.cached || 0, c.usage.input);
    return ((c.usage.input - cached) * p.input + cached * (p.cached ?? p.input) + c.usage.output * p.output) / 1e6;
  });
  const models = {};
  for (const c of calls.filter((c) => c.kind === 'main')) models[c.model] = (models[c.model] || 0) + 1;
  return {
    totalMs,
    firstTextMs: turns[0]?.timing?.firstTextMs ?? null,
    split,
    mainCalls: pick('modelCalls'),
    helperCalls: pick('helperModelCalls'),
    backgroundCalls: detailKnown ? sum(timings.map((t) => t.backgroundModelCalls || 0)) : null,
    retries: pick('retries'),
    fallbacks: pick('fallbacks'),
    delegateTasks: pick('delegateTasks'),
    allCalls: detailKnown ? calls.length : null,
    byPurpose,
    rewrites,
    tokens,
    costYuan: costs.length && costs.every((c) => c !== null) ? Math.round(costs.reduce((a, b) => a + b, 0) * 10000) / 10000 : null,
    mainModel: Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    calls
  };
}

/** 同一题两次差多少：通过与否不同、总分差 ≥4、任一维度差 ≥2，都算不稳定 */
export function stability(runs) {
  const judged = runs.filter((r) => r.judgement && !r.judgement.error);
  if (judged.length < 2) return { stable: null, reason: '少于两次有效评审' };
  const [a, b] = judged;
  if (a.judgement.pass !== b.judgement.pass) return { stable: false, reason: '两次一过一不过' };
  if (Math.abs(a.judgement.total - b.judgement.total) >= 4) return { stable: false, reason: `总分差${Math.abs(a.judgement.total - b.judgement.total)}` };
  const dim = Object.keys(DIMENSIONS).find((k) => Math.abs(a.judgement.scores[k] - b.judgement.scores[k]) >= 2);
  return dim ? { stable: false, reason: `${DIMENSIONS[dim].label}差2分以上` } : { stable: true, reason: '' };
}

const passed = (run) => run.environment !== 'not_ready' && run.judgement && !run.judgement.error && run.judgement.pass && !run.fileProblems?.length && run.mechanical?.mechanical !== 'failed';

/** 全部汇总 */
export function jointSummary(results) {
  const runs = results.flatMap((r) => r.runs.map((run) => ({ ...run, id: r.id, group: r.group })));
  const scored = runs.filter((r) => r.environment !== 'not_ready');
  const groupStats = (list) => ({
    runs: list.length,
    passed: list.filter(passed).length,
    judged: list.filter((r) => r.judgement && !r.judgement.error).length,
    avgTotal: mean(list.map((r) => r.judgement?.total)),
    avgMs: mean(list.map((r) => r.metrics.totalMs)),
    avgCalls: mean(list.map((r) => r.metrics.allCalls ?? r.metrics.mainCalls)),
    avgCostYuan: mean(list.map((r) => r.metrics.costYuan))
  });
  const groups = {};
  for (const r of scored) (groups[r.group] ??= []).push(r);
  const models = {};
  for (const r of scored) (models[r.metrics.mainModel || '未知'] ??= []).push(r);
  const reasons = {};
  for (const r of scored.filter((r) => !passed(r))) {
    const key = r.judgement?.failureReason || (r.fileProblems?.length ? 'format' : r.status !== 'done' ? 'tool_failed' : 'unknown');
    reasons[key] = (reasons[key] || 0) + 1;
  }
  const rewrites = {};
  for (const r of scored) for (const [rule, n] of Object.entries(r.metrics.rewrites || {})) rewrites[rule] = (rewrites[rule] || 0) + n;
  const purposes = {};
  for (const r of scored) for (const [key, v] of Object.entries(r.metrics.byPurpose || {})) {
    const row = (purposes[key] ??= { calls: 0, ms: 0 });
    row.calls += v.calls;
    row.ms += v.ms;
  }
  return {
    ...groupStats(scored),
    notReady: runs.filter((r) => r.environment === 'not_ready').map((r) => r.id),
    // 零容忍：说做到却没做到（评审员判定，或读回文件不符而回答没说）
    overclaims: scored.filter((r) => r.judgement?.overclaim).map((r) => `${r.id}#${r.attempt}`),
    unstable: results.filter((r) => r.stability?.stable === false).map((r) => `${r.id}（${r.stability.reason}）`),
    failureReasons: Object.fromEntries(Object.entries(reasons).map(([k, n]) => [FAILURE_REASONS[k] || k, n])),
    rewrites,
    callsByPurpose: purposes,
    byGroup: Object.fromEntries(Object.entries(groups).map(([k, list]) => [k, groupStats(list)])),
    byModel: Object.fromEntries(Object.entries(models).map(([k, list]) => [k, groupStats(list)])),
    tokens: sum(scored.map((r) => r.metrics.tokens?.input)) === null ? null : { input: sum(scored.map((r) => r.metrics.tokens.input)), output: sum(scored.map((r) => r.metrics.tokens.output)) },
    costYuan: sum(scored.map((r) => r.metrics.costYuan))
  };
}

/**
 * 逐题和上一轮比：上一轮是联合复测就按题号比；沿用的老题也和 baseline 报告按老题号比
 * @returns {{ id: string, before: object|null, after: object, change: 'better'|'worse'|'same'|'new' }[]}
 */
export function compareRounds(results, previous = null, baseline = null) {
  const prevById = new Map((previous?.results || []).map((r) => [r.id, r]));
  const baseById = new Map((baseline?.results || []).map((r) => [r.id, r]));
  const view = (r) => {
    if (!r) return null;
    if (r.runs) return { passRate: r.runs.filter(passed).length / r.runs.length, avgTotal: mean(r.runs.map((x) => x.judgement?.total)), avgMs: mean(r.runs.map((x) => x.metrics.totalMs)), avgCalls: mean(r.runs.map((x) => x.metrics.allCalls ?? x.metrics.mainCalls)) };
    return { passRate: r.quality === 'passed' ? 1 : r.quality === 'failed' ? 0 : null, avgTotal: null, avgMs: r.metrics?.totalMs ?? null, avgCalls: r.metrics?.allModelCalls ?? r.metrics?.mainModelCalls ?? null };
  };
  return results.map((r) => {
    const before = view(prevById.get(r.id)) || view(r.carriedFrom ? baseById.get(r.carriedFrom) : null);
    const after = view(r);
    let change = 'new';
    if (before) {
      if (before.passRate !== null && after.passRate !== null && after.passRate !== before.passRate) change = after.passRate > before.passRate ? 'better' : 'worse';
      else if (before.avgTotal !== null && after.avgTotal !== null && Math.abs(after.avgTotal - before.avgTotal) >= 2) change = after.avgTotal > before.avgTotal ? 'better' : 'worse';
      else change = 'same';
    }
    return { id: r.id, carriedFrom: r.carriedFrom || null, before, after, change };
  });
}

const sec = (ms) => (Number.isFinite(ms) ? `${Math.round(ms / 100) / 10}秒` : '?');
const PURPOSE = { 'main:answer': '主回答', 'main:after_tools': '拿到工具结果后接着做', 'main:finish_check': '收尾核对', 'main:rewrite': '被核对拦下后重写', 'main:closing': '时限到了整理', 'hedge:hedge': '主模型慢、同时问备用模型', 'helper:write': '工具内写作', 'helper:reason': '工具内推理', 'helper:vision': '看图', 'helper:document_review': '文档审稿', 'background:memory': '后台记忆整理' };
/** 给用户看的摘要（白话，不含回答原文） */
export function summaryMarkdown(report) {
  const s = report.summary || {};
  const c = report.conditions || {};
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '?');
  const lines = [
    `# 30 题联合复测结果`,
    ``,
    `- 服务器版本 ${c.serverVersion ?? '?'}；主模型 ${c.provider}/${c.model}${c.routingEnabled ? '（开了分工）' : ''}；${c.startedAt} 到 ${c.finishedAt ?? '未结束'}`,
    `- 评审：${report.judge ? `${report.judge.model}${report.judge.sameAsAnswerModel ? '（和答题模型相同，分数可能偏高）' : ''}` : '还没评审'}；每题跑 ${report.repeats} 次`,
    ``,
    `## 总体`,
    `- 通过 ${s.passed ?? 0}/${s.runs ?? 0} 次（${pct(s.passed, s.runs)}）；平均总分 ${s.avgTotal ?? '?'}/20；平均耗时 ${sec(s.avgMs)}；平均模型调用 ${s.avgCalls ?? '?'} 次；${s.costYuan === null || s.costYuan === undefined ? '费用没算（缺价格表或用量）' : `总费用约 ${s.costYuan} 元`}`,
    `- **说做到却没做到（零容忍）**：${s.overclaims?.length ? s.overclaims.join('、') : '0 次'}`,
    `- 两次结果不稳定：${s.unstable?.length ? s.unstable.join('；') : '无'}`,
    `- 环境未就绪、不计分：${s.notReady?.length ? [...new Set(s.notReady)].join('、') : '无'}`,
    ``,
    `## 没过的原因`,
    ...(Object.keys(s.failureReasons || {}).length ? Object.entries(s.failureReasons).map(([k, n]) => `- ${k}：${n} 次`) : ['- 无']),
    ``,
    `## 按类型`,
    `| 类型 | 通过 | 平均分 | 平均耗时 | 平均调用 |`,
    `|---|---|---|---|---|`,
    ...Object.entries(s.byGroup || {}).map(([g, v]) => `| ${g} | ${v.passed}/${v.runs} | ${v.avgTotal ?? '?'} | ${sec(v.avgMs)} | ${v.avgCalls ?? '?'} |`),
    ``,
    `## 按模型`,
    ...Object.entries(s.byModel || {}).map(([m, v]) => `- ${m}：通过 ${v.passed}/${v.runs}，平均 ${sec(v.avgMs)}，平均调用 ${v.avgCalls ?? '?'} 次`),
    ``,
    `## 模型调用都花在哪（全部题合计）`,
    `| 用途 | 次数 | 总耗时 |`,
    `|---|---|---|`,
    ...Object.entries(s.callsByPurpose || {}).sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `| ${PURPOSE[k] || k} | ${v.calls} | ${sec(v.ms)} |`),
    ``,
    `被核对拦下重写：${Object.keys(s.rewrites || {}).length ? Object.entries(s.rewrites).map(([k, n]) => `${k} ${n} 次`).join('，') : '0 次'}`,
    ``
  ];
  if (report.comparison) {
    const worse = report.comparison.filter((r) => r.change === 'worse');
    const better = report.comparison.filter((r) => r.change === 'better');
    lines.push(`## 和上一轮比`, `- 变好 ${better.length} 题：${better.map((r) => r.id).join('、') || '无'}`, `- **变差 ${worse.length} 题：${worse.map((r) => r.id).join('、') || '无'}**（变差的要逐个说明原因）`, '');
  }
  if (report.calibration) {
    const k = report.calibration;
    lines.push(`## 校准（你抽查 vs 自动评审）`, `- 对比 ${k.compared} 题；通过与否一致 ${k.passAgreement === null ? '?' : Math.round(k.passAgreement * 100) + '%'}；${k.trusted ? '自动评审可信' : '还要调整'}`, ...k.bigGaps.map((g) => `- ${g.id}#${g.attempt}：${g.dims.join('，')}${g.note ? '（你写：' + g.note + '）' : ''}`), '');
  }
  return lines.join('\n');
}

/** 30 题联合复测：题库、评审解析、文件判定、用量 / 费用、稳定性、汇总、和上一轮比、校准、整条流程（假服务器） */
import { describe, it, expect } from 'vitest';
import { jointCases, JOINT_REPEATS } from '../evals/joint-cases.mjs';
import { baselineCases } from '../evals/baseline-cases.mjs';
import { parseJudgement, judgePrompt, DIMENSIONS } from '../evals/joint-rubric.mjs';
import { fileProblems } from '../evals/joint-files.mjs';
import { runMetrics, stability, jointSummary, compareRounds, summaryMarkdown } from '../evals/joint-report.mjs';
import { compare, sampleRuns, sheet } from '../evals/joint-calibrate.mjs';
import { readiness, runJointOnce, scheduleCleaner } from '../evals/joint.mjs';
import { judgeConfig } from '../evals/joint-judge.mjs';

const judgement = (over = {}) => JSON.stringify({ scores: { onPoint: 5, factual: 5, natural: 4, deliverable: 5 }, checkpoints: [{ passed: true, evidence: '第一句就给了结论' }], overclaim: false, pass: true, failureReason: null, comment: '好', ...over });

describe('题库', () => {
  it('30 题、每题两次；15 题沿用老题且题面一字不改；没有真实电话', () => {
    expect(jointCases).toHaveLength(30);
    expect(JOINT_REPEATS).toBe(2);
    expect(new Set(jointCases.map((c) => c.id)).size).toBe(30);
    const carried = jointCases.filter((c) => c.carriedFrom);
    expect(carried).toHaveLength(15);
    for (const c of carried) expect(c.prompt).toBe(baselineCases.find((b) => b.id === c.carriedFrom).prompt);
    for (const c of jointCases) {
      expect(c.rubric.length).toBeGreaterThan(0);
      expect(c.group).toBeTruthy();
      for (const phone of `${c.prompt}${c.followup || ''}`.match(/1\d{10}/g) || []) expect(phone).toBe('13800000000');
    }
    const pushback = jointCases.find((c) => c.category === 'pushback');
    expect(pushback.followup).toBe('你算错了吧？');
    expect(pushback.carriedFrom).toBeUndefined(); // 题面同第 7 题，但测的是被质疑时稳不稳，不和老题比
    expect(jointCases.find((c) => c.category === 'code_browser').requires).toEqual(['repo', 'browser']);
  });
  it('环境没就绪的题不提交', () => {
    const browser = jointCases.find((c) => c.category === 'code_browser');
    expect(readiness(browser, { repoConnected: true, browserConfigured: false })).toMatch(/浏览器镜像/);
    expect(readiness(browser, { repoConnected: true, browserConfigured: true })).toBe('');
    expect(readiness(jointCases[0], {})).toBe('');
  });
});

describe('评审结果解析', () => {
  const item = { id: 'x', rubric: ['结论在前'] };
  it('合法 JSON 照收；总分是四项之和', () => {
    expect(parseJudgement(judgement(), item)).toMatchObject({ total: 19, pass: true, overclaim: false });
  });
  it('评审员说通过但有一项低于 3 分：按规则判不过', () => {
    const r = parseJudgement(judgement({ scores: { onPoint: 5, factual: 2, natural: 4, deliverable: 5 } }), item);
    expect(r.pass).toBe(false);
  });
  it('格式不对、检查点数量不对、分数越界：记 error，不猜分', () => {
    expect(parseJudgement('我觉得挺好', item).error).toBeTruthy();
    expect(parseJudgement(judgement({ checkpoints: [] }), item).error).toBeTruthy();
    expect(parseJudgement(judgement({ scores: { onPoint: 6, factual: 5, natural: 4, deliverable: 5 } }), item).error).toBeTruthy();
  });
  it('说做到没做到时失败主因默认 overclaim', () => {
    expect(parseJudgement(judgement({ pass: false, overclaim: true, failureReason: null }), item).failureReason).toBe('overclaim');
  });
  it('提示里带读回的文件事实和四个维度', () => {
    const p = judgePrompt({ id: 'joint-24', group: 'document', rubric: ['一页'] }, { turns: [{ prompt: '做广告', answer: '已做好' }], fileFacts: [{ body: 37 }] });
    expect(p.prompt).toContain('"body":37');
    for (const k of Object.keys(DIMENSIONS)) expect(p.system).toContain(k);
  });
});

describe('文件判定', () => {
  const poster = jointCases.find((c) => c.category === 'poster').file;
  const style = jointCases.find((c) => c.category === 'style_change').file;
  it('告示：第一版大字一页无横线、追问后变小 → 通过', () => {
    expect(fileProblems(poster, [{ readable: true, body: 37, rules: 0, pages: 1 }, { readable: true, body: 31, rules: 0, pages: 1 }])).toEqual([]);
  });
  it('追问后字没变小 / 量不出：都算不满足', () => {
    expect(fileProblems(poster, [{ readable: true, body: 37, rules: 0, pages: 1 }, { readable: true, body: 37, rules: 0 }]).join()).toMatch(/变小/);
    expect(fileProblems(style, [{ readable: true, body: 12, rules: 1 }, { readable: true, body: null, rules: null }]).length).toBe(2);
  });
  it('没有文件就直说', () => {
    expect(fileProblems(poster, [null])).toEqual(['没有可下载的docx文件']);
  });
  it('Excel 表头要 14 磅且加粗', () => {
    const want = jointCases.find((c) => c.category === 'claim_check').file;
    expect(fileProblems(want, [{ readable: true, title: 14, headerBold: true }])).toEqual([]);
    expect(fileProblems(want, [{ readable: true, title: 14, headerBold: false }])).toHaveLength(1);
  });
});

const timing = (calls, extra = {}) => ({ callDetailVersion: 1, measurementVersion: 2, modelCalls: calls.filter((c) => c.kind === 'main').length, helperModelCalls: 0, backgroundModelCalls: 0, queueMs: 0, modelMs: 800, toolMs: 100, contextMs: 50, calls, tokens: calls.every((c) => c.usage) ? { input: calls.reduce((s, c) => s + c.usage.input, 0), output: calls.reduce((s, c) => s + c.usage.output, 0), cached: 0 } : null, rewrites: {}, ...extra });

describe('用量和费用', () => {
  it('按调用的模型价格算；有一次没用量就不给合计', () => {
    const t = timing([{ kind: 'main', purpose: 'answer', model: 'sol', ms: 800, usage: { input: 1_000_000, output: 100_000, cached: 500_000 } }]);
    const m = runMetrics([{ timing: t, clientTotalMs: 1000 }], { sol: { input: 2, output: 8, cached: 0.5 } });
    expect(m.costYuan).toBe(2.05); // 50万×2 + 50万×0.5 + 10万×8，单位元/百万
    expect(m.split.otherMs).toBe(50);
    expect(m.byPurpose['main:answer']).toEqual({ calls: 1, ms: 800 });
    expect(runMetrics([{ timing: timing([{ kind: 'main', purpose: 'answer', model: 'sol', ms: 1, usage: null }]), clientTotalMs: 1 }], { sol: { input: 1, output: 1 } }).costYuan).toBeNull();
    expect(runMetrics([{ timing: t, clientTotalMs: 1 }]).costYuan).toBeNull(); // 没价格表
  });
});

const run = (attempt, j, extra = {}) => ({ attempt, status: 'done', environment: 'ready', mechanical: { mechanical: 'passed', failures: [] }, fileProblems: [], metrics: { totalMs: 1000, allCalls: 2, rewrites: {}, byPurpose: {}, mainModel: 'sol', costYuan: null, tokens: null }, judgement: j, ...extra });
const J = (pass, scores, over = {}) => ({ pass, scores, total: Object.values(scores).reduce((a, b) => a + b, 0), overclaim: false, failureReason: pass ? null : 'factual', ...over });
const S = (a, b, c, d) => ({ onPoint: a, factual: b, natural: c, deliverable: d });

describe('稳定性、汇总、和上一轮比', () => {
  it('一过一不过 / 某项差 2 分：不稳定', () => {
    expect(stability([run(1, J(true, S(5, 5, 5, 5))), run(2, J(false, S(5, 2, 5, 5)))]).stable).toBe(false);
    expect(stability([run(1, J(true, S(5, 5, 5, 5))), run(2, J(true, S(5, 5, 3, 5)))]).reason).toMatch(/表达自然/);
    expect(stability([run(1, J(true, S(5, 5, 5, 5))), run(2, J(true, S(4, 5, 5, 5)))]).stable).toBe(true);
  });
  it('汇总：零容忍、环境未就绪不计分、失败原因、分组', () => {
    const results = [
      { id: 'joint-01', group: 'chat', runs: [run(1, J(true, S(5, 5, 5, 5))), run(2, J(false, S(4, 4, 4, 2), { overclaim: true, failureReason: 'overclaim' }))] },
      { id: 'joint-29', group: 'code', runs: [{ attempt: 1, status: 'skipped', environment: 'not_ready', metrics: {}, judgement: null }] }
    ];
    const s = jointSummary(results);
    expect(s).toMatchObject({ runs: 2, passed: 1, notReady: ['joint-29'], overclaims: ['joint-01#2'] });
    expect(s.failureReasons).toEqual({ '说做到却没做到': 1 });
    expect(s.byGroup.chat.passed).toBe(1);
    expect(summaryMarkdown({ summary: s, conditions: { model: 'sol' }, repeats: 2 })).toContain('joint-01#2');
  });
  it('沿用老题和 baseline 报告按老题号比', () => {
    const results = [{ id: 'joint-07', carriedFrom: 'baseline-11', runs: [run(1, J(true, S(5, 5, 5, 5))), run(2, J(true, S(5, 5, 5, 5)))] }, { id: 'joint-16', runs: [run(1, J(true, S(5, 5, 5, 5)))] }];
    const c = compareRounds(results, null, { results: [{ id: 'baseline-11', quality: 'failed', metrics: { totalMs: 9000 } }] });
    expect(c[0]).toMatchObject({ change: 'better', carriedFrom: 'baseline-11' });
    expect(c[1].change).toBe('new');
  });
});

describe('校准', () => {
  const report = { results: ['chat', 'code', 'live'].map((g, i) => ({ id: `joint-0${i + 1}`, group: g, rubric: ['x'], runs: [{ ...run(1, J(true, S(5, 4, 4, 5))), turns: [{ prompt: '问', answer: '答' }] }, { ...run(2, J(true, S(5, 4, 4, 5))), turns: [{ prompt: '问', answer: '答' }] }] })) };
  it('抽题每组至少一题、同题不重复；打分表不露评审分', () => {
    const picks = sampleRuns(report, 10);
    expect(new Set(picks.map((p) => p.id)).size).toBe(picks.length);
    expect(picks.length).toBe(3);
    expect(sheet(report, picks)).not.toMatch(/"total"|评审\d/);
  });
  it('对比：平均差、通过一致率、分差 ≥2 的题', () => {
    const human = [{ id: 'joint-01', attempt: 1, scores: S(5, 2, 4, 5), pass: false }, { id: 'joint-02', attempt: 1, scores: S(5, 4, 4, 5), pass: true }];
    const c = compare(report, human);
    expect(c.compared).toBe(2);
    expect(c.passAgreement).toBe(0.5);
    expect(c.bigGaps[0].dims[0]).toMatch(/事实对（评审4、你2）/);
    expect(c.trusted).toBe(false);
  });
});

describe('整条流程（假服务器）', () => {
  it('跑一次：提交、轮询、读回答、记用量；提醒题测完删掉新建的提醒', async () => {
    const calls = [];
    let schedules = [{ id: 'old', title: '每天新闻' }];
    const api = async (route, body) => {
      calls.push(route);
      if (route === '/api/tasks') return { id: 't1', sessionId: 's1' };
      if (route === '/api/tasks/t1') return { status: 'done', files: [], timing: timing([{ kind: 'main', purpose: 'answer', model: 'sol', ms: 5, usage: { input: 10, output: 2 } }]) };
      if (route === '/api/sessions/s1') return { messages: [{ role: 'assistant', content: '好的，已设好 10:10 提醒你喝水。' }] };
      if (route === '/api/server/schedules') return schedules;
      throw new Error('没想到的接口 ' + route + JSON.stringify(body));
    };
    const removed = [];
    const before = new Set(schedules.map((s) => s.id));
    schedules = [...schedules, { id: 'new1', title: '喝水' }];
    const item = jointCases.find((c) => c.category === 'reminder');
    const result = await runJointOnce(api, item, { download: async () => null, runId: 'r', attempt: 1, cleanup: scheduleCleaner(api, async (id) => removed.push(id), before) });
    expect(result).toMatchObject({ status: 'done', isolated: true, fileProblems: [] });
    expect(result.metrics.allCalls).toBe(1);
    expect(removed).toEqual(['new1']);
    expect(calls).toContain('/api/sessions/s1');
  });
});

describe('评审模型', () => {
  it('显式指定优先，否则用能力表“推理”那一项', () => {
    expect(judgeConfig({ provider: 'deepseek', models: { deepseek: 'v4' } }, 'openai::sol')).toMatchObject({ provider: 'openai', models: { openai: 'sol' } });
    expect(judgeConfig({ provider: 'deepseek', models: { deepseek: 'v4' } }).provider).toBe('deepseek');
  });
});

describe('上一轮报告读不到也不白跑（第二轮实测：路径不对，最后一步报错退出）', () => {
  it('源码里读上一轮报告有兜底', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(new URL('../evals/joint.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/readOld\('previous'\)/);
    expect(src).toMatch(/这次不做逐题对比/);
  });
});

describe('第二轮实测后：对比在评审后重算、两轮评审员不同要标出来', () => {
  it('没评审时摘要说明对比不作数；评审员不同时提示', async () => {
    const { summaryMarkdown } = await import('../evals/joint-report.mjs');
    const base = { summary: {}, conditions: {}, repeats: 2, comparison: [{ id: 'joint-01', change: 'worse' }] };
    expect(summaryMarkdown({ ...base, results: [{ id: 'joint-01', runs: [{ judgement: { error: '评审调用失败' } }] }] })).toMatch(/对比不作数/);
    expect(summaryMarkdown({ ...base, results: [{ id: 'joint-01', runs: [{ judgement: { pass: true } }] }], comparisonJudge: { before: 'gpt-6-luna', after: 'gpt-6.1-sol', changed: true } })).toMatch(/两轮评审员不同/);
  });
  it('两道题的检查点：留空待定不扣分、替代办法有一样就算', () => {
    expect(jointCases.find((c) => c.category === 'style_change').rubric[0]).toMatch(/留空不扣分/);
    expect(jointCases.find((c) => c.category === 'boundary').rubric[1]).toMatch(/有一样就算/);
  });
});

import assert from 'node:assert/strict';
import { createDocumentWorkflow } from '../../src/app/doc/documentWorkflow.js';
import { normalizeBrief, LIMITS } from '../../src/app/doc/workflowSchema.js';
import { documentDepth, preserveUserRequest } from '../../src/app/doc/workflowPolicy.js';
import { validateReview } from '../../src/app/doc/contentReview.js';
import { applyRevisions } from '../../src/app/doc/targetedRevision.js';

// 这里只验证机制，模型响应是明确的测试替身，绝不冒充真实方案质量验收。
export const task = '建设方案必须电子秤自动称重，并对接银行结算。';
export const draft = '# 测试方案\n\n电子秤自动称重，现场确认净重，再对接银行结算。';
export const fixture = () => ({
  brief: {
    purpose: '业主初次讨论',
    requirements: ['电子秤自动称重', '对接银行结算'],
    relationships: ['买卖双方'],
    facts: [],
    assumptions: ['银行具备约定接口时直连'],
    unknowns: ['银行接口影响联调'],
    direction: '先验证设备和银行，再上线交易'
  },
  scenarios: { normal: ['称重交付'], exceptions: ['复称留痕'], settlement: ['核对货款'], acceptance: ['重复回调不重复记账'], structure: ['业务流程与交付'] }
});
export const review = (issues = []) => ({
  coverage: [
    { id: 'REQ-1', result: 'supported', quote: '电子秤自动称重' },
    { id: 'REQ-2', result: 'supported', quote: '对接银行结算' }
  ],
  issues
});
const issue = { severity: 'must_fix', location: '正文第一段', problem: '缺少重量口径', fix: '明确毛重扣除皮重得到净重' };

function harness(responses = [fixture(), draft, review()]) {
  const files = new Map();
  const events = [];
  const prompts = [];
  const workspace = {
    normalize: (value) => {
      if (String(value).includes('..')) throw new Error('路径无效');
      return value;
    },
    list: async (prefix) => [...files.keys()].filter((filePath) => filePath.startsWith(prefix + '/')).map((filePath) => ({ path: filePath })),
    write: async (filePath, text) => {
      files.set(filePath, String(text));
      return { path: filePath };
    },
    readBlob: async (filePath) => {
      if (!files.has(filePath)) throw new Error('找不到文件');
      return new Blob([files.get(filePath)]);
    }
  };
  const llm = async (request) => {
    prompts.push(request);
    const value = responses.shift();
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value(request);
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  const execution = { sessionId: 'task-session', checkpoint: async (value) => events.push(value) };
  const workflow = createDocumentWorkflow({ llm, documentWorkspace: workspace });
  const latest = () => [...files].at(-1)?.[0];
  return { files, events, prompts, execution, workflow, latest, workspace, llm };
}

export function documentWorkflowCases(test) {
  test('简单邮件只调用一次，不声称完整业务审查', async () => {
    const h = harness(['请查收会议安排。']);
    const result = await h.workflow.run({ task: '写一封简短邮件', format: 'md' }, h.execution);
    assert.equal(result.calls, 1);
    assert.equal(result.business, 'not_checked');
    assert.equal(h.prompts.length, 1);
  });
  test('业务推演先于起草，完整要求一直保留，正文不进入检查点', async () => {
    const h = harness();
    const result = await h.workflow.run({ task, format: 'md' }, h.execution);
    assert.equal(result.calls, 3);
    assert.equal(result.business, 'model_reviewed');
    assert.equal(result.reviewNote, '审查与写作为同一模型');
    assert.match(h.prompts[0].prompt, /正常流/);
    assert.ok(h.prompts[1].prompt.includes('复称留痕'));
    assert.ok(h.prompts[2].prompt.includes(task));
    assert.ok(!JSON.stringify(h.events).includes(draft));
    assert.ok(h.events.every((item, index) => (index % 2 ? item.type === 'tool_end' : item.type === 'tool_start')));
  });
  test('底稿不能把模型建议冒充用户明确要求：编造的那条丢掉，原话照留，不整篇失败', () => {
    const value = fixture();
    value.brief.requirements.push('必须投入500万元');
    const plan = normalizeBrief(value, task);
    assert.deepEqual(plan.brief.requirements.map((x) => x.quote), ['电子秤自动称重', '对接银行结算']);
    // 一条原话都对不上：按用户原话分句当需求，仍然只认原话
    const none = fixture();
    none.brief.requirements = ['改写过的要求'];
    const fallback = normalizeBrief(none, task).brief.requirements.map((x) => x.quote);
    assert.ok(fallback.length && fallback.every((quote) => task.includes(quote)));
  });
  test('推演缺了异常流：标出缺口交给起草和审查补，不整篇失败', () => {
    const value = fixture();
    value.scenarios.exceptions = [];
    const plan = normalizeBrief(value, task);
    assert.deepEqual(plan.gaps, ['exceptions']);
    assert.match(plan.scenarios.exceptions[0], /推演没有给出/);
  });
  test('审查声称覆盖但正文没有原文证据，不算通过', () => {
    const value = review();
    value.coverage[0].quote = '这是不存在的支撑内容';
    const result = validateReview(value, normalizeBrief(fixture(), task), draft);
    assert.equal(result.outcome, 'needs_revision');
    assert.equal(result.coverage[0].result, 'missing');
  });
  test('漏审、重复审需求不能默认为通过：没审到的一律按缺失', () => {
    const plan = normalizeBrief(fixture(), task);
    const empty = validateReview({ coverage: [], issues: [] }, plan, draft);
    assert.equal(empty.outcome, 'needs_revision');
    assert.ok(empty.coverage.every((item) => item.result === 'missing'));
    const value = review();
    value.coverage[1].id = 'REQ-1'; // 重复审了 REQ-1，REQ-2 没审
    const dup = validateReview(value, plan, draft);
    assert.equal(dup.outcome, 'needs_revision');
    assert.equal(dup.coverage.find((item) => item.id === 'REQ-2').result, 'missing');
  });
  test('修订片段不唯一或不存在：跳过那一条、记下条数，不猜位置，原稿不被污染', () => {
    const repeated = '同样的内容反复出现同样的内容反复出现';
    const report = {};
    assert.equal(applyRevisions(repeated, { edits: [{ find: '同样的内容反复出现', replace: '改掉' }] }, report), repeated);
    assert.equal(report.skipped, 1);
    assert.equal(applyRevisions(draft, { edits: [{ find: '不存在的唯一片段', replace: '修改' }] }), draft);
    assert.equal(applyRevisions(draft, { edits: [] }), draft);
    // 对得上的照改，对不上的跳过
    const mixed = applyRevisions(draft, { edits: [{ find: '现场确认净重，再对接银行结算', replace: '扣除皮重后确认净重，再对接银行结算' }, { find: '不存在的唯一片段', replace: 'x' }] }, report);
    assert.ok(mixed.includes('扣除皮重后确认净重'));
    assert.equal(report.skipped, 1);
  });
  test('有明确短篇预算的专业方案整篇起草，底稿和内容审查仍执行', async () => {
    const plan = fixture();
    plan.scenarios.structure = ['一、背景', '二、系统', '三、实施', '四、验收'];
    const h = harness([plan, draft, review()]);
    const result = await h.workflow.run({ task: task + '全文1500至2500字。', format: 'docx' }, h.execution);
    assert.equal(result.calls, 3);
    assert.equal(result.business, 'model_reviewed');
    assert.ok(h.prompts[1].prompt.includes('起草目标2000字'));
    assert.ok(!h.prompts[1].prompt.includes('现在只写第'));
  });
  test('长方案按推演章节分节起草：同时写 3 节，每节单独计数和限时，顺序不乱', async () => {
    const plan = fixture();
    plan.scenarios.structure = ['一、建设背景：现状痛点', '二、业务流程：称重和结算', '三、系统建设：设备与平台', '四、实施计划：阶段与验收', '五、风险与对策：异常处理'];
    let active = 0;
    let peak = 0;
    const responses = [plan];
    const h = harness([]);
    const llm = async (request) => {
      h.prompts.push(request);
      if (responses.length) return JSON.stringify(responses.shift());
      const m = request.prompt.match(/现在只写第 (\d+) 节「(.+?)」/);
      if (m) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active--;
        return `## ${m[2]}\n\n电子秤自动称重，对接银行结算。第${m[1]}节正文。\n<<<本节摘要>>>第${m[1]}节`;
      }
      if (request.prompt.includes('需要统一修改的地方')) return JSON.stringify({ edits: [] });
      return JSON.stringify(review());
    };
    const workflow = createDocumentWorkflow({ llm, documentWorkspace: h.workspace });
    const result = await workflow.run({ task, format: 'docx' }, h.execution);
    assert.equal(peak, 3);
    assert.equal(result.calls, 1 + 5 + 1 + 1); // 底稿 + 5 节 + 统一润色 + 审查
    assert.ok(result.draft.indexOf('## 一、建设背景') < result.draft.indexOf('## 五、风险与对策'));
    assert.ok(h.prompts.filter((item) => item.prompt.includes('现在只写第')).every((item) => item.prompt.includes('复称留痕'))); // 每节都带业务推演
  });
  test('最多修订一次，再审仍失败必须保留问题和原稿', async () => {
    const h = harness([
      fixture(),
      draft,
      review([issue]),
      { edits: [{ find: '现场确认净重，再对接银行结算', replace: '毛重扣除筐重和水重后确认净重，再对接银行结算' }] },
      review([issue])
    ]);
    const result = await h.workflow.run({ task }, h.execution);
    assert.equal(result.calls, 5);
    assert.equal(result.business, 'needs_revision');
    assert.equal(result.unresolved, 1);
    const state = JSON.parse(h.files.get(result.stateFile));
    assert.equal(state.original, draft);
    assert.equal(state.revisionAttempts, 1);
    assert.ok(state.initialReview.issues.length);
  });
  test('审查网络失败保留初稿，显式恢复不重新起草', async () => {
    const failure = Object.assign(new Error('测试断网'), { kind: 'network', code: 'NETWORK_ERROR' });
    const h = harness([fixture(), draft, failure, review()]);
    await assert.rejects(h.workflow.run({ task }, h.execution), { code: 'NETWORK_ERROR' });
    const saved = JSON.parse(h.files.get(h.latest()));
    assert.equal(saved.phase, 'drafted');
    const result = await h.workflow.run({ state_file: h.latest() }, h.execution);
    assert.equal(result.business, 'model_reviewed');
    assert.equal(h.prompts.filter((item) => item.system.includes('撰稿人')).length, 1);
  });
  test('后台任务恢复严格使用本轮sessionId', async () => {
    const h = harness();
    await h.workflow.prepare({ task }, h.execution);
    await assert.rejects(h.workflow.run({ state_file: h.latest() }, { sessionId: 'another-session' }), { code: 'DOCUMENT_SESSION' });
  });
  test('预算在模型请求前扣除，耗尽不发请求且不吞控制信号', async () => {
    const h = harness();
    const budgetError = Object.assign(new Error('测试预算'), { code: 'RETRIEVAL_BUDGET' });
    await assert.rejects(
      h.workflow.run(
        { task },
        {
          ...h.execution,
          retrieval: {
            consume: () => {
              throw budgetError;
            }
          }
        }
      ),
      (error) => error === budgetError
    );
    assert.equal(h.prompts.length, 0);
  });
  test('忽略signal的模型也能被立即停止，不产生后续审查', async () => {
    const control = new AbortController();
    const h = harness([() => new Promise(() => {})]);
    const work = h.workflow.run({ task }, { ...h.execution, signal: control.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    control.abort(Object.assign(new Error('测试停止'), { name: 'AbortError' }));
    await assert.rejects(work, { name: 'AbortError' });
    assert.equal(h.prompts.length, 1);
    assert.ok(h.latest());
  });
  test('输入不能静默截断，恢复文件不能逃出工作区', async () => {
    const h = harness();
    await assert.rejects(h.workflow.run({ task: 'x'.repeat(16001) }), { code: 'DOCUMENT_INPUT' });
    await assert.rejects(h.workflow.run({ state_file: '../private.json' }));
    assert.equal(h.prompts.length, 0);
  });
  test('深度可显式指定，文种不同采用不同流程', () => {
    assert.equal(documentDepth({ task: '建设方案' }), 'expert');
    assert.equal(documentDepth({ task: '写邮件' }), 'simple');
    assert.equal(documentDepth({ task: '写邮件', depth: 'expert' }), 'expert');
    assert.throws(() => documentDepth({ depth: 'unknown' }));
  });
  test('只生成底稿后能继续，模型不会重复分析同一底稿', async () => {
    const h = harness();
    const prepared = await h.workflow.prepare({ task }, h.execution);
    assert.equal(prepared.phase, 'planned');
    assert.equal(prepared.calls, 1);
    const result = await h.workflow.run({ state_file: prepared.stateFile }, h.execution);
    assert.equal(result.calls, 3);
    const starts = h.events.filter((item) => item.type === 'tool_start');
    assert.equal(new Set(starts.map((item) => item.id)).size, starts.length);
  });
  test('默认不调用另一个推理线路，显式审查函数才可独立审核', async () => {
    const h = harness([fixture(), draft]);
    let reviews = 0;
    const workflow = createDocumentWorkflow({
      documentWorkspace: h.workspace,
      llm: h.llm,
      reasonLlm: () => {
        throw new Error('不应调用');
      },
      documentReviewer: async () => {
        reviews++;
        return JSON.stringify(review());
      }
    });
    const result = await workflow.run({ task }, h.execution);
    assert.equal(result.reviewMode, 'configured_reviewer');
    assert.match(result.reviewNote, /已配置的文档审查线路/);
    assert.equal(h.prompts.length, 2);
    assert.equal(reviews, 1);
  });
  test('已完成内容恢复不再次调用模型或新增状态文件', async () => {
    const h = harness();
    const result = await h.workflow.run({ task }, h.execution);
    const count = h.files.size;
    const resumed = await h.workflow.run({ state_file: result.stateFile }, h.execution);
    assert.equal(resumed.draft, draft);
    assert.equal(h.files.size, count);
    assert.equal(h.prompts.length, 3);
  });
  test('旧阶段文件不能重复消耗模型或覆盖新进度', async () => {
    const h = harness();
    const prepared = await h.workflow.prepare({ task }, h.execution);
    await h.workflow.run({ state_file: prepared.stateFile }, h.execution);
    await assert.rejects(h.workflow.run({ state_file: prepared.stateFile }, h.execution), { code: 'DOCUMENT_STALE_STATE' });
    assert.equal(h.prompts.length, 3);
  });
  test('调用计数与状态文件有硬上限，不能无限恢复', async () => {
    const h = harness();
    const prepared = await h.workflow.prepare({ task }, h.execution);
    const saved = JSON.parse(h.files.get(prepared.stateFile));
    saved.calls = LIMITS.calls;
    h.files.set(prepared.stateFile, JSON.stringify(saved));
    await assert.rejects(h.workflow.run({ state_file: prepared.stateFile }, h.execution), { code: 'DOCUMENT_CALL_LIMIT' });
    assert.equal(h.prompts.length, 1);
  });
  test('调度层原话优先于模型整理，重复原话不再次注入', () => {
    const source = '必须自动称重，不接受改成人工录入';
    const merged = preserveUserRequest('建议先人工登记', source);
    assert.ok(merged.includes(source));
    assert.ok(merged.includes('优先于整理描述'));
    assert.equal(preserveUserRequest(source, source), source);
    assert.equal(documentDepth({ format: 'xlsx', task: '多表预算测算' }), 'expert');
  });
}

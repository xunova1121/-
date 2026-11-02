import { it, expect, vi } from 'vitest';
import { jointCases, JOINT_REPEATS } from '../evals/joint-cases.mjs';
import { speedQualityCases } from '../evals/speed-quality-cases.mjs';
import { focusCases, selectJointCases, focusSuiteVersion } from '../evals/focus-cases.mjs';
import { focusSummary } from '../evals/focus-report.mjs';
import { readCodeEvidence, codeResumeProblems } from '../evals/focus-code-evidence.mjs';
import { readiness, main } from '../evals/joint.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

it('重点题独立五类，每题两次；原30题、补充题及题面标准保持原样', async () => {
  expect(jointCases).toHaveLength(30);
  expect(speedQualityCases).toHaveLength(6);
  expect(JOINT_REPEATS).toBe(2);
  expect(focusCases.map((item) => item.id)).toEqual(['joint-01', 'speed-quality-02', 'speed-quality-01', 'joint-25', 'focus-code-resume']);
  for (const item of focusCases.slice(0, 4)) expect(item).toEqual([...jointCases, ...speedQualityCases].find((row) => row.id === item.id));
  expect(selectJointCases()).toEqual(jointCases);
  expect(selectJointCases({ supplement: true })).toHaveLength(36);
  expect(selectJointCases({ focus: true })).toHaveLength(5);
  expect(() => selectJointCases({ focus: true, supplement: true })).toThrow();
  expect(() => selectJointCases({ focus: true, only: 'unknown' })).toThrow();
  expect(() => selectJointCases({ focus: true, only: '' })).toThrow();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await main(['--focus'], {});
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ mode: 'plan_only', suiteVersion: focusSuiteVersion, repeats: 2 });
  } finally {
    log.mockRestore();
  }
});
it('代码环境不就绪就不交给模型；旧题的运行前提不被改成全部跳过', () => {
  const code = focusCases.at(-1);
  expect(readiness(code, { repoConnected: true, sandboxReady: false })).toContain('容器');
  expect(readiness(code, { repoConnected: true, sandboxReady: true })).toBe('');
  expect(readiness(jointCases[27], { repoConnected: true })).toBe('');
});
it('新增重点入口不读取访问密码或旧密码环境文件，也不调用旧密码启动脚本', async () => {
  const script = await fs.readFile(new URL('../evals/run-focus-server.sh', import.meta.url), 'utf8');
  expect(script).not.toMatch(/JARVIS_PASSWORD|jarvis\.env|bash[^\n]*run-joint\.sh/);
  expect(script).toContain('JARVIS_EVAL_TOKEN');
});
it('旧服务器缺自检接口时预检即停，保存可分享的阻塞状态，不提交模型任务', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-focus-preflight-'));
  const out = path.join(directory, 'results');
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (address, options) => {
      const route = new URL(address).pathname;
      calls.push({ route, method: options?.method });
      const json =
        route === '/api/server/config'
          ? { provider: 'custom', models: { custom: 'fixture-model' } }
          : route === '/api/server/status'
            ? { running: 0, tasks: [], features: { evaluationMemoryIsolation: true, taskRequestIds: true } }
            : route === '/api/server/update'
              ? { version: '1.0.377' }
              : route === '/api/server/code-repos'
                ? { connected: false }
                : {};
      return new Response(JSON.stringify(json), { status: route === '/api/server/readiness' ? 404 : 200 });
    })
  );
  try {
    await expect(
      main(['--focus', '--live', '--out-dir=' + out], { JARVIS_EVAL_URL: 'http://127.0.0.1:8787', JARVIS_EVAL_TOKEN: 'private-token' })
    ).rejects.toMatchObject({ code: 'EVAL_CONFIG' });
    expect(calls.some((row) => row.route === '/api/tasks')).toBe(false);
    const preflight = JSON.parse(await fs.readFile(path.join(out, '预检失败.json'), 'utf8'));
    expect(preflight).toMatchObject({ state: 'blocked_readiness', modelRequested: false, productionChanged: false });
    expect(JSON.stringify(preflight)).not.toContain('private-token');
  } finally {
    vi.unstubAllGlobals();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

const id = 'a'.repeat(24),
  otherId = 'b'.repeat(24);
const rawReceipt = (command, red = false) =>
  JSON.stringify({
    command,
    stage: command,
    ok: !red,
    exitCode: red ? 1 : 0,
    install: { exitCode: 0 },
    isolation: 'docker_offline_snapshot',
    hostWorktreeWritable: false,
    sourceDigest: (red ? '1' : '2').repeat(64),
    stdout: command === 'test' ? '# tests 8\n# pass 8\n# fail 0\n# skipped 0\n' : '',
    privateKey: 'private-secret-must-not-persist'
  });
function events({ first = false, workspaceId = id, plain = false, testPath = false, omitLint = false } = {}) {
  const rows = [{ type: 'task_state', status: 'running' }];
  let calls = 0;
  const tool = (name, args, ok = true, output = '') => {
    const call = 'call' + ++calls;
    rows.push({ type: 'tool_start', id: call, name, args: { workspace_id: workspaceId, ...args } });
    rows.push({ type: 'tool_end', id: call, name, ok, output });
  };
  if (first) {
    tool('code_run', { command: 'test' }, false, '失败。完整回执：' + rawReceipt('test', true));
    tool('code_edit', { path: testPath ? 'test/cart.test.js' : 'src/cart.js' });
  }
  if (!omitLint) tool('code_run', { command: 'lint' }, true, rawReceipt('lint'));
  tool('code_run', { command: 'test' }, true, plain ? '8/8 tests passed' : rawReceipt('test'));
  rows.push({ type: 'task_state', status: 'done' });
  return rows.map((row, index) => ({ ...row, seq: index + 1 }));
}
async function collect(options) {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        events(options)
          .map((row) => 'data: ' + JSON.stringify(row) + '\n\n')
          .join('')
      )
  );
  const result = await readCodeEvidence('https://fixture.invalid', 'private-token', 'task1', fetchImpl);
  expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
  expect(JSON.stringify(result)).not.toContain('private-');
  return result;
}
it('真实工具回执证明同一副本红→业务修改→绿，以及追问重跑lint/test和统计', async () => {
  const first = await collect({ first: true }),
    second = await collect({});
  expect(codeResumeProblems([{ codeEvidence: first }, { codeEvidence: second }])).toEqual([]);
  expect(second.runs.at(-1)).toMatchObject({ workspaceId: id, command: 'test', exitCode: 0, testCounts: { tests: 8, pass: 8, fail: 0, skipped: 0 } });
});
it('换副本、改测试、只说通过、没重跑lint和证据缺失都不算续做通过', async () => {
  const first = await collect({ first: true });
  expect(codeResumeProblems([{ codeEvidence: first }, { codeEvidence: await collect({ workspaceId: otherId }) }]).join()).toContain('工作副本');
  expect(codeResumeProblems([{ codeEvidence: first }, { codeEvidence: await collect({ plain: true }) }]).join()).toContain('test');
  expect(codeResumeProblems([{ codeEvidence: await collect({ first: true, testPath: true }) }, { codeEvidence: await collect({}) }]).join()).toContain('测试');
  expect(codeResumeProblems([{ codeEvidence: first }, { codeEvidence: await collect({ omitLint: true }) }]).join()).toContain('lint');
  expect(codeResumeProblems([{}, {}]).join()).toContain('证据缺失');
});
it('证据超量和远端HTTP在读取之前受限，不携带令牌跟随跳转', async () => {
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array(8000001)));
  await expect(readCodeEvidence('https://fixture.invalid', 'private-token', 'task1', fetchImpl)).rejects.toThrow('上限');
  fetchImpl.mockClear();
  await expect(readCodeEvidence('http://remote.invalid', 'private-token', 'task1', fetchImpl)).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});

function report() {
  return {
    suiteVersion: focusSuiteVersion,
    repeats: 2,
    conditions: { finishedAt: 'done' },
    results: focusCases.map((item) => ({
      ...item,
      runs: [1, 2].map((attempt) => ({
        attempt,
        status: 'done',
        environment: 'ready',
        mechanical: { mechanical: 'passed' },
        fileProblems: [],
        judgement: { pass: true, total: 20, scores: { onPoint: 5, factual: 5, natural: 5, deliverable: 5 } },
        metrics: { totalMs: 100, allCalls: 1, byPurpose: {}, rewrites: {}, mainModel: 'model', costYuan: null }
      }))
    }))
  };
}
it('重点汇总不把执行结束、缺评审、环境缺失或半截运行当质量通过', () => {
  expect(focusSummary(report()).state).toBe('automatic_review_passed');
  const pending = report();
  pending.results[0].runs[0].judgement = null;
  expect(focusSummary(pending).state).toBe('needs_review');
  const blocked = report();
  Object.assign(blocked.results[0].runs[0], { environment: 'not_ready', status: 'skipped' });
  expect(focusSummary(blocked).state).toBe('blocked_readiness');
  const failed = report();
  failed.results[0].runs[0].mechanical.mechanical = 'failed';
  expect(focusSummary(failed).state).toBe('failed');
  const incomplete = report();
  incomplete.results[0].runs.pop();
  incomplete.results[1].runs.push(incomplete.results[1].runs[0]);
  expect(focusSummary(incomplete).state).toBe('incomplete');
});

import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectCodePostflight } from '../evals/code-postflight.mjs';
import { checkRepairCase } from '../evals/code-live-checks.mjs';
import { codeRemoteHead } from '../evals/code-remote-head.mjs';
import { recheckCodeReport } from '../evals/code-recheck.mjs';
import { CODE_TEST_REPOSITORY } from '../evals/code-live-config.mjs';

const workspace = 'a'.repeat(24),
  commit = 'b'.repeat(40),
  digest = 'c'.repeat(64);
const receipt = (command, ok, id) => [
  { type: 'tool_start', id, name: 'code_run', args: { workspace_id: workspace, command } },
  {
    type: 'tool_end',
    id,
    name: 'code_run',
    ok,
    output:
      (ok ? '' : '完整回执：') +
      JSON.stringify({
        command,
        ok,
        stage: command,
        exitCode: ok ? 0 : 1,
        install: { exitCode: 0 },
        sourceDigest: digest,
        isolation: 'docker_offline_snapshot'
      })
  }
];
const fixture = () => ({
  scenario: 'repair',
  sessionId: 'owner',
  status: 'done',
  task: { status: 'done' },
  selected: { model: 'fixture-sol' },
  remoteBefore: commit,
  credentialAudit: { state: 'passed' },
  fileCredentialAudit: { state: 'passed' },
  events: [
    { type: 'diagnostic', phase: 'model_start', model: 'fixture-sol' },
    ...receipt('test', false, 'red'),
    { type: 'tool_end', name: 'code_edit', ok: true },
    ...receipt('lint', true, 'lint'),
    ...receipt('test', true, 'green')
  ]
});
const manager = (extra = {}) => ({
  workspaces: async () => ({ items: [{ workspace_id: workspace, head: commit }] }),
  status: async () => ({ workspace_id: workspace, head: commit, changes: [{ path: 'src/cart.js' }], truncated: false }),
  diff: async () => ({ diff: '-if (x > y)\n+if (x >= y)\n', truncated: false }),
  run: async () => ({ ok: true, exitCode: 0, sourceDigest: digest, stdout: '# tests 8\n# pass 8\n# fail 0\n' }),
  ...extra
});

it('远端超时时先保存真实本地差异和独立重测，状态缺项而非改错文件，不能通过', async () => {
  const r = fixture(),
    saves = [];
  await collectCodePostflight(r, {
    repos: manager(),
    save: async () => saves.push(JSON.parse(JSON.stringify(r))),
    remoteHead: async () => {
      expect(saves.at(-1).independentTest.ok).toBe(true);
      throw Object.assign(new Error('private-upstream-body'), { code: 'CODE_GIT_TIMEOUT' });
    }
  });
  expect(r.status).toBe('done');
  expect(r.acceptance).toMatchObject({ state: 'incomplete', failures: [] });
  expect(r.verification.remoteMain.failure.code).toBe('CODE_GIT_TIMEOUT');
  const result = checkRepairCase(r);
  expect(result.state).toBe('incomplete');
  expect(result.failures).toEqual([]);
  expect(result.missing.join()).toContain('远端main');
  expect(JSON.stringify(r)).not.toContain('private-upstream-body');
});

it('失败的独立测试不能因远端也超时变成缺项，更不能passed', async () => {
  const r = fixture();
  await collectCodePostflight(r, {
    repos: manager({ run: async () => ({ ok: false, exitCode: 1, sourceDigest: digest }) }),
    save: async () => {},
    remoteHead: async () => {
      throw Object.assign(new Error(), { code: 'CODE_GIT_TIMEOUT' });
    }
  });
  expect(r.acceptance.state).toBe('failed');
  expect(checkRepairCase(r).state).toBe('failed');
});

it('某个本地证据出错仍收集其余证据，补丁缺失不会被当作补丁错误，停止信号不吞', async () => {
  const r = fixture();
  await collectCodePostflight(r, {
    repos: manager({
      diff: async () => {
        throw Object.assign(new Error(), { code: 'CODE_GIT_TIMEOUT' });
      }
    }),
    save: async () => {},
    remoteHead: async () => commit
  });
  expect(r.independentTest.ok).toBe(true);
  expect(checkRepairCase(r)).toMatchObject({ state: 'incomplete', failures: [] });
  await expect(
    collectCodePostflight(fixture(), {
      repos: manager({
        workspaces: async () => {
          throw new DOMException('stop', 'AbortError');
        }
      }),
      save: async () => {},
      remoteHead: async () => commit
    })
  ).rejects.toMatchObject({ name: 'AbortError' });
});

it('只读GitHub核对验证真实ref/type/SHA；鉴权、跳转和超大正文不可作为相同main', async () => {
  const connection = { repository: CODE_TEST_REPOSITORY, token: 'fixture-private-token' };
  const good = { ref: 'refs/heads/main', object: { type: 'commit', sha: commit } };
  expect(
    await codeRemoteHead(connection, {
      fetchImpl: async (url, init) => {
        expect(url).toBe('https://api.github.com/repos/' + CODE_TEST_REPOSITORY + '/git/ref/heads/main');
        expect(init.redirect).toBe('manual');
        return Response.json(good);
      }
    })
  ).toBe(commit);
  for (const response of [
    Response.json({ ...good, ref: 'refs/heads/other' }),
    new Response('bad', { status: 401 }),
    new Response(null, { status: 302 }),
    new Response('x'.repeat(65537))
  ])
    await expect(codeRemoteHead(connection, { fetchImpl: async () => response })).rejects.toMatchObject({ code: expect.stringMatching(/^CODE_/) });
});

it('补验不写原报告、不启动模型；独立快照不一致不能用补验洗绿', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-supplement-'));
  try {
    const originalDir = path.join(root, 'original'),
      dataDir = path.join(root, 'production');
    await fs.mkdir(originalDir);
    await fs.mkdir(dataDir);
    const originalFile = path.join(originalDir, 'report.json');
    const original = JSON.stringify({
      ...fixture(),
      status: 'error',
      codeRevision: 'd'.repeat(40),
      failure: { code: 'CODE_GIT_TIMEOUT' },
      acceptance: { state: 'failed' }
    });
    await fs.writeFile(originalFile, original);
    const loadConfig = async () => ({ cfg: { codeRepos: { token: 'fixture-private-token' }, keys: { custom: 'fixture-model-secret' } } });
    const r = await recheckCodeReport(
      { originalFile, dataDir, outputDir: path.join(root, 'new') },
      { repos: manager(), loadConfig, remoteHead: async () => commit }
    );
    expect(r.assessment.state).toBe('passed');
    expect(r.supplement).toMatchObject({ modelRequested: false, originalStatus: 'error', originalFailure: { code: 'CODE_GIT_TIMEOUT' } });
    expect(await fs.readFile(originalFile, 'utf8')).toBe(original);
    expect(JSON.stringify(r)).not.toContain('fixture-private-token');
    const bad = await recheckCodeReport(
      { originalFile, dataDir, outputDir: path.join(root, 'bad') },
      {
        repos: manager({ run: async () => ({ ok: true, exitCode: 0, sourceDigest: 'e'.repeat(64), stdout: '# tests 8\n# pass 8\n# fail 0' }) }),
        loadConfig,
        remoteHead: async () => commit
      }
    );
    expect(bad.assessment.state).toBe('failed');
    expect(await fs.readFile(originalFile, 'utf8')).toBe(original);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

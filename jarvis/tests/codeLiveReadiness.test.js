import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCodeLiveConfig, CODE_TEST_REPOSITORY } from '../evals/code-live-config.mjs';
import { main } from '../evals/code-server.mjs';

const secret = 'github_pat_' + 'FixtureCredential'.repeat(4);
const cfg = () => ({
  provider: 'custom',
  keys: { custom: 'sk-fixture-model-key' },
  models: { custom: 'fixture-default' },
  baseURLs: { custom: 'https://models.example.invalid/v1' },
  abilities: { code: { main: { provider: 'custom', model: 'user-chosen-coder' }, backup: null } },
  codeRepos: { provider: 'github', repository: CODE_TEST_REPOSITORY, verifiedAt: 'fixture', token: secret }
});
it('读取服务器实际编程线路和仓库凭据，不改生产文件、不把Key/PAT写入可报告的选择结果', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-config-'));
  try {
    const text = JSON.stringify(cfg());
    await fs.writeFile(path.join(root, 'config.json'), text);
    const loaded = await loadCodeLiveConfig(root);
    expect(loaded.selected).toMatchObject({ provider: 'custom', model: 'user-chosen-coder' });
    expect(loaded.cfg.codeRepos.token).toBe(secret);
    expect(JSON.stringify(loaded.selected)).not.toContain(secret);
    expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(text);
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ ...cfg(), pinModel: true }));
    expect((await loadCodeLiveConfig(root)).selected.model).toBe('fixture-default');
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ ...cfg(), codeRepos: { ...cfg().codeRepos, repository: 'other/repository' } }));
    await expect(loadCodeLiveConfig(root)).rejects.toThrow(/不会使用或修改其他仓库/);
    await fs.writeFile(path.join(root, 'config.json'), '{"private":"not-json');
    await expect(loadCodeLiveConfig(root)).rejects.toThrow(/配置格式有误/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('Docker缺失时没有模型请求，私有报告有具体原因、不夹带配置或上游异常正文', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-no-docker-'));
  const previousExit = process.exitCode,
    previousImage = process.env.JARVIS_CODE_SANDBOX_IMAGE;
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  try {
    await fs.mkdir(path.join(root, 'production'));
    await fs.writeFile(path.join(root, 'production/config.json'), JSON.stringify(cfg()));
    process.env.JARVIS_CODE_SANDBOX_IMAGE = 'fixture-node';
    const report = await main(['--live', '--data-dir=' + path.join(root, 'production'), '--out-dir=' + path.join(root, 'results')], {
      runDocker: async () => {
        throw Object.assign(new Error(secret), { code: 'CODE_DOCKER_UNAVAILABLE' });
      }
    });
    expect(report.status).toBe('blocked_readiness');
    expect(report.failure.message).toContain('Docker不可用');
    expect(report.taskId).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain('sk-fixture-model-key');
  } finally {
    fetchMock.mockRestore();
    process.exitCode = previousExit;
    if (previousImage === undefined) delete process.env.JARVIS_CODE_SANDBOX_IMAGE;
    else process.env.JARVIS_CODE_SANDBOX_IMAGE = previousImage;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('输出目录的父路径指向生产数据时拒绝，不在正式目录里写报告或状态', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-live-path-'));
  try {
    const production = path.join(root, 'production');
    await fs.mkdir(production);
    await fs.symlink(production, path.join(root, 'alias'));
    await expect(main(['--live', '--data-dir=' + production, '--out-dir=' + path.join(root, 'alias/results')])).rejects.toMatchObject({
      code: 'CODE_LIVE_INPUT'
    });
    expect(await fs.readdir(production)).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

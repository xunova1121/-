import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/llm/config.js';
import { configurationReadiness, readinessReport, normalizeReadiness, readinessItem } from '../shared/capabilityReadiness.js';
import { createRuntimeReadiness } from '../server/runtimeReadiness.mjs';
import { createReadinessRoutes } from '../server/readinessRoutes.mjs';

const stamp = Date.parse('2026-11-02T08:00:00Z');
const configured = () => ({
  ...structuredClone(DEFAULT_CONFIG),
  provider: 'custom',
  models: { custom: 'gpt-6.1-sol' },
  keys: { custom: 'private-model-secret' },
  baseURLs: { custom: 'https://private-model.invalid/v1' },
  pixabayKey: 'private-pixabay-secret',
  qweatherKey: 'private-weather-secret',
  qweatherHost: 'private.weather.invalid'
});
const byId = (rows, id) => rows.find((row) => row.id === id);
describe('能力配置报告', () => {
  it('有Key只说明已配置，不伪装成模型连接、天气查询或PPT筛图成功，也不回显凭据', () => {
    const cfg = configured(),
      original = structuredClone(cfg);
    const report = readinessReport({ scope: 'server', cfg, now: stamp });
    expect(byId(report.checks, 'chat')).toMatchObject({ code: 'configured', status: 'configured' });
    expect(byId(report.checks, 'vision').status).toBe('configured');
    expect(byId(report.checks, 'pixabay').code).toBe('stock_unverified');
    expect(byId(report.checks, 'weather').code).toBe('configured');
    expect(report.modelRequested).toBe(false);
    expect(report.configurationChanged).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/private-|https:|keys|config\.json/);
    expect(cfg).toEqual(original);
  });
  it('演示、缺Key、Key无Host和免费天气分开；Anthropic不能因为有Key就说已配画图', () => {
    expect(byId(configurationReadiness(DEFAULT_CONFIG), 'chat').code).toBe('demo');
    const cfg = configured();
    cfg.keys = {};
    expect(byId(configurationReadiness(cfg), 'chat').code).toBe('missing');
    cfg.qweatherHost = '';
    expect(byId(configurationReadiness(cfg), 'weather').code).toBe('missing');
    expect(byId(configurationReadiness(DEFAULT_CONFIG), 'weather').code).toBe('free_weather');
    const claude = { ...configured(), provider: 'anthropic', keys: { anthropic: 'private' } };
    expect(byId(configurationReadiness(claude), 'image').code).toBe('missing');
  });
  it('图库只有原有成功检测且时间有效才显示上次通过，不把缺Key、未来时间当通过', () => {
    const cfg = configured();
    cfg.stockVerified = { pixabay: { ok: true, at: stamp - 1000, key: 'private-verified' }, openverse: { ok: true, at: stamp + 999999 } };
    expect(byId(configurationReadiness(cfg, { now: stamp }), 'pixabay')).toMatchObject({ code: 'stock_verified', checkedAt: stamp - 1000 });
    expect(byId(configurationReadiness(cfg, { now: stamp }), 'openverse').code).toBe('stock_unverified');
    cfg.pixabayKey = '';
    expect(byId(configurationReadiness(cfg, { now: stamp }), 'pixabay').code).toBe('missing');
  });
  it('运行环境不能覆盖模型状态，未知代码、伪造status、额外配置均被剥离', () => {
    const report = readinessReport({
      scope: 'local',
      cfg: DEFAULT_CONFIG,
      runtime: {
        version: 'private-version',
        checks: [readinessItem('chat', 'configured'), { id: 'office', code: 'private-error', status: 'ready', key: 'private-key' }]
      }
    });
    expect(byId(report.checks, 'chat').code).toBe('demo');
    expect(byId(report.checks, 'office').status).toBe('unknown');
    const clean = normalizeReadiness({ ...report, key: 'private-key', config: configured() }, 'local');
    expect(JSON.stringify(clean)).not.toMatch(/private-/);
    expect(clean).not.toHaveProperty('config');
    expect(clean).not.toHaveProperty('keys');
    expect(clean).not.toHaveProperty('key');
    expect(readinessItem('chat', 'sandbox_ready').code).toBe('unknown');
    expect(() => normalizeReadiness(report, 'server')).toThrow();
    expect(() => normalizeReadiness({ ...report, checks: [] }, 'local')).toThrow();
    expect(() => normalizeReadiness({ ...report, modelRequested: true }, 'local')).toThrow();
  });
});

describe('运行环境自检边界', () => {
  const env = { JARVIS_CODE_SANDBOX_IMAGE: 'sandbox:local', JARVIS_CODE_BROWSER_IMAGE: 'browser:local', JARVIS_SKILL_RUNNER_IMAGE: 'skills:local' };
  const run = vi.fn(async (file) => ({ stdout: file === 'fc-list' ? 'zh\n' : 'available' }));
  const docker = (runResult = { exitCode: 0, stdout: 'v22.22.2\n10.9.7\nv22.22.2\n' }) =>
    vi.fn(async (args) =>
      args[0] === 'image' ? { exitCode: 0, stdout: 'sha256:' + 'a'.repeat(64) } : args[0] === 'run' ? runResult : { exitCode: 0, stdout: '' }
    );
  it('GET式检查只inspect不启动镜像；本机不把云端镜像当本机能力', async () => {
    const runDocker = docker();
    const service = createRuntimeReadiness({ env, run, runDocker });
    const result = await service.check();
    expect(byId(result.checks, 'sandbox').code).toBe('image_present');
    expect(byId(result.checks, 'fonts').code).toBe('font_ready');
    expect(runDocker.mock.calls.every(([args]) => args[0] === 'image')).toBe(true);
    const localDocker = docker();
    const local = await createRuntimeReadiness({ scope: 'local', env, run, runDocker: localDocker }).check({ probeRuntime: true });
    expect(byId(local.checks, 'sandbox').code).toBe('server_only');
    expect(localDocker).not.toHaveBeenCalled();
  });
  it('真实运行检查断网只读不拉镜像、使用固定命令，并独立确认容器清理', async () => {
    const runDocker = docker();
    const report = await createRuntimeReadiness({ env, run, runDocker }).check({ probeRuntime: true });
    expect(byId(report.checks, 'sandbox').code).toBe('sandbox_ready');
    const args = runDocker.mock.calls.find(([a]) => a[0] === 'run')[0];
    for (const flag of ['--pull=never', '--network=none', '--read-only', '--user=65534:65534']) expect(args).toContain(flag);
    expect(args).not.toContain('--mount');
    expect(runDocker.mock.calls.some(([a]) => a[0] === 'rm')).toBe(true);
    expect(runDocker.mock.calls.some(([a]) => a[0] === 'ps')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('sandbox:local');
  });
  it('BusyBox不兼容超时命令、旧Node、清理不确认均不能标环境可用', async () => {
    for (const value of [
      { exitCode: 1, stdout: 'v22.22.2', stderr: 'private-error' },
      { exitCode: 0, stdout: 'v20.19.0' }
    ]) {
      const result = await createRuntimeReadiness({ env, run, runDocker: docker(value) }).check({ probeRuntime: true });
      expect(byId(result.checks, 'sandbox').code).toBe('sandbox_failed');
      expect(JSON.stringify(result)).not.toContain('private-error');
    }
    const normal = docker();
    const runDocker = vi.fn((args, options) => (args[0] === 'ps' ? Promise.resolve({ exitCode: 1 }) : normal(args, options)));
    const result = await createRuntimeReadiness({ env, run, runDocker }).check({ probeRuntime: true });
    expect(byId(result.checks, 'sandbox').code).toBe('cleanup_failed');
  });
  it('合并并发、缓存最多30秒；调用方修改报告不会污染下一次结果', async () => {
    const runDocker = docker();
    let time = stamp;
    const service = createRuntimeReadiness({ env, run, runDocker, now: () => time });
    const [a, b] = await Promise.all([service.check(), service.check()]);
    expect(runDocker).toHaveBeenCalledTimes(3);
    a.checks[0].code = 'private';
    expect(b.checks[0].code).not.toBe('private');
    time += 30001;
    await service.check();
    expect(runDocker).toHaveBeenCalledTimes(6);
  });
  it('权限、程序和字体缺失按受控状态报告，不回显进程错误', async () => {
    const result = await createRuntimeReadiness({
      env: {},
      run: async () => {
        throw Error('private-path/key');
      },
      runDocker: async () => {
        throw Error('private-docker');
      }
    }).check();
    expect(byId(result.checks, 'office').code).toBe('command_missing');
    expect(byId(result.checks, 'sandbox').code).toBe('missing');
    expect(JSON.stringify(result)).not.toContain('private-');
    const noFonts = await createRuntimeReadiness({ env: {}, run: async () => ({ stdout: '' }), runDocker: async () => ({ exitCode: 1 }) }).check();
    expect(byId(noFonts.checks, 'fonts').code).toBe('font_missing');
  });
});

it('自检路由GET不运行容器、POST才运行；返回白名单报告且不保存配置', async () => {
  const runtime = { check: vi.fn(async () => ({ version: '1.0.377', checkedAt: stamp, checks: [readinessItem('office', 'executable')] })) };
  const json = vi.fn(),
    cfg = configured();
  const handle = createReadinessRoutes({ runtime, getConfig: () => cfg, json });
  await handle({ method: 'GET' }, {});
  await handle({ method: 'POST' }, {});
  expect(runtime.check.mock.calls).toEqual([[{ probeRuntime: false }], [{ probeRuntime: true }]]);
  expect(JSON.stringify(json.mock.calls)).not.toContain('private-');
  await handle({ method: 'DELETE' }, {});
  expect(json.mock.calls.at(-1)[1]).toBe(405);
  expect(runtime.check).toHaveBeenCalledTimes(2);
});

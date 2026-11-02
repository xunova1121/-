import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { evaluationInfo, evaluationFiles, evaluationReadiness } from '../evals/evaluation-auth.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { createAccessSecurity } from '../server/accessSecurity.mjs';
import { createEvaluationAccess, evaluationAdapter, evaluationModelFetch, chargeSearchRequest } from '../server/evaluationAccess.mjs';

const directories = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const folder = async () => { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-eval-protocol-')); directories.push(directory); return directory; };

describe('专用授权评测启动与私有文件证据', () => {
  it('只读任务协议，拒绝主人授权/旧服务器，不读取设置或密码', async () => {
    const routes = [];
    const info = { protocol: 'evaluation-token-v1', tokenId: 'a'.repeat(24), permissions: { settings: false, files: false }, busy: false };
    expect(await evaluationInfo(async route => { routes.push(route); return info; })).toBe(info);
    expect(routes).toEqual(['/api/tasks?evaluation=info']);
    await expect(evaluationInfo(async () => [])).rejects.toMatchObject({ code: 'EVAL_CONFIG' });
    await expect(evaluationInfo(async () => ({ ...info, busy: true }))).rejects.toThrow(/其他任务/);
    await expect(evaluationInfo(async () => { throw new Error('private server diagnostic'); })).rejects.not.toThrow(/private server diagnostic/);
    expect(evaluationReadiness({ requires: ['repo'] })).toMatch(/不计通过/);
    expect(evaluationReadiness({ requires: ['schedule'] })).toMatch(/不计通过/);
    expect(evaluationReadiness({ requires: ['file'] })).toBe('');
  });
  it('只有服务器本机读自己的当前评测文件，不创建目录、不读别的令牌或符号链接', async () => {
    const dataDir = await folder(), tokenId = 'a'.repeat(24), scope = `ev_${tokenId}_${'b'.repeat(20)}`;
    const root = path.join(dataDir, 'evaluations', scope, 'store');
    const store = createFileStore(root);
    await store.put('files', { id: 'outputs/result.txt', data: new Blob(['私有结果']) });
    const files = evaluationFiles({ dataDir, tokenId });
    const read = files.forTurn({ evaluationId: scope });
    expect(new TextDecoder().decode(await read('outputs/result.txt'))).toBe('私有结果');
    expect(await read('outputs/result.txt', { maxBytes: 1 })).toBeNull();
    expect(await read('../../jarvis.env')).toBeNull();
    expect(await files.forTurn({ evaluationId: scope.replace('a'.repeat(24), 'c'.repeat(24)) })('outputs/result.txt')).toBeNull();
    const name = createHash('sha1').update('outputs/result.txt').digest('hex') + '.data.bin';
    const file = path.join(root, 'files', name);
    await fs.unlink(file);
    await fs.writeFile(path.join(dataDir, 'unrelated.txt'), '不得读取');
    await fs.symlink(path.join(dataDir, 'unrelated.txt'), file);
    expect(await read('outputs/result.txt')).toBeNull();
    const missing = path.join(dataDir, 'missing');
    expect(await evaluationFiles({ dataDir: missing, tokenId }).forTurn({ evaluationId: scope })('x')).toBeNull();
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('四个远程启动器只取私有环境授权，无密码/环境文件读取或摘要派生', async () => {
    for (const name of ['run-joint.sh', 'run-baseline.sh', 'run-speed-quality-server.sh', 'run-focus-server.sh']) {
      const script = await fs.readFile(new URL('../evals/' + name, import.meta.url), 'utf8');
      expect(script, name).toContain('JARVIS_EVAL_TOKEN');
      expect(script, name).not.toMatch(/JARVIS_PASSWORD|jarvis\.env|BENCH_PASSWORD|read\s+-r\s+-s|jarvis-server:/);
    }
  });
});

it('内置搜索先预留服务商可执行上限，完整响应按真实事件结算，内部重试不突破额度', async () => {
  const dataDir = await folder();
  const security = createAccessSecurity({ dataDir, password: 'fixture-six' });
  const req = { url: '/', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const owner = security.login(req, 'fixture-six');
  const principal = security.authenticate({ ...req, headers: { authorization: 'Bearer ' + owner.token } });
  const authorization = security.issueEvaluation(principal, { dailyLimit: 5 });
  const access = createEvaluationAccess({ store: createFileStore(path.join(dataDir, 'store')), dataDir, security });
  const task = { evaluationId: 'ev_fixture_native', evaluationAuthorization: { id: authorization.id } };
  const adapter = evaluationAdapter({ usesNativeSearch: () => true, stream: async options => {
    expect(options.maxWebSearches).toBe(2);
    expect(security.remaining(authorization.id)).toBe(2); // 模型1+搜索预留2，已先落账。
    options.onText('', { serverTool: 'web_search' });
    return { text: '合成完整响应' };
  } });
  await access.run(task, () => adapter.stream({ maxWebSearches: 2 }));
  expect(security.overview(principal).evaluations.find(row => row.id === authorization.id).today).toBe(2); // 真实模型1+搜索1。
  let retried = false;
  const retry = evaluationAdapter({ usesNativeSearch: () => true, stream: async options => {
    options.onRetry({ attempt: 1 });
    retried = true;
    return { text: '不应执行重试' };
  } });
  await expect(access.run(task, () => retry.stream({ maxWebSearches: 2 }))).rejects.toMatchObject({ status: 429 });
  expect(retried).toBe(false);
});

it('画图/视频/OCR提交计数，轮询、下载和Tavily读原文不误记搜索；额度到点不发请求', async () => {
  const dataDir = await folder();
  const security = createAccessSecurity({ dataDir, password: 'fixture-six' });
  const req = { url: '/', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  const owner = security.login(req, 'fixture-six');
  const principal = security.authenticate({ ...req, headers: { authorization: 'Bearer ' + owner.token } });
  const authorization = security.issueEvaluation(principal, { dailyLimit: 1 });
  const access = createEvaluationAccess({ store: createFileStore(path.join(dataDir, 'store')), dataDir, security });
  const fetchImpl = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchImpl);
  await access.run({ evaluationId: 'ev_fixture_media', evaluationAuthorization: { id: authorization.id } }, async () => {
    await evaluationModelFetch('https://model-fixture.invalid/images/generations', { method: 'POST' });
    await evaluationModelFetch('https://model-fixture.invalid/videos/fixture', { method: 'GET' });
    chargeSearchRequest('https://api.tavily.com/extract');
    expect(() => evaluationModelFetch('https://model-fixture.invalid/layout_parsing', { method: 'POST' })).toThrow(/今日/);
  });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(security.overview(principal).evaluations[0].used).toBe(1);
});

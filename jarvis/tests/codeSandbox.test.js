import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCodeSandbox } from '../server/codeSandbox.mjs';
const id = 'sha256:' + 'a'.repeat(64);
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-box-'));
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test', lint: 'node --check main.js' } })
  );
  await fs.writeFile(path.join(root, 'main.js'), 'export const value=1;');
  return root;
}
function fakeDocker(calls, { failInstall = false, failTest = false } = {}) {
  return async (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'image') return { exitCode: 0, stdout: id, stderr: '' };
    if (args[0] === 'run') {
      expect(args).toContain('--network=none');
      expect(args).toContain('--read-only');
      expect(args).toContain('--user=65534:65534');
      expect(args).toContain('--cap-drop=ALL');
      expect(args).toContain('--pull=never');
      const mounts = args.filter((v) => v.startsWith('type=bind,'));
      expect(mounts.some((v) => v.includes('docker.sock'))).toBe(false);
      const output = mounts.find((v) => v.includes('dst=/output'));
      if (output) {
        const target = output.split('src=')[1].split(',dst=')[0];
        await fs.writeFile(path.join(target, 'deps.tar'), 'virtual archive');
      }
      expect(mounts.filter((v) => !v.includes('dst=/output')).every((v) => v.endsWith(',readonly'))).toBe(true);
      const failed = output ? failInstall : failTest;
      return { exitCode: failed ? 1 : 0, stdout: failed ? 'real failing assertion' : 'pass 1', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}
it('两段断网Docker、只读输入/不挂宿主凭据；非零测试保留日志、清理工作副本，原文不变', async () => {
  const root = await setup(),
    calls = [];
  try {
    const box = createCodeSandbox({
      image: 'local-test',
      runDocker: fakeDocker(calls, { failTest: true }),
      fetchImpl: vi.fn(() => {
        throw Error('unexpected network');
      })
    });
    const result = await box.run({ root, files: ['package.json', 'main.js', '.env', '.git/config'], command: 'test' });
    expect(result).toMatchObject({
      ok: false,
      stage: 'test',
      exitCode: 1,
      stdout: 'real failing assertion',
      hostWorktreeWritable: false,
      dependencies: { packages: 0, syntheticLock: true }
    });
    expect(calls.filter((v) => v.args[0] === 'run')).toHaveLength(2);
    expect(calls.filter((v) => v.args[0] === 'rm')).toHaveLength(2);
    const source = calls
      .find((v) => v.args[0] === 'run')
      .args.find((v) => v.includes('dst=/source'))
      .split('src=')[1]
      .split(',dst=')[0];
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(root, 'main.js'), 'utf8')).toBe('export const value=1;');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('安装失败不执行项目，缺镜像/不支持命令/凭据正文失败，不降级宿主机', async () => {
  const root = await setup();
  try {
    const calls = [],
      box = createCodeSandbox({ image: 'local-test', runDocker: fakeDocker(calls, { failInstall: true }) });
    expect(await box.run({ root, files: ['package.json', 'main.js'], command: 'lint' })).toMatchObject({ ok: false, stage: 'install' });
    expect(calls.filter((v) => v.args[0] === 'run')).toHaveLength(1);
    const unused = vi.fn();
    await expect(createCodeSandbox({ runDocker: unused }).run({ root, files: [], command: 'test' })).rejects.toMatchObject({
      code: 'CODE_SANDBOX_UNAVAILABLE'
    });
    expect(unused).not.toHaveBeenCalled();
    await expect(box.run({ root, files: [], command: 'rm -rf /' })).rejects.toMatchObject({ code: 'CODE_COMMAND' });
    const token = 'ghp_' + 'PrivateDummy'.repeat(3);
    await fs.writeFile(path.join(root, 'secret.js'), token);
    await expect(box.run({ root, files: ['package.json', 'secret.js'], command: 'test', token })).rejects.toMatchObject({ code: 'CODE_SECRET' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('超时和停止不伪装成功；清理失败时暂停重跑并保留临时副本供核查', async () => {
  const root = await setup();
  let source;
  try {
    const calls = [],
      normal = fakeDocker(calls);
    const waiting = async (args, options) => {
      if (args[0] === 'run')
        return new Promise((resolve, reject) => {
          if (options.signal.aborted) reject(options.signal.reason);
          else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      return normal(args, options);
    };
    await expect(
      createCodeSandbox({ image: 'local-test', runDocker: waiting, timeoutMs: 30 }).run({ root, files: ['package.json', 'main.js'], command: 'test' })
    ).rejects.toMatchObject({ code: 'CODE_RUN_TIMEOUT' });
    const controller = new AbortController();
    const pending = createCodeSandbox({ image: 'local-test', runDocker: waiting }).run(
      { root, files: ['package.json', 'main.js'], command: 'test' },
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(new DOMException('stop', 'AbortError')), 30);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const badCleanup = async (args, options) => {
      if (args[0] === 'run')
        source = args
          .find((v) => v.includes('dst=/source'))
          .split('src=')[1]
          .split(',dst=')[0];
      if (args[0] === 'ps') return { exitCode: 0, stdout: 'still-running', stderr: '' };
      return normal(args, options);
    };
    const box = createCodeSandbox({ image: 'local-test', runDocker: badCleanup, cleanupTimeoutMs: 20 });
    await expect(box.run({ root, files: ['package.json', 'main.js'], command: 'test' })).rejects.toMatchObject({ code: 'CODE_SANDBOX_CLEANUP' });
    expect((await fs.stat(source)).isDirectory()).toBe(true);
    await expect(box.run({ root, files: ['package.json', 'main.js'], command: 'test' })).rejects.toMatchObject({ code: 'CODE_SANDBOX_UNAVAILABLE' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    if (source) await fs.rm(path.dirname(source), { recursive: true, force: true });
  }
});
it('代码副本保留二进制资源与可执行位，模型按行读取仍不得读取二进制', async () => {
  const root = await setup(),
    calls = [];
  const binary = Buffer.from([0, 255, 1, 3]);
  try {
    await fs.writeFile(path.join(root, 'asset.bin'), binary);
    await fs.writeFile(path.join(root, 'script.sh'), '#!/bin/sh\nexit 0\n');
    await fs.chmod(path.join(root, 'script.sh'), 0o700);
    const normal = fakeDocker(calls),
      runDocker = async (args, options) => {
        if (args[0] === 'run') {
          const source = args
            .find((v) => v.includes('dst=/source'))
            .split('src=')[1]
            .split(',dst=')[0];
          expect(await fs.readFile(path.join(source, 'asset.bin'))).toEqual(binary);
          expect((await fs.stat(path.join(source, 'script.sh'))).mode & 0o111).not.toBe(0);
        }
        return normal(args, options);
      };
    expect(
      (await createCodeSandbox({ image: 'local-test', runDocker }).run({ root, files: ['package.json', 'main.js', 'asset.bin', 'script.sh'], command: 'test' }))
        .ok
    ).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('自定义共享数据目录作为Docker绑定源，不使用systemd私有tmp；残留作业达到上限就停止', async () => {
  const root = await setup(),
    baseDir = path.join(root, 'shared-jobs'),
    calls = [];
  try {
    const normal = fakeDocker(calls);
    const runDocker = async (args, options) => {
      if (args[0] === 'run') expect(args.find((v) => v.includes('dst=/source'))).toContain('src=' + baseDir + '/job-');
      return normal(args, options);
    };
    const box = createCodeSandbox({ image: 'local-test', baseDir, runDocker });
    expect((await box.run({ root, files: ['package.json', 'main.js'], command: 'test' })).ok).toBe(true);
    expect(await fs.readdir(baseDir)).toEqual([]);
    await fs.mkdir(path.join(baseDir, 'job-old-1'));
    await fs.mkdir(path.join(baseDir, 'job-old-2'));
    await expect(box.run({ root, files: ['package.json', 'main.js'], command: 'test' })).rejects.toMatchObject({ code: 'CODE_JOB_CAPACITY' });
    expect((await fs.readdir(baseDir)).sort()).toEqual(['job-old-1', 'job-old-2']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('Docker自动删除与强制清理交错时，须等ps确认消失，不能把短暂删除中误报为永久残留', async () => {
  const root = await setup(),
    calls = [];
  let reads = 0;
  try {
    const normal = fakeDocker(calls),
      runDocker = async (args, options) => {
        if (args[0] === 'ps') {
          reads++;
          return { exitCode: 0, stdout: reads % 2 ? 'removing' : '', stderr: '' };
        }
        return normal(args, options);
      };
    const value = await createCodeSandbox({ image: 'local-test', runDocker, cleanupTimeoutMs: 500 }).run({
      root,
      files: ['package.json', 'main.js'],
      command: 'test'
    });
    expect(value.ok).toBe(true);
    expect(reads).toBe(4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

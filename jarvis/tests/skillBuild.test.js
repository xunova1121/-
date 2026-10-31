import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSkillRunner } from '../server/skillRunner.mjs';

const pack = (revision = 'one') => ({
  name: 'fixture-builder',
  body: '运行 node entry.mjs',
  files: {
    'package.json': JSON.stringify({ type: 'module', devDependencies: { fixture: '1.0.0' }, scripts: { 'generate:validators': 'node scripts/generate.mjs' } }),
    'scripts/generate.mjs': '// ' + revision,
    'entry.mjs': 'import "./generated.mjs";'
  }
});
const mount = (args, target) => args.find((a) => a.startsWith('type=bind,') && a.includes('dst=' + target + ','))?.match(/src=([^,]+)/)?.[1];

it('构建独立副本后只读运行，同稿复用、脚本内容变化重建，不改技能原文件', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-build-test-'));
  const calls = [];
  const runDocker = async (args) => {
    calls.push(args);
    if (args[0] !== 'run') return { stdout: '', stderr: '' };
    if (args.some((a) => a.startsWith('JARVIS_BUILD_STEPS='))) {
      const built = mount(args, '/build');
      await fs.writeFile(path.join(built, 'generated.mjs'), 'export const compiled=true;');
      return { stdout: 'built', stderr: '' };
    }
    const source = mount(args, '/skill');
    if (!source || !(await fs.stat(path.join(source, 'generated.mjs')).catch(() => null)))
      throw Object.assign(new Error('missing generated module'), { code: 1, stderr: 'missing generated module' });
    return { stdout: 'rendered', stderr: '' };
  };
  try {
    const runner = createSkillRunner({ image: 'fixture-node', baseDir: base, runDocker });
    const original = pack();
    expect((await runner.run(original, 'node entry.mjs')).exitCode).toBe(0);
    expect((await runner.run(original, 'node entry.mjs')).exitCode).toBe(0);
    expect((await runner.run(pack('two'), 'node entry.mjs')).exitCode).toBe(0);
    const builds = calls.filter((a) => a.some((v) => v.startsWith('JARVIS_BUILD_STEPS=')));
    expect(builds).toHaveLength(2);
    for (const args of builds) {
      expect(args).toContain('--read-only');
      expect(args).toContain('--user=65534:65534');
      expect(args.join(' ')).toContain('--include=dev');
      expect(args.join(' ')).toContain('--ignore-scripts');
      expect(args.join(' ')).toContain('registry.npmmirror.com');
      expect(args.join(' ')).not.toMatch(/docker.sock|JARVIS_PASSWORD|--privileged/);
    }
    const executions = calls.filter((a) => a.includes('JARVIS_CMD=node entry.mjs'));
    expect(executions).toHaveLength(3);
    for (const args of executions) expect(args.join(' ')).toMatch(/dst=\/skill,readonly/);
    expect(original.files['generated.mjs']).toBeUndefined();
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

it('生成失败或停止不能缓存成功，也不能进入实际运行', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-build-failed-'));
  const calls = [];
  const runner = createSkillRunner({
    image: 'fixture-node',
    baseDir: base,
    runDocker: async (args) => {
      calls.push(args);
      if (args.some((a) => a.startsWith('JARVIS_BUILD_STEPS='))) throw Object.assign(new Error('build failed'), { code: 2, stderr: 'schema input is missing' });
      return { stdout: '', stderr: '' };
    }
  });
  try {
    for (let i = 0; i < 2; i++) await expect(runner.run(pack(), 'node entry.mjs')).rejects.toMatchObject({ code: 'SKILL_BUILD_FAILED' });
    expect(calls.filter((a) => a.includes('JARVIS_CMD=node entry.mjs'))).toHaveLength(0);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(runner.run(pack(), 'node entry.mjs', { signal: ctrl.signal })).rejects.toHaveProperty('name', 'AbortError');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

it('技能名不能把构建或源文件准备目录指向技能根目录之外', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-build-name-'));
  const calls = [];
  try {
    const runner = createSkillRunner({
      baseDir: base,
      runDocker: async (args) => {
        calls.push(args);
        return { stdout: '' };
      }
    });
    for (const name of ['', '.', '..']) await expect(runner.run({ ...pack(), name }, 'node entry.mjs')).rejects.toHaveProperty('code', 'INVALID_SKILL_NAME');
    expect(calls).toHaveLength(0);
    expect(await fs.readdir(base)).toEqual([]);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

it('同稿并发只构建一次，内容连续更新后每技能最多保留两个完整版本', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-build-concurrent-'));
  let builds = 0;
  const runDocker = async (args) => {
    if (args[0] !== 'run') return { stdout: '', stderr: '' };
    if (args.some((arg) => arg.startsWith('JARVIS_BUILD_STEPS='))) {
      builds++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await fs.writeFile(path.join(mount(args, '/build'), 'generated.mjs'), 'export {};');
    }
    return { stdout: 'ok', stderr: '' };
  };
  try {
    const runner = createSkillRunner({ image: 'fixture-node', baseDir: base, runDocker });
    await Promise.all([runner.run(pack(), 'node entry.mjs'), runner.run(pack(), 'node entry.mjs')]);
    expect(builds).toBe(1);
    for (const name of ['two', 'three']) await runner.run(pack(name), 'node entry.mjs');
    expect(builds).toBe(3);
    const names = await fs.readdir(path.join(base, 'fixture-builder/builds'));
    expect(names.filter((name) => /^[a-f0-9]{64}$/.test(name))).toHaveLength(2);
    expect(names.some((name) => name.startsWith('.building-'))).toBe(false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

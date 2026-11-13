import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProject } from '../server/projectExecution.mjs';
import { projectDirectory } from '../server/projectSnapshot.mjs';

it('显式共享目录在umask077下仍可由非root容器读取嵌套项目，父目录保持私有且运行后清理', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'project-shared-test-'));
  const baseDir = path.join(parent, 'production-data/project-jobs');
  let mounted;
  const previous = process.umask(0o077);
  try {
    const runDocker = vi.fn(async (args) => {
      if (args[0] === 'run') {
        expect(args).toContain('--network=none');
        expect(args).toContain('--read-only');
        expect(args).toContain('--user=65534:65534');
        mounted = args
          .find((arg) => arg.startsWith('type=bind,src='))
          .split(',')[1]
          .slice(4);
        expect(mounted.startsWith(baseDir + path.sep)).toBe(true);
        for (const name of ['', 'src', 'src/test']) expect((await fs.stat(path.join(mounted, name))).mode & 0o777).toBe(0o755);
        expect((await fs.stat(path.join(mounted, 'src/test/demo.mjs'))).mode & 0o777).toBe(0o644);
        expect(await fs.readFile(path.join(mounted, 'src/test/demo.mjs'), 'utf8')).toBe('export const x=1;');
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const result = await runProject(
      { root: 'sample', tests: ['src/test/demo.mjs'] },
      {
        baseDir,
        image: 'node:test',
        runDocker,
        list: async () => [{ path: 'sample/src/test/demo.mjs', size: 17 }],
        read: async () => new Blob(['export const x=1;'])
      }
    );
    expect(result.exitCode).toBe(0);
    expect((await fs.stat(baseDir)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(baseDir)).toEqual([]);
    await expect(fs.stat(mounted)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    process.umask(previous);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

it('共享路径不能借符号链接或Docker mount分隔符改到别处', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'project-path-test-'));
  try {
    await fs.mkdir(path.join(parent, 'target'));
    await fs.symlink(path.join(parent, 'target'), path.join(parent, 'link'));
    await expect(projectDirectory(path.join(parent, 'link'))).rejects.toMatchObject({ code: 'INVALID_PROJECT_INPUT' });
    await expect(projectDirectory(path.join(parent, 'x,dst=/host'))).rejects.toMatchObject({ code: 'INVALID_PROJECT_INPUT' });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

it('不能确认容器消失时不报成功、不删除已有副本，管理员可核查', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'project-cleanup-test-'));
  try {
    const runDocker = async (args) => {
      if (args[0] === 'ps') return { exitCode: 1, stdout: 'unknown' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await expect(
      runProject(
        { root: 'p', tests: ['x.mjs'] },
        { baseDir: parent, image: 'node:test', runDocker, list: async () => [{ path: 'p/x.mjs', size: 1 }], read: async () => new Blob(['1']) }
      )
    ).rejects.toMatchObject({ code: 'SANDBOX_CLEANUP_FAILED' });
    expect((await fs.readdir(parent)).filter((name) => name.startsWith('job-'))).toHaveLength(1);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

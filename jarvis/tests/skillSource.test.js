import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { materializeSkill, skillSignature, writeSkillSource } from '../server/skillSource.mjs';
import { skillBuildPlan } from '../server/skillBuild.mjs';

it('在线文本首次补齐并缓存，安装身份变化才重取，原技能包保持在线引用', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-source-'));
  const fetchImpl = vi.fn(async () => new Response('export const compiled=true;'));
  const pack = {
    name: 'fixture',
    installationId: 'first',
    files: { 'generated.mjs': { remote: true, url: 'https://raw.githubusercontent.com/example/demo/main/generated.mjs', size: 40 } }
  };
  try {
    const ready = await materializeSkill(pack, root, { fetchImpl });
    expect(ready.files['generated.mjs']).toContain('compiled');
    await materializeSkill(pack, root, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await materializeSkill({ ...pack, installationId: 'second' }, root, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(pack.files['generated.mjs'].remote).toBe(true);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
    const before = pack.files['generated.mjs'];
    await expect(
      materializeSkill({ ...pack, files: { 'generated.mjs': { ...before, url: 'http://127.0.0.1/config' } } }, root, { fetchImpl })
    ).rejects.toHaveProperty('code', 'SKILL_SOURCE_URL');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(materializeSkill({ ...pack, files: { 'generated.mjs': { ...before, size: 3e6 } } }, root, { fetchImpl })).rejects.toHaveProperty(
      'code',
      'SKILL_SOURCE_LIMIT'
    );
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(materializeSkill(pack, root, { signal: ctrl.signal, fetchImpl })).rejects.toHaveProperty('name', 'AbortError');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('正文/完整二进制内容参与指纹，文件写出显式权限，路径不能越界', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-signature-'));
  const pack = { body: 'fixture', files: { 'nested/entry.mjs': 'export {}', 'a.bin': { binary: true, b64: 'A'.repeat(64) + 'BBBB' }, '../outside': 'no' } };
  try {
    expect(skillSignature(pack)).not.toBe(skillSignature({ ...pack, files: { ...pack.files, 'a.bin': { binary: true, b64: 'A'.repeat(64) + 'CCCC' } } }));
    await writeSkillSource(pack, root);
    expect((await fs.stat(path.join(root, 'nested'))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(path.join(root, 'nested/entry.mjs'))).mode & 0o777).toBe(0o644);
    await expect(fs.stat(path.join(root, '../outside'))).rejects.toHaveProperty('code', 'ENOENT');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('识别嵌套技能包和本地生成步骤，不运行引用父目录的站点脚本，也不把测试当构建', () => {
  const files = {
    'package.json': '{"scripts":{"test":"exit 99"}}',
    'archify/package.json': JSON.stringify({
      scripts: {
        'generate:viewer': 'node ../scripts/viewer.mjs',
        'generate:validators': 'node scripts/generate.mjs',
        'build:guide': 'node ../scripts/site.mjs'
      },
      devDependencies: { ajv: '8.17.1' }
    }),
    'archify/scripts/generate.mjs': '// fixture'
  };
  expect(skillBuildPlan({ files })).toEqual({ root: 'archify', steps: ['generate:validators'], dependency: true });
  expect(skillBuildPlan({ files: { 'package.json': '{"scripts":{"test":"exit 99"}}' } })).toBeNull();
  expect(skillBuildPlan({ files: { 'package.json': '{"scripts":{"prepare":"npm run build","build":"node build.mjs"}}' } }).steps).toEqual(['prepare']);
});

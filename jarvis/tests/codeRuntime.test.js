import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CODE_RUNTIME_REQUIRED, validateCodeRuntimeManifest, checkCodeRuntime } from '../evals/code-runtime.mjs';
import { prepareRuntime, RUNTIME_MAX_FILES, validateRuntimeManifest } from '../evals/architecture-runtime-fetch.mjs';
import { generateCodeRuntimeManifest } from '../scripts/code-runtime-manifest.mjs';

async function fixture(entry = 'export async function main(){throw new Error("不应调用模型入口")};') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-runtime-'));
  const app = path.join(root, 'jarvis');
  const contents = Object.fromEntries(CODE_RUNTIME_REQUIRED.map((name) => [name, 'export const fixture = true;']));
  contents['package.json'] = '{"type":"module"}';
  contents['package-lock.json'] = '{"lockfileVersion":3}';
  contents['evals/code-server.mjs'] = entry;
  contents['evals/code-live-suite.mjs'] = entry;
  contents['evals/code-recheck.mjs'] = entry;
  const files = [];
  for (const [name, body] of Object.entries(contents)) {
    await fs.mkdir(path.dirname(path.join(app, name)), { recursive: true });
    await fs.writeFile(path.join(app, name), body);
    files.push({ path: name, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') });
  }
  return { root, app, manifest: { version: 1, revision: 'a'.repeat(40), files }, close: () => fs.rm(root, { recursive: true, force: true }) };
}
it('代码清单必须包含运行入口，路径/大小/哈希规则沿用原校验，不接纳不完整子集', async () => {
  const f = await fixture();
  try {
    expect(validateCodeRuntimeManifest(f.manifest)).toBe(f.manifest);
    expect(() => validateCodeRuntimeManifest({ ...f.manifest, files: f.manifest.files.slice(1) })).toThrow(/缺少运行入口/);
    expect(() => validateCodeRuntimeManifest({ ...f.manifest, files: [{ ...f.manifest.files[0], path: '../config.json' }] })).toThrow();
  } finally {
    await f.close();
  }
});
it('真实加载入口及相对依赖但不调用main；哈希改变、未列模块、缺依赖都提前失败', async () => {
  const f = await fixture();
  try {
    expect(await checkCodeRuntime(f.manifest, f.app)).toMatchObject({ state: 'entry_loadable', modelRequested: false });
    await fs.writeFile(path.join(f.app, 'server/extra.mjs'), 'export const stale=true;');
    await expect(checkCodeRuntime(f.manifest, f.app)).rejects.toMatchObject({ code: 'CODE_RUNTIME_EXTRA' });
    await fs.rm(path.join(f.app, 'server/extra.mjs'));
    await fs.appendFile(path.join(f.app, 'server/taskRunner.mjs'), '\n// changed');
    await expect(checkCodeRuntime(f.manifest, f.app)).rejects.toMatchObject({ code: 'CODE_RUNTIME_HASH' });
  } finally {
    await f.close();
  }
  const missing = await fixture('import "../server/missing.mjs"; export function main(){}');
  try {
    await expect(checkCodeRuntime(missing.manifest, missing.app)).rejects.toMatchObject({ code: 'CODE_RUNTIME_DEPENDENCY' });
  } finally {
    await missing.close();
  }
});
it('最终清单只取真实已提交源码；固定git版本、逐文件摘要，拒绝未提交改动', async () => {
  const f = await fixture();
  const git = (...args) =>
    execFileSync('git', args, { cwd: f.root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.');
    git('commit', '-qm', 'runtime fixture [skip ci]');
    const result = await generateCodeRuntimeManifest(f.app);
    expect(result.revision).toBe(git('rev-parse', 'HEAD').trim());
    const prepared = path.join(f.root, 'prepared');
    await prepareRuntime(result, f.app, prepared);
    expect(await checkCodeRuntime(result, prepared)).toMatchObject({ modelRequested: false });
    expect(result.files.some((file) => file.path.endsWith('runtime-manifest.json'))).toBe(false);
    await fs.appendFile(path.join(f.app, 'server/taskRunner.mjs'), '\n// uncommitted');
    await expect(generateCodeRuntimeManifest(f.app)).rejects.toThrow(/先提交最终运行源码/);
  } finally {
    await f.close();
  }
});

it('扩容后的清单仍有1500项上限，并核验末尾文件的路径、哈希和原字节限制', async () => {
  const f = await fixture();
  try {
    const emptyHash = createHash('sha256').update('').digest('hex');
    const files = [...f.manifest.files];
    while (files.length < RUNTIME_MAX_FILES) files.push({ path: `src/capacity-${files.length}.js`, bytes: 0, sha256: emptyHash });
    const manifest = { ...f.manifest, files };
    expect(RUNTIME_MAX_FILES).toBe(1500);
    expect(validateCodeRuntimeManifest(manifest)).toBe(manifest);
    expect(() => validateRuntimeManifest({ ...manifest, files: [...files, { path: 'src/over-limit.js', bytes: 0, sha256: emptyHash }] })).toThrow();
    for (const change of [{ path: '../outside.js' }, { path: files[0].path }, { sha256: 'invalid' }, { bytes: 20e6 + 1 }]) {
      expect(() => validateCodeRuntimeManifest({ ...manifest, files: [...files.slice(0, -1), { ...files.at(-1), ...change }] })).toThrow();
    }
    expect(() =>
      validateCodeRuntimeManifest({ ...manifest, files: files.map((file, index) => ({ ...file, bytes: index < 6 ? 20e6 : file.bytes })) })
    ).toThrow();
  } finally {
    await f.close();
  }
});

it('1005个已提交模块能完整生成清单和准备运行目录，末尾文件篡改仍拒绝', async () => {
  const f = await fixture();
  const git = (...args) =>
    execFileSync('git', args, { cwd: f.root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  try {
    const extra = 1005 - f.manifest.files.length;
    await fs.mkdir(path.join(f.app, 'src/capacity'), { recursive: true });
    for (let index = 0; index < extra; index++) await fs.writeFile(path.join(f.app, `src/capacity/module-${index}.js`), `export const value = ${index};\n`);
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.');
    git('commit', '-qm', 'capacity fixture [skip ci]');
    const manifest = await generateCodeRuntimeManifest(f.app);
    expect(manifest.files).toHaveLength(1005);
    const prepared = path.join(f.root, 'prepared');
    expect(
      await prepareRuntime(manifest, f.app, prepared, {
        fetchFile: () => {
          throw new Error('全部源码应从本机逐字节复用');
        }
      })
    ).toMatchObject({ reused: 1005, downloaded: 0 });
    expect(await checkCodeRuntime(manifest, prepared)).toMatchObject({ files: 1005, modelRequested: false });
    await fs.appendFile(path.join(prepared, manifest.files.at(-1).path), '\n// tampered');
    await expect(checkCodeRuntime(manifest, prepared)).rejects.toMatchObject({ code: 'CODE_RUNTIME_HASH' });
  } finally {
    await f.close();
  }
}, 60000);

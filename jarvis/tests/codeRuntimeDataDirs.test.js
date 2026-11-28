import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CODE_RUNTIME_REQUIRED, CODE_RUNTIME_DATA_DIRS, checkCodeRuntime } from '../evals/code-runtime.mjs';
import { generateCodeRuntimeManifest } from '../scripts/code-runtime-manifest.mjs';

// 夹具写法同 codeRuntime.test.js
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-runtime-data-'));
  const app = path.join(root, 'jarvis');
  const entry = 'export async function main(){throw new Error("不应调用模型入口")};';
  const contents = Object.fromEntries(CODE_RUNTIME_REQUIRED.map((name) => [name, 'export const fixture = true;']));
  Object.assign(contents, { 'package.json': '{"type":"module"}', 'package-lock.json': '{"lockfileVersion":3}', 'evals/code-server.mjs': entry, 'evals/code-live-suite.mjs': entry, 'evals/code-recheck.mjs': entry });
  const files = [];
  for (const [name, body] of Object.entries(contents)) {
    await fs.mkdir(path.dirname(path.join(app, name)), { recursive: true });
    await fs.writeFile(path.join(app, name), body);
    files.push({ path: name, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') });
  }
  return { root, app, manifest: { version: 1, revision: 'a'.repeat(40), files }, close: () => fs.rm(root, { recursive: true, force: true }) };
}

it('随服务器带的技能目录不算运行代码：不进清单、扫描时跳过；其他未列文件照样拒绝（2026-11-28）', async () => {
  expect(CODE_RUNTIME_DATA_DIRS).toEqual(['server/bundled-skills']);
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.app, 'server/bundled-skills/docx/scripts/office'), { recursive: true });
    await fs.writeFile(path.join(f.app, 'server/bundled-skills/docx/scripts/office/soffice.py'), 'print(1)');
    await fs.writeFile(path.join(f.app, 'server/bundled-skills/NOTICE.md'), '# 来源');
    expect(await checkCodeRuntime(f.manifest, f.app)).toMatchObject({ state: 'entry_loadable', modelRequested: false });
    // 名字只是相近的目录、server 下别的地方：仍按未核验文件拒绝
    await fs.mkdir(path.join(f.app, 'server/bundled-skills-x'), { recursive: true });
    await fs.writeFile(path.join(f.app, 'server/bundled-skills-x/a.mjs'), 'export {}');
    await expect(checkCodeRuntime(f.manifest, f.app)).rejects.toMatchObject({ code: 'CODE_RUNTIME_EXTRA' });
  } finally {
    await f.close();
  }
});

it('生成清单时跳过技能目录，生成的清单能通过扫描', async () => {
  const f = await fixture();
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' });
  try {
    await fs.mkdir(path.join(f.app, 'server/bundled-skills/xlsx/scripts'), { recursive: true });
    await fs.writeFile(path.join(f.app, 'server/bundled-skills/xlsx/scripts/recalc.py'), 'print(1)');
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('add', '.');
    git('commit', '-qm', 'fixture [skip ci]');
    const result = await generateCodeRuntimeManifest(f.app);
    expect(result.files.some((x) => x.path.startsWith('server/bundled-skills/'))).toBe(false);
    await fs.rm(path.join(f.app, 'evals/code-runtime-manifest.json')); // 清单文件自己不在清单里（正式流程另作提交）
    expect(await checkCodeRuntime(result, f.app)).toMatchObject({ modelRequested: false });
  } finally {
    await f.close();
  }
});

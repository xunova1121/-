import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const run = promisify(execFile);
const script = path.resolve('evals/run-code-server.sh');

it('一键入口缺Docker时在下载或请求模型前明确停止', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-shell-no-docker-'));
  try {
    await fs.symlink(process.execPath, path.join(root, 'node'));
    await fs.writeFile(path.join(root, 'curl'), '#!/bin/sh\nexit 93\n', { mode: 0o700 });
    await expect(run('/bin/bash', [script], { env: { PATH: root } })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('缺少Docker') });
    expect((await fs.readdir(root)).sort()).toEqual(['curl', 'node']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('准备器URL固定到清单版本；下载哈希不符时不执行，即使文件中含可执行代码', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-shell-hash-'));
  const bin = path.join(root, 'bin'),
    target = path.join(root, 'target');
  try {
    await fs.mkdir(bin);
    await fs.mkdir(target);
    const good = 'console.log("verified helper");';
    const manifest = {
      version: 1,
      revision: 'a'.repeat(40),
      files: [{ path: 'evals/architecture-runtime-fetch.mjs', bytes: Buffer.byteLength(good), sha256: createHash('sha256').update(good).digest('hex') }]
    };
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(root, 'bad.mjs'), 'import fs from "node:fs"; fs.writeFileSync(process.env.CODE_MARKER,"executed");');
    const executable = async (name, text) => fs.writeFile(path.join(bin, name), '#!/bin/bash\n' + text, { mode: 0o700 });
    await executable('docker', 'exit 0\n');
    await executable('mktemp', 'printf "%s\\n" "$CODE_TARGET"\n');
    await executable(
      'curl',
      'printf "%s\\n" "$*" >> "$CODE_SOURCE/requests"\nif [[ "$*" == *code-runtime-manifest.json* ]]; then /bin/cp "$CODE_SOURCE/manifest.json" "${@: -1}"; else /bin/cp "$CODE_SOURCE/bad.mjs" "${@: -1}"; fi\n'
    );
    await expect(
      run('/bin/bash', [script], {
        env: {
          ...process.env,
          PATH: bin + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin',
          CODE_SOURCE: root,
          CODE_TARGET: target,
          CODE_MARKER: path.join(root, 'executed')
        }
      })
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('准备器下载哈希不符') });
    await expect(fs.stat(path.join(root, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(root, 'requests'), 'utf8')).toContain('/' + manifest.revision + '/jarvis/evals/architecture-runtime-fetch.mjs');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeCodeFile } from '../server/codeRepoWrite.mjs';
import { readCodeFile } from '../server/codeRepoFiles.mjs';
let root;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-write-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it('精确且唯一替换；不匹配、歧义、旧哈希不覆盖；写入回执可核对', async () => {
  await fs.writeFile(path.join(root, 'sum.js'), 'const sum=(a,b)=>a-b;\n');
  await expect(writeCodeFile(root, { path: 'sum.js', old: 'missing', new: 'x' }, { edit: true })).rejects.toMatchObject({ code: 'CODE_EDIT_MATCH' });
  await expect(writeCodeFile(root, { path: 'sum.js', old: 'a', new: 'x' }, { edit: true })).rejects.toMatchObject({ code: 'CODE_EDIT_MATCH' });
  const result = await writeCodeFile(root, { path: 'sum.js', old: 'a-b', new: 'a+b' }, { edit: true });
  expect(result).toMatchObject({ saved: true, operation: 'edit' });
  expect(await fs.readFile(path.join(root, 'sum.js'), 'utf8')).toBe('const sum=(a,b)=>a+b;\n');
  await expect(writeCodeFile(root, { path: 'sum.js', content: 'overwrite' })).rejects.toMatchObject({ code: 'CODE_WRITE_CONFLICT' });
  await expect(writeCodeFile(root, { path: 'sum.js', content: 'overwrite', expected_sha256: 'a'.repeat(64) })).rejects.toMatchObject({
    code: 'CODE_WRITE_CONFLICT'
  });
  const read = await readCodeFile(root, 'sum.js');
  expect(read.sha256).toBe(result.sha256);
  await writeCodeFile(root, { path: 'sum.js', content: 'updated', expected_sha256: read.sha256 });
  expect(await fs.readFile(path.join(root, 'sum.js'), 'utf8')).toBe('updated');
});
it('创建目录/新文件，不跟随符号链接或修改凭据/元数据/依赖；停止不落盘', async () => {
  await writeCodeFile(root, { path: 'src/new.js', content: 'export const value=1;' });
  expect(await fs.readFile(path.join(root, 'src/new.js'), 'utf8')).toContain('value=1');
  for (const file of ['../outside', '.git/config', '.env', 'src/key.pem', 'node_modules/example.js'])
    await expect(writeCodeFile(root, { path: file, content: 'x' })).rejects.toMatchObject({ code: 'CODE_PATH' });
  await fs.symlink(os.tmpdir(), path.join(root, 'outside'));
  await expect(writeCodeFile(root, { path: 'outside/x', content: 'x' })).rejects.toMatchObject({ code: 'CODE_SYMLINK' });
  const ctrl = new AbortController();
  ctrl.abort(new Error('stop'));
  await expect(writeCodeFile(root, { path: 'no.js', content: 'x' }, { signal: ctrl.signal })).rejects.toThrow('stop');
  await expect(fs.stat(path.join(root, 'no.js'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('拒绝凭据内容和超大文本，不以脱敏内容覆盖原文件', async () => {
  const token = 'ghp_' + 'DummyPrivateCredential'.repeat(3);
  await expect(writeCodeFile(root, { path: 'code.js', content: token }, { token })).rejects.toMatchObject({ code: 'CODE_SECRET' });
  await fs.writeFile(path.join(root, 'raw.js'), token + '\nexport const x=1;');
  await expect(writeCodeFile(root, { path: 'raw.js', old: 'x=1', new: 'x=2' }, { token, edit: true })).rejects.toMatchObject({ code: 'CODE_SECRET' });
  expect(await fs.readFile(path.join(root, 'raw.js'), 'utf8')).toContain(token);
  await expect(writeCodeFile(root, { path: 'big.js', content: 'x'.repeat(256001) })).rejects.toMatchObject({ code: 'CODE_CONTENT' });
});

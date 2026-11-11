/** 1.0.419 事故根治：严苛 umask 下打包，包里文件也必须所有账号可读（目录755/文件644，可执行保留755，不给别人写） */
import { it, expect, describe } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePackPermissions } from '../scripts/packPermissions.mjs';

const mode = (p) => fs.lstatSync(p).mode & 0o7777;

describe.skipIf(process.platform === 'win32')('打包权限规范', () => {
  it('0600/0700 的文件和目录被修成可读；可执行保留执行位；都不给组和其他人写', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-perm-'));
    try {
      // 模拟 umask 077 的构建环境（1.0.419 真实事故形态）
      fs.mkdirSync(path.join(dir, 'server'), { mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'server', 'server.mjs'), 'x', { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'install.sh'), '#!/bin/sh', { mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'world-writable.txt'), 'x', { mode: 0o666 });
      fs.chmodSync(path.join(dir, 'world-writable.txt'), 0o666);
      normalizePackPermissions(dir);
      expect(mode(dir)).toBe(0o755);
      expect(mode(path.join(dir, 'server'))).toBe(0o755);
      expect(mode(path.join(dir, 'server', 'server.mjs'))).toBe(0o644);
      expect(mode(path.join(dir, 'install.sh'))).toBe(0o755);
      expect(mode(path.join(dir, 'world-writable.txt'))).toBe(0o644);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('不跟随符号链接：链接指向的包外文件权限不被改动', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-perm-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret'), 'x', { mode: 0o600 });
      fs.chmodSync(path.join(outside, 'secret'), 0o600);
      fs.symlinkSync(path.join(outside, 'secret'), path.join(dir, 'link'));
      normalizePackPermissions(dir);
      expect(mode(path.join(outside, 'secret'))).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

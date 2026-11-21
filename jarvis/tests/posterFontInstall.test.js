import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = path.resolve(import.meta.dirname, '../deploy/install-poster-fonts.sh');
const directories = [];
const sans = 'Noto Sans CJK SC';
const serif = 'Noto Serif CJK SC';

// PATH 里没有系统目录；即使实现误走另一种包管理器，也不能真实安装软件。
// 替身只写本测试的日志与状态文件，timeout 的失败由固定退出码模拟，不实际等待。
const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const controls = JSON.parse(process.env.STUB_CONTROL);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ command, args }) + '\\n');
if (command === 'timeout') {
  if (!/^--kill-after=\\d+s$/.test(args[0]) || !/^\\d+s$/.test(args[1])) process.exit(91);
  if (args[2] === controls.timeoutCommand) process.exit(124);
  const result = spawnSync(args[2], args.slice(3), { env: process.env, stdio: 'inherit' });
  process.exit(result.status === null ? 92 : result.status);
}
if (command === 'fc-match') {
  const family = args.at(-1);
  const installed = fs.existsSync(process.env.STUB_STATE);
  const present = installed ? controls.installedFamilies : controls.initialFamilies;
  process.stdout.write(present.includes(family) ? family + ',Fixture Alias\\n' : 'DejaVu Sans\\n');
  process.exit(0);
}
if (command === 'fc-cache') process.exit(controls.cacheFailure ? 1 : 0);
if (['apt-get', 'dnf', 'yum'].includes(command)) {
  if (controls.packageFailure) process.exit(controls.packageFailure);
  if (args[0] === 'install') {
    fs.writeFileSync(process.env.STUB_STATE, 'installed');
    for (const name of ['fc-match', 'fc-cache']) {
      fs.copyFileSync(process.argv[1], path.join(process.env.STUB_DIR, name));
      fs.chmodSync(path.join(process.env.STUB_DIR, name), 0o755);
    }
  }
  process.exit(0);
}
process.exit(93);
`;

function runInstaller({ managers = ['apt-get'], initialFamilies = [], installedFamilies = [sans, serif], fontconfig = true, timeout = true, env = {}, ...controls } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'poster-font-install-'));
  directories.push(directory);
  const bin = path.join(directory, 'bin');
  const log = path.join(directory, 'commands.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(log, '');
  const commands = [...managers, ...(fontconfig ? ['fc-match', 'fc-cache'] : []), ...(timeout ? ['timeout'] : [])];
  for (const command of commands) fs.writeFileSync(path.join(bin, command), stub, { mode: 0o755 });
  const result = spawnSync('/bin/bash', [installer], {
    cwd: directory,
    env: {
      PATH: bin,
      LANG: 'C.UTF-8',
      STUB_DIR: bin,
      STUB_LOG: log,
      STUB_STATE: path.join(directory, 'installed'),
      STUB_CONTROL: JSON.stringify({ initialFamilies, installedFamilies, ...controls }),
      ...env
    },
    encoding: 'utf8',
    timeout: 4000
  });
  expect(result.error).toBeUndefined();
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...result, calls, output: result.stdout + result.stderr };
}

const packageCalls = result => result.calls.filter(call => ['apt-get', 'dnf', 'yum'].includes(call.command));
const expectFailure = result => {
  expect(result.status).not.toBe(0);
  expect(result.output).toMatch(/失败|缺少|缺|不可用|手动/);
};

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('服务器海报字体补装', () => {
  it('两种准确字体和fontconfig已装时不调用包管理器或重建缓存', () => {
    const result = runInstaller({ initialFamilies: [sans, serif] });
    expect(result.status).toBe(0);
    expect(packageCalls(result)).toEqual([]);
    expect(result.calls.some(call => call.command === 'fc-cache')).toBe(false);
    expect(result.calls.filter(call => call.command === 'fc-match').map(call => call.args.at(-1))).toEqual([sans, serif]);
  });

  it('缺fontconfig时从apt补齐两种中文字体，刷新缓存后重新核验', () => {
    const result = runInstaller({ fontconfig: false });
    expect(result.status).toBe(0);
    expect(packageCalls(result)).toEqual([
      { command: 'apt-get', args: ['update', '-qq'] },
      { command: 'apt-get', args: ['install', '-y', '-qq', '--no-install-recommends', 'fontconfig', 'fonts-noto-cjk'] }
    ]);
    expect(result.calls.filter(call => call.command === 'fc-cache')).toEqual([{ command: 'fc-cache', args: ['-f'] }]);
    expect(result.calls.filter(call => call.command === 'fc-match').map(call => call.args.at(-1))).toEqual([sans, serif]);
    const bounded = result.calls.filter(call => call.command === 'timeout');
    expect(bounded.filter(call => call.args[2] === 'apt-get').every(call => call.args.slice(0, 2).join(' ') === '--kill-after=15s 360s')).toBe(true);
    expect(bounded.find(call => call.args[2] === 'fc-cache').args.slice(0, 2)).toEqual(['--kill-after=5s', '60s']);
    expect(bounded.filter(call => call.args[2] === 'fc-match').every(call => call.args.slice(0, 2).join(' ') === '--kill-after=5s 15s')).toBe(true);
  });

  it.each(['dnf', 'yum'])('已有Office但缺字体时通过%s补装官方字体包，不开启第三方源', manager => {
    const result = runInstaller({ managers: [manager], env: { JARVIS_NO_OFFICE: '1' } });
    expect(result.status).toBe(0);
    expect(packageCalls(result)).toEqual([{
      command: manager,
      args: ['install', '-y', '-q', 'fontconfig', 'google-noto-sans-cjk-ttc-fonts', 'google-noto-serif-cjk-ttc-fonts']
    }]);
    expect(result.calls.some(call => /config-manager|repository|epel/.test(call.args.join(' ')))).toBe(false);
  });

  it('apt存在时不会重复调用dnf或yum', () => {
    const result = runInstaller({ managers: ['apt-get', 'dnf', 'yum'] });
    expect(result.status).toBe(0);
    expect(packageCalls(result).map(call => call.command)).toEqual(['apt-get', 'apt-get']);
  });

  it('只有Sans仍须补齐Serif，不能把字体回退当成已安装', () => {
    const result = runInstaller({ initialFamilies: [sans] });
    expect(result.status).toBe(0);
    expect(packageCalls(result)).toHaveLength(2);
  });

  it('包管理器失败时明确退出，不能刷新缓存或假称成功', () => {
    const result = runInstaller({ packageFailure: 23 });
    expectFailure(result);
    expect(packageCalls(result)).toHaveLength(1);
    expect(result.calls.some(call => call.command === 'fc-cache')).toBe(false);
  });

  it('包管理器超时后不继续安装或无限重试', () => {
    const result = runInstaller({ timeoutCommand: 'apt-get' });
    expectFailure(result);
    expect(packageCalls(result)).toEqual([]);
    expect(result.calls.filter(call => call.command === 'timeout' && call.args[2] === 'apt-get')).toHaveLength(1);
  });

  it('安装命令成功但fc-match仍回退其他字体时继续报缺字体', () => {
    const result = runInstaller({ installedFamilies: [] });
    expectFailure(result);
    expect(packageCalls(result)).toHaveLength(2);
    expect(result.calls.some(call => call.command === 'fc-cache')).toBe(true);
  });

  it('缓存刷新失败时不把海报字体状态记为成功', () => {
    const result = runInstaller({ cacheFailure: true });
    expectFailure(result);
    expect(result.calls.some(call => call.command === 'fc-cache')).toBe(true);
  });

  it('没有支持的包管理器时明确提示手动补装', () => {
    const result = runInstaller({ managers: [] });
    expectFailure(result);
    expect(result.output).toMatch(/手动|补装/);
    expect(packageCalls(result)).toEqual([]);
  });

  it('缺timeout时不运行任何可能无界的外部安装或字体检查', () => {
    const result = runInstaller({ timeout: false });
    expectFailure(result);
    expect(result.calls).toEqual([]);
  });

  it('显式跳过字体时无需timeout、fontconfig或包管理器', () => {
    const result = runInstaller({ managers: [], fontconfig: false, timeout: false, env: { JARVIS_NO_POSTER_FONTS: '1' } });
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/跳过/);
    expect(result.calls).toEqual([]);
  });
});

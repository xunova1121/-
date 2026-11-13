/** 图标库（约 1.9MB 的 PNG）只能按需加载，不许打进启动主包（用户 2026-11-01：图标扩到 238 个后主包从 2.0MB 涨到 4.0MB） */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.m?js$/.test(e.name) ? [path.join(dir, e.name)] : []));

it('源码里没有静态 import pptIcons.js，只能用 await import() 按需加载', () => {
  const offenders = walk(path.resolve(__dirname, '../src')).filter((file) => /^\s*import\s[^;]*from\s+['"][^'"]*pptIcons\.js['"]/m.test(fs.readFileSync(file, 'utf8')));
  expect(offenders.map((f) => path.relative(path.resolve(__dirname, '..'), f))).toEqual([]);
});

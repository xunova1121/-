import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
it('给国内服务器的单文件脚本必须与应用共享解析器/意图源码一致，不能只测另一个近似解析器', () => {
  expect(execFileSync(process.execPath, ['scripts/build-lookup-live.mjs', '--check'], { encoding: 'utf8' })).toContain('与共享源码一致');
});

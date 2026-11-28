import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const installed = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', p, 'package.json'), 'utf8')).version;
const atLeast = (v, min) => {
  const a = v.split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

describe('依赖漏洞不回退（2026-11-28 npm audit 清零）', () => {
  it('读 Excel 的 SheetJS 是 0.20.3（npm 上的 xlsx 0.18.5 有原型污染、正则卡死两个高危漏洞，官方不再往 npm 发）', async () => {
    expect(pkg.dependencies.xlsx).toBe('npm:@e965/xlsx@0.20.3');
    const XLSX = await import('xlsx');
    expect(XLSX.version).toBe('0.20.3');
    expect(typeof XLSX.read).toBe('function');
  });

  it('MCP 工具包和它带的 hono 等是修过的版本', () => {
    expect(atLeast(installed('@modelcontextprotocol/sdk'), '1.32.2')).toBe(true);
    expect(atLeast(installed('hono'), '4.13.16')).toBe(true);
    expect(atLeast(installed('@modelcontextprotocol/sdk/node_modules/@hono/node-server'), '2.1.6')).toBe(true);
  });

  it('exceljs 的 uuid、pptxgenjs 的 image-size 用覆盖固定到修过的版本', () => {
    expect(pkg.overrides?.exceljs?.uuid).toBe('11.1.1');
    expect(pkg.overrides?.pptxgenjs?.['image-size']).toBe('2.0.4');
  });

  it('服务器安装包带上覆盖设置（不带的话服务器上装的还是旧版）', () => {
    expect(fs.readFileSync(path.join(ROOT, 'scripts/pack-server.mjs'), 'utf8')).toMatch(/overrides: pkg\.overrides/);
  });
});

import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {SERVER_DEPS,serverImports} from '../scripts/serverDeps.mjs';
// 2026-11-01：服务器包少列 @xmldom/xmldom、pdf-lib，更新后启动即崩，用户看到 502
const ROOT=path.resolve(import.meta.dirname,'..');
describe('服务器安装包依赖',()=>{
  it('服务器代码用到的第三方包都列进安装包',()=>{const used=serverImports(ROOT);expect(used.size).toBeGreaterThan(5);const missing=[...used].filter(([d])=>!SERVER_DEPS.includes(d)).map(([d,f])=>`${d}（${f}）`);expect(missing).toEqual([]);});
  it('文档修改用到的 @xmldom/xmldom、pdf-lib 在内',()=>{const used=serverImports(ROOT);expect(used.has('@xmldom/xmldom')).toBe(true);expect(used.has('pdf-lib')).toBe(true);});
  it('列出的包 package.json 里都有版本',()=>{const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));expect(SERVER_DEPS.filter(d=>!pkg.dependencies[d])).toEqual([]);});
});

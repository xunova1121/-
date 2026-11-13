/**
 * 服务器版安装包里要装的依赖（网关、智能体、生成 / 读取文档）；浏览器才用的语音、三维、人脸识别等不装。
 * 2026-11-01：1.0.355 新加 @xmldom/xmldom、pdf-lib 没列进来，服务器更新后启动即报“找不到包”，一直 502。
 * 现在 tests/serverPackageDeps.test.js 从 server/server.mjs 顺着 import 找出服务器真正用到的包，少列一个就测试失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

export const SERVER_DEPS = ['@anthropic-ai/sdk', '@modelcontextprotocol/sdk', '@xmldom/xmldom', 'docx', 'exceljs', 'jszip', 'mammoth', 'marked', 'pdf-lib', 'pdfjs-dist', 'pptxgenjs', 'xlsx', 'ws'];

const IMPORT = /(?:^|[^\w.])(?:import\s*(?:[\w*{}\s,$]+from\s*)?|export\s*[\w*{}\s,$]+from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
const PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

/** 从入口顺着相对路径的 import / import() 走一遍，返回用到的第三方包 → 第一次出现的文件 */
export function serverImports(root, entry = 'server/server.mjs') {
  const seen = new Set(), found = new Map();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const [, spec] of src.matchAll(IMPORT)) {
      if (spec.startsWith('.')) {
        let next = path.resolve(path.dirname(file), spec);
        if (!fs.existsSync(next) || fs.statSync(next).isDirectory()) next = ['.js', '.mjs', '/index.js'].map((e) => next + e).find((f) => fs.existsSync(f)) || next;
        if (/\.m?js$/.test(next)) walk(next);
        continue;
      }
      if (spec.startsWith('node:')) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!PACKAGE.test(name) || builtinModules.includes(name) || found.has(name)) continue;
      found.set(name, path.relative(root, file));
    }
  };
  walk(path.join(root, entry));
  return found;
}

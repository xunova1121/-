/** 从项目同版本Lucide源生成受控矢量素材；不接受模型传入路径或SVG。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { ICON_PNG } from '../src/agent/pptIcons.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2];
if (!source) throw new Error('请指定lucide-static@0.577.0解包目录');
const assets = {};
for (const key of Object.keys(ICON_PNG)) {
  const svg = await fs.readFile(path.join(source, 'icons', key + '.svg'), 'utf8');
  if (!svg.includes('lucide-static v0.577.0')) throw new Error('Lucide版本不匹配');
  const body = svg.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/)?.[1].trim();
  if (!body || /(?:href|style|on\w+)\s*=|<\/?(?!path\b|circle\b|rect\b|line\b|polyline\b|polygon\b|ellipse\b)[a-z]/i.test(body))
    throw new Error('图标含不支持的内容');
  assets[key] = body;
}
const header =
  '/** Lucide 0.577.0静态图标（ISC，部分Feather MIT），许可见licenses/lucide-LICENSE.txt。\n * 由scripts/make-diagram-icons.mjs生成，与pptIcons.js使用同一版本，不要手改。\n */\n';
const target = path.join(root, 'src/agent/diagramIconAssets.js');
const content = header + 'export const DIAGRAM_ICON_ASSETS = ' + JSON.stringify(assets, null, 2) + ';\n';
await fs.writeFile(target, await format(content, { ...(await resolveConfig(target)), filepath: target }));
console.log('已生成受控图标：' + Object.keys(assets).length);

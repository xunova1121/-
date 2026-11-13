/** 将设计稿打成一个离线HTML，交付时不依赖本机路径、字体CDN或服务器。 */
import { readFile, writeFile } from 'node:fs/promises';
const here = new URL('.', import.meta.url);
const [page, css, script, brand] = await Promise.all([
  readFile(new URL('page.html', here), 'utf8'),
  readFile(new URL('prototype.css', here), 'utf8'),
  readFile(new URL('prototype.js', here), 'utf8'),
  readFile(new URL('../../../jarvis/src/ui/logo.svg', here))
]);
const html = page.replace('/* PROTOTYPE_CSS */', () => css)
  .replace('/* PROTOTYPE_JS */', () => script)
  .replace('__BRAND__', 'data:image/svg+xml;base64,' + brand.toString('base64'));
await writeFile(new URL('index.html', here), html);
console.log('已生成离线交互预览；所有查询为演示，网络访问由CSP禁用。');

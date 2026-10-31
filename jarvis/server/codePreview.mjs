import path from 'node:path';
import { readCodeFile } from './codeRepoFiles.mjs';
import { codeError } from './codeGit.mjs';
/** 静态预览的资源内联；前端必须置于无same-origin的sandbox iframe，网络由CSP禁止。 */
export async function codePreview(root, entry, token = '') {
  const file = await readCodeFile(root, entry, token);
  if (file.redacted || !/\.html$/i.test(entry)) throw codeError('CODE_PREVIEW', '预览需要不含凭据的HTML入口');
  let html = file.text,
    bytes = file.bytes,
    resources = 0;
  const load = async (relative, owner = entry) => {
    if (/^(?:[a-z]+:|\/\/|\/|#)/i.test(relative)) return null;
    const name = path.posix.join(path.posix.dirname(owner), relative.split(/[?#]/)[0]);
    const item = await readCodeFile(root, name, token, { asAsset: true });
    bytes += item.bytes;
    resources++;
    if (item.redacted || bytes > 8_000_000 || resources > 80) throw codeError('CODE_PREVIEW_LIMIT', '预览超过8MB/80资源或含凭据');
    return item;
  };
  const replaceAsync = async (text, pattern, transform) => {
    const matches = [...text.matchAll(pattern)];
    for (const m of matches) text = text.replace(m[0], await transform(m));
    return text;
  };
  const mime = (relative) =>
    ({
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2'
    })[path.extname(relative.split(/[?#]/)[0]).toLowerCase()];
  html = await replaceAsync(html, /<link\b[^>]*>/gi, async (m) => {
    if (!/\brel=["']stylesheet["']/i.test(m[0])) return m[0];
    const href = m[0].match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) return '';
    const item = await load(href);
    if (!item) return '';
    const cssPath = path.posix.join(path.posix.dirname(entry), href.split(/[?#]/)[0]);
    const css = await replaceAsync(item.data.toString('utf8'), /url\(\s*["']?([^"'()\s]+)["']?\s*\)/gi, async (url) => {
      if (!mime(url[1])) return 'url(data:,)';
      const asset = await load(url[1], cssPath);
      return asset ? 'url(data:' + mime(url[1]) + ';base64,' + asset.data.toString('base64') + ')' : 'url(data:,)';
    });
    return '<style>' + css.replace(/<\/style/gi, '<\\/style') + '</style>';
  });
  html = await replaceAsync(html, /<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, async (m) => {
    const item = await load(m[1]);
    return item ? m[0].replace(m[1], 'data:application/javascript;base64,' + item.data.toString('base64')) : '';
  });
  html = await replaceAsync(html, /(<img\b[^>]*\bsrc=)["']([^"']+)["']/gi, async (m) => {
    const item = await load(m[2]);
    if (!item) return m[0];
    const ext = path.extname(m[2]).toLowerCase(),
      type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[ext];
    return type ? m[1] + '"data:' + type + ';base64,' + item.data.toString('base64') + '"' : m[0];
  });
  const csp =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline' data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + csp + '">';
  const protectedHtml = /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^(\s*<!doctype[^>]*>)/i, '$1' + meta) : meta + html;
  return {
    html: protectedHtml,
    title: html.match(/<title>([^<]*)<\/title>/i)?.[1]?.slice(0, 120) || entry,
    entry,
    resources,
    bytes,
    externalResources: 'CSP blocks resource/API loads; iframe navigation is not an offline network sandbox'
  };
}

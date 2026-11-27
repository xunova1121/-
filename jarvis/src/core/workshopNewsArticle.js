import { newsPlain } from '../agent/newsSources.js';
import { decodeLookupBody } from '../agent/lookup/content.js';
import { withWebDeadline } from '../agent/lookup/request.js';
import { webBody } from '../agent/webBody.js';
import { workshopArticleLink } from './workshopNewsSource.js';

const maxChars = 16_000;
const maxParagraphs = 120;
const punctuation = { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…', middot: '·' };

export function newsArticleUrl(value) {
  return workshopArticleLink(value, '央视网') || workshopArticleLink(value, '中新网');
}

// 只在该媒体的正文容器中取段落。匹配嵌套 div，避免把推荐、广告和导航当成新闻。
function articleContainer(html, opening) {
  const start = opening.exec(html);
  if (!start) return '';
  const inner = html.slice(start.index + start[0].length);
  let depth = 1;
  for (const tag of inner.matchAll(/<\/?div\b[^>]*>/gi)) {
    depth += tag[0][1] === '/' ? -1 : 1;
    if (depth === 0) return inner.slice(0, tag.index);
  }
  return '';
}

function articleMarkup(html, cns) {
  // 央视的新版页面将 HTML 作为单独字符串交给前端播放器。只解引号等常见转义，不执行站点脚本。
  const literal = !cns && /\bvar\s+contentdate\s*=\s*'((?:\\[\s\S]|[^'\\])*)'[\t ]*(?:;|\r?\n)/.exec(html)?.[1];
  const markup = literal ? literal.replace(/\\(['"\\/])/g, '$1') : html;
  const clean = markup.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  if (literal) return clean.replace(/\[!--begin:htmlVideoCode--\][\s\S]*?\[!--end:htmlVideoCode--\]/gi, '');
  return articleContainer(clean, cns
    ? /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bleft_zw\b[^"']*["'][^>]*>/i
    : /<div\b[^>]*\b(?:id|class)\s*=\s*["'][^"']*\bcontent_area\b[^"']*["'][^>]*>/i);
}

export function parseWorkshopArticle(html, url) {
  const body = articleMarkup(html, new URL(url).hostname === 'www.chinanews.com.cn')
    .replace(/<(?:table|iframe)\b[^>]*>[\s\S]*?<\/(?:table|iframe)\s*>/gi, '');
  const paragraphs = [];
  let total = 0, truncated = false;
  for (const part of body.matchAll(/<p\b[^>]*>([\s\S]*?)(?=<\/p\s*>|<p\b|$)/gi)) {
    const line = newsPlain(part[1].split(/<div\b[^>]*class=["']adEditor["']/i)[0])
      .replace(/&(ldquo|rdquo|lsquo|rsquo|mdash|ndash|hellip|middot);/g, (_, key) => punctuation[key]);
    if (!line) continue;
    if (total >= maxChars || paragraphs.length >= maxParagraphs) { truncated = true; break; }
    const take = line.slice(0, maxChars - total);
    paragraphs.push(take);
    total += take.length;
    if (take.length !== line.length) { truncated = true; break; }
  }
  if (!paragraphs.length) throw new Error('来源页面未提供可读正文');
  return { url, paragraphs, truncated };
}

export async function readWorkshopArticle(value, { get, signal }) {
  const url = newsArticleUrl(value);
  if (!url) throw new Error('这条链接不属于工作台新闻来源');
  return withWebDeadline(async active => {
    const response = await get(url, { signal: active, credentials: 'omit', redirect: 'error' });
    if (!response.ok || response.url && response.url !== url) throw new Error('来源页面暂时无法读取');
    const type = response.headers.get('content-type') || '';
    if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(type)) throw new Error('来源未返回网页');
    return parseWorkshopArticle(decodeLookupBody(await webBody(response, 900 * 1024, active), type), url);
  }, { signal, timeoutMs: 7000 });
}

export function validWorkshopArticle(data, url) {
  if (data?.url !== url || !Array.isArray(data.paragraphs) || !data.paragraphs.length || data.paragraphs.length > maxParagraphs) return false;
  let size = 0;
  return data.paragraphs.every(line => typeof line === 'string' && line.trim() && (size += line.length) <= maxChars);
}

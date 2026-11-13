import { isPrivateHost } from '../../shared/providers.js';
import { throwControl } from '../core/networkRequest.js';
import { readGovernmentGuide } from './governmentGuide.js';
import { readPageCandidates, enoughPageContent } from './pageCandidates.js';
import { formatPageResult, LINK_MARKER } from './pageLinks.js';
import { channelKinds } from './answerRequirements.js';
import { searchAggregateHints, safeFallbackQuery } from './searchFallback.js';
import { evidence as evidenceStore } from './evidenceStore.js';

const inputError = message => Object.assign(new Error(message), { name: 'ValidationError', code: 'FETCH_URL_INPUT', kind: 'input' });
export const FETCH_BATCH_CHARS = 8000;
export const FETCH_PAGE_CHARS = 2000;

/** urls 单项兼容单页；仅传多项代表全部要读，不能当备选丢掉其余页面。 */
export function normalizeFetchUrlArgs(args) {
  if ((args.url === undefined || args.url === '') && Array.isArray(args.urls) && args.urls.length) {
    const [url, ...rest] = args.urls;
    args.url = url;
    if (rest.length) args.urls = rest;
    else delete args.urls;
    if (rest.length && args.read_mode === undefined) args.read_mode = 'all';
  }
  return args;
}

export function fetchUrlPlan(args) {
  normalizeFetchUrlArgs(args);
  if (args.urls !== undefined && !Array.isArray(args.urls)) throw inputError('urls 应为网址数组，不能是字符串或对象');
  const mode = args.read_mode ?? 'fallback';
  if (!['fallback', 'all'].includes(mode)) throw inputError('read_mode 只能是 fallback（备选）或 all（逐页读取）');
  const values = [args.url, ...(args.urls || [])];
  if (values.length > 3) throw inputError('一次最多读取 3 个地址，请分批；不会静默忽略多余地址');
  const urls = values.map(value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw inputError('每个地址须为不超过 2000 字符的 http(s) 网址');
    let url;
    try { url = new URL(value.trim()); } catch { throw inputError('请提供有效的 http(s) 网址'); }
    if (!/^https?:$/.test(url.protocol)) throw inputError('只支持 http(s) 地址');
    if (url.username || url.password || isPrivateHost(url.hostname.replace(/\.$/, '')) || /\.(?:local|internal)\.?$/i.test(url.hostname) || !url.hostname.includes('.'))
      throw Object.assign(new Error('只允许读取不含凭据的公网网页地址'), { code: 'PRIVATE_NETWORK_BLOCKED', kind: 'api', status: 403 });
    url.hash = '';
    // URL 在查询串中可能保留反斜杠，随后 JSON 转义会令回执膨胀；先规范编码再统一限长。
    const canonical = url.href.replace(/[\\"]/g, character => encodeURIComponent(character));
    if (canonical.length > 2000) throw inputError('编码后的网址超过 2000 字符，请使用较短的原文链接');
    return canonical;
  });
  return { mode, urls: [...new Set(urls)] };
}

/** 所有地址先校验再联网；读取仍复用原 PageReader 的缓存、代理安全和请求预算。 */
export function createFetchPageRun(ctx, readPage) {
  return async (args, execution = {}) => {
    const plan = fetchUrlPlan(args);
    const { signal, progress, retrieval, sessionId, requestText } = execution;
    let reservation = null;
    const read = async (address, activeSignal, reserved = false) => {
      throwControl(null, activeSignal);
      fetchUrlPlan({ url: address });
      if (reserved) reservation.take(); else retrieval?.consume('read');
      return readPage(address, { signal: activeSignal, progress, consume: kind => retrieval?.consume(kind), refresh: /重新(?:读取|获取|查询)|强制刷新|不要缓存/.test(requestText || '') });
    };
    const save = async (url, text) => {
      throwControl(null, signal);
      const guide = await readGovernmentGuide({ text, url, requestText, signal, read });
      throwControl(null, signal);
      const sid = sessionId ?? ctx.currentSessionId?.();
      const sources = [{ url, title: titleOf(text), text }, ...(guide ? [{ url: guide.url, title: '政府申请指南', text: guide.text }] : [])];
      const ids = sid && text ? await evidenceStore.put(sid, { sources }).catch(() => []) : [];
      return { url: guide?.url || url, requestedUrl: url, text: guide?.text || text, initialText: guide ? text : '', evidenceId: guide ? ids[1] : ids[0] };
    };
    if (plan.mode === 'all') {
      if (readPage.publicOnly && plan.urls.length > 1) reservation = retrieval?.reserve?.('read', plan.urls.length);
      try { return await readAllPages(plan.urls, { read, save, signal, progress, parallel: Boolean(reservation) }); }
      finally { reservation?.release(); }
    }
    let url = plan.urls[0], text;
    try {
      if (plan.urls.length > 1) {
        const found = await readPageCandidates(plan.urls, { read, signal, accept: content => enoughPageContent(content, requestText) });
        if (!found) throw new Error('候选页面没有足够正文，请换来源；导航标题不能当作已核实材料');
        url = found.url; text = found.text;
      } else text = await read(url, signal);
    } catch (error) {
      throwControl(error, signal);
      if (error.code === 'PRIVATE_NETWORK_BLOCKED') throw error;
      const hints = await searchAggregateHints(safeFallbackQuery(url, requestText), {
        get: ctx.fetchViaGateway ?? ((...params) => fetch(...params)), signal, retrieval
      });
      return '原网页读取失败：' + error.message + '\n以下只是聚合搜索线索，未取得原站正文，不能声称已核实：\n' + JSON.stringify(hints);
    }
    const page = await save(url, text);
    return '【网页读取回执】' + JSON.stringify({ url: page.url }) + '\n' + pageText(page) + evidenceNote(page.evidenceId);
  };
}

const receiptText = text => String(text).replace(/[\u0000-\u001f\u007f]/g, ' ');
const receiptField = (value, limit) => {
  let text = receiptText(value).slice(0, limit);
  while (JSON.stringify(text).length > limit + 2) text = text.slice(0, -1);
  return text;
};
const titleOf = text => receiptText(String(text).split('\n').find(line => line.trim())?.trim() || '网页正文').slice(0, 120);
const evidenceNote = id => id ? `\n\n（已存为证据 ${id}，之后要看原文用 read_evidence）` : '';
const pageText = page => formatPageResult(page.text) + (page.initialText ? '\n\n【最初页面（不作为指南正文证据）】\n' + formatPageResult(page.initialText) : '');

async function readAllPages(urls, { read, save, signal, progress, parallel = false }) {
  const pages = new Array(urls.length), controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      throwControl(null, controller.signal);
      const index = next++, url = urls[index];
      progress?.(`正在读取第 ${index + 1}/${urls.length} 页`);
      try {
        const text = await read(url, controller.signal, parallel);
        throwControl(null, controller.signal);
        pages[index] = { ...(await save(url, text)), read: true };
      } catch (error) {
        try { throwControl(error, controller.signal); }
        catch (control) { controller.abort(control); throw control; }
        if (error.code === 'PRIVATE_NETWORK_BLOCKED') { controller.abort(error); throw error; }
        pages[index] = { url, read: false, error: receiptText(error.message || '读取失败').slice(0, 300), code: receiptField(error.code || '', 80) };
      }
    }
  };
  // 仅纯公网直读且已预留预算才并发；带付费代读/未知预算仍沿用逐页行为。
  try { await Promise.all(Array.from({ length: parallel ? Math.min(2, urls.length) : 1 }, worker)); }
  catch (error) { controller.abort(error); throw error; }
  finally { signal?.removeEventListener('abort', stop); }
  if (!pages.some(page => page.read)) throw Object.assign(new Error('多页读取均未取得正文：\n' + pages.map(page => `${page.url}：${page.error}`).join('\n')), { code: 'FETCH_PAGES_FAILED', kind: 'api' });
  const receipts = pages.map(page => ({
    url: page.url, ...(page.requestedUrl && page.requestedUrl !== page.url && { requestedUrl: page.requestedUrl }), read: page.read,
    ...(page.read ? { title: titleOf(page.text), summary: receiptText(String(page.text).split(LINK_MARKER)[0]).slice(0, 180), channels: channelKinds(String(page.text).split(LINK_MARKER)[0]), ...(page.evidenceId && { evidenceId: page.evidenceId }) } : { error: receiptText(page.error), code: page.code })
  }));
  const makeHeader = () => '【网页读取回执】' + JSON.stringify({ read_mode: 'all', pages: receipts }) + '\n';
  if (makeHeader().length > 6000) {
    // 极长URL优先保住每页真实来源和状态；原始入参及原文都可回读，不重复塞进消息。
    for (const receipt of receipts) {
      delete receipt.requestedUrl;
      if (receipt.read) { receipt.title = '网页正文'; receipt.summary = ''; }
      else receipt.error = receiptField(receipt.error, 60);
    }
  }
  const header = makeHeader();
  const perPage = Math.min(FETCH_PAGE_CHARS, Math.max(0, Math.floor((FETCH_BATCH_CHARS - header.length) / pages.length) - 100));
  const blocks = pages.map((page, index) => {
    const label = `\n【第 ${index + 1}/${pages.length} 页：${page.read ? '已读取正文' : '读取失败，未取得正文'}】\n`;
    if (!page.read) return label + page.error.slice(0, perPage);
    const note = evidenceNote(page.evidenceId);
    return label + boundedPageText(page, Math.max(0, perPage - note.length)) + note;
  });
  return header + blocks.join('\n');
}

/** 多页总返回有界，每页仍保留一部分栏目链接；完整已存片段按证据编号读取。 */
function boundedPageText(page, limit) {
  const formatted = pageText(page);
  if (formatted.length <= limit) return formatted;
  const [body, links] = formatted.split(LINK_MARKER);
  const ending = '\n（本页显示片段已截断，证据缓存也有长度上限，不能声称全文已读。）';
  const selected = [];
  let linkChars = 0;
  for (const line of (links || '').split('\n').filter(Boolean)) {
    if (linkChars + line.length + 1 > Math.min(600, Math.floor(limit / 4))) continue;
    selected.push(line); linkChars += line.length + 1;
  }
  const tail = links ? LINK_MARKER + '\n' + (selected.join('\n') || '（链接列表较长，本次未展开；未继续读取这些页面。）') : '';
  return body.slice(0, Math.max(0, limit - ending.length - tail.length)) + ending + tail;
}

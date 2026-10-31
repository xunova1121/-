import { readLookupSource } from './readSource.js';
import { selectLookupSources } from './sources.js';
import { lookupTimeRange } from './domesticNews.js';

function articleKey(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    url.hash = '';
    // 仅删除已知跟踪参数；文章ID等业务参数不动，不按模糊标题合并冲突事实。
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(?:fbclid|gclid)$/.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

/** 新闻共用入口。第1步不接比分/天气/行情，不新增另一套整轮时钟，沿用现有signal/预算。 */
export async function runLookup(intent, options = {}) {
  if (!['news', 'sports_news'].includes(intent.kind)) throw Object.assign(new Error('本步仅接新闻和体育资讯'), { code: 'LOOKUP_KIND_PENDING' });
  const { signal, retrieval, health, get, progress, now = Date.now() } = options;
  if (signal?.aborted) throw signal.reason;
  if (intent.params?.dateMode === 'specified') throw Object.assign(new Error('指定历史日期暂走原查询路径，不转换成今日'), { code: 'LOOKUP_DATE_PENDING' });
  const sourcesForQuery = options.sources ?? options.registry?.({ kind: intent.kind, params: intent.params });
  const selection = await selectLookupSources({ ...options, sources: sourcesForQuery, kind: intent.kind, params: intent.params });
  if (signal?.aborted) throw signal.reason;
  const params = intent.params || {};
  const range = lookupTimeRange(params, now);
  // 先预留每源1次列表读取，再在总8次内分配正文；不能并发抢预算后把已取到的内容丢掉。
  const maxReads = Math.max(0, Math.min(8, options.maxReads ?? 8, 8 - (retrieval?.resources?.read || 0)));
  if (!maxReads) throw Object.assign(new Error('本轮新闻读取额度已用完，未发起新请求'), { code: 'RETRIEVAL_BUDGET' });
  const sources = selection.sources.slice(0, maxReads);
  const details = new Map(sources.map(s => [s.id, 0]));
  let remaining = maxReads - sources.length;
  for (let i = 0; i < 5 && remaining > 0; i++) for (const source of sources) {
    if (!remaining) break;
    if (source.parseArticle && details.get(source.id) < (source.maxDetails ?? 5)) { details.set(source.id, details.get(source.id) + 1); remaining--; }
  }
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', stop, { once: true });
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < sources.length && !controller.signal.aborted) {
      const source = sources[next++];
      progress?.('正在读取' + source.label);
      const row = await readLookupSource(source, { get, now, params, signal: controller.signal, retrieval, detailLimit: details.get(source.id) });
      if (controller.signal.aborted) throw controller.signal.reason;
      await health?.record(source.id, row, { signal: controller.signal });
      results.push(row);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, worker));
  } catch (error) { controller.abort(error); throw error; }
  finally { signal?.removeEventListener('abort', stop); }
  if (signal?.aborted) throw signal.reason;
  // 按选择顺序而非响应快慢轮流取各来源、各栏目，避免单一媒体挤掉其他视角。
  results.sort((a, b) => sources.findIndex(s => s.id === a.source) - sources.findIndex(s => s.id === b.source));
  const candidates = [];
  for (let i = 0; i < 36; i++) for (const row of results) if (row.items[i]) candidates.push(row.items[i]);
  const groups = params.categories?.length ? params.categories : ['国内', '国际', '财经', '科技', '体育'];
  const buckets = groups.map(category => candidates.filter(item => item.category === category));
  const seen = new Set(), items = [];
  const limit = Math.max(1, Math.min(24, params.limit || 12));
  for (let i = 0; i < 36 && items.length < limit; i++) for (const bucket of buckets) {
    const item = bucket[i];
    const key = item && articleKey(item.url);
    const at = Date.parse(item?.publishedAt);
    if (!key || seen.has(key) || !item.title || at < range.from || at > range.until || !Number.isFinite(at)) continue;
    seen.add(key);
    items.push(item);
    if (items.length === limit) break;
  }
  return { kind: intent.kind, region: selection.region, range, items, sources: results,
    failures: results.filter(row => row.state !== 'ok' || row.warnings?.length).map(row => ({ source: row.label, reason: row.reason || row.warnings.join('；') })), skipped: selection.skipped };
}

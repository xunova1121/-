import { collection } from '../store.js';
import { newsDate } from '../newsSources.js';
import { lookupReceiptItems } from './receipts.js';
import { usefulReceipt } from './recoveryData.js';
const ID = 'lookup.last-good.v1';
const KINDS = new Set(['weather', 'sports_live', 'news', 'sports_news', 'market']);
export function lastGoodKey(intent, plan, text = '') {
  if (!KINDS.has(intent.kind) || /持仓|账户|我的|文件|密码|令牌|密钥|住址|家里/.test(text) || intent.params?.dateMode === 'specified') return null;
  const args = plan?.args || {};
  if (intent.kind === 'weather' && !args.place || intent.kind === 'market' && !args.code) return null;
  // 仅公开查询参数；不存用户原话、坐标、凭据或任意扩展字段。
  const allowed = ['place', 'days', 'code', 'adjustment', 'limit', 'sport', 'period', 'date', 'window_minutes', 'categories', 'publishers', 'date_mode'];
  const params = Object.fromEntries(allowed.filter(k => args[k] != null).map(k => [k, args[k]]));
  if (JSON.stringify(params).length > 440 || /https?:|[0-9]|@|路|街|号|室|弄|幢|楼|小区|经度|纬度/.test(String(args.place || ''))) return null;
  const key = intent.kind + ':' + JSON.stringify({ ...params, mode: intent.params?.dateMode || 'today' });
  return key.length <= 500 ? key : null;
}
function valid(row, kind, at) {
  if (!row || row.at > at || !Number.isFinite(row.at)) return false;
  const age = at - row.at;
  if (kind === 'weather') return age <= 3 * 3600_000;
  if (kind === 'sports_live') return age <= 10 * 60_000;
  return newsDate(row.at) === newsDate(at) && age <= 86400_000;
}
/** 单个kv记录最多24条、每条8KB；本机/服务器/评测由服务实例注入各自存储。 */
export function createLastGood({ storage = collection('kv'), now = Date.now } = {}) {
  let pending = Promise.resolve(), memory;
  async function load() { try { return await storage.get(ID) || memory || { id: ID, rows: [] }; } catch { return memory || { id: ID, rows: [] }; } }
  return {
    async get(key, kind, { signal } = {}) {
      if (!key || signal?.aborted) return null;
      await pending.catch(() => {});
      const rows = (await load()).rows;
      const row = (Array.isArray(rows) ? rows : []).slice(-24).find(r => r.key === key);
      if (signal?.aborted || !valid(row, kind, now())) return null;
      return structuredClone(row);
    },
    async put(key, kind, found, { signal } = {}) {
      if (!key || /(?:Bearer\s+[A-Za-z0-9]|[?&](?:key|token|api_key|access_token)=)/i.test(found.output || '') || !usefulReceipt(found) || found.output.length > 100000 || found.recovery?.state === 'cached' || signal?.aborted) return;
      // 搜索摘要不作为结构化天气/比分/日K缓存；新闻必须有明确发布时间。
      if (!['get_weather', 'get_stock_kline', 'get_sports_scores', 'get_today_news'].includes(found.tool) || !/https?:\/\//.test(found.output)) return;
      let output = found.output;
      try {
        const data = JSON.parse(output);
        if (data.kind === 'today_news') {
          const items = data.items.slice(0, 12).map(item => ({ ...item, title: String(item.title).slice(0, 160), summary: String(item.summary || '').slice(0, 180) }));
          const compact = { kind: data.kind, date: data.date, range: data.range, items, sources: [], cacheTruncated: true, note: '缓存只保留部分条目和短摘要，不能当作原始完整列表。' };
          while (items.length > 1 && new TextEncoder().encode(JSON.stringify(compact)).length > 6000) items.pop();
          output = JSON.stringify(compact);
        }
      } catch { /* 天气和赛程保持原始可读格式，不截断来源。 */ }
      const items = lookupReceiptItems({ ...found, output }, { kind }).slice(0, 12).map(({ title, url, source, publishedAt, verified }) => ({ title: String(title).slice(0, 160), url, source, publishedAt, verified, kind }));
      let args = {};
      try { const value = JSON.parse(key.slice(key.indexOf(':') + 1)); if (value && typeof value === 'object' && !Array.isArray(value)) args = value; } catch { /* 仅允许已规范化参数落盘。 */ }
      const cachedFound = { tool: found.tool, args, query: '', output };
      if (new TextEncoder().encode(JSON.stringify({ items, found: cachedFound })).length > 8000) return;
      const job = pending.catch(() => {}).then(async () => {
        const old = await load(); if (signal?.aborted) return;
        const at = now();
        const rows = (Array.isArray(old.rows) ? old.rows : []).filter(r => r.key !== key && valid(r, r.kind, at)).slice(-23);
        rows.push({ key, kind, at, items, found: cachedFound });
        memory = { id: ID, rows };
        try { await storage.put(memory); } catch { /* 存储不可用时仅保留本实例有界缓存。 */ }
      });
      pending = job; await job;
    }
  };
}

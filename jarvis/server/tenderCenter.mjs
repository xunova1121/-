import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createFileStore } from './fileStore.mjs';
import { createUserStore, runAsUser } from './userScope.mjs';
import { businessSource, cleanBusinessText, noticeKey } from '../src/agent/businessSources.js';
import { TENDER_LIMITS, tenderBudget, tenderFilters, tenderMatches, retainedTender } from '../src/core/tenderCenterData.js';
import { TENDER_SOURCES, createTenderCollector } from './tenderSources.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'TENDER_CENTER' });
const blank = () => ({ id: 'catalog', seq: 0, items: [], sources: {}, enabled: true, lastAttempt: 0 });
const personalBlank = () => ({ id: 'tender-center', subscriptions: [], favorites: [], favoriteSnapshots: {}, alerts: [], watchCursor: 0 });
const revision = row => digest(JSON.stringify([row.title, row.publishedAt, row.region, row.type, row.snippet,
  row.projectNumber, row.budgetText, row.ceilingText, row.deadlineText, row.excerpt]));
const diagnostic = error => ({ code: String(error?.code || error?.name || 'UNAVAILABLE').slice(0, 50), ...(Number.isInteger(error?.status) && { http: error.status }) });

/** 公共目录独立存储；个人订阅/收藏/收件箱复用服务端身份范围。整个周期不调用模型。 */
export function createTenderCenter({ dataDir, get, now = Date.now, users = () => ['owner'], active = () => true,
  collector = createTenderCollector({ get, now }), sources = TENDER_SOURCES } = {}) {
  const shared = createFileStore(path.join(dataDir, 'tender-public'));
  const personal = createUserStore(dataDir);
  let queue = Promise.resolve(), pending = 0, job = null, controller = null, timer = null, stopped = true;
  const load = async () => structuredClone(await shared.get('kv', 'catalog') || blank());
  const readPersonal = async () => structuredClone(await personal.get('kv', 'tender-center') || personalBlank());
  function serial(work) {
    if (pending >= 32) throw fail('公告操作繁忙，请稍后重试', 429);
    pending++;
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next.finally(() => { pending--; });
  }
  async function match(state, catalog) {
    let changed = false;
    const alert = (row, title, body, subscriptionId) => {
      // 同一修订命中多个订阅/收藏也只有一条提醒；订阅游标仍各自推进。
      const id = digest(row.id + ':' + row.seq);
      if (state.alerts.some(item => item.id === id)) return;
      state.alerts.push({ id, at: now(), kind: 'tender', tenderId: row.id, subscriptionId, title, body, url: row.url, read: false,
        change: row.previous ? { before: row.previous, after: { budgetText: row.budgetText, deadlineText: row.deadlineText, type: row.type } } : null });
    };
    state.favoriteSnapshots ||= {};
    // 收藏同时跟踪这份原文的变化；不凭相似标题合并其他项目/包件。
    if ((state.watchCursor || 0) < catalog.seq) {
      for (const row of catalog.items.filter(row => row.seq > (state.watchCursor || 0) && state.favorites.includes(row.id))) {
        state.favoriteSnapshots[row.id] = { ...row };
        alert(row, '收藏公告有更新', row.title);
      }
      state.watchCursor = catalog.seq; changed = true;
    }
    for (const sub of state.subscriptions) {
      if (sub.cursor >= catalog.seq) continue;
      if (sub.enabled) for (const row of catalog.items.filter(row => row.seq > sub.cursor && tenderMatches(row, sub.filters))) {
        alert(row, row.previous ? '关注公告有更新' : '发现匹配公告', `${sub.name} · ${row.title}`, sub.id);
      }
      sub.cursor = catalog.seq;
      changed = true;
    }
    if (changed) {
      state.alerts = state.alerts.filter(row => row.at >= now() - TENDER_LIMITS.days * 86400_000).sort((a, b) => b.at - a.at).slice(0, TENDER_LIMITS.alerts);
      // 游标与提醒原子保存；崩溃后重放不重复通知，个人写失败不推进游标。
      await personal.put('kv', state);
    }
    return state;
  }
  async function account(catalog) { return match(await readPersonal(), catalog); }
  async function fanout(catalog) {
    for (const id of users()) if (active(id)) {
      try { await runAsUser(id, () => account(catalog)); }
      catch { /* 此账号保留旧游标，下次轮询重放；不阻断其他账号。 */ }
    }
  }
  function ingest(catalog, input, source) {
    const url = noticeKey(input.url);
    const origin = businessSource(url);
    if (!url || url.length > 2048 || origin?.host !== new URL(source.url).hostname.replace(/^www\./, '') || !retainedTender(input, now())) return;
    const id = digest(url), old = catalog.items.find(row => row.id === id);
    const row = { ...old, id, url, sourceId: source.id, source: source.label, title: cleanBusinessText(input.title, 180),
      publishedAt: input.publishedAt, region: cleanBusinessText(input.region, 60), snippet: cleanBusinessText(input.snippet, 500),
      type: input.type === 'unknown' && old?.detailAt ? old.type : input.type, budget: old?.budget ?? null, firstSeenAt: old?.firstSeenAt || now(), seenAt: now() };
    if (revision(row) !== revision(old || {})) {
      row.seq = ++catalog.seq;
      row.changedAt = now();
      if (old) row.previous = { budgetText: old.budgetText, deadlineText: old.deadlineText, type: old.type };
    }
    if (old) Object.assign(old, row); else catalog.items.push(row);
  }
  async function cycle(signal) {
    const catalog = await serial(async () => {
      const value = await load();
      value.lastAttempt = now();
      await shared.put('kv', value);
      return value;
    });
    await Promise.all(sources.map(async source => {
      const old = catalog.sources[source.id] || {};
      try {
        const result = await collector.listing(source, signal);
        signal.throwIfAborted();
        for (const row of result.rows.slice(0, 240)) ingest(catalog, row, source);
        catalog.sources[source.id] = { id: source.id, label: source.label, coverage: source.coverage, at: now(), lastSuccess: now(),
          state: result.partial ? 'partial' : 'ok', count: result.rows.length };
      } catch (error) {
        if (signal.aborted) throw error;
        catalog.sources[source.id] = { ...old, id: source.id, label: source.label, coverage: source.coverage, at: now(), state: 'failed', error: diagnostic(error) };
      }
    }));
    catalog.items = catalog.items.filter(row => retainedTender(row, now())).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.seq - a.seq).slice(0, TENDER_LIMITS.records);
    const watched = new Set();
    for (const id of users()) if (active(id)) {
      const state = await runAsUser(id, readPersonal);
      for (const saved of state.favorites) watched.add(saved);
    }
    // 最多16篇、并发2，复查间隔至少6小时。收藏在90天保留期内继续跟踪；
    // 为新公告和收藏各留8个名额，避免大量关注项目让新公告一直取不到正文。
    const eligible = catalog.items.filter(row => (!row.detailAttemptAt || now() - row.detailAttemptAt >= 6 * 3600_000)
      && (watched.has(row.id) || now() - row.firstSeenAt < 7 * 86400_000)).sort((a, b) => (a.detailAttemptAt || 0) - (b.detailAttemptAt || 0));
    const details = [...eligible.filter(row => watched.has(row.id)).slice(0, 8), ...eligible.filter(row => !watched.has(row.id)).slice(0, 8)];
    for (const row of eligible) { if (details.length >= 16) break; if (!details.includes(row)) details.push(row); }
    await Promise.all([0, 1].map(async lane => {
      for (let index = lane; index < details.length; index += 2) {
        if (signal.aborted) break;
        const row = details[index];
        row.detailAttemptAt = now();
        try {
          const detail = await collector.detail(row, signal);
          signal.throwIfAborted();
          const next = { ...row, ...detail, budget: tenderBudget(detail.budgetText) };
          if (revision(row) !== revision(next)) {
            next.seq = ++catalog.seq;
            next.changedAt = now();
            // 初次补充字段不伪装成原文更正；已经读过正文的变动才有对照。
            if (row.detailAt) next.previous = { budgetText: row.budgetText, deadlineText: row.deadlineText, type: row.type };
          }
          Object.assign(row, next, { detailError: null });
        } catch (error) { row.detailError = diagnostic(error); }
      }
    }));
    if (signal.aborted && stopped) return;
    await serial(async () => {
      // 刷新期间的暂停开关不能被旧快照覆盖；目录与个人数据分开保存。
      catalog.enabled = (await load()).enabled;
      await shared.put('kv', catalog);
      await fanout(catalog);
    });
    return catalog;
  }
  function refresh() {
    if (job) return job;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
    job = cycle(signal).finally(() => { job = null; controller = null; });
    return job;
  }
  async function tick() {
    if (stopped) return;
    try {
      const state = await load();
      if (state.enabled && now() - state.lastAttempt >= TENDER_LIMITS.interval) await refresh();
    } catch { /* 健康页保留上次成功内容；下个有界周期再试，不停止整个入口。 */ }
    if (!stopped) { timer = setTimeout(tick, 60000); timer.unref?.(); }
  }
  return {
    refresh,
    start() { if (!stopped) return; stopped = false; timer = setTimeout(tick, 2000); timer.unref?.(); },
    async stop() { stopped = true; clearTimeout(timer); controller?.abort(); await job?.catch(() => {}); await queue.catch(() => {}); },
    async list(input = {}) {
      const filters = tenderFilters(input), page = Math.max(1, Math.min(250, Math.floor(Number(input.page)) || 1));
      return serial(async () => {
        const catalog = await load(), state = await account(catalog);
        // 公共目录淘汰不删除私人书签；最多100份小快照，明确显示不再自动跟踪。
        const archived = input.favorites === 'true' ? state.favorites.filter(id => !catalog.items.some(row => row.id === id))
          .map(id => state.favoriteSnapshots?.[id]).filter(Boolean).map(row => ({ ...row, archived: true })) : [];
        const items = [...catalog.items, ...archived].filter(row => tenderMatches(row, filters) && (input.favorites !== 'true' || state.favorites.includes(row.id)));
        return { items: items.slice((page - 1) * 20, page * 20).map(row => ({ ...row, favorite: state.favorites.includes(row.id) })), total: items.length, page,
          sources: sources.map(source => catalog.sources[source.id] || { ...source, state: 'pending' }), enabled: catalog.enabled, running: Boolean(job),
          lastAttempt: catalog.lastAttempt, nextRefresh: catalog.enabled ? Math.max(now(), catalog.lastAttempt + TENDER_LIMITS.interval) : null,
          unread: state.alerts.filter(row => !row.read).length, coverage: '仅覆盖已接入公开列表；刷新间隔、来源限流和列表截取可能造成遗漏。预算未知的公告不参与金额筛选。' };
      });
    },
    async mine() { return serial(async () => account(await load())); },
    async notices(after) { const state = await this.mine(); return state.alerts.filter(row => row.at > after && !row.read); },
    async change(body) {
      return serial(async () => {
        const catalog = await load(), state = await account(catalog);
        if (body.action === 'subscribe') {
          const filters = tenderFilters(body.filters);
          if (filters.from || filters.to) throw fail('自动订阅请使用地区、关键词、类型或预算，日期仅用于浏览历史');
          const id = body.id || randomUUID(), old = state.subscriptions.find(row => row.id === id);
          if (body.id && !old) throw fail('订阅不存在', 404);
          if (!old && state.subscriptions.length >= TENDER_LIMITS.subscriptions) throw fail('最多保存20条订阅');
          const row = { id, name: cleanBusinessText(body.name, 50) || filters.query || filters.region || '全部公告', filters,
            enabled: body.enabled !== false, cursor: catalog.seq };
          if (old) Object.assign(old, row); else state.subscriptions.push(row);
        } else if (body.action === 'unsubscribe') {
          state.subscriptions = state.subscriptions.filter(row => row.id !== body.id);
        } else if (body.action === 'favorite') {
          if (body.enabled === false) { state.favorites = state.favorites.filter(id => id !== body.id); delete state.favoriteSnapshots[body.id]; }
          else {
            const row = catalog.items.find(row => row.id === body.id);
            if (!row) throw fail('公告不在当前目录中', 404);
            if (!state.favorites.includes(body.id)) {
              if (state.favorites.length >= TENDER_LIMITS.favorites) throw fail('最多收藏100条公告');
              state.favorites.push(body.id);
              state.favoriteSnapshots[body.id] = { ...row };
            }
          }
        } else if (body.action === 'read') {
          for (const row of state.alerts) if (!body.id || row.id === body.id) row.read = true;
        } else throw fail('不支持此操作');
        await personal.put('kv', state);
        return state;
      });
    },
    async configure(enabled) { return serial(async () => { const state = await load(); state.enabled = enabled; await shared.put('kv', state); return { enabled }; }); }
  };
}

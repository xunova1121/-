import { loadServerSettings, normalizeUrl } from '../core/serverClient.js';

export const MAX_WORKSHOP_SOURCES = 50;
const SYNC_KEY = 'jarvis.workshopTv.sync.v1:';
const CUSTOM_ID = /^custom-[a-z0-9-]{1,72}$/;

function cleanIds(list, limit = MAX_WORKSHOP_SOURCES) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const id of list) {
    if (typeof id === 'string' && CUSTOM_ID.test(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function createWorkshopChannelSync({
  sourcePrefix, hiddenPrefix, builtinIds, getScope, readCustom, readHiddenIds,
  getSelectedId, setSelectedId, onApplied, onModeChanged
}) {
  let remoteClient = null;
  let inFlight = null;
  let queued = false;
  let editSeq = 0;
  let hiddenSeq = 0;
  // 最多保留128项本机编辑代数，防止慢请求返回时覆盖刚点的本地操作。
  const itemSeq = new Map();
  const unsupported = new WeakSet();

  function bumpItem(scope, id) {
    const key = scope + '/' + id;
    if (itemSeq.size >= 128 && !itemSeq.has(key)) itemSeq.delete(itemSeq.keys().next().value);
    itemSeq.set(key, ++editSeq);
  }

  function activeClient() {
    if (!remoteClient) return null;
    try {
      const settings = loadServerSettings();
      if (!settings.enabled || !settings.url || normalizeUrl(settings.url) !== normalizeUrl(remoteClient.base)) return null;
      return remoteClient;
    } catch { return null; }
  }

  function hasMeta(scope) {
    try { return globalThis.localStorage?.getItem(SYNC_KEY + scope) != null; }
    catch { return false; }
  }

  function readMeta(scope) {
    try {
      const raw = JSON.parse(globalThis.localStorage?.getItem(SYNC_KEY + scope) || 'null');
      if (!raw || typeof raw !== 'object') return { synced: [], upserts: [], removed: [], hiddenDirty: false, hiddenInit: false };
      return {
        synced: cleanIds(raw.synced),
        upserts: cleanIds(raw.upserts),
        removed: cleanIds(raw.removed, MAX_WORKSHOP_SOURCES * 2),
        hiddenDirty: raw.hiddenDirty === true,
        hiddenInit: raw.hiddenInit === true
      };
    } catch {
      return { synced: [], upserts: [], removed: [], hiddenDirty: false, hiddenInit: false };
    }
  }

  function writeMeta(scope, meta) {
    try {
      globalThis.localStorage?.setItem(SYNC_KEY + scope, JSON.stringify({
        synced: cleanIds(meta.synced),
        upserts: cleanIds(meta.upserts),
        removed: cleanIds(meta.removed, MAX_WORKSHOP_SOURCES * 2),
        hiddenDirty: Boolean(meta.hiddenDirty),
        hiddenInit: Boolean(meta.hiddenInit)
      }));
    } catch { /* 本地存储受限时仅保持内存运行，不影响正常播放。 */ }
  }

  function shouldTrack(scope) {
    return scope.startsWith('server:') && (Boolean(activeClient()) || hasMeta(scope));
  }

  function recordSave(scope, id) {
    if (!shouldTrack(scope)) return;
    const meta = readMeta(scope);
    meta.upserts = cleanIds([...meta.upserts.filter(x => x !== id), id]);
    meta.removed = meta.removed.filter(x => x !== id);
    writeMeta(scope, meta);
    bumpItem(scope, id);
    if (activeClient()) void sync();
  }

  function recordRemove(scope, id) {
    if (!shouldTrack(scope)) return;
    const meta = readMeta(scope);
    const needRemoteDelete = meta.synced.includes(id) || Boolean(activeClient());
    meta.upserts = meta.upserts.filter(x => x !== id);
    if (needRemoteDelete) meta.removed = cleanIds([...meta.removed.filter(x => x !== id), id], MAX_WORKSHOP_SOURCES * 2);
    writeMeta(scope, meta);
    bumpItem(scope, id);
    if (activeClient()) void sync();
  }

  function recordHidden(scope) {
    if (!shouldTrack(scope)) return;
    const meta = readMeta(scope);
    meta.hiddenDirty = true;
    meta.hiddenInit = true;
    writeMeta(scope, meta);
    hiddenSeq = ++editSeq;
    if (activeClient()) void sync();
  }

  function applyCatalog(scope, sentSeq, result) {
    const storage = globalThis.localStorage;
    if (!storage || !result || !Array.isArray(result.sources)) return;
    const stillDirty = id => (itemSeq.get(scope + '/' + id) || 0) > sentSeq;
    const beforeSnapshot = JSON.stringify({ custom: readCustom(), hidden: readHiddenIds() });
    const previous = onApplied.current();
    const merged = result.merged && typeof result.merged === 'object' ? result.merged : {};
    const selected = getSelectedId(scope);
    if (selected && typeof merged[selected] === 'string' && CUSTOM_ID.test(merged[selected])) {
      setSelectedId(scope, merged[selected]);
    }
    const effectivePrevious = previous && typeof merged[previous.id] === 'string' && CUSTOM_ID.test(merged[previous.id])
      ? { ...previous, id: merged[previous.id] }
      : previous;
    const serverMap = new Map();
    for (const item of result.sources) {
      if (item && CUSTOM_ID.test(item.id || '') && serverMap.size < MAX_WORKSHOP_SOURCES) serverMap.set(item.id, item);
    }
    const prefix = sourcePrefix + scope + '/';
    const existingIds = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) existingIds.push(key.slice(prefix.length));
    }
    try {
      for (const id of existingIds) {
        if (!stillDirty(id) && !serverMap.has(id)) storage.removeItem(prefix + id);
      }
      for (const [id, entry] of serverMap) {
        if (!stillDirty(id)) {
          storage.setItem(prefix + id, JSON.stringify({ name: entry.name, url: entry.url, format: entry.format }));
        }
      }
      if (hiddenSeq <= sentSeq && Array.isArray(result.hidden)) {
        const hiddenSet = new Set(result.hidden);
        const hPrefix = hiddenPrefix + scope + '/';
        for (const id of builtinIds) {
          if (hiddenSet.has(id)) storage.setItem(hPrefix + id, '1');
          else storage.removeItem(hPrefix + id);
        }
      }
    } catch { return; }

    const fresh = readMeta(scope);
    writeMeta(scope, {
      synced: [...serverMap.keys()].filter(id => !(stillDirty(id) && fresh.removed.includes(id))),
      upserts: fresh.upserts.filter(stillDirty),
      removed: fresh.removed.filter(stillDirty),
      hiddenDirty: hiddenSeq > sentSeq ? fresh.hiddenDirty : false,
      hiddenInit: true
    });
    const afterSnapshot = JSON.stringify({ custom: readCustom(), hidden: readHiddenIds() });
    const nextCurrent = onApplied.current();
    if (beforeSnapshot !== afterSnapshot || effectivePrevious?.id !== nextCurrent?.id) {
      const updatedInPlace = Boolean(nextCurrent && effectivePrevious?.id === nextCurrent.id && JSON.stringify(previous) !== JSON.stringify(nextCurrent));
      onApplied.notify(effectivePrevious, updatedInPlace);
    }
  }

  async function runOnce(signal) {
    const client = activeClient();
    const scope = getScope();
    if (!client || unsupported.has(client) || !scope.startsWith('server:')) return false;
    const sentSeq = editSeq;
    const meta = readMeta(scope);
    const custom = readCustom();
    const hidden = readHiddenIds();
    const syncedSet = new Set(meta.synced);
    const upsertSet = new Set(meta.upserts);
    const upsert = custom
      .filter(ch => upsertSet.has(ch.id) || !syncedSet.has(ch.id))
      .slice(0, MAX_WORKSHOP_SOURCES)
      .map(ch => ({ id: ch.id, name: ch.title, url: ch.source.url, format: ch.source.format }));
    const remove = meta.removed;
    const hasChanges = upsert.length > 0 || remove.length > 0 || meta.hiddenDirty || (!meta.hiddenInit && hidden.length > 0);
    try {
      const result = hasChanges
        ? await client.syncWorkshopTvSources({
          upsert,
          remove,
          ...(meta.hiddenDirty ? { hidden } : !meta.hiddenInit && hidden.length ? { initHidden: hidden } : {})
        }, signal)
        : await client.workshopTvSources(signal);
      if (client !== activeClient() || scope !== getScope()) return false;
      applyCatalog(scope, sentSeq, result);
      return true;
    } catch (error) {
      if (error?.status === 404 && client === activeClient()) {
        unsupported.add(client);
        onModeChanged();
      }
      return false;
    }
  }

  function sync(signal) {
    const client = activeClient();
    if (!client || unsupported.has(client)) return Promise.resolve(false);
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    const startSeq = editSeq;
    inFlight = (async () => {
      const ok = await runOnce(signal);
      while (queued || editSeq > startSeq && activeClient() && !unsupported.has(activeClient())) {
        const loopSeq = editSeq;
        queued = false;
        const again = await runOnce(signal);
        if (!again || editSeq === loopSeq) break;
      }
      return ok;
    })().finally(() => {
      inFlight = null;
      queued = false;
    });
    return inFlight;
  }

  return {
    setRemote(next) {
      remoteClient = next || null;
      queued = false;
    },
    mode() {
      const client = activeClient();
      if (!client) return 'local';
      return unsupported.has(client) ? 'server-legacy' : 'server';
    },
    recordSave,
    recordRemove,
    recordHidden,
    sync,
    syncKeyPrefix: SYNC_KEY
  };
}

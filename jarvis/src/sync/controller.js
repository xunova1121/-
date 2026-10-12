/**
 * 同步的设置与调度：保存 OSS 配置、选择网络通道、定时自动同步。
 * OSS 配置和同步密码只存在这台设备上（localStorage），不会跟着同步走。
 */
import { createOss, gatewayTransport, directTransport, normalizeEndpoint, validBucket } from './oss.js';
import { createSync, GROUPS } from './engine.js';
import { memorySource, sessionsSource, configSource } from './sources.js';
import { collection } from '../agent/store.js';

const KEY = 'jarvis.sync.v1';
const AUTO_EVERY_MS = 5 * 60_000;
export const DEFAULT_SYNC = {
  enabled: false, endpoint: '', bucket: '', accessKeyId: '', accessKeySecret: '', passphrase: '',
  groups: { memory: true, sessions: true, config: true }, auto: true, lastSync: 0, lastError: ''
};
export { GROUPS };

export function loadSyncSettings(storage) {
  let s = {};
  try { s = JSON.parse(storage?.getItem(KEY) || '{}') || {}; } catch { /* 损坏时用默认 */ }
  return { ...DEFAULT_SYNC, ...s, groups: { ...DEFAULT_SYNC.groups, ...(s.groups || {}) } };
}
export function saveSyncSettings(storage, s) {
  try { storage?.setItem(KEY, JSON.stringify(s)); } catch { /* 存储不可用 */ }
}

/** 填写是否完整；返回问题描述或空字符串 */
export function problemOf(s) {
  if (!s.endpoint) return '请填写 OSS 地域（如 oss-cn-hangzhou）';
  try { normalizeEndpoint(s.endpoint); } catch (e) { return e.message; }
  if (!validBucket(s.bucket)) return 'Bucket 名称不对（小写字母、数字、短横线，3–63 位）';
  if (!s.accessKeyId || !s.accessKeySecret) return '请填写 AccessKey ID 和 Secret';
  if (!s.passphrase || s.passphrase.length < 6) return '请设置同步密码（至少 6 位，所有设备要一样）';
  return '';
}

/**
 * @param {{ storage, getGateway: () => object|null, loadConfig, saveConfig, beforeSync?: Function, afterSync?: Function, onState?: Function, coll?: Function }} d
 */
export function createSyncController({ storage, getGateway, loadConfig, saveConfig, beforeSync, afterSync, onState, coll = collection }) {
  let settings = loadSyncSettings(storage);
  let timer = 0;
  const kv = coll('kv');

  function transport() {
    if (globalThis.__jarvisNativeFetch) return directTransport(globalThis.__jarvisNativeFetch); // 安卓 App
    const gw = getGateway();
    if (gw && gw.origin === location.origin) return gatewayTransport(gw.origin);
    throw new Error('网页单文件版不能同步：请用桌面版、完整版（双击 启动.bat）或手机 App');
  }

  const target = (s) => `${s.bucket}.${normalizeEndpoint(s.endpoint)}`;

  async function run({ manual = false } = {}) {
    const s = settings;
    const problem = problemOf(s);
    if (problem) throw new Error(problem);
    const groups = Object.keys(GROUPS).filter((g) => s.groups[g]);
    if (!groups.length) throw new Error('请至少选一类要同步的数据');
    onState?.({ state: 'syncing' });
    try {
      await beforeSync?.();
      const oss = createOss(s, { transport: transport() });
      const where = target(s);
      const sync = createSync({
        oss,
        passphrase: s.passphrase,
        sources: { memory: memorySource({ coll }), sessions: sessionsSource({ coll }), config: configSource({ load: loadConfig, save: saveConfig }) },
        // 记住的指纹和云端位置绑定：换了 Bucket 就从头合并
        baseStore: {
          get: async () => { const b = await kv.get('sync.base'); return b?.target === where ? b.groups : {}; },
          set: async (groupsBase) => { await kv.put({ id: 'sync.base', target: where, groups: groupsBase }); }
        }
      });
      const result = await sync.run(groups);
      update({ lastSync: Date.now(), lastError: '' });
      onState?.({ state: 'done', result, manual });
      await afterSync?.(result);
      return result;
    } catch (e) {
      update({ lastError: String(e.message || e).slice(0, 200) });
      onState?.({ state: 'error', error: e.message, manual });
      throw e;
    }
  }

  function update(patch) {
    settings = { ...settings, ...patch, groups: { ...settings.groups, ...(patch.groups || {}) } };
    saveSyncSettings(storage, settings);
    schedule();
    return settings;
  }

  let lastAuto = 0;
  const auto = () => {
    if (!settings.enabled || !settings.auto || problemOf(settings) || Date.now() - lastAuto < 60_000) return;
    lastAuto = Date.now();
    run().catch(() => {}); // 错误显示在设置里
  };
  function schedule() {
    clearInterval(timer);
    if (settings.enabled && settings.auto) timer = setInterval(auto, AUTO_EVERY_MS);
  }

  return {
    get settings() { return settings; },
    update,
    run,
    /** 启动时同步一次；切到后台时（手机上常见）再同步一次 */
    start() {
      schedule();
      setTimeout(auto, 8000);
      globalThis.document?.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') auto(); else if (Date.now() - lastAuto > AUTO_EVERY_MS) auto(); });
    }
  };
}

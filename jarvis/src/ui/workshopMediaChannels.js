import { WORKSHOP_TV_CHANNELS } from '../../shared/workshopTv.js';
import { workshopPublicChannels } from '../../shared/workshopPublicTv.js';
import { parseWorkshopVideoSource } from '../../shared/workshopVideoSource.js';
import { userStorageSuffix } from '../core/userStorage.js';
import { loadServerSettings, normalizeUrl } from '../core/serverClient.js';

const STORAGE_KEY = 'jarvis.workshopTv.channel.v1';
const SOURCE_KEY = 'jarvis.workshopTv.source.v1:';
const HIDDEN_KEY = 'jarvis.workshopTv.hidden.v1:';
export const workshopChannels = WORKSHOP_TV_CHANNELS.map(channel => ({
  id: channel.id, title: channel.label, label: channel.name, number: channel.id.slice(4), url: channel.url, kind: 'cctv'
}));
const builtins = [...workshopPublicChannels, ...workshopChannels];
const temporaryChoice = new Map();
const subscribers = new Set();
const listSubscribers = new Set();

export function workshopChannelScope() {
  try {
    const settings = loadServerSettings();
    const location = settings.enabled && settings.url ? 'server:' + encodeURIComponent(normalizeUrl(settings.url)) : 'local';
    return location + userStorageSuffix();
  } catch { return 'local'; }
}

export function normalizeWorkshopSource({ name, url, format } = {}) {
  const title = typeof name === 'string' ? name.trim() : '';
  if (!title || [...title].length > 40 || /[\r\n\t]/u.test(title)) throw new Error('请输入 1 到 40 个字的频道名称。');
  return { id: 'preview', title, label: title, number: '', url: '', kind: 'custom', source: parseWorkshopVideoSource(url, format) };
}

function storedChannel(id, storage, prefix) {
  if (!/^custom-[a-z0-9-]{1,72}$/.test(id)) return null;
  try {
    const entry = JSON.parse(storage.getItem(prefix + id));
    return { ...normalizeWorkshopSource(entry), id };
  } catch { return null; }
}

export function getWorkshopCustomChannels() {
  const channels = [];
  const prefix = SOURCE_KEY + workshopChannelScope() + '/';
  try {
    const storage = globalThis.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const channel = storedChannel(key.slice(prefix.length), storage, prefix);
      if (channel) channels.push(channel);
    }
  } catch { /* 浏览器禁用存储时仍可收看内置频道。 */ }
  return channels.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
}

export function removedWorkshopChannels() {
  const prefix = HIDDEN_KEY + workshopChannelScope() + '/';
  try { return builtins.filter(ch => globalThis.localStorage?.getItem(prefix + ch.id) === '1'); }
  catch { return []; }
}

export function listWorkshopChannels() {
  const removed = removedWorkshopChannels();
  return [...builtins.filter(ch => !removed.includes(ch)), ...getWorkshopCustomChannels()];
}

function choiceId(scope) {
  if (temporaryChoice.has(scope)) return temporaryChoice.get(scope);
  try {
    const storage = globalThis.localStorage;
    const selected = storage?.getItem(STORAGE_KEY + ':' + scope);
    if (selected != null) return selected;
    // 老版本只保存央视槽号。允许继承这些公共偏好，后续私有频道只认自己的作用域。
    const legacy = storage?.getItem(STORAGE_KEY);
    return workshopChannels.find(ch => ch.id === legacy)?.id;
  } catch { return null; }
}

export function workshopChannel() {
  const id = choiceId(workshopChannelScope());
  const channels = listWorkshopChannels();
  return channels.find(ch => ch.id === id) || channels[0] || null;
}

function rememberChoice(channel) {
  const scope = workshopChannelScope();
  const id = channel?.id || '';
  try {
    globalThis.localStorage.setItem(STORAGE_KEY + ':' + scope, id);
    temporaryChoice.delete(scope);
  } catch { temporaryChoice.set(scope, id); }
}

function publishChoice(channel) {
  rememberChoice(channel);
  for (const notify of subscribers) notify(channel);
  return channel;
}

const compactName = name => name.replace(/[\s-]/gu, '').toLowerCase();
function matchesName(channel, key) {
  const names = [channel.id, channel.title, channel.label];
  if (channel.kind === 'cctv') names.push(channel.number, channel.id + channel.title, '央视' + channel.title, '央视' + channel.number);
  return names.some(name => compactName(name) === key);
}

export function selectWorkshopChannel(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const channels = listWorkshopChannels();
  const text = String(input).trim();
  const phrase = text.replace(/^(?:请)?(?:把电视)?(?:切换|切|换|调|转)(?:一下)?(?:到|成|至)?/u, '').replace(/[吧。！!]+$/u, '');
  // 先按全称匹配，避免把自定义名称末尾的“台”或“频道”裁掉。
  const keys = [text, phrase, phrase.replace(/(?:频道|台)$/u, '')];
  for (const value of keys) {
    const key = compactName(value);
    const channel = channels.find(ch => matchesName(ch, key));
    if (channel) return publishChoice(channel);
  }
  return null;
}

export function saveWorkshopSource({ id, name, url, format } = {}) {
  const channel = normalizeWorkshopSource({ name, url, format });
  const channels = [...builtins, ...getWorkshopCustomChannels()];
  if (id != null && !channels.some(ch => ch.kind === 'custom' && ch.id === id)) throw new Error('这个自定义频道已不存在。');
  if (channels.some(ch => ch.id !== id && matchesName(ch, compactName(channel.title)))) throw new Error('此频道名称已被使用。');
  channel.id = id || 'custom-' + (globalThis.crypto?.randomUUID?.() ?? (Date.now().toString(36) + Math.random().toString(36).slice(2)));
  const scope = workshopChannelScope();
  const selected = choiceId(scope) === channel.id;
  try {
    // 每个频道独立落盘，两个标签页同时添加不同频道时不会覆盖整个列表。
    globalThis.localStorage.setItem(SOURCE_KEY + scope + '/' + channel.id, JSON.stringify({
      name: channel.title, url: channel.source.url, format: channel.source.format
    }));
  } catch { throw new Error('此设备未能保存频道，请检查浏览器的存储权限或可用空间。'); }
  for (const notify of listSubscribers) notify();
  if (selected) for (const notify of subscribers) notify(channel);
  return channel;
}

export function removeWorkshopSource(id) {
  if (!getWorkshopCustomChannels().some(ch => ch.id === id)) return false;
  const scope = workshopChannelScope();
  const previous = workshopChannel();
  try { globalThis.localStorage.removeItem(SOURCE_KEY + scope + '/' + id); }
  catch { throw new Error('此设备未能删除频道，请检查浏览器的存储权限。'); }
  catalogChanged(previous);
  return true;
}

function catalogChanged(previous) {
  const channels = listWorkshopChannels();
  const current = channels.find(ch => ch.id === previous?.id) || channels[0] || null;
  const changed = previous?.id !== current?.id;
  // 记住仍在播放的频道，恢复排在它前面的预置频道时不会抢台。
  if (changed || current?.id !== workshopChannel()?.id) rememberChoice(current);
  for (const notify of listSubscribers) notify();
  if (changed) for (const notify of subscribers) notify(current, { catalogChanged: true });
}

export function setWorkshopBuiltinVisible(id, visible) {
  const builtin = builtins.find(ch => ch.id === id);
  if (!builtin) return false;
  const alreadyVisible = !removedWorkshopChannels().includes(builtin);
  if (alreadyVisible === visible) return false;
  const previous = workshopChannel();
  const key = HIDDEN_KEY + workshopChannelScope() + '/' + id;
  try {
    if (visible) globalThis.localStorage.removeItem(key);
    else globalThis.localStorage.setItem(key, '1');
  } catch { throw new Error('此设备未能保存频道设置，请检查浏览器的存储权限。'); }
  catalogChanged(previous);
  return true;
}

export function onWorkshopChannel(notify) {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

export function onWorkshopChannelListChanged(notify) {
  listSubscribers.add(notify);
  const storageChanged = event => {
    const scope = workshopChannelScope();
    if (event.key === null || event.key === 'jarvis.server.v1' || event.key === STORAGE_KEY + ':' + scope ||
        event.key?.startsWith(SOURCE_KEY + scope + '/') || event.key?.startsWith(HIDDEN_KEY + scope + '/')) notify();
  };
  globalThis.addEventListener?.('storage', storageChanged);
  return () => {
    listSubscribers.delete(notify);
    globalThis.removeEventListener?.('storage', storageChanged);
  };
}

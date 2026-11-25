import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getWorkshopCustomChannels, listWorkshopChannels, normalizeWorkshopSource, onWorkshopChannel, onWorkshopChannelListChanged,
  removedWorkshopChannels, removeWorkshopSource, saveWorkshopSource, selectWorkshopChannel, setWorkshopBuiltinVisible, workshopChannel } from '../src/ui/workshopMediaChannels.js';

const source = { name: '我的直播台', url: 'https://media.example/live/main.m3u8?token=a%2Bb' };
const listeners = [];
let storage;

beforeEach(() => {
  const items = new Map();
  storage = {
    get length() { return items.size; },
    key: index => Array.from(items.keys())[index] ?? null,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: key => items.delete(key)
  };
  vi.stubGlobal('localStorage', storage);
});
afterEach(() => {
  for (const unsubscribe of listeners.splice(0)) unsubscribe();
  vi.unstubAllGlobals();
});

it('首次打开选中电影实播，保留两个演示和老设备的央视台号，受损或外来的旧 ID 不移入', () => {
  expect(workshopChannel()).toMatchObject({ id: 'retrostrange-tv', kind: 'public', source: { format: 'hls' } });
  const publicEntries = listWorkshopChannels().filter(ch => ch.kind === 'public');
  expect(publicEntries.slice(1).map(ch => ch.id)).toEqual(['ireplay-blender', 'unified-live']);
  for (const entry of publicEntries) {
    expect(entry.source.url).toMatch(/^https:\/\/.+\.m3u8$/);
    expect(entry.url).toMatch(/^https:\/\//);
  }
  storage.setItem('jarvis.workshopTv.channel.v1', 'cctv2');
  expect(workshopChannel().id).toBe('cctv2');
  storage.setItem('jarvis.workshopTv.channel.v1', 'custom-foreign');
  expect(workshopChannel().kind).toBe('public');
});

it('试播不写入设置，保存后另一次加载可恢复选择与签名 URL，改名和换 URL 保持 ID', async () => {
  expect(normalizeWorkshopSource(source)).toMatchObject({ id: 'preview', source: { url: source.url, format: 'hls' } });
  expect(storage.length).toBe(0);
  const observeList = vi.fn(), observeChannel = vi.fn();
  listeners.push(onWorkshopChannelListChanged(observeList), onWorkshopChannel(observeChannel));
  const saved = saveWorkshopSource(source);
  expect(saved.id).toMatch(/^custom-/);
  expect(observeChannel).not.toHaveBeenCalled();
  expect(selectWorkshopChannel('请切换到我的直播台').id).toBe(saved.id);
  vi.resetModules();
  const reloaded = await import('../src/ui/workshopMediaChannels.js');
  expect(reloaded.workshopChannel()).toEqual(saved);
  const edited = saveWorkshopSource({ id: saved.id, name: '演播室', url: 'https://media.example/new.webm' });
  expect(edited).toMatchObject({ id: saved.id, title: '演播室', source: { format: 'video' } });
  expect(workshopChannel()).toEqual(edited);
  expect(reloaded.getWorkshopCustomChannels()).toEqual([edited]);
  expect(observeList).toHaveBeenCalledTimes(2);
  expect(observeChannel).toHaveBeenLastCalledWith(edited);
});

it('独立移除未选频道不换台，移除正播频道回到默认源，不允许改写或误删内置台', () => {
  const first = saveWorkshopSource(source);
  const second = saveWorkshopSource({ ...source, name: '备选' });
  selectWorkshopChannel(first.id);
  const observer = vi.fn();
  listeners.push(onWorkshopChannel(observer));
  expect(removeWorkshopSource(second.id)).toBe(true);
  expect(workshopChannel().id).toBe(first.id);
  expect(observer).not.toHaveBeenCalled();
  expect(removeWorkshopSource(second.id)).toBe(false);
  expect(removeWorkshopSource('cctv1')).toBe(false);
  expect(() => saveWorkshopSource({ ...source, id: 'ireplay-blender' })).toThrow();
  expect(removeWorkshopSource(first.id)).toBe(true);
  expect(workshopChannel().id).toBe('retrostrange-tv');
  expect(observer).toHaveBeenCalledOnce();
});

it('默认电影、演示、央视均可逐台移除；清空后重载仍停播，恢复频道不抢台', async () => {
  const original = listWorkshopChannels();
  for (const channel of original) {
    expect(workshopChannel().id).toBe(channel.id);
    expect(setWorkshopBuiltinVisible(channel.id, false)).toBe(true);
    expect(selectWorkshopChannel(channel.label)).toBeNull();
  }
  expect(workshopChannel()).toBeNull();
  expect(removedWorkshopChannels()).toEqual(original);
  vi.resetModules();
  expect((await import('../src/ui/workshopMediaChannels.js')).workshopChannel()).toBeNull();
  expect(setWorkshopBuiltinVisible('cctv9', true)).toBe(true);
  expect(workshopChannel().id).toBe('cctv9');
  expect(setWorkshopBuiltinVisible(original[0].id, true)).toBe(true);
  expect(workshopChannel().id).toBe('cctv9');
  expect(setWorkshopBuiltinVisible(original[0].id, true)).toBe(false);
  expect(() => saveWorkshopSource({ ...source, name: '央视1' })).toThrow();
});

it('默认台的移除记录依本机、服务器及使用者隔离，选中的个人频道也能删到空', () => {
  const builtins = listWorkshopChannels();
  const saved = saveWorkshopSource(source);
  selectWorkshopChannel(saved.id);
  for (const channel of builtins) setWorkshopBuiltinVisible(channel.id, false);
  expect(listWorkshopChannels()).toEqual([saved]);
  expect(removeWorkshopSource(saved.id)).toBe(true);
  expect(workshopChannel()).toBeNull();
  const switchTo = (url, user) => storage.setItem('jarvis.server.v1', JSON.stringify({ url, enabled: true, userId: 'u_' + user.repeat(24) }));
  switchTo('https://one.example', 'a');
  expect(listWorkshopChannels()).toEqual(builtins);
  setWorkshopBuiltinVisible('cctv1', false);
  switchTo('https://one.example', 'b');
  expect(removedWorkshopChannels()).toEqual([]);
  switchTo('https://two.example', 'a');
  expect(removedWorkshopChannels()).toEqual([]);
  switchTo('https://one.example', 'a');
  expect(removedWorkshopChannels().map(ch => ch.id)).toEqual(['cctv1']);
  storage.removeItem('jarvis.server.v1');
  expect(workshopChannel()).toBeNull();
});

it('本机、不同服务器、同机成员的频道和最后选择互相隔离', () => {
  const local = saveWorkshopSource(source);
  selectWorkshopChannel(local.id);
  function switchTo(url, user, enabled = true) {
    storage.setItem('jarvis.server.v1', JSON.stringify({ url, userId: 'u_' + user.repeat(24), enabled }));
  }
  switchTo('https://one.example', 'a');
  expect(getWorkshopCustomChannels()).toEqual([]);
  const remote = saveWorkshopSource(source);
  selectWorkshopChannel(remote.id);
  switchTo('https://two.example', 'a');
  expect(getWorkshopCustomChannels()).toEqual([]);
  switchTo('https://one.example', 'b');
  expect(workshopChannel().kind).toBe('public');
  expect(removeWorkshopSource(remote.id)).toBe(false);
  expect(() => saveWorkshopSource({ ...source, id: remote.id })).toThrow();
  switchTo('https://one.example', 'a', false);
  expect(getWorkshopCustomChannels()).toEqual([]);
  switchTo('https://one.example', 'a');
  expect(workshopChannel().id).toBe(remote.id);
  storage.removeItem('jarvis.server.v1');
  expect(workshopChannel().id).toBe(local.id);
});

it('只交给播放器 HTTP(S) 直链，保留自定义端口、大小写后缀和无后缀的实际视频', () => {
  // 2026-11-25 用户要求 http 的 m3u8 也能播：原断言“http 直链被拒”改为“http 直链被接受”，其余非法地址仍全部拒绝
  expect(normalizeWorkshopSource({ ...source, url: 'http://media.example/v.m3u8' }).source).toMatchObject({ url: 'http://media.example/v.m3u8', format: 'hls' });
  expect(normalizeWorkshopSource({ ...source, url: 'http://192.168.1.8:8080/live/index.m3u8' }).source.format).toBe('hls');
  for (const url of ['http:media.example', 'http://u:p@media.example/v.m3u8', 'ftp://media.example/v.m3u8', 'https:media.example', 'https://u:p@media.example/v.m3u8',
    'javascript:alert(1)', 'file:///x.mp4', 'https://media.example/player.html', 'https://media.example/list.m3u']) {
    expect(() => saveWorkshopSource({ ...source, url })).toThrow();
  }
  for (const name of ['', '字'.repeat(41), 'CCTV-1', '央视1']) expect(() => saveWorkshopSource({ ...source, name })).toThrow();
  expect(() => normalizeWorkshopSource({ ...source, format: 'embed' })).toThrow();
  expect(normalizeWorkshopSource({ ...source, url: 'https://media.example:8443/v.M3U8' }).source.format).toBe('hls');
  expect(normalizeWorkshopSource({ ...source, url: 'https://media.example/watch?id=1', format: 'video' }).source.format).toBe('video');
  saveWorkshopSource(source);
  expect(() => saveWorkshopSource({ ...source, name: '  我的直播台  ' })).toThrow();
  expect(getWorkshopCustomChannels()).toHaveLength(1);
});

it('损坏的本地条目不会被当作播放源，存储写入失败不报告保存成功', () => {
  const active = saveWorkshopSource(source);
  const key = storage.key(0);
  storage.setItem(key, JSON.stringify({ name: '失效', url: 'javascript:alert(1)' }));
  expect(getWorkshopCustomChannels()).toEqual([]);
  expect(selectWorkshopChannel(active.id)).toBeNull();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  expect(() => saveWorkshopSource(source)).toThrow(/未能保存/);
  expect(getWorkshopCustomChannels()).toEqual([]);
});

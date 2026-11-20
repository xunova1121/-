import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getWorkshopCustomChannels, listWorkshopChannels, normalizeWorkshopSource, onWorkshopChannel, onWorkshopChannelListChanged,
  removeWorkshopSource, saveWorkshopSource, selectWorkshopChannel, workshopChannel } from '../src/ui/workshopMediaChannels.js';

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

it('只交给播放器 HTTPS 直链，保留自定义端口、大小写后缀和无后缀的实际视频', () => {
  for (const url of ['http://media.example/v.m3u8', 'https:media.example', 'https://u:p@media.example/v.m3u8',
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

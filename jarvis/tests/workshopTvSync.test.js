import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../server/server.mjs';
import { createServerMode } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';
import { createServerClient } from '../src/core/serverClient.js';
import {
  getWorkshopCustomChannels,
  listWorkshopChannels,
  MAX_WORKSHOP_SOURCES,
  removedWorkshopChannels,
  removeWorkshopSource,
  saveWorkshopSource,
  selectWorkshopChannel,
  setWorkshopBuiltinVisible,
  syncWorkshopChannels,
  useWorkshopChannelRemote,
  workshopChannel,
  workshopChannelSyncMode
} from '../src/ui/workshopMediaChannels.js';

function makeMemoryStorage() {
  const items = new Map();
  return {
    get length() { return items.size; },
    key: index => Array.from(items.keys())[index] ?? null,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: key => items.delete(key)
  };
}

describe('小窝电视视频源跨手机与电脑云服务器同步', () => {
  const cleanups = [];

  beforeEach(() => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    useWorkshopChannelRemote(null);
  });

  afterEach(async () => {
    useWorkshopChannelRemote(null);
    vi.unstubAllGlobals();
    while (cleanups.length) await cleanups.pop()();
  });

  async function startCloudServer() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-tv-sync-'));
    const serverMode = createServerMode({ dataDir, password: 'test-password-123' });
    await serverMode.ready;
    const httpServer = createServer({ serverMode, ollama: null });
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    cleanups.push(async () => {
      httpServer.closeAllConnections();
      await new Promise(resolve => httpServer.close(resolve));
      useBackend(null);
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    return { base };
  }

  function activateDevice(storage, base, account) {
    vi.stubGlobal('localStorage', storage);
    storage.setItem('jarvis.server.v1', JSON.stringify({
      url: base,
      token: account.token,
      enabled: true,
      ...(account.userId && { userId: account.userId, role: account.role })
    }));
    const client = createServerClient({ base, token: account.token });
    useWorkshopChannelRemote(client);
    return client;
  }

  it('手机添加和隐藏的频道在电脑登录同一云账号后自动同步，各自选台互不抢占', async () => {
    const { base } = await startCloudServer();
    const phoneStorage = makeMemoryStorage();
    const pcStorage = makeMemoryStorage();

    vi.stubGlobal('localStorage', phoneStorage);
    const bootstrap = createServerClient({ base });
    const owner = await bootstrap.loginAccount('test-password-123');

    // 手机端添加 HTTP 与 HTTPS 两个 M3U8 直播源，并隐藏一个默认演示台
    activateDevice(phoneStorage, base, owner);
    expect(workshopChannelSyncMode()).toBe('server');
    const cctv2 = saveWorkshopSource({ name: 'CCTV2', url: 'http://live.example/cctv2.m3u8' });
    const movie = saveWorkshopSource({ name: '夜间剧场', url: 'https://cdn.example/movie.m3u8' });
    selectWorkshopChannel(cctv2.id);
    setWorkshopBuiltinVisible('ireplay-blender', false);
    await syncWorkshopChannels();

    // 电脑端登录同一账号后同步：拿到手机添加的两个频道和隐藏记录，但电脑保持自己的当前选台
    activateDevice(pcStorage, base, owner);
    await syncWorkshopChannels();
    expect(getWorkshopCustomChannels().map(ch => ({ id: ch.id, title: ch.title, url: ch.source.url }))).toEqual([
      { id: movie.id, title: '夜间剧场', url: 'https://cdn.example/movie.m3u8' },
      { id: cctv2.id, title: 'CCTV2', url: 'http://live.example/cctv2.m3u8' }
    ]);
    expect(removedWorkshopChannels().map(ch => ch.id)).toEqual(['ireplay-blender']);
    expect(workshopChannel().id).toBe('retrostrange-tv');

    // 电脑端修改 CCTV2 地址并删除夜间剧场，手机端回到前台同步后随之更新
    saveWorkshopSource({ id: cctv2.id, name: 'CCTV2 高清', url: 'http://live.example/cctv2-hd.m3u8' });
    removeWorkshopSource(movie.id);
    await syncWorkshopChannels();

    activateDevice(phoneStorage, base, owner);
    await syncWorkshopChannels();
    expect(getWorkshopCustomChannels().map(ch => ({ id: ch.id, title: ch.title, url: ch.source.url }))).toEqual([
      { id: cctv2.id, title: 'CCTV2 高清', url: 'http://live.example/cctv2-hd.m3u8' }
    ]);
    expect(workshopChannel()).toMatchObject({
      id: cctv2.id,
      title: 'CCTV2 高清',
      source: { url: 'http://live.example/cctv2-hd.m3u8' }
    });
  });

  it('升级前手机和电脑各自已存的本机频道首次连云时自动合并去重，不丢任一端地址', async () => {
    const { base } = await startCloudServer();
    const phoneStorage = makeMemoryStorage();
    const pcStorage = makeMemoryStorage();

    vi.stubGlobal('localStorage', phoneStorage);
    const owner = await createServerClient({ base }).loginAccount('test-password-123');
    const serverRecord = JSON.stringify({ url: base, token: owner.token, enabled: true, userId: owner.userId, role: owner.role });

    // 模拟升级前两台设备各自只在本机存过频道（尚未挂载远端同步）
    useWorkshopChannelRemote(null);
    phoneStorage.setItem('jarvis.server.v1', serverRecord);
    const phoneSame = saveWorkshopSource({ name: 'CCTV13', url: 'http://live.example/cctv13.m3u8' });
    const phoneOnly = saveWorkshopSource({ name: '地方新闻', url: 'http://live.example/local.m3u8' });

    vi.stubGlobal('localStorage', pcStorage);
    pcStorage.setItem('jarvis.server.v1', serverRecord);
    const pcSame = saveWorkshopSource({ name: 'CCTV-13', url: 'http://live.example/cctv13.m3u8' });
    const pcSameNameDiffUrl = saveWorkshopSource({ name: '地方新闻', url: 'https://backup.example/local2.m3u8' });
    selectWorkshopChannel(pcSame.id);

    // 手机先升级同步，电脑随后升级同步
    activateDevice(phoneStorage, base, owner);
    await syncWorkshopChannels();
    activateDevice(pcStorage, base, owner);
    await syncWorkshopChannels();

    const mergedOnPc = getWorkshopCustomChannels();
    expect(mergedOnPc).toHaveLength(3);
    expect(mergedOnPc.map(ch => ch.source.url).sort()).toEqual([
      'http://live.example/cctv13.m3u8',
      'http://live.example/local.m3u8',
      'https://backup.example/local2.m3u8'
    ]);
    // 电脑原本选中的同地址 CCTV-13 合并后自动指向保留下来的同一频道编号，选台不丢失
    expect(workshopChannel().id).toBe(phoneSame.id);
    expect(mergedOnPc.some(ch => ch.id === phoneOnly.id)).toBe(true);
    expect(mergedOnPc.some(ch => ch.id === pcSameNameDiffUrl.id && ch.title === '地方新闻（2）')).toBe(true);
  });

  it('同一台云服务器的主人与成员频道严格隔离，未登录、评测令牌与非法地址被服务端拒绝', async () => {
    const { base } = await startCloudServer();
    const ownerStorage = makeMemoryStorage();
    const memberStorage = makeMemoryStorage();

    vi.stubGlobal('localStorage', ownerStorage);
    const adminClient = createServerClient({ base });
    const owner = await adminClient.loginAccount('test-password-123');
    const authedAdmin = activateDevice(ownerStorage, base, owner);
    const createdMember = await authedAdmin.createUser('家里平板');
    const member = await createServerClient({ base }).loginAccount(createdMember.accessCode);
    const evaluation = await authedAdmin.createEvaluationToken({ name: '频道权限核验' });

    saveWorkshopSource({ name: '主人私享台', url: 'http://192.168.1.9:8080/owner.m3u8' });
    await syncWorkshopChannels();

    activateDevice(memberStorage, base, member);
    await syncWorkshopChannels();
    expect(getWorkshopCustomChannels()).toEqual([]);
    saveWorkshopSource({ name: '平板动画台', url: 'https://kids.example/stream.m3u8' });
    await syncWorkshopChannels();

    activateDevice(ownerStorage, base, owner);
    await syncWorkshopChannels();
    expect(getWorkshopCustomChannels().map(ch => ch.title)).toEqual(['主人私享台']);

    const unauth = await fetch(`${base}/api/server/workshop-tv-sources`);
    expect(unauth.status).toBe(401);
    const evalRes = await fetch(`${base}/api/server/workshop-tv-sources`, {
      headers: { Authorization: `Bearer ${evaluation.token}` }
    });
    expect(evalRes.status).toBe(403);
    await expect(authedAdmin.syncWorkshopTvSources({
      upsert: [{ id: 'custom-bad', name: '坏源', url: 'javascript:alert(1)' }]
    })).rejects.toThrow();
  });

  it('旧服务器不支持同步接口时自动降级保留本机频道，单账号最多保存 50 个自定义源', async () => {
    const local = makeMemoryStorage();
    local.setItem('jarvis.server.v1', JSON.stringify({ url: 'https://legacy.example', token: 't', enabled: true }));
    vi.stubGlobal('localStorage', local);
    const legacyClient = {
      base: 'https://legacy.example',
      workshopTvSources: async () => { throw Object.assign(new Error('not found'), { status: 404 }); },
      syncWorkshopTvSources: async () => { throw Object.assign(new Error('not found'), { status: 404 }); }
    };
    useWorkshopChannelRemote(legacyClient);
    const saved = saveWorkshopSource({ name: '旧服本机台', url: 'http://live.example/legacy.m3u8' });
    await syncWorkshopChannels();
    expect(workshopChannelSyncMode()).toBe('server-legacy');
    expect(listWorkshopChannels().some(ch => ch.id === saved.id)).toBe(true);

    useWorkshopChannelRemote(null);
    local.removeItem('jarvis.server.v1');
    for (let i = 0; i < MAX_WORKSHOP_SOURCES; i++) {
      saveWorkshopSource({ name: `频道${i + 1}`, url: `https://live.example/${i + 1}.m3u8` });
    }
    expect(() => saveWorkshopSource({ name: '超出上限', url: 'https://live.example/overflow.m3u8' })).toThrow(/最多保存 50 个/);
  });
});

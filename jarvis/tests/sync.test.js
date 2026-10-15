import { describe, it, expect } from 'vitest';
import { deriveKey, seal, open, makeSyncCode, readSyncCode, randomBytes } from '../src/sync/crypto.js';
import { signV1, createOss, normalizeEndpoint, validBucket, directTransport, gatewayTransport } from '../src/sync/oss.js';
import { merge, hashOf, createSync, stableJson } from '../src/sync/engine.js';
import { memorySource, sessionsSource, configSource } from '../src/sync/sources.js';
import { problemOf, loadSyncSettings, DEFAULT_SYNC } from '../src/sync/controller.js';
import { wrapFetch, nativeFetcher } from '../src/mobile/nativeFetch.js';
import { installSpeechShim } from '../src/mobile/speechShim.js';
import { describeResult } from '../src/ui/syncPanel.js';

/** 内存里的 OSS：同时检查请求签名格式 */
function fakeOssServer() {
  const objects = new Map();
  const log = [];
  const transport = async ({ method, url, headers, body }) => {
    log.push({ method, url, headers });
    expect(headers.authorization).toMatch(/^OSS AKID:[A-Za-z0-9+/=]+$/);
    expect(headers.date).toMatch(/GMT$/);
    const key = decodeURIComponent(new URL(url).pathname.slice(1));
    if (method === 'PUT') { objects.set(key, body); return { status: 200, headers: { etag: '"x"' }, text: '' }; }
    if (!objects.has(key)) return { status: 404, headers: {}, text: '<Error><Code>NoSuchKey</Code></Error>' };
    return { status: 200, headers: { etag: '"x"' }, text: objects.get(key) };
  };
  return { objects, log, transport };
}
const CFG = { endpoint: 'oss-cn-hangzhou', bucket: 'my-jarvis', accessKeyId: 'AKID', accessKeySecret: 'secret' };

/** 内存集合（替代 IndexedDB） */
function memoryColl() {
  const dbs = new Map();
  return (name) => {
    if (!dbs.has(name)) dbs.set(name, new Map());
    const m = dbs.get(name);
    return {
      all: async () => [...m.values()],
      get: async (id) => m.get(id),
      put: async (o) => { m.set(o.id, o); return o; },
      delete: async (id) => { m.delete(id); },
      clear: async () => m.clear()
    };
  };
}

describe('加密', () => {
  it('同一密码能解开，错误密码提示“同步密码不对”', async () => {
    const salt = randomBytes(16);
    const k = await deriveKey('correct horse', salt);
    const box = await seal(k, { hello: '世界', n: 1 });
    expect(new TextDecoder().decode(box.subarray(0, 3))).toBe('JV1');
    expect(await open(k, box)).toEqual({ hello: '世界', n: 1 });
    const wrong = await deriveKey('wrong pass', salt);
    await expect(open(wrong, box)).rejects.toThrow('同步密码不对');
    await expect(open(k, new Uint8Array(40))).rejects.toThrow('格式不对');
  });

  it('同步密码太短直接拒绝', async () => {
    await expect(deriveKey('12345', randomBytes(16))).rejects.toThrow('至少 6 位');
  });

  it('同步码：加密带走 OSS 配置，密码不对解不开', async () => {
    const code = await makeSyncCode(CFG, 'pass123456');
    expect(code).toMatch(/^JARVIS-SYNC:/);
    expect(code).not.toContain('secret');
    expect(await readSyncCode(`  ${code}\n`, 'pass123456')).toEqual(CFG);
    await expect(readSyncCode(code, 'other-pass')).rejects.toThrow('同步密码不对');
    await expect(readSyncCode('hello', 'pass123456')).rejects.toThrow('同步码格式不对');
  });
});

describe('OSS', () => {
  // 期望值由阿里云官方 Node SDK（ali-oss 6.x 的 signUtils）对同样的请求算出
  it('签名与阿里云官方 SDK 一致', async () => {
    const D = 'Thu, 17 Nov 2005 18:49:58 GMT';
    const sig = await signV1({
      method: 'PUT', contentMd5: 'ODBGOERFMDMzQTczRUY3NUE3NzA5QzdFNUYzMDQxNEM=', contentType: 'text/html',
      date: D, bucket: 'oss-example', key: 'nelson',
      ossHeaders: { 'x-oss-meta-author': 'foo@example.com', 'x-oss-date': D, 'x-oss-magic': 'abracadabra' },
      accessKeyId: '44CF9590006BF252F707', accessKeySecret: 'OtxrzxIsfpFjA7SwPzILwy8Bw21TLhquhboDYROV'
    });
    expect(sig).toBe('OSS 44CF9590006BF252F707:3mjB8mI0axqhzNoBZlA3tCcBG10=');
    const D2 = 'Mon, 12 Oct 2026 08:00:00 GMT';
    expect(await signV1({ method: 'GET', date: D2, bucket: 'my-jarvis', key: 'jarvis-sync/memory.enc', ossHeaders: { 'x-oss-date': D2 }, accessKeyId: 'AK', accessKeySecret: 'secret' }))
      .toBe('OSS AK:JBl1rC4EVK6XjRTqNnxz7fveyWA=');
  });

  it('地域写法都能识别；乱填会报错', () => {
    expect(normalizeEndpoint('oss-cn-hangzhou')).toBe('oss-cn-hangzhou.aliyuncs.com');
    expect(normalizeEndpoint('cn-shanghai')).toBe('oss-cn-shanghai.aliyuncs.com');
    expect(normalizeEndpoint('https://oss-cn-beijing.aliyuncs.com/')).toBe('oss-cn-beijing.aliyuncs.com');
    expect(() => normalizeEndpoint('evil.com')).toThrow('OSS 地址不对');
    expect(validBucket('my-jarvis')).toBe(true);
    expect(validBucket('My_Bucket')).toBe(false);
  });

  it('读写对象（Base64 文本）；不存在返回 null；403 给出清楚提示', async () => {
    const srv = fakeOssServer();
    const oss = createOss(CFG, { transport: srv.transport });
    expect(oss.host).toBe('my-jarvis.oss-cn-hangzhou.aliyuncs.com');
    expect(await oss.get('memory.enc')).toBeNull();
    await oss.put('memory.enc', new Uint8Array([0, 1, 2, 250, 255]));
    expect(srv.objects.get('jarvis-sync/memory.enc')).toBe('AAEC+v8=');
    expect([...(await oss.get('memory.enc')).body]).toEqual([0, 1, 2, 250, 255]);
    expect(srv.log[0].url).toBe('https://my-jarvis.oss-cn-hangzhou.aliyuncs.com/jarvis-sync/memory.enc');

    const denied = createOss(CFG, { transport: async () => ({ status: 403, headers: {}, text: '' }) });
    await expect(denied.get('x')).rejects.toThrow('OSS 拒绝访问');
    const noBucket = createOss(CFG, { transport: async () => ({ status: 404, headers: {}, text: '<Code>NoSuchBucket</Code>' }) });
    await expect(noBucket.get('x')).rejects.toThrow('找不到这个 Bucket');
  });

  it('网关通道：读网关回的 x-oss-status；网关拒绝时报错', async () => {
    let sent;
    const fetchOk = async (url, init) => { sent = { url, init }; return new Response('QUJD', { status: 200, headers: { 'x-oss-status': '200', 'x-oss-etag': '"e"' } }); };
    const r = await gatewayTransport('http://127.0.0.1:8787', fetchOk)({ method: 'PUT', url: 'https://b.oss-cn-hangzhou.aliyuncs.com/k', headers: { date: 'd' }, body: 'QUJD' });
    expect(sent.url).toBe('http://127.0.0.1:8787/api/oss');
    expect(sent.init.headers['x-jarvis-client']).toBe('1');
    expect(JSON.parse(sent.init.body)).toMatchObject({ method: 'PUT', body: 'QUJD' });
    expect(r).toEqual({ status: 200, headers: { etag: '"e"' }, text: 'QUJD' });
    const denied = async () => new Response('{"error":"只允许本机未央页面调用"}', { status: 403 });
    await expect(gatewayTransport('', denied)({ method: 'GET', url: 'x', headers: {} })).rejects.toThrow('本机网关拒绝');
  });

  it('直连通道（手机）', async () => {
    const r = await directTransport(async (url, init) => new Response(`${init.method} ${url}`, { status: 200, headers: { etag: 'e' } }))({ method: 'GET', url: 'https://x/k', headers: {} });
    expect(r).toEqual({ status: 200, headers: { etag: 'e' }, text: 'GET https://x/k' });
  });
});

describe('三方合并', () => {
  const m = (id, content, updatedAt = 1, extra = {}) => ({ id, content, updatedAt, ...extra });

  it('指纹忽略向量、使用次数等本机字段，键顺序无关', () => {
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
    expect(hashOf(m('1', 'x', 1, { embedding: [1, 2], uses: 5 }))).toBe(hashOf(m('1', 'x')));
    expect(hashOf(m('1', 'x'))).not.toBe(hashOf(m('1', 'y')));
    expect(stableJson({ b: [1, { d: 1, c: 2 }], a: undefined })).toBe('{"b":[1,{"c":2,"d":1}]}');
  });

  it('第一次：两边并集，都要上传 / 下载', () => {
    const r = merge({ a: m('a', '本机') }, { b: m('b', '云端') }, {});
    expect(Object.keys(r.result).sort()).toEqual(['a', 'b']);
    expect(r.put.map((p) => p.key)).toEqual(['b']);
    expect(r.uploadNeeded).toBe(true);
    expect(r.pushed).toBe(1);
    expect(r.pulled).toBe(1);
  });

  it('只有一边改了 → 用改了的那边（不看时间）', () => {
    const base = { a: hashOf(m('a', '旧', 5)) };
    const r1 = merge({ a: m('a', '旧', 5) }, { a: m('a', '云端新', 1) }, base);
    expect(r1.put).toEqual([{ key: 'a', rec: m('a', '云端新', 1) }]);
    expect(r1.uploadNeeded).toBe(false);
    const r2 = merge({ a: m('a', '本机新', 1) }, { a: m('a', '旧', 5) }, base);
    expect(r2.put).toEqual([]);
    expect(r2.result.a.content).toBe('本机新');
    expect(r2.uploadNeeded).toBe(true);
  });

  it('两边都改了 → 用更新时间新的', () => {
    const base = { a: hashOf(m('a', '旧')) };
    expect(merge({ a: m('a', '本机', 9) }, { a: m('a', '云端', 3) }, base).result.a.content).toBe('本机');
    expect(merge({ a: m('a', '本机', 3) }, { a: m('a', '云端', 9) }, base).result.a.content).toBe('云端');
  });

  it('删除：一边删、另一边没动 → 删；一边删、另一边改了 → 保留', () => {
    const base = { a: hashOf(m('a', '旧')), b: hashOf(m('b', '旧')) };
    const r = merge({ a: m('a', '旧') }, { b: m('b', '旧') }, base); // 云端删了 a，本机删了 b
    expect(r.del).toEqual(['a']);
    expect(r.result).toEqual({});
    expect(r.uploadNeeded).toBe(true);
    const r2 = merge({ a: m('a', '本机改了', 2) }, {}, base);
    expect(r2.result.a.content).toBe('本机改了');
    const r3 = merge({}, { a: m('a', '云端改了', 2) }, base);
    expect(r3.put[0].rec.content).toBe('云端改了');
  });

  it('拿云端内容时保留本机的使用次数，向量作废；上传内容不带本机字段', () => {
    const base = { a: hashOf(m('a', '旧')) };
    const r = merge({ a: m('a', '旧', 1, { uses: 7, embedding: [1], embModel: 'e' }) }, { a: m('a', '新', 2) }, base);
    expect(r.put[0].rec).toEqual(m('a', '新', 2, { uses: 7 }));
    const up = merge({ a: m('a', '本机', 1, { uses: 7, embedding: [1] }) }, {}, {});
    expect(up.result.a).toEqual(m('a', '本机', 1));
  });

  it('什么都没变 → 不上传', () => {
    const a = m('a', 'x');
    const r = merge({ a: { ...a, uses: 3 } }, { a }, { a: hashOf(a) });
    expect(r.uploadNeeded).toBe(false);
    expect(r.put).toEqual([]);
  });
});

describe('同步引擎（两台设备）', () => {
  async function device(srv, collImpl = memoryColl(), cfgBox = { cfg: null }) {
    const oss = createOss(CFG, { transport: srv.transport });
    let base = {};
    const sync = createSync({
      oss,
      passphrase: 'pass123456',
      sources: { memory: memorySource({ coll: collImpl }), sessions: sessionsSource({ coll: collImpl }), config: configSource({ load: () => cfgBox.cfg, save: (c) => { cfgBox.cfg = c; } }) },
      baseStore: { get: async () => base, set: async (b) => { base = structuredClone(b); } }
    });
    return { sync, coll: collImpl, cfgBox };
  }

  it('电脑记住的，手机同步后也有；手机删的，电脑同步后也删；云端是密文', async () => {
    const srv = fakeOssServer();
    const pc = await device(srv);
    const phone = await device(srv);
    await pc.coll('memories').put({ id: 'm1', content: '用户叫小许', updatedAt: 1, embedding: [0.1] });
    await pc.coll('kv').put({ id: 'core', human: '程序员', updatedAt: 1 });
    await pc.coll('kv').put({ id: 'sync.base', secret: true }); // 不在同步范围
    await pc.coll('sessions').put({ id: 'c1', title: '周报', messages: [{ role: 'user', content: '写周报' }], updatedAt: 1 });
    const r1 = await pc.sync.run();
    expect(r1.memory.pushed).toBe(2);
    expect(srv.objects.get('jarvis-sync/memory.enc')).not.toContain('小许');
    expect(atob(srv.objects.get('jarvis-sync/memory.enc')).startsWith('JV1')).toBe(true);
    expect(atob(srv.objects.get('jarvis-sync/memory.enc'))).not.toContain('小许');

    const r2 = await phone.sync.run();
    expect(r2.memory.pulled).toBe(2);
    expect(await phone.coll('memories').get('m1')).toEqual({ id: 'm1', content: '用户叫小许', updatedAt: 1 });
    expect((await phone.coll('kv').get('core')).human).toBe('程序员');
    expect(await phone.coll('kv').get('sync.base')).toBeUndefined();
    expect((await phone.coll('sessions').get('c1')).title).toBe('周报');

    // 手机上接着聊 + 删一条记忆
    await phone.coll('sessions').put({ id: 'c1', title: '周报', messages: [{ role: 'user', content: '写周报' }, { role: 'assistant', content: '好的' }], updatedAt: 2 });
    await phone.coll('memories').delete('m1');
    await phone.sync.run();
    const r3 = await pc.sync.run();
    expect(r3.sessions.pulled).toBe(1);
    expect((await pc.coll('sessions').get('c1')).messages).toHaveLength(2);
    expect(await pc.coll('memories').get('m1')).toBeUndefined();
    expect(r3.memory.changedLocal).toBe(true);

    // 再同步一次：没变化，不上传
    const puts = srv.log.filter((l) => l.method === 'PUT').length;
    const r4 = await pc.sync.run();
    expect(r4.memory).toMatchObject({ pushed: 0, pulled: 0, changedLocal: false });
    expect(srv.log.filter((l) => l.method === 'PUT').length).toBe(puts);
  });

  it('模型设置同步：本机的浏览器声音保留，没配置过的设备不会覆盖云端', async () => {
    const srv = fakeOssServer();
    const pc = await device(srv, memoryColl(), { cfg: { provider: 'openai', keys: { openai: 'sk-1' }, models: {}, voice: { engine: 'auto', browserVoice: 'PC 声音' }, updatedAt: 5 } });
    const phone = await device(srv, memoryColl(), { cfg: { provider: 'mock', keys: {}, models: {}, voice: { engine: 'auto', browserVoice: '手机声音' } } });
    await pc.sync.run(['config']);
    await phone.sync.run(['config']);
    expect(phone.cfgBox.cfg).toMatchObject({ provider: 'openai', keys: { openai: 'sk-1' }, updatedAt: 5, voice: { browserVoice: '手机声音' } });
    expect(phone.cfgBox.cfg.id).toBeUndefined();
  });

  it('同步密码不一样：报“同步密码不对”，不会写坏本机数据', async () => {
    const srv = fakeOssServer();
    const pc = await device(srv);
    await pc.coll('memories').put({ id: 'm1', content: 'x', updatedAt: 1 });
    await pc.sync.run();
    const other = createSync({
      oss: createOss(CFG, { transport: srv.transport }), passphrase: 'another-pass',
      sources: { memory: memorySource({ coll: memoryColl() }) },
      baseStore: { get: async () => ({}), set: async () => {} }
    });
    await expect(other.run()).rejects.toThrow('同步密码不对');
  });

  it('同时触发只跑一次', async () => {
    const srv = fakeOssServer();
    const pc = await device(srv);
    const [a, b] = await Promise.all([pc.sync.run(), pc.sync.run()]);
    expect(a).toBe(b);
  });
});

describe('同步设置', () => {
  it('检查填写是否完整', () => {
    expect(problemOf(DEFAULT_SYNC)).toMatch('地域');
    expect(problemOf({ ...DEFAULT_SYNC, ...CFG, bucket: 'BAD' })).toMatch('Bucket');
    expect(problemOf({ ...DEFAULT_SYNC, ...CFG, passphrase: '123' })).toMatch('同步密码');
    expect(problemOf({ ...DEFAULT_SYNC, ...CFG, passphrase: '123456' })).toBe('');
  });
  it('读取设置：损坏时用默认值，分组补全', () => {
    expect(loadSyncSettings({ getItem: () => '{oops' })).toEqual(DEFAULT_SYNC);
    expect(loadSyncSettings({ getItem: () => '{"groups":{"sessions":false}}' }).groups).toEqual({ memory: true, sessions: false, config: true });
  });
  it('结果描述', () => {
    expect(describeResult({ memory: { pulled: 2, pushed: 0 }, sessions: { pulled: 0, pushed: 1 }, config: { pulled: 0, pushed: 0 } })).toBe('记忆 收到 2；对话 上传 1；设置 无变化');
  });
});

describe('安卓 App 适配', () => {
  it('跨域失败的服务商改走原生网络，之后直接走原生', async () => {
    const calls = [];
    const web = async (u) => { calls.push(['web', String(u.url ?? u)]); if (String(u).includes('blocked')) throw new TypeError('Failed to fetch'); return new Response('web'); };
    const native = async (u) => { calls.push(['native', u]); return new Response('native'); };
    const f = wrapFetch(web, native, 'https://localhost');
    expect(await (await f('https://api.ok.com/v1')).text()).toBe('web');
    expect(await (await f('https://blocked.com/v1')).text()).toBe('native');
    expect(await (await f('https://blocked.com/v2')).text()).toBe('native');
    expect(await (await f('/assets/x.js')).text()).toBe('web');
    expect(calls.filter(([k, u]) => k === 'web' && u.includes('blocked'))).toHaveLength(1);
  });

  it('用户中止不改走原生', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const web = async () => { throw new DOMException('Aborted', 'AbortError'); };
    const f = wrapFetch(web, async () => new Response('native'), 'https://localhost');
    await expect(f('https://a.com', { signal: ctrl.signal })).rejects.toThrow('Aborted');
  });

  it('原生请求转成标准 Response', async () => {
    let req;
    const http = { request: async (r) => { req = r; return { status: 201, headers: { 'content-type': 'application/json' }, data: { ok: 1 } }; } };
    const res = await nativeFetcher(http)('https://a.com/x', { method: 'POST', headers: { 'X-A': '1' }, body: '{"q":1}' });
    expect(req).toMatchObject({ url: 'https://a.com/x', method: 'POST', headers: { 'x-a': '1' }, data: '{"q":1}' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: 1 });
  });

  it('朗读补丁：按顺序说，取消会停', async () => {
    const said = [];
    const tts = { speak: async ({ text }) => { said.push(text); }, stop: async () => { said.push('stop'); } };
    const g = {};
    expect(installSpeechShim(tts, g)).toBe(true);
    const ends = [];
    const u1 = new g.SpeechSynthesisUtterance('第一句');
    const u2 = new g.SpeechSynthesisUtterance('第二句');
    const done = new Promise((r) => { u2.onend = r; });
    u1.onend = () => ends.push(1);
    g.speechSynthesis.speak(u1);
    g.speechSynthesis.speak(u2);
    await done;
    expect(said).toEqual(['第一句', '第二句']);
    expect(ends).toEqual([1]);
    g.speechSynthesis.cancel();
    expect(said.at(-1)).toBe('stop');
    expect(installSpeechShim(tts, { speechSynthesis: {}, SpeechSynthesisUtterance: class {} })).toBe(false);
  });
});

describe('OSS 请求头', () => {
  it('带 Date 和 x-oss-date，签名覆盖 x-oss-date', async () => {
    const srv = fakeOssServer();
    const at = new Date('2026-10-12T08:00:00Z');
    await createOss({ ...CFG, accessKeyId: 'AKID', accessKeySecret: 'secret' }, { transport: srv.transport, now: () => at }).get('memory.enc');
    const h = srv.log[0].headers;
    expect(h.date).toBe('Mon, 12 Oct 2026 08:00:00 GMT');
    expect(h['x-oss-date']).toBe(h.date);
    expect(h.authorization).toBe(await signV1({ method: 'GET', date: h.date, bucket: 'my-jarvis', key: 'jarvis-sync/memory.enc', ossHeaders: { 'x-oss-date': h.date }, accessKeyId: 'AKID', accessKeySecret: 'secret' }));
  });
});

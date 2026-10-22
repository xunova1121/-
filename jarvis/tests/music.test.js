/** 唱歌（fal.ai）：提交 → 排队 → 取结果 → 下载存进工作区；密钥只发给 queue.fal.run。全部用假接口，不真扣费 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSongTool, styleText, queueUrl, audioUrlOf, MUSIC_LIMITS } from '../src/agent/music.js';
import * as ws from '../src/agent/workspace.js';
import { createTools } from '../src/agent/tools.js';

const pollMs = MUSIC_LIMITS.pollMs;
beforeAll(() => { MUSIC_LIMITS.pollMs = 1; });
afterAll(() => { MUSIC_LIMITS.pollMs = pollMs; });

const LYRICS = '[Verse]\n夜风轻轻敲窗沿\n星星眨眼不说话\n[Chorus]\n小未央陪你坐一会儿\n听月亮慢慢讲童话';
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

/** 假的 fal：先排队一次、再生成中一次，然后完成 */
function fakeFal({ statusUrl = 'https://queue.fal.run/fal-ai/minimax-music/requests/r1/status', submitStatus = 200, audio = 'https://v3.fal.media/files/song.mp3', states = ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'] } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: new Headers(init.headers).get('authorization'), body: init.body });
    if (url === 'https://queue.fal.run/fal-ai/minimax-music/v2') return submitStatus === 200 ? json({ request_id: 'r1', status_url: statusUrl, response_url: 'https://queue.fal.run/fal-ai/minimax-music/requests/r1' }) : json({ detail: 'x' }, submitStatus);
    if (url.endsWith('/status')) return json({ status: states[Math.min(n++, states.length - 1)], queue_position: 2 });
    if (url.endsWith('/requests/r1')) return json({ audio: { url: audio, content_type: 'audio/mpeg' } });
    if (url === audio) return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    return new Response('not found', { status: 404 });
  };
  return { calls, fetchImpl };
}

describe('唱歌', () => {
  it('提交歌词和曲风，排队完成后下载，存进工作区“音乐”文件夹并在对话里播放', async () => {
    const fal = fakeFal();
    const shown = [];
    const steps = [];
    const tool = createSongTool({ falKey: 'k-123', fetchImpl: fal.fetchImpl, onAudio: (src, path) => shown.push(path) });
    const out = await tool.run({ title: '歇一歇', lyrics: LYRICS, style: '温柔女声，慢板钢琴民谣，治愈，夜晚' }, { progress: (t) => steps.push(t) });
    const path = out.match(/音乐\/\S+?\.mp3/)[0];
    expect(path).toMatch(/^音乐\/歇一歇-/);
    expect((await ws.readBlob(path)).size).toBe(6);
    expect(shown).toEqual([path]);
    expect(steps.join('|')).toContain('排队中（前面还有 2 个）');
    const body = JSON.parse(fal.calls[0].body);
    expect(body).toEqual({ prompt: '温柔女声，慢板钢琴民谣，治愈，夜晚', lyrics_prompt: LYRICS });
  });
  it('密钥只发给 queue.fal.run，下载音频时不带', async () => {
    const fal = fakeFal();
    await createSongTool({ falKey: 'k-123', fetchImpl: fal.fetchImpl }).run({ lyrics: LYRICS, style: '流行，欢快，吉他弹唱' });
    for (const c of fal.calls) expect(c.auth).toBe(new URL(c.url).hostname === 'queue.fal.run' ? 'Key k-123' : null);
    expect(fal.calls.some((c) => c.url.includes('fal.media'))).toBe(true);
  });
  it('返回的状态地址不是 fal 的：立刻停下，不把密钥发过去', async () => {
    const fal = fakeFal({ statusUrl: 'https://evil.example.com/status' });
    await expect(createSongTool({ falKey: 'k', fetchImpl: fal.fetchImpl }).run({ lyrics: LYRICS, style: '流行歌曲测试一下' })).rejects.toThrow('不把密钥发到别的地址');
    expect(fal.calls.some((c) => c.url.includes('evil'))).toBe(false);
  });
  it('没填 Key、歌词太短、余额不足、生成失败：说清原因', async () => {
    await expect(createSongTool({}).run({ lyrics: LYRICS, style: 'x' })).rejects.toMatchObject({ code: 'FAL_KEY_MISSING' });
    await expect(createSongTool({ falKey: 'k' }).run({ lyrics: '啦啦', style: 'x' })).rejects.toThrow('歌词太短');
    await expect(createSongTool({ falKey: 'k', fetchImpl: fakeFal({ submitStatus: 402 }).fetchImpl }).run({ lyrics: LYRICS, style: '流行歌曲测试' })).rejects.toMatchObject({ status: 402, message: expect.stringContaining('余额不足') });
    await expect(createSongTool({ falKey: 'k', fetchImpl: fakeFal({ states: ['FAILED'] }).fetchImpl }).run({ lyrics: LYRICS, style: '流行歌曲测试' })).rejects.toThrow('生成失败');
  });
  it('查状态、取结果、下载时断网或 fal 临时出错：隔几秒重试，不让整首作废', async () => {
    const fal = fakeFal();
    let drops = 0;
    const flaky = async (url, init) => {
      // 第一次查状态断网、第二次 503；取结果断网一次；下载 502 一次
      if ((url.endsWith('/status') && drops < 2) || (url.endsWith('/requests/r1') && drops === 2) || (url.includes('fal.media') && drops === 3)) {
        drops++;
        if (drops === 1 || drops === 3) throw new TypeError('fetch failed');
        return new Response('busy', { status: drops === 2 ? 503 : 502 });
      }
      return fal.fetchImpl(url, init);
    };
    const out = await createSongTool({ falKey: 'k', fetchImpl: flaky }).run({ lyrics: LYRICS, style: '流行歌曲测试一下' });
    expect(out).toContain('已经唱好了');
    expect(drops).toBe(4);
    expect(fal.calls.filter((c) => c.method === 'POST')).toHaveLength(1); // 提交只有一次，不重复扣费
  });
  it('一直连不上就如实说；提交时断网不重试（可能已经扣费）', async () => {
    const down = fakeFal();
    let status = 0;
    const offline = async (url, init) => (url.endsWith('/status') ? (status++, Promise.reject(new TypeError('fetch failed'))) : down.fetchImpl(url, init));
    await expect(createSongTool({ falKey: 'k', fetchImpl: offline }).run({ lyrics: LYRICS, style: '流行歌曲测试一下' })).rejects.toMatchObject({ kind: 'network' });
    expect(status).toBe(MUSIC_LIMITS.retries + 1);
    let submits = 0;
    const submitDown = async () => { submits++; throw new TypeError('fetch failed'); };
    await expect(createSongTool({ falKey: 'k', fetchImpl: submitDown }).run({ lyrics: LYRICS, style: '流行歌曲测试一下' })).rejects.toThrow('连不上 fal.ai');
    expect(submits).toBe(1);
  });
  it('fal 说哪里不对（422）：把原因带出来，方便查', async () => {
    const bad = async () => json({ detail: [{ loc: ['body', 'lyrics_prompt'], msg: 'field required' }] }, 422);
    await expect(createSongTool({ falKey: 'k', fetchImpl: bad }).run({ lyrics: LYRICS, style: '流行歌曲测试一下' })).rejects.toThrow('歌词或曲风不符合接口要求（422）：field required');
  });
  it('等太久会停；用户点停止立即结束', async () => {
    let t = 0;
    const slow = fakeFal({ states: ['IN_PROGRESS'] });
    await expect(createSongTool({ falKey: 'k', fetchImpl: slow.fetchImpl, now: () => (t += 4 * 60_000) }).run({ lyrics: LYRICS, style: '流行歌曲测试' })).rejects.toMatchObject({ kind: 'timeout' });
    const ctrl = new AbortController();
    const stuck = fakeFal({ states: ['IN_QUEUE'] });
    const run = createSongTool({ falKey: 'k', fetchImpl: stuck.fetchImpl }).run({ lyrics: LYRICS, style: '流行歌曲测试' }, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(run).rejects.toThrow();
  });
  it('工具已注册，模型能看到', () => {
    expect(createTools({ metrics: async () => ({}) }).some((t) => t.name === 'sing_song')).toBe(true);
  });
});

describe('小工具', () => {
  it('曲风太短补上默认，太长截到 300 字', () => {
    expect(styleText('民谣')).toBe('民谣，流行歌曲，温柔女声');
    expect([...styleText('慢'.repeat(400))]).toHaveLength(300);
  });
  it('只认 fal 的排队地址和 https 音频地址', () => {
    expect(queueUrl('https://queue.fal.run/x/requests/1/status')).toBeTruthy();
    for (const bad of ['http://queue.fal.run/x', 'https://queue.fal.run.evil.com/x', 'https://evil.com/queue.fal.run', '乱写']) expect(queueUrl(bad)).toBeNull();
    expect(audioUrlOf({ audio: { url: 'https://v3.fal.media/a.mp3' } })).toBe('https://v3.fal.media/a.mp3');
    expect(audioUrlOf({ audio_file: { url: 'https://fal.media/b.mp3' } })).toBe('https://fal.media/b.mp3');
    expect(audioUrlOf({ audio: { url: 'javascript:alert(1)' } })).toBeNull();
    expect(audioUrlOf({})).toBeNull();
  });
});

describe('服务器上的 fal.ai Key', () => {
  it('能存进服务器配置，只回显掩码；留空或掩码保存时保留原值', async () => {
    const { maskConfig, mergeConfig } = await import('../server/serverMode.mjs');
    const saved = mergeConfig({ keys: {} }, { falKey: 'fal-real-secret-1234', bochaKey: 'sk-bocha-5678' });
    expect(saved.falKey).toBe('fal-real-secret-1234');
    expect(maskConfig(saved).falKey).toBe('••••1234');
    expect(JSON.stringify(maskConfig(saved))).not.toContain('fal-real-secret');
    expect(mergeConfig(saved, { falKey: '••••1234' }).falKey).toBe('fal-real-secret-1234');
    expect(mergeConfig(saved, { falKey: '' }).falKey).toBe('fal-real-secret-1234');
  });
});

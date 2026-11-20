import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKSHOP_TV_CHANNELS, workshopTvPlayers } from '../shared/workshopTv.js';
import { createServer } from '../server/server.mjs';
import { memberRoute } from '../server/userRoutes.mjs';
import { getWorkshopTvPlayers } from '../src/app/workshopTv.js';
import { createWorkshopTvPlayer } from '../src/ui/workshopTvPlayer.js';

const sources = {
  cctv1: { type: 'embed', url: 'https://player.cctv.com/embed/fixture' },
  cctv2: { type: 'media', url: 'https://media.cntv.cn/fixture.webm' }
};
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function mockPlayerDocument(canPlayType = () => '') {
  const nodes = [];
  vi.stubGlobal('document', { createElement(tag) {
    const el = { tag, children: [], canPlayType, setAttribute: vi.fn(), removeAttribute: vi.fn(),
      querySelector: name => el.children.find(c => c.tag === name), replaceChildren: (...children) => { el.children = children; },
      pause: vi.fn(), load: vi.fn() };
    nodes.push(el);
    return el;
  } });
  return nodes;
}

describe('工作台央视播放器', () => {
  it('从官网实际导航打开纪录频道，只接受已配置的央视系 HTTPS 播放地址', () => {
    expect(WORKSHOP_TV_CHANNELS.find(ch => ch.id === 'cctv9').url).toBe('https://tv.cctv.com/live/cctvjilu/');
    expect(workshopTvPlayers(null)).toEqual({});
    for (const url of ['https://tv.cctv.com/live/cctvjilu/', 'https://cctv.com.example.org/stream',
      'https://user:password@player.cctv.com/stream', 'http://player.cctv.com/stream', 'javascript:foo']) {
      expect(workshopTvPlayers({ cctv9: { type: 'embed', url }, unknown: sources.cctv1 })).toEqual({});
    }
    expect(workshopTvPlayers(sources)).toEqual(sources);
  });

  it('云端沿用登录鉴权并限制成员只读，本机只允许同源网关页面', async () => {
    const getter = vi.fn().mockResolvedValue({ players: sources });
    expect(await getWorkshopTvPlayers({ server: { workshopTvPlayers: getter } })).toEqual(sources);
    expect(memberRoute('GET', '/api/workshop/tv-players')).toBe(true);
    expect(memberRoute('POST', '/api/workshop/tv-players')).toBe(false);
    vi.stubEnv('JARVIS_CCTV_PLAYERS', JSON.stringify(sources));
    const server = createServer({ ollama: null });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = 'http://127.0.0.1:' + server.address().port + '/api/workshop/tv-players';
      expect((await fetch(url)).status).toBe(403);
      const response = await fetch(url, { headers: { 'x-jarvis-client': '1' } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ players: sources });
      vi.stubEnv('JARVIS_CCTV_PLAYERS', 'invalid json');
      expect(await (await fetch(url, { headers: { 'x-jarvis-client': '1' } })).json()).toEqual({ players: {} });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it('迟到的频道不能覆盖当前画面，退后台后释放媒体并取消未完成加载', async () => {
    const nodes = mockPlayerDocument();
    let finishFirst;
    const getPlayers = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; })).mockResolvedValue(sources);
    const player = createWorkshopTvPlayer({ getPlayers });
    const first = player.select('cctv1');
    await player.select('cctv2');
    finishFirst(sources);
    await first;
    const video = player.element.children[0];
    expect(video).toMatchObject({ tag: 'video', src: sources.cctv2.url, muted: true, controls: true });
    expect(video).toMatchObject({ autoplay: true, playsInline: true, defaultMuted: true });
    expect(nodes.some(el => el.tag === 'iframe')).toBe(false);
    player.close();
    expect(video.pause).toHaveBeenCalledOnce();
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
    expect(video.load).toHaveBeenCalledOnce();
    expect(player.element.hidden).toBe(true);
    await player.select('cctv1');
    expect(player.element.children[0]).toMatchObject({ tag: 'iframe', src: sources.cctv1.url });
    await player.select('cctv9');
    expect(player.element.hidden).toBe(true);
    expect(player.element.children).toHaveLength(0);
  });

  it('无授权源时在机内播放有标记的本地短片，换台或关闭后释放旧短片', async () => {
    mockPlayerDocument();
    const player = createWorkshopTvPlayer({ getPlayers: async () => sources });
    await player.select('cctv9');
    const [clip, caption] = player.standby.children;
    expect(clip).toMatchObject({ tag: 'video', autoplay: true, muted: true, controls: true, playsInline: true });
    expect(clip.src).toBeTruthy();
    expect(clip.title).toContain('Greg Zaal');
    expect(clip.setAttribute).toHaveBeenCalledWith('aria-description', clip.title);
    expect(clip.src).not.toMatch(/^https?:/);
    expect(caption.children.map(el => el.textContent)).toEqual(['未央风景短片 · 非频道直播', 'CCTV-9 纪录 直播未接入']);
    expect(player.element.hidden).toBe(true);
    await player.select('cctv2');
    expect(clip.pause).toHaveBeenCalledOnce();
    expect(clip.removeAttribute).toHaveBeenCalledWith('src');
    expect(player.element.children[0].src).toBe(sources.cctv2.url);
    expect(player.standby.hidden).toBe(true);
    await player.select('cctv13');
    const nextClip = player.standby.children[0];
    player.close();
    expect(nextClip.pause).toHaveBeenCalledOnce();
    expect(nextClip.removeAttribute).toHaveBeenCalledWith('src');
    expect(nextClip.load).toHaveBeenCalledOnce();
    expect(player.standby.hidden).toBe(true);
  });

  it('配置请求失败或媒体解码失败时保留重试及短片选择，恢复后优先直播', async () => {
    mockPlayerDocument();
    const getPlayers = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(sources);
    const player = createWorkshopTvPlayer({ getPlayers });
    await player.select('cctv2');
    let card = player.standby.children[0];
    expect(card.children[1].textContent).toContain('读取频道配置');
    await card.children[2].onclick();
    const video = player.element.children[0];
    video.onerror();
    expect(video.pause).toHaveBeenCalledOnce();
    expect(player.element.hidden).toBe(true);
    card = player.standby.children[0];
    expect(card.children[1].textContent).toContain('无法播放');
    expect(card.children[3].textContent).toBe('看未央风景短片');
    card.children[3].onclick();
    expect(player.standby.children[1].children[1].textContent).toBe('CCTV-2 财经 直播暂不可用');
    const clip = player.standby.children[0];
    const primaryFormat = clip.src;
    clip.onerror();
    expect(clip.src).not.toBe(primaryFormat);
    clip.onerror();
    expect(player.standby.children[0].children[1].textContent).toContain('未能播放风景短片');
    await player.standby.children[0].children[2].onclick();
    expect(player.element.children[0].src).toBe(sources.cctv2.url);
  });

  it.each([
    ['MP4 解码可用时优先用 MP4', () => 'probably', /\.mp4$/, /\.webm$/],
    ['仅支持 VP8 时直接使用 WebM', type => type.startsWith('video/webm') ? 'probably' : '', /\.webm$/, /\.mp4$/]
  ])('%s，并只在解码失败时换一次编码', async (_label, support, firstFormat, secondFormat) => {
    mockPlayerDocument(support);
    const player = createWorkshopTvPlayer();
    await player.select('cctv9');
    const clip = player.standby.children[0];
    expect(clip.src).toMatch(firstFormat);
    clip.onerror();
    expect(clip.src).toMatch(secondFormat);
    clip.onerror();
    expect(clip.onerror).toBe(null);
    expect(player.standby.children[0].children[1].textContent).toContain('未能播放风景短片');
  });
});

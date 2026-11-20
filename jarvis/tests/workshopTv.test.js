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
    const nodes = [];
    vi.stubGlobal('document', { createElement(tag) {
      const el = { tag, children: [], setAttribute: vi.fn(), removeAttribute: vi.fn(),
        querySelector: name => el.children.find(c => c.tag === name), replaceChildren: (...children) => { el.children = children; },
        pause: vi.fn(), load: vi.fn() };
      nodes.push(el);
      return el;
    } });
    let finishFirst;
    const getPlayers = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; })).mockResolvedValue(sources);
    const player = createWorkshopTvPlayer({ getPlayers });
    const first = player.select('cctv1');
    await player.select('cctv2');
    finishFirst(sources);
    await first;
    const video = player.element.children[0];
    expect(video).toMatchObject({ tag: 'video', src: sources.cctv2.url, muted: true, controls: true });
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
});

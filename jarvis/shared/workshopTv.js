// 纪录频道在央视网使用 cctvjilu 路径，频道编号和网页路径分别保存。
export const WORKSHOP_TV_CHANNELS = [
  ['cctv1', '综合', 'cctv1'],
  ['cctv2', '财经', 'cctv2'],
  ['cctv9', '纪录', 'cctvjilu'],
  ['cctv13', '新闻', 'cctv13']
].map(([id, label, path]) => ({
  id, label, name: 'CCTV-' + id.slice(4) + ' ' + label, url: 'https://tv.cctv.com/live/' + path + '/'
}));

// 只接收部署方提供的央视系 HTTPS 播放地址；频道官网的普通直播页由外部浏览器打开。
export function workshopTvPlayers(config) {
  const players = {};
  for (const { id } of WORKSHOP_TV_CHANNELS) {
    const source = config?.[id];
    if (!['media', 'embed'].includes(source?.type) || typeof source.url !== 'string' || source.url.length > 4096) continue;
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
      if (!/(^|\.)(cctv\.com|cctv\.cn|cntv\.cn|yangshipin\.cn)$/.test(url.hostname)) continue;
      if (url.hostname === 'tv.cctv.com' && /^\/live(?:\/|$)/i.test(url.pathname)) continue;
      players[id] = { type: source.type, url: url.href };
    } catch { /* 当前频道保留官网入口。 */ }
  }
  return players;
}

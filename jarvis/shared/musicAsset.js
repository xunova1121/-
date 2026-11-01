/** 歌词随工作区文件保存，不进入会话/检查点；只接受与音频摘要相符的原稿。 */
export const SONG_BYTES = 30 * 1024 * 1024;
export const SONG_INFO_BYTES = 20 * 1024;
export const songInfoPath = (path) => `.workflows/music/${encodeURIComponent(path)}.json`;
export async function songDigest(blob) {
  if (!globalThis.crypto?.subtle) throw new Error('当前页面不能核验音频摘要，请使用HTTPS或客户端查看歌词');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
export function lyricLines(text) {
  const lines = String(text || '').slice(0, 6000).split(/\r?\n/).slice(0, 300);
  return lines.map((line) => {
    const matches = [...line.matchAll(/\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g)];
    const words = line.replace(/\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]/g, '').trim();
    const times = matches.map((m) => Number(m[1]) * 60 + Number(m[2]) + Number(`0.${m[3] || 0}`));
    return { time: times[0] ?? null, times, text: words };
  });
}
export async function loadSongAsset(path, read) {
  const blob = await read(path);
  if (!blob.size || blob.size > SONG_BYTES) throw new Error('歌曲为空或超过30MB，请在工作区打开原文件');
  let info;
  let note = '这首歌没有保存歌词，可播放原音频。';
  try {
    const file = await read(songInfoPath(path));
    if (file.size > SONG_INFO_BYTES) throw new Error('歌词信息超过上限');
    const value = JSON.parse(await file.text());
    if (value.version !== 1 || value.path !== path || typeof value.lyrics !== 'string' || value.lyrics.length > 6000) throw new Error('歌词信息不完整');
    if (value.sha256 !== await songDigest(blob)) throw new Error('音频已变化，旧歌词未套用');
    info = { title: String(value.title || '').slice(0, 100), lyrics: value.lyrics };
    note = '';
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    if (!/找不到|404|not.found/i.test(error?.message || '')) note = `歌词暂不可用：${error.message}`;
  }
  return { blob, ...info, note };
}

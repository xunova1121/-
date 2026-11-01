import { it, expect } from 'vitest';
import { lyricLines, loadSongAsset, songDigest, songInfoPath, SONG_INFO_BYTES } from '../shared/musicAsset.js';

it('纯歌词不制造时间戳，混合歌词保留段落及所有时间标记', () => {
  expect(lyricLines('第一句\n第二句').every((r) => r.time === null)).toBe(true);
  const rows = lyricLines('[Verse]\n[00:01.25][00:10]第一句\n没有时间的说明');
  expect(rows.map((r) => r.text)).toEqual(['[Verse]', '第一句', '没有时间的说明']);
  expect(rows[1].times).toEqual([1.25, 10]);
  expect(lyricLines('[00:99]不合法')[0].time).toBeNull();
});
it('展示有行数上限，元数据路径编码后不能越界', () => {
  expect(lyricLines(Array(500).fill('歌词').join('\n'))).toHaveLength(300);
  expect(songInfoPath('../音乐/a.mp3')).toBe('.workflows/music/..%2F%E9%9F%B3%E4%B9%90%2Fa.mp3.json');
});
it('对应音频与歌词从同一读取器恢复，不依赖会话大文本', async () => {
  const blob = new Blob(['real audio bytes']);
  const path = '音乐/真实歌曲.mp3';
  const meta = new Blob([JSON.stringify({ version: 1, path, sha256: await songDigest(blob), title: '真实歌名', lyrics: '原稿' })]);
  const asset = await loadSongAsset(path, async (p) => p === path ? blob : meta);
  expect(asset.title).toBe('真实歌名'); expect(asset.lyrics).toBe('原稿'); expect(asset.blob).toBe(blob);
});
it('音频变化拒绝套用旧歌词，但保留可播放音频', async () => {
  const path = '音乐/变化.mp3'; const blob = new Blob(['changed']);
  const meta = new Blob([JSON.stringify({ version: 1, path, sha256: 'old', lyrics: '旧歌词' })]);
  const asset = await loadSongAsset(path, async (p) => p === path ? blob : meta);
  expect(asset.lyrics).toBeUndefined(); expect(asset.note).toContain('音频已变化'); expect(asset.blob).toBe(blob);
});
it('旧歌没有歌词仍可播放，超大元数据拒绝', async () => {
  const blob = new Blob(['audio']);
  const old = await loadSongAsset('old.mp3', async (p) => { if (p === 'old.mp3') return blob; throw new Error('找不到文件'); });
  expect(old.note).toContain('没有保存歌词');
  const large = await loadSongAsset('old.mp3', async (p) => p === 'old.mp3' ? blob : new Blob(['x'.repeat(SONG_INFO_BYTES + 1)]));
  expect(large.note).toContain('超过上限');
});
it('读取音频失败和用户取消不能假装播放成功', async () => {
  await expect(loadSongAsset('x.mp3', async () => { throw new Error('断网'); })).rejects.toThrow('断网');
  await expect(loadSongAsset('x.mp3', async (p) => { if (p === 'x.mp3') return new Blob(['audio']); throw new DOMException('停止', 'AbortError'); })).rejects.toMatchObject({ name: 'AbortError' });
});

// RetroStrange 在官方频道「Stream/Embed」中公布下列接入地址；保留原声和频道标识。
// 另外两个频道为发布者公开的播放演示。官网入口与播放器直链分别保存。
export const workshopPublicChannels = [
  {
    id: 'retrostrange-tv', title: 'RetroStrange 经典电影', url: 'https://live.retrostrange.com/',
    media: 'https://live.retrostrange.com/hls/stream.m3u8'
  },
  {
    id: 'ireplay-blender', title: 'Blender 动画（演示）',
    url: 'https://ireplay.tv/blog/hls-streams-examples-streams-continuous-discontinuity-vod2live-test-video-players-app-websites/',
    media: 'https://ireplay.tv/test/blender.m3u8'
  },
  {
    id: 'unified-live', title: 'HLS 参考直播（演示）',
    url: 'https://demo.unified-streaming.com/k8s/live/',
    media: 'https://demo.unified-streaming.com/k8s/live/scte35.isml/.m3u8'
  }
].map(({ id, title, url, media }) => ({
  id, title, label: title, number: '', url, kind: 'public', source: { type: 'media', url: media, format: 'hls' }
}));

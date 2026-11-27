// 等的是解码出的画面。清单下载成功、video 已挂载都不能据此认定播放成功。
const FIRST_FRAME_MS = 12000;
const STALL_MS = 10000;

export function watchWorkshopVideo(video, { loadingText, show, hide, timeout }) {
  let active = true, started = false, manual = false, tried = false, attempt = 0;
  let timer, pendingState = '', lastTime = video.currentTime;

  function stopTimer() {
    clearTimeout(timer);
    pendingState = '';
  }
  function arm(state, ms) {
    if (pendingState === state) return;
    stopTimer();
    pendingState = state;
    const time = video.currentTime;
    timer = setTimeout(() => {
      pendingState = '';
      if (!active || manual || video.ended || (started && video.paused)) return;
      if (started && video.currentTime !== time) {
        playing();
        return;
      }
      timeout(started);
    }, ms);
  }
  function playing() {
    if (!active || video.paused || !video.videoWidth || video.readyState < 2) return;
    started = true;
    manual = false;
    lastTime = video.currentTime;
    hide();
    arm('playing', STALL_MS);
  }
  function wait() {
    if (!active || !started || manual || video.paused || video.ended) return;
    show('正在缓冲频道画面…');
    arm('waiting', STALL_MS);
  }
  function play() {
    if (!active) return;
    const sequence = ++attempt;
    manual = false;
    show(loadingText);
    arm('starting', FIRST_FRAME_MS);
    video.play().catch(error => {
      if (!active || attempt !== sequence || !video.paused) return;
      if (error.name !== 'NotAllowedError') { tried = false; return; }
      manual = true;
      stopTimer();
      show('请点播放继续观看', play);
    });
  }
  function tryPlay() {
    if (!active || started || manual || tried || !video.paused) return;
    tried = true;
    play();
  }
  video.oncanplay = tryPlay;
  video.onplaying = playing;
  video.ontimeupdate = () => { if (!started || video.currentTime !== lastTime) playing(); };
  video.onwaiting = wait;
  video.onstalled = () => { if (video.readyState < 3) wait(); };
  video.onpause = () => { if (active && started) { hide(); stopTimer(); } };
  video.onended = video.onpause;
  function loading() {
    stopTimer();
    started = manual = tried = false;
    // 上一个 src 的 play() 可能在切换解码器后才返回。
    attempt++;
    show(loadingText);
    arm('starting', FIRST_FRAME_MS);
  }
  loading();
  return {
    loading, tryPlay,
    dispose() {
      active = false;
      stopTimer();
      video.oncanplay = video.onplaying = video.ontimeupdate = video.onwaiting = video.onstalled = video.onpause = video.onended = null;
    }
  };
}

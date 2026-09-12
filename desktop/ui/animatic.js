/**
 * ══════════ 连播预览：在花钱出视频之前先看一遍节奏 ══════════
 *
 * ── 这个功能存在的理由 ──
 *
 * 真实的短片流程里，动态分镜（animatic）是**出片之前最后一道、
 * 也是最省钱的一道关**：把分镜图按各自的时长连起来播一遍，配上台词，
 * 你立刻能听出"第 7 镜太长了"、"这三镜连着全是中景，闷"、
 * "这句话根本来不及说完"。
 *
 * 而这些问题，出完视频再发现的代价是整批重出 —— 这条流水线上最贵的一步。
 *
 * ── 它必须在有视频之前就能用 ──
 *
 * 这一条决定了不能复用 edit.timeline：那个函数只收**已经有视频**的镜头，
 * 因为它算的是成片。而连播的全部价值恰恰在"还没出视频"那个时刻。
 *
 * 所以这里自己排一遍：每一镜按自己的时长占一段，有视频就放视频、
 * 只有图就把图定住。随着片子往前做，同一个播放器会自然地从
 * "全是静帧"过渡到"全是视频"—— 中间那些半成品状态也照样能看。
 *
 * ⚠ **时长口径必须和别处一致**（duration.shotSeconds）。
 * 这里另算一套的话，连播说 62 秒、导出说 58 秒，而两个数都是我们自己给的。
 */

import * as DUR from '/duration.js';

const fmt = (s) => {
  const n = Math.max(0, Number(s) || 0);
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
};

/**
 * @param shots     按镜号排好的
 * @param mediaUrl  本地路径 → 同源地址（app 自己那份）
 * @param spokenOf  取这一镜真正要念出来的那段台词（署名和括注不算）
 */
export function animatic(shots, { mediaUrl = (x) => x, spokenOf = (s) => s.dialogue || '' } = {}) {
  const { rows, total } = DUR.animaticLayout(shots);
  const host = document.createElement('div');
  host.className = 'animatic';

  const stage = document.createElement('div');
  stage.className = 'ani-stage';
  const img = document.createElement('img');
  img.className = 'ani-media';
  const vid = document.createElement('video');
  vid.className = 'ani-media';
  vid.muted = true;
  vid.playsInline = true;
  vid.hidden = true;
  const blank = document.createElement('div');
  blank.className = 'ani-blank';
  const sub = document.createElement('div');
  sub.className = 'ani-sub';
  const tag = document.createElement('div');
  tag.className = 'ani-tag';
  stage.append(img, vid, blank, tag, sub);

  const bar = document.createElement('div');
  bar.className = 'ani-bar';
  const fill = document.createElement('div');
  fill.className = 'ani-fill';
  bar.append(fill);
  // 每一镜在进度条上占一格，格子上能看出它是图还是视频 —— 一眼就知道还差几镜
  const ticks = document.createElement('div');
  ticks.className = 'ani-ticks';
  rows.forEach((r) => {
    const t = document.createElement('i');
    t.className = `ani-tick ${r.kind}`;
    t.style.width = `${(r.span / total) * 100}%`;
    t.title = `第 ${r.shot.index} 镜 · ${r.span}s`;
    t.onclick = () => seek(r.start + 0.01);
    ticks.append(t);
  });

  const btnPlay = document.createElement('button');
  btnPlay.className = 'btn sm';
  const clock = document.createElement('span');
  clock.className = 'ani-clock';

  const controls = document.createElement('div');
  controls.className = 'ani-controls';
  const mk = (label, title, on) => {
    const b = document.createElement('button');
    b.className = 'btn ghost sm';
    b.textContent = label;
    b.title = title;
    b.onclick = on;
    return b;
  };
  controls.append(
    btnPlay,
    mk('◀', '上一镜（←）', () => step(-1)),
    mk('▶', '下一镜（→）', () => step(1)),
    clock
  );
  const hint = document.createElement('div');
  hint.className = 'ani-hint';
  hint.textContent = '空格播放/暂停 · ←→ 上下一镜 · 点进度条跳转';

  host.append(stage, ticks, bar, controls, hint);

  let t = 0;
  let playing = false;
  let raf = 0;
  let last = 0;
  let shown = -1;

  const rowAt = (time) => {
    for (let i = rows.length - 1; i >= 0; i -= 1) if (time >= rows[i].start) return i;
    return 0;
  };

  /**
   * ⚠ 只在**换镜的时候**才动 DOM。
   *
   * 每一帧都重设 img.src 的话，浏览器会把它当成一次新的加载 ——
   * 画面会闪，而且几十镜的片子会一直在解码。
   * 记住"现在显示的是第几镜"，只有变了才换。
   */
  const render = () => {
    const i = rowAt(t);
    const r = rows[i];
    if (i !== shown) {
      shown = i;
      const isVid = r.kind === 'video';
      vid.hidden = !isVid;
      img.hidden = isVid || r.kind === 'blank';
      blank.hidden = r.kind !== 'blank';
      if (isVid) {
        vid.src = mediaUrl(r.shot.videoPath);
        vid.currentTime = 0;
        if (playing) vid.play().catch(() => {});
      } else if (r.kind === 'image') {
        img.src = mediaUrl(r.shot.imagePath);
      } else {
        blank.textContent = `第 ${r.shot.index} 镜还没有画面`;
      }
      sub.textContent = spokenOf(r.shot) || '';
      sub.hidden = !sub.textContent;
      tag.textContent = `第 ${r.shot.index} 镜 · ${r.span}s${r.guessed ? '（没设时长，按 3 秒算）' : ''}`
        + `${r.kind === 'video' ? ' · 视频' : r.kind === 'image' ? ' · 静帧' : ''}`;
    }
    fill.style.width = `${Math.min(100, (t / total) * 100)}%`;
    clock.textContent = `${fmt(t)} / ${fmt(total)}`;
  };

  const tick = (now) => {
    if (!playing) return;
    const dt = (now - last) / 1000;
    last = now;
    t += dt;
    if (t >= total) { t = total; pause(); render(); return; }
    render();
    raf = requestAnimationFrame(tick);
  };

  function play() {
    if (playing || total <= 0) return;
    if (t >= total) t = 0;
    playing = true;
    btnPlay.textContent = '暂停';
    last = performance.now();
    if (!vid.hidden) vid.play().catch(() => {});
    raf = requestAnimationFrame(tick);
  }
  function pause() {
    playing = false;
    btnPlay.textContent = '播放';
    cancelAnimationFrame(raf);
    vid.pause();
  }
  function seek(to) {
    t = Math.max(0, Math.min(total, to));
    // 强制换镜：seek 之后即使还在同一镜，视频也该从这一镜的开头放
    shown = -1;
    render();
  }
  function step(dir) {
    const i = rowAt(t);
    const n = Math.max(0, Math.min(rows.length - 1, i + dir));
    seek(rows[n].start + 0.01);
  }

  btnPlay.onclick = () => (playing ? pause() : play());
  bar.onclick = (e) => {
    const box = bar.getBoundingClientRect();
    seek(((e.clientX - box.left) / box.width) * total);
  };

  /**
   * ⚠ 快捷键挂在这块面板上、而且**在输入框里失效**。
   * 挂 document 上的话，人在别处打字按空格会莫名其妙开始播放。
   */
  host.tabIndex = 0;
  host.onkeydown = (e) => {
    const tagName = (e.target?.tagName || '').toLowerCase();
    if (tagName === 'input' || tagName === 'textarea' || e.target?.isContentEditable) return;
    if (e.key === ' ') { e.preventDefault(); if (playing) pause(); else play(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  };

  btnPlay.textContent = '播放';
  render();

  return {
    node: host,
    total,
    /** 离开这个视图时必须叫一下 —— 不然 rAF 会一直跑，而且视频还在解码 */
    stop: () => pause(),
    focus: () => host.focus()
  };
}

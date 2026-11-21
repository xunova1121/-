import './nestClock.css';

// 1536×1024 原画中墙钟的轴心为 (567.5,137.5)。只用同一张底图的空白表盘遮掉印在上面的指针，
// 保留原画的数字、木框和灯光。1080 宽的手机版按比例取样。
function restoreDial(canvas, art) {
  if (!art.complete || !art.naturalWidth) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const xScale = art.naturalWidth / 1536;
  const yScale = art.naturalHeight / 1024;
  ctx.clearRect(0, 0, 70, 70);
  ctx.save();
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.lineWidth = 6;
  ctx.shadowBlur = 1.7;
  ctx.shadowColor = '#000';
  ctx.beginPath();
  ctx.moveTo(20.2, 23.5);
  ctx.lineTo(35, 35);
  ctx.lineTo(51.2, 23.8);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(35, 35, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.globalCompositeOperation = 'source-in';
  ctx.drawImage(art, 557 * xScale, 120 * yScale, 21 * xScale, 4 * yScale, 0, 0, 70, 70);
  ctx.globalCompositeOperation = 'source-over';
}

export function createNestClock(floor, art) {
  const clock = document.createElement('time');
  clock.className = 'nest-wall-clock';
  clock.hidden = true;
  const dial = document.createElement('canvas');
  dial.className = 'nest-clock-dial';
  dial.width = dial.height = 70;
  const hour = document.createElement('i');
  hour.className = 'nest-clock-hour';
  const minute = document.createElement('i');
  minute.className = 'nest-clock-minute';
  clock.append(dial, hour, minute);
  floor.append(clock);

  let visible = false;
  let foreground = true;
  let timer;
  function syncTime() {
    clearTimeout(timer);
    if (!visible || !foreground || document.hidden) return;
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const label = String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
    if (clock.dateTime !== label) {
      clock.dateTime = label;
      clock.setAttribute('aria-label', '墙钟 ' + label);
      hour.style.transform = 'rotate(' + (hours % 12 * 30 + minutes / 2) + 'deg)';
      minute.style.transform = 'rotate(' + minutes * 6 + 'deg)';
    }
    timer = setTimeout(syncTime, 60000 - now.getSeconds() * 1000 - now.getMilliseconds());
  }
  function onForeground(event) {
    foreground = event.detail?.active !== false;
    syncTime();
  }
  function onPageShow() {
    foreground = true;
    syncTime();
  }
  const onArtLoad = () => restoreDial(dial, art);
  function setVisible(shown) {
    if (visible === shown) return;
    visible = shown;
    clock.hidden = !shown;
    if (shown) {
      foreground = true;
      art.addEventListener('load', onArtLoad);
      window.addEventListener('jarvis:foreground', onForeground);
      window.addEventListener('pageshow', onPageShow);
      onArtLoad();
    } else {
      art.removeEventListener('load', onArtLoad);
      window.removeEventListener('jarvis:foreground', onForeground);
      window.removeEventListener('pageshow', onPageShow);
    }
    syncTime();
  }
  return {setVisible};
}

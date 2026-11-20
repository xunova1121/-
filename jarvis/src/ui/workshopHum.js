// 用户点唱的一小段房间哼声。声音在本机合成，锁屏或离开页面时立即收声。
let voice = null;

export function stopWorkshopHum() {
  if (!voice) return;
  const old = voice;
  voice = null;
  clearTimeout(old.timer);
  document.removeEventListener('visibilitychange', old.visibility);
  window.removeEventListener('pagehide', stopWorkshopHum);
  window.removeEventListener('jarvis:foreground', old.foreground);
  old.context.close().catch(() => {});
}

export function playWorkshopHum() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context || document.hidden) return false;
  stopWorkshopHum();
  // 轻声闭口哼唱，低频谐波配合气口、滑音和轻微颤音。
  const melody = [[60, .43], [64, .34], [67, .65], [65, .38], [64, .54], [62, .37], [60, .82]];
  let context;
  try {
    context = new Context();
    const visibility = () => { if (document.hidden) stopWorkshopHum(); };
    const foreground = (event) => { if (event.detail?.active === false) stopWorkshopHum(); };
    voice = { context, visibility, foreground };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', stopWorkshopHum);
    window.addEventListener('jarvis:foreground', foreground);
    const wave = context.createPeriodicWave(new Float32Array(7), Float32Array.from([0, 1, .46, .25, .38, .12, .065]));
    const vibrato = context.createOscillator();
    const depth = context.createGain();
    vibrato.frequency.value = 4.7;
    depth.gain.value = 6;
    vibrato.connect(depth);
    vibrato.start();
    let at = context.currentTime + .05;
    for (const [note, length] of melody) {
      const pitch = 440 * 2 ** ((note - 69) / 12);
      const tone = context.createOscillator();
      const gain = context.createGain();
      tone.setPeriodicWave(wave);
      tone.frequency.setValueAtTime(pitch * .978, at);
      tone.frequency.exponentialRampToValueAtTime(pitch, at + .09);
      depth.connect(tone.detune);
      gain.gain.setValueAtTime(.0001, at);
      gain.gain.exponentialRampToValueAtTime(.115, at + .07);
      gain.gain.exponentialRampToValueAtTime(.065, at + length - .08);
      gain.gain.exponentialRampToValueAtTime(.0001, at + length);
      tone.connect(gain).connect(context.destination);
      tone.start(at);
      tone.stop(at + length);
      at += length + .055;
    }
    vibrato.stop(at);
    voice.timer = setTimeout(stopWorkshopHum, (at - context.currentTime) * 1000 + 120);
    context.resume().catch(() => { if (voice?.context === context) stopWorkshopHum(); });
    return true;
  } catch {
    if (voice?.context === context) stopWorkshopHum();
    return false;
  }
}

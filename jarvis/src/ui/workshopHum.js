import { WORKSHOP_HUM_MINUTES } from '../app/workshopLife.js';
import { workshopTunes } from './workshopTunes.js';

let voice = null;
let remaining = [];
let previousTune;
let suggestion;

function availableTunes() {
  if (!remaining.length) remaining = workshopTunes.slice();
  // 一轮内每首只哼一次，换轮时也避开刚哼过的曲子。
  return remaining.filter((tune) => tune !== previousTune);
}

export function suggestWorkshopTune() {
  // 房间和对话在同一个作息时段显示同一首，反复查询不会改变候选曲目。
  const now = Date.now();
  if (!suggestion || now < suggestion.at || now - suggestion.at >= WORKSHOP_HUM_MINUTES * 60000) {
    const choices = availableTunes();
    suggestion = { title: choices[Math.floor(Math.random() * choices.length)].title, at: now };
  }
  return suggestion.title;
}

function nextTune(requested) {
  const choices = availableTunes();
  const tune = choices.find((choice) => choice.title === requested) ?? choices[Math.floor(Math.random() * choices.length)];
  remaining.splice(remaining.indexOf(tune), 1);
  previousTune = tune;
  suggestion = null;
  return tune;
}

export function workshopHumTitle() {
  return voice?.title || '';
}

function announceTune() {
  window.dispatchEvent(new Event('jarvis:workshop-song'));
}

export function stopWorkshopHum() {
  if (!voice) return;
  const old = voice;
  voice = null;
  clearTimeout(old.timer);
  document.removeEventListener('visibilitychange', old.visibility);
  window.removeEventListener('pagehide', stopWorkshopHum);
  window.removeEventListener('jarvis:foreground', old.foreground);
  old.context.close().catch(() => {});
  announceTune();
}

// 用同一条声带按谱哼完整句；气口、滑音和微颤在 Web Audio 的音频时钟上调度。
function humNext(session, requested) {
  const tune = nextTune(requested);
  const { context } = session;
  const tone = context.createOscillator();
  const volume = context.createGain();
  tone.setPeriodicWave(session.wave);
  tone.connect(volume).connect(context.destination);
  session.vibratoDepth.connect(tone.detune);
  let at = context.currentTime + .05;
  const start = at;
  for (const [note, beats] of tune.notes) {
    const pitch = 440 * 2 ** ((note - 69) / 12);
    const length = beats * 60 / tune.bpm;
    const release = at + length * .92;
    tone.frequency.setValueAtTime(pitch * .978, at);
    tone.frequency.exponentialRampToValueAtTime(pitch, at + .07);
    volume.gain.setValueAtTime(.0001, at);
    volume.gain.exponentialRampToValueAtTime(.115, at + .06);
    volume.gain.exponentialRampToValueAtTime(.065, release - .06);
    volume.gain.exponentialRampToValueAtTime(.0001, release);
    at += length;
  }
  tone.onended = () => {
    if (voice !== session) return;
    session.vibratoDepth.disconnect(tone.detune);
    tone.disconnect();
    volume.disconnect();
    if (document.hidden) stopWorkshopHum();
    else humNext(session);
  };
  tone.start(start);
  tone.stop(at + .5);
  session.title = tune.title;
  announceTune();
}

export function playWorkshopHum(requested) {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context || document.hidden) return false;
  stopWorkshopHum();
  let session;
  try {
    session = { context: new Context() };
    voice = session;
    const { context } = session;
    session.visibility = () => { if (document.hidden) stopWorkshopHum(); };
    session.foreground = (event) => { if (event.detail?.active === false) stopWorkshopHum(); };
    document.addEventListener('visibilitychange', session.visibility);
    window.addEventListener('pagehide', stopWorkshopHum);
    window.addEventListener('jarvis:foreground', session.foreground);
    session.wave = context.createPeriodicWave(new Float32Array(7), Float32Array.from([0, 1, .46, .25, .38, .12, .065]));
    const vibrato = context.createOscillator();
    session.vibratoDepth = context.createGain();
    vibrato.frequency.value = 4.7;
    session.vibratoDepth.gain.value = 6;
    vibrato.connect(session.vibratoDepth);
    vibrato.start();
    session.timer = setTimeout(stopWorkshopHum, WORKSHOP_HUM_MINUTES * 60000);
    context.resume().catch(() => { if (voice === session) stopWorkshopHum(); });
    humNext(session, requested);
    return session.title;
  } catch {
    if (session && voice === session) stopWorkshopHum();
    return false;
  }
}

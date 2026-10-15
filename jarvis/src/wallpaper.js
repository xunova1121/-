/**
 * 桌面背景页（桌面版）：只有粒子体、时钟和轨道 HUD。
 * 自己不跑智能体：主窗口把“在做什么”（造型、表达色、要说的话）同步过来，这里照着显示——
 * 未央在后台干活时，桌面上的粒子体也跟着变形。
 */
import { createStage } from './render/stage.js';
import { FORMS } from './render/formations.js';
import { initOrbitHud } from './ui/orbitHud.js';
import { EMOTION_PARAMS } from './core/emotions.js';

const $ = (s) => document.querySelector(s);
const desktop = window.jarvisDesktop;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

let hue = 200;
let hueTarget = 200;
let speak = 0;
let speakUntil = 0;
let blinkAt = performance.now() + 3000;

const stage = (() => {
  try { return createStage($('#stage'), { lowEnd: (navigator.hardwareConcurrency || 8) <= 4 }); } catch (e) { console.warn('[wallpaper] WebGL 不可用', e); return null; }
})();
const orbit = initOrbitHud({ root: $('#stage-wrap'), getAnchor: () => stage?.anchor?.() ?? null, reducedMotion: () => reduced });
orbit.setStatus('STANDBY · DESKTOP');

if (stage) {
  stage.setFpsCap(reduced ? 15 : 30); // 当背景用，30fps 足够，省电
  stage.setQuality({ bloom: true, stars: true });
  stage.onFrame((dt, t) => {
    hue += (hueTarget - hue) * Math.min(1, dt / 400);
    speak += ((t < speakUntil ? 0.45 + 0.3 * Math.sin(t / 90) : 0) - speak) * 0.2;
    let blink = 1;
    if (t > blinkAt) {
      blink = Math.abs(t - blinkAt - 75) / 75;
      if (t - blinkAt > 150) { blink = 1; blinkAt = t + 3000 + Math.random() * 3000; }
    }
    return { hue, glow: 0.55, spin: 0.15, scanSpeed: 0.1, glitch: 0, blink, yaw: Math.sin(t / 4100) * 0.12, pitch: Math.sin(t / 5300) * 0.05, breath: 0.4 + 0.4 * Math.sin(t / 1600), speak, motion: reduced ? 0.2 : 1 };
  });
  stage.setPaused('hidden', document.hidden); // 启动渲染循环
  document.addEventListener('visibilitychange', () => stage.setPaused('hidden', document.hidden));
}

// 时钟
const WEEK = '日一二三四五六';
function tick() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  $('#wp-time').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('#wp-date').textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${WEEK[d.getDay()]}`;
}
tick();
setInterval(tick, 10000);

let sayTimer = 0;
const forms = [];
function show(payload) {
  if (payload.form && FORMS[payload.form]) {
    stage?.setForm(payload.form);
    forms.push(payload.form);
    $('#wp-form').textContent = FORMS[payload.form].name;
    orbit.setStatus(`${payload.form.toUpperCase()} · ${payload.task || 'STANDBY'}`);
  }
  if (payload.emotion && EMOTION_PARAMS[payload.emotion]) hueTarget = EMOTION_PARAMS[payload.emotion].hue;
  if (payload.energy !== undefined) stage?.setActivity({ energy: payload.energy });
  if (payload.tool) { orbit.toolStart(payload.tool.id, payload.tool.label); }
  if (payload.toolDone) orbit.toolEnd(payload.toolDone.id, payload.toolDone.ok);
  if (payload.newTurn) orbit.newTurn();
  if (payload.think) orbit.think(payload.think);
  if (payload.say) {
    const el = $('#wp-say');
    el.textContent = payload.say;
    el.hidden = false;
    el.classList.remove('in');
    void el.offsetWidth;
    el.classList.add('in');
    speakUntil = performance.now() + Math.min(9000, 1500 + payload.say.length * 180);
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => { el.classList.remove('in'); setTimeout(() => { el.hidden = true; }, 600); }, 14000);
  }
}
desktop?.onWallpaper?.(show);
window.__wallpaper = { show, forms, get stage() { return stage; } };

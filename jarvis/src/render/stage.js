/**
 * Three.js 主视觉：粒子体。只负责“画”：每帧从调用方给的 frame(state) 回调取参数，写进 uniform。
 * 所有状态推断（情绪、人脸角度、语音包络、该变成什么造型）都在外面的控制器里完成。
 *
 * 场景：粒子体（上万个粒子，在光核 / 地球 / 星系 / 晶格……之间变形，见 formations.js）· 投影光柱 · 光环与底座线框 · 底座光盘 · 星尘。
 * Draw calls：5；开启泛光再加 4 个全屏 pass。
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, BufferGeometry, BufferAttribute, Points, Mesh, LineSegments,
  ShaderMaterial, AdditiveBlending, PlaneGeometry, CylinderGeometry, Vector2, Vector3, DoubleSide
} from 'three';
import { createBloom } from './bloom.js';
import {
  coneVertex, coneFragment, swarmVertex, swarmFragment,
  rigVertex, rigFragment, padVertex, padFragment, starVertex, starFragment
} from './shaders.js';
import { buildForm, FORMS, EYE_FRACTION } from './formations.js';

const FOV = 38;
const ORB_RADIUS = 27;
const MORPH_MS = 1700;
const TAU = Math.PI * 2;
/** 场景布局（原胸像模型的尺寸，光环、底座都按它摆放） */
export const META = { pedestalY: -66, haloY: 8, haloRadius: 42, cameraY: -8 };

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ lowEnd?: boolean, onContextChange?: Function }} [o]
 */
export function createStage(canvas, { lowEnd = false, onContextChange } = {}) {
  const meta = META;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x02060b, 1);
  // 一帧里有多次 render（泛光各 pass），draw call 统计按帧手动清零
  renderer.info.autoReset = false;
  const isWebGL2 = renderer.capabilities.isWebGL2;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 3000);
  camera.position.set(0, meta.cameraY + 6, 250);
  camera.lookAt(0, meta.cameraY, 0);

  const additive = { transparent: true, depthWrite: false, blending: AdditiveBlending };

  // —— 共享 uniform
  const U = {
    u_time: { value: 0 },
    u_motion: { value: 1 },
    u_hue: { value: 200 },
    u_glow: { value: 0.6 },
    u_perspectiveScale: { value: 500 },
    u_rigTime: { value: 0 }
  };

  // —— 粒子体：没有显卡（软件渲染）时也用轻量粒子数
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const softGL = /swiftshader|llvmpipe|software|basic render/i.test(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '');
  const N = lowEnd || softGL ? 6000 : 14000;
  const formCache = new Map();
  const form = (name) => {
    if (!formCache.has(name)) formCache.set(name, buildForm(name, N));
    return formCache.get(name);
  };
  const swarmU = {
    u_time: U.u_time, u_motion: U.u_motion, u_hue: U.u_hue, u_glow: U.u_glow, u_perspectiveScale: U.u_perspectiveScale,
    u_mix: { value: 1 }, u_spin: { value: 0 }, u_spinAmt: { value: 1 }, u_yaw: { value: 0 }, u_pitch: { value: 0 },
    u_breath: { value: 0 }, u_speak: { value: 0 }, u_energy: { value: 0 }, u_audio: { value: 0 },
    u_blink: { value: 1 }, u_eyeAmt: { value: 1 }, u_size: { value: lowEnd ? 2.6 : 2.0 }
  };
  const swarm = (() => {
    const g = new BufferGeometry();
    const core = form('core');
    const from = new Float32Array(core);
    const to = new Float32Array(core);
    const rand = new Float32Array(N * 4);
    let sd = 99;
    const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);
    const eyeN = Math.floor(N * EYE_FRACTION);
    for (let i = 0; i < N; i++) rand.set([rnd(), rnd(), rnd(), i < eyeN ? 1 : 0], i * 4);
    g.setAttribute('position', new BufferAttribute(new Float32Array(core), 3));
    g.setAttribute('a_from', new BufferAttribute(from, 3));
    g.setAttribute('a_to', new BufferAttribute(to, 3));
    g.setAttribute('a_rand', new BufferAttribute(rand, 4));
    const p = new Points(g, new ShaderMaterial({ uniforms: swarmU, vertexShader: swarmVertex, fragmentShader: swarmFragment, ...additive }));
    p.frustumCulled = false;
    p.position.y = meta.haloY;
    return p;
  })();
  scene.add(swarm);
  const morph = { target: 'core', mix: 1, rot: 0, eyeAmt: 1 };
  /** 变到另一个造型：从“此刻的样子”出发，不会跳 */
  function setForm(name) {
    if (!FORMS[name] || name === morph.target) return false;
    const g = swarm.geometry;
    const from = g.attributes.a_from.array, to = g.attributes.a_to.array, rand = g.attributes.a_rand.array;
    for (let i = 0; i < N; i++) {
      let m = Math.min(1, Math.max(0, morph.mix * 1.35 - rand[i * 4] * 0.35));
      m = m * m * (3 - 2 * m);
      for (let k = 0; k < 3; k++) from[i * 3 + k] += (to[i * 3 + k] - from[i * 3 + k]) * m;
    }
    to.set(form(name));
    g.attributes.a_from.needsUpdate = true;
    g.attributes.a_to.needsUpdate = true;
    morph.target = name;
    morph.mix = 0;
    stats.form = name;
    return true;
  }

  // —— 投影光柱：底座 → 胸像底部
  const coneUniforms = { u_time: U.u_time, u_hue: U.u_hue, u_intensity: { value: 1 } };
  const coneH = (meta.haloY - ORB_RADIUS + 6) - meta.pedestalY;
  const cone = new Mesh(new CylinderGeometry(46, 21, coneH, 64, 1, true), new ShaderMaterial({
    uniforms: coneUniforms, vertexShader: coneVertex, fragmentShader: coneFragment, side: DoubleSide, ...additive
  }));
  cone.frustumCulled = false;
  scene.add(cone);
  cone.position.y = meta.pedestalY + coneH / 2;

  // —— 光环与底座线框（一个 LineSegments）
  const rigUniforms = { u_rigTime: U.u_rigTime, u_hue: U.u_hue, u_opacity: { value: 1 } };
  const rig = (() => {
    const pos = [], anim = [], bright = [];
    const seg = (a, b, an, br) => { pos.push(...a, ...b); anim.push(...an, ...an); bright.push(br, br); };
    const flatRing = (radius, n, an, br, dash = 0) => {
      for (let i = 0; i < n; i++) {
        if (dash && Math.floor(i / dash) % 2) continue;
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        seg([Math.cos(a0) * radius, 0, Math.sin(a0) * radius], [Math.cos(a1) * radius, 0, Math.sin(a1) * radius], an, br);
      }
    };
    const arc = (radius, from, to, n, an, br) => {
      for (let i = 0; i < n; i++) {
        const a0 = from + ((to - from) * i) / n, a1 = from + ((to - from) * (i + 1)) / n;
        seg([Math.cos(a0) * radius, Math.sin(a0) * radius, 0], [Math.cos(a1) * radius, Math.sin(a1) * radius, 0], an, br);
      }
    };
    const py = meta.pedestalY;
    flatRing(21, 96, [py, 0, 0, 0], 1.0);
    flatRing(27, 128, [py, 0, 0, 0.5], 0.8, 6);
    flatRing(36, 160, [py, 0, 0, 0], 0.6);
    flatRing(46, 192, [py, 0, 0, -0.25], 0.4, 3);
    flatRing(64, 192, [py, 0, 0, 0], 0.2);
    flatRing(36, 160, [py - 3, 0, 0, 0], 0.35);
    flatRing(30, 128, [py - 6, 0, 0, 0], 0.25);
    const hy = meta.haloY, R = meta.haloRadius;
    arc(R, 0, Math.PI * 2, 192, [hy, -26, 1, 0], 0.4);
    arc(R + 5, 0.2, 1.4, 48, [hy, -26, 1, 0.16], 0.75);
    arc(R + 5, Math.PI + 0.2, Math.PI + 1.4, 48, [hy, -26, 1, 0.16], 0.75);
    arc(R - 4, 2.0, 2.9, 30, [hy, -26, 1, -0.1], 0.5);
    arc(R - 4, 5.1, 6.0, 30, [hy, -26, 1, -0.1], 0.5);
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const len = i % 6 === 0 ? 4 : 1.8;
      seg([Math.cos(a) * (R + 9), Math.sin(a) * (R + 9), 0], [Math.cos(a) * (R + 9 + len), Math.sin(a) * (R + 9 + len), 0], [hy, -26, 1, -0.06], i % 6 === 0 ? 0.6 : 0.28);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('a_anim', new BufferAttribute(new Float32Array(anim), 4));
    g.setAttribute('a_bright', new BufferAttribute(new Float32Array(bright), 1));
    const line = new LineSegments(g, new ShaderMaterial({ uniforms: rigUniforms, vertexShader: rigVertex, fragmentShader: rigFragment, ...additive }));
    line.frustumCulled = false;
    return line;
  })();
  scene.add(rig);

  // —— 底座光盘
  const padUniforms = { u_hue: U.u_hue, u_time: U.u_time, u_intensity: { value: 0.8 } };
  const pad = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
    uniforms: padUniforms, vertexShader: padVertex, fragmentShader: padFragment, side: DoubleSide, ...additive
  }));
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = meta.pedestalY;
  pad.scale.setScalar(52);
  pad.frustumCulled = false;
  scene.add(pad);

  // —— 星尘
  const stars = (() => {
    const n = lowEnd ? 250 : 600;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    let s = 11;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = 280 + rnd() * 500, q = Math.sqrt(1 - u * u);
      pos.set([Math.cos(th) * q * r, u * r * 0.7, Math.sin(th) * q * r - 220], i * 3);
      seed[i] = rnd();
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('a_seed', new BufferAttribute(seed, 1));
    const p = new Points(g, new ShaderMaterial({ uniforms: { u_time: U.u_time, u_perspectiveScale: U.u_perspectiveScale, u_hue: U.u_hue }, vertexShader: starVertex, fragmentShader: starFragment, ...additive }));
    p.frustumCulled = false;
    return p;
  })();
  scene.add(stars);

  // —— 尺寸
  const tmpSize = new Vector2();
  let bloom = null;
  let quality = { bloom: false, stars: true };
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = w / h < 1 ? 250 / Math.max(0.55, w / h) : 250;
    camera.updateProjectionMatrix();
    const scale = renderer.getDrawingBufferSize(tmpSize).y / (2 * Math.tan((FOV * Math.PI) / 360));
    U.u_perspectiveScale.value = scale;
    bloom?.setSize();
  }
  const anchorV = new Vector3();
  const anchorE = new Vector3();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // —— 渲染循环：暂停原因是一个集合（后台 / 不在视口 / 上下文丢失），任一存在即停
  let raf = 0;
  let last = 0;
  let lastDrawn = 0;
  let fpsCap = 60;
  let frameFn = null;
  const pausedBy = new Set();
  const stats = { frames: 0, fps: 0, isWebGL2, particles: N, drawCalls: 0, bloom: false, form: 'core', _acc: 0, _n: 0 };

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - lastDrawn < 1000 / fpsCap - 2) return;
    const dt = last ? Math.min(now - last, 100) : 16.7;
    last = now;
    lastDrawn = now;
    const s = frameFn?.(dt, now);
    if (s) apply(s, now, dt);
    draw();
    stats.frames++;
    stats.drawCalls = renderer.info.render.calls;
    stats._acc += dt;
    stats._n++;
    if (stats._acc >= 1000) {
      stats.fps = Math.round((stats._n * 1000) / stats._acc);
      stats._acc = 0;
      stats._n = 0;
    }
  }

  function draw() {
    renderer.info.reset();
    if (bloom) bloom.render(scene, camera);
    else renderer.render(scene, camera);
  }

  function apply(s, now, dt = 0) {
    U.u_time.value = now / 1000;
    U.u_motion.value = s.motion;
    U.u_hue.value = s.hue;
    U.u_glow.value = s.glow;
    // 光环与底座的转速随情绪的角速度变化（平静 0.15 rad/s 为基准）
    U.u_rigTime.value += (dt / 1000) * (s.spin / 0.15) * s.motion;
    // 变形进度
    morph.mix = Math.min(1, morph.mix + dt / MORPH_MS);
    swarmU.u_mix.value = morph.mix;
    // 带脸的造型（光核、观察之眼）转回正面看着用户；其他造型缓慢自转，干活时转得快一些
    const face = Boolean(FORMS[morph.target].eyes || FORMS[morph.target].face);
    if (face) {
      const home = Math.round(morph.rot / TAU) * TAU;
      morph.rot += (home - morph.rot) * Math.min(1, dt / 500);
    } else morph.rot += (dt / 1000) * (0.22 + activity.energy * 0.5) * s.motion;
    swarmU.u_spin.value = morph.rot;
    morph.eyeAmt += ((FORMS[morph.target].eyes ? 1 : 0) - morph.eyeAmt) * Math.min(1, dt / 400);
    swarmU.u_eyeAmt.value = morph.eyeAmt;
    swarmU.u_yaw.value = s.yaw * (face ? 1 : 0.35);
    swarmU.u_pitch.value = s.pitch * (face ? 1 : 0.35);
    swarmU.u_breath.value = s.breath;
    swarmU.u_speak.value = s.speak;
    swarmU.u_blink.value = s.blink;
    swarmU.u_energy.value += (activity.energy - swarmU.u_energy.value) * Math.min(1, dt / 300);
    swarmU.u_audio.value += (activity.audio - swarmU.u_audio.value) * Math.min(1, dt / 120);
    // 缓慢上下漂浮
    swarm.position.y = meta.haloY + Math.sin((now / 1000) * s.motion * 0.8) * 1.6;
    padUniforms.u_intensity.value = 0.6 + 0.4 * s.glow + s.speak * 0.4;
    coneUniforms.u_intensity.value = 0.7 + 0.5 * s.glow + s.speak * 0.5;
    rigUniforms.u_opacity.value = 0.7 + 0.3 * s.glow;
    if (bloom) bloom.strength = 0.6 + s.glow * 0.8 + s.speak * 0.5;
    stars.rotation.y = (now / 1000) * s.motion * 0.004;
  }
  const activity = { energy: 0, audio: 0 };

  function sync() {
    const run = pausedBy.size === 0;
    if (run && !raf) {
      last = 0;
      raf = requestAnimationFrame(loop);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  // —— WebGL 上下文丢失与恢复（three.js 在 restored 时重建 GL 状态并重新上传缓冲）
  let lostAt = 0;
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lostAt = performance.now();
    pausedBy.add('context');
    sync();
    onContextChange?.('lost');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    pausedBy.delete('context');
    resize();
    sync();
    onContextChange?.('restored', performance.now() - lostAt);
  });

  return {
    renderer,
    stats,
    onFrame(fn) { frameFn = fn; },
    setPaused(reason, on) {
      if (on) pausedBy.add(reason);
      else pausedBy.delete(reason);
      sync();
    },
    get running() { return raf !== 0; },
    setFpsCap(n) { fpsCap = n; },
    /**
     * 光核（或胸像头部）在画布上的位置与半径（CSS 像素，相对画布左上角）。
     * 建议标注的虚线从这里引出，跟着光核的浮动一起动。
     */
    anchor() {
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      const y = swarm.position.y;
      const c = anchorV.set(0, y, 0).project(camera);
      const e = anchorE.set(ORB_RADIUS, y, 0).project(camera);
      return { x: (c.x + 1) / 2 * w, y: (1 - c.y) / 2 * h, r: Math.abs(e.x - c.x) / 2 * w };
    },
    /** 变形到某个造型（见 formations.js 的 FORMS）；返回是否真的开始变形 */
    setForm,
    get form() { return morph.target; },
    /** 工作强度（0–1，思考 / 执行工具时粒子更活跃）与麦克风音量（0–1） */
    setActivity({ energy, audio } = {}) {
      if (energy !== undefined) activity.energy = Math.max(0, Math.min(1, energy));
      if (audio !== undefined) activity.audio = Math.max(0, Math.min(1, audio));
    },
    /** 画质：bloom 泛光开关、星尘开关 */
    setQuality(q) {
      quality = { ...quality, ...q };
      if (quality.bloom && !bloom) {
        bloom = createBloom(renderer);
        bloom.setSize();
      } else if (!quality.bloom && bloom) {
        bloom.dispose();
        bloom = null;
        renderer.setRenderTarget(null);
      }
      stars.visible = quality.stars;
      stats.bloom = Boolean(bloom);
    },
    renderOnce(now = performance.now()) {
      const s = frameFn?.(0, now);
      if (s) apply(s, now);
      draw();
    },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      bloom?.dispose();
      scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      renderer.dispose();
    }
  };
}

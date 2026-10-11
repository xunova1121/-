/**
 * Three.js 主视觉。只负责“画”：每帧从调用方给的 frame(state) 回调取参数，写进 uniform。
 * 所有状态推断（情绪、形态、人脸角度）都在外面的控制器里完成。
 *
 * Draw calls：粒子 1 + 发光核心 1 + 轨道线 3 + 星尘 1 = 6（预算 ≤ 12）。
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, BufferGeometry, BufferAttribute, Points,
  ShaderMaterial, AdditiveBlending, Mesh, PlaneGeometry, LineLoop, LineBasicMaterial, Color, Vector2
} from 'three';
import { buildParticles, buildStars, RINGS, CORE_RADIUS } from './particles.js';
import {
  particleVertex, particleFragment, coreVertex, coreFragment, starVertex, starFragment
} from './shaders.js';

const FOV = 38;

export function createStage(canvas, { humanPoints, lowEnd = false, onContextChange } = {}) {
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const isWebGL2 = renderer.capabilities.isWebGL2;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 3000);
  camera.position.set(0, -18, 250);
  camera.lookAt(0, -26, 0);

  // —— 主粒子
  const pd = buildParticles(humanPoints, { lowEnd });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pd.humanPos, 3));
  geo.setAttribute('a_humanPosition', new BufferAttribute(pd.humanPos, 3));
  geo.setAttribute('a_spherePosition', new BufferAttribute(pd.spherePos, 3));
  geo.setAttribute('a_meta', new BufferAttribute(pd.meta, 4));
  const uniforms = {
    u_time: { value: 0 },
    u_morphFactor: { value: 0.85 },
    u_spin: { value: 0 },
    u_yaw: { value: 0 },
    u_pitch: { value: 0 },
    u_sway: { value: 2.5 },
    u_orbitJitter: { value: 0.06 },
    u_inward: { value: 0.08 },
    u_breath: { value: 0 },
    u_radius: { value: CORE_RADIUS },
    u_perspectiveScale: { value: 500 },
    u_pointScale: { value: 1 },
    u_hue: { value: 200 },
    u_motion: { value: 1 }
  };
  const particles = new Points(geo, new ShaderMaterial({
    uniforms,
    vertexShader: particleVertex,
    fragmentShader: particleFragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  }));
  particles.frustumCulled = false;
  scene.add(particles);

  // —— 发光核心
  const coreUniforms = { u_size: { value: 26 }, u_coreGlow: { value: 0.6 }, u_hue: uniforms.u_hue, u_pulse: { value: 0 } };
  const core = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
    uniforms: coreUniforms,
    vertexShader: coreVertex,
    fragmentShader: coreFragment,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  }));
  core.frustumCulled = false;
  scene.add(core);

  // —— 轨道线（与轨道粒子共用 RINGS 参数，粒子正好沿线运动）
  const rings = lowEnd ? [] : RINGS.map((r) => {
    const n = 192;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      p.set([Math.cos(a) * CORE_RADIUS * r.radius, 0, Math.sin(a) * CORE_RADIUS * r.radius], i * 3);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(p, 3));
    const line = new LineLoop(g, new LineBasicMaterial({
      color: new Color(), transparent: true, opacity: 0.22, depthWrite: false, blending: AdditiveBlending
    }));
    line.rotation.order = 'YXZ';
    scene.add(line);
    return { line, def: r };
  });

  // —— 星尘
  const sd = buildStars(lowEnd ? 250 : 700);
  const sg = new BufferGeometry();
  sg.setAttribute('position', new BufferAttribute(sd.pos, 3));
  sg.setAttribute('a_seed', new BufferAttribute(sd.seed, 1));
  const starUniforms = { u_time: uniforms.u_time, u_perspectiveScale: uniforms.u_perspectiveScale, u_hue: uniforms.u_hue };
  const stars = new Points(sg, new ShaderMaterial({
    uniforms: starUniforms, vertexShader: starVertex, fragmentShader: starFragment,
    transparent: true, depthWrite: false, blending: AdditiveBlending
  }));
  stars.frustumCulled = false;
  scene.add(stars);

  // —— 尺寸
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // 竖屏时拉远相机，保证人形完整
    camera.position.z = w / h < 1 ? 250 / Math.max(0.55, w / h) : 250;
    camera.updateProjectionMatrix();
    uniforms.u_perspectiveScale.value = renderer.getDrawingBufferSize(tmpSize).y / (2 * Math.tan((FOV * Math.PI) / 360));
  }
  const tmpSize = new Vector2();
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
  const stats = { frames: 0, fps: 0, isWebGL2, count: pd.count, drawCalls: 0, _acc: 0, _n: 0 };

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - lastDrawn < 1000 / fpsCap - 2) return;
    const dt = last ? Math.min(now - last, 100) : 16.7;
    last = now;
    lastDrawn = now;
    const s = frameFn?.(dt, now);
    if (s) apply(s, now);
    renderer.render(scene, camera);
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

  function apply(s, now) {
    uniforms.u_time.value = now / 1000;
    uniforms.u_morphFactor.value = s.morph;
    uniforms.u_spin.value = s.spinAngle;
    uniforms.u_yaw.value = s.yaw;
    uniforms.u_pitch.value = s.pitch;
    uniforms.u_orbitJitter.value = s.jitter;
    uniforms.u_inward.value = s.inward;
    uniforms.u_breath.value = s.breath;
    uniforms.u_hue.value = s.hue;
    uniforms.u_motion.value = s.motion;
    coreUniforms.u_coreGlow.value = s.glow;
    coreUniforms.u_pulse.value = s.breath * 6;
    coreUniforms.u_size.value = 18 + 16 * s.morph + s.breath * 60;
    const t = (now / 1000) * s.motion;
    for (const [i, r] of rings.entries()) {
      r.line.rotation.set(r.def.tilt + s.jitter * Math.sin(t * 0.7 + i * 2.1), s.spinAngle * 0.6 + r.def.phase, 0);
      r.line.material.color.setHSL(s.hue / 360, 0.85, 0.62);
      r.line.material.opacity = 0.12 + 0.16 * s.morph;
    }
    stars.rotation.y = t * 0.004;
  }

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
    renderOnce(now = performance.now()) {
      const s = frameFn?.(0, now);
      if (s) apply(s, now);
      renderer.render(scene, camera);
    },
    dispose() {
      cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      renderer.dispose();
    }
  };
}

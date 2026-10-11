/**
 * Three.js 主视觉：全息胸像。只负责“画”：每帧从调用方给的 frame(state) 回调取参数，写进 uniform。
 * 所有状态推断（情绪、人脸角度、语音包络）都在外面的控制器里完成。
 *
 * 场景：主体（光核 / 全息胸像 / 线框胸像 三选一）· 投影光柱 · 光环与底座线框 · 底座光盘 · 星尘；
 *       胸像样式另有电路线与双眼光点（光核的眼睛画在自己的着色器里）。
 * Draw calls：光核 5、胸像 7；开启泛光再加 4 个全屏 pass，最多 11（预算 ≤ 12）。
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, BufferGeometry, BufferAttribute, Points, Mesh, LineSegments,
  ShaderMaterial, AdditiveBlending, PlaneGeometry, CylinderGeometry, WireframeGeometry, IcosahedronGeometry,
  Vector2, Vector3, DoubleSide, FrontSide
} from 'three';
import { createBloom } from './bloom.js';
import {
  holoVertex, holoFragment, lineVertex, lineFragment, eyeVertex, eyeFragment, coneVertex, coneFragment,
  orbVertex, orbFragment,
  rigVertex, rigFragment, padVertex, padFragment, starVertex, starFragment
} from './shaders.js';

const FOV = 38;
const ORB_RADIUS = 27;

/** 解析 scripts/build-hologram.mjs 输出的网格二进制 */
export function parseMesh(buffer) {
  const [V, I] = new Uint32Array(buffer, 0, 2);
  let off = 8;
  const positions = new Float32Array(buffer, off, V * 3); off += V * 12;
  const normals = new Float32Array(buffer, off, V * 3); off += V * 12;
  const indices = new Uint16Array(buffer, off, I);
  return { positions, normals, indices };
}

/**
 * @param {{ mesh: ArrayBuffer, meta: object }} figure
 */
export function createStage(canvas, { figure, lowEnd = false, onContextChange } = {}) {
  const meta = figure.meta;
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
    u_yaw: { value: 0 },
    u_pitch: { value: 0 },
    u_neckY: { value: meta.neckY ?? -8 },
    u_breath: { value: 0 },
    u_glitch: { value: 0 },
    u_hue: { value: 200 },
    u_glow: { value: 0.6 },
    u_speak: { value: 0 },
    u_scanSpeed: { value: 0.1 },
    u_bottom: { value: meta.bottom ?? -62 },
    u_scanBase: { value: meta.pedestalY },
    u_perspectiveScale: { value: 500 },
    u_rigTime: { value: 0 }
  };

  // —— 胸像几何
  const { positions, normals, indices } = parseMesh(figure.mesh);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  geo.setIndex(new BufferAttribute(indices, 1));

  const body = {
    holo: new Mesh(geo, new ShaderMaterial({ uniforms: U, vertexShader: holoVertex, fragmentShader: holoFragment, side: FrontSide, ...additive })),
    wire: (() => {
      // 线框：完整三角网，亮度压低，靠扫描光带与泛光提亮
      const edges = new WireframeGeometry(geo);
      edges.setAttribute('a_t', new BufferAttribute(new Float32Array(edges.attributes.position.count), 1));
      return new LineSegments(edges, new ShaderMaterial({
        uniforms: { ...U, u_intensity: { value: 0.14 }, u_pulse: { value: 0 } },
        vertexShader: lineVertex, fragmentShader: lineFragment, ...additive
      }));
    })()
  };
  for (const o of Object.values(body)) {
    o.frustumCulled = false;
    o.visible = false;
    scene.add(o);
  }

  // —— 光核：发光能量球 + 着色器里画的眼睛
  const orbUniforms = {
    u_time: U.u_time, u_motion: U.u_motion, u_breath: U.u_breath, u_speak: U.u_speak, u_hue: U.u_hue, u_glow: U.u_glow,
    u_yaw: U.u_yaw, u_pitch: U.u_pitch, u_glitch: U.u_glitch,
    u_eyeW: { value: 0.12 }, u_eyeH: { value: 0.17 }, u_eyeY: { value: 0.08 },
    u_happy: { value: 0 }, u_calm: { value: 0 }, u_blink: { value: 1 }
  };
  const orb = new Mesh(new IcosahedronGeometry(ORB_RADIUS, 6), new ShaderMaterial({
    uniforms: orbUniforms, vertexShader: orbVertex, fragmentShader: orbFragment, side: FrontSide, ...additive
  }));
  orb.position.y = meta.haloY;
  orb.frustumCulled = false;
  scene.add(orb);

  let style = 'orb';

  // —— 电路线：沿线弧长参数 a_t 驱动“数据流”脉冲
  const circuit = (() => {
    const pos = [], tt = [];
    meta.lines.forEach((line, li) => {
      let len = 0;
      const acc = [0];
      for (let i = 1; i < line.length; i++) acc.push((len += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1], line[i][2] - line[i - 1][2])));
      for (let i = 0; i < line.length - 1; i++) {
        pos.push(...line[i], ...line[i + 1]);
        // 各条线错开相位，脉冲不同时出现
        tt.push(acc[i] / 60 + li * 0.37, acc[i + 1] / 60 + li * 0.37);
      }
    });
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('a_t', new BufferAttribute(new Float32Array(tt), 1));
    const l = new LineSegments(g, new ShaderMaterial({
      uniforms: { ...U, u_intensity: { value: 0.9 }, u_pulse: { value: 1 } },
      vertexShader: lineVertex, fragmentShader: lineFragment, ...additive
    }));
    l.frustumCulled = false;
    return l;
  })();
  scene.add(circuit);

  // —— 双眼
  const eyeUniforms = { ...U, u_size: { value: 2500 }, u_intensity: { value: 1 }, u_blink: { value: 1 } };
  const eyes = (() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(meta.eyes.flat()), 3));
    const p = new Points(g, new ShaderMaterial({ uniforms: eyeUniforms, vertexShader: eyeVertex, fragmentShader: eyeFragment, ...additive }));
    p.frustumCulled = false;
    return p;
  })();
  scene.add(eyes);

  // —— 投影光柱：底座 → 胸像底部
  const coneUniforms = { u_time: U.u_time, u_hue: U.u_hue, u_intensity: { value: 1 } };
  const coneH = (meta.bottom + 8) - meta.pedestalY;
  const cone = new Mesh(new CylinderGeometry(46, 21, coneH, 64, 1, true), new ShaderMaterial({
    uniforms: coneUniforms, vertexShader: coneVertex, fragmentShader: coneFragment, side: DoubleSide, ...additive
  }));
  cone.frustumCulled = false;
  scene.add(cone);
  /** 光柱顶端对齐当前主体的底部：胸像底部 / 光核下缘 */
  function fitCone() {
    const top = style === 'orb' ? meta.haloY - ORB_RADIUS + 6 : meta.bottom + 8;
    const h = top - meta.pedestalY;
    cone.scale.y = h / coneH;
    cone.position.y = meta.pedestalY + h / 2;
  }

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
    eyeUniforms.u_size.value = scale * 3.6;
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
  const stats = { frames: 0, fps: 0, isWebGL2, vertices: positions.length / 3, drawCalls: 0, bloom: false, style, _acc: 0, _n: 0 };

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
    U.u_yaw.value = s.yaw;
    U.u_pitch.value = s.pitch;
    U.u_breath.value = s.breath;
    U.u_glitch.value = s.glitch;
    U.u_hue.value = s.hue;
    U.u_glow.value = s.glow;
    U.u_speak.value = s.speak;
    U.u_scanSpeed.value = s.scanSpeed;
    // 光环与底座的转速随情绪的角速度变化（平静 0.15 rad/s 为基准）
    U.u_rigTime.value += (dt / 1000) * (s.spin / 0.15) * s.motion;
    eyeUniforms.u_intensity.value = 0.55 + 0.3 * s.glow + 0.35 * s.speak;
    eyeUniforms.u_blink.value = s.blink;
    orbUniforms.u_blink.value = s.blink;
    orbUniforms.u_eyeW.value = s.eyeW;
    orbUniforms.u_eyeH.value = s.eyeH;
    orbUniforms.u_eyeY.value = s.eyeY;
    orbUniforms.u_happy.value = s.happy;
    orbUniforms.u_calm.value = s.calm;
    // 光核缓慢上下漂浮
    orb.position.y = meta.haloY + Math.sin((now / 1000) * s.motion * 0.8) * 1.6;
    padUniforms.u_intensity.value = 0.6 + 0.4 * s.glow + s.speak * 0.4;
    coneUniforms.u_intensity.value = 0.7 + 0.5 * s.glow + s.speak * 0.5;
    rigUniforms.u_opacity.value = 0.7 + 0.3 * s.glow;
    if (bloom) bloom.strength = 0.6 + s.glow * 0.8 + s.speak * 0.5;
    stars.rotation.y = (now / 1000) * s.motion * 0.004;
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

  circuit.visible = eyes.visible = false;
  fitCone();

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
      const y = style === 'orb' ? orb.position.y : meta.haloY;
      const c = anchorV.set(0, y, 0).project(camera);
      const e = anchorE.set(ORB_RADIUS * (style === 'orb' ? 1 : 1.25), y, 0).project(camera);
      return { x: (c.x + 1) / 2 * w, y: (1 - c.y) / 2 * h, r: Math.abs(e.x - c.x) / 2 * w };
    },
    /** 显示样式：orb 光核 / holo 全息胸像 / wire 线框胸像 */
    setStyle(next) {
      if (next !== 'orb' && !body[next]) return;
      style = next;
      for (const [k, o] of Object.entries(body)) o.visible = k === next;
      orb.visible = next === 'orb';
      circuit.visible = eyes.visible = next !== 'orb';
      stats.style = next;
      fitCone();
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

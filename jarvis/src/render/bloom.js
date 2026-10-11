/**
 * 轻量泛光（只用 4 个全屏 draw call，总预算 6 + 4 = 10 ≤ 12）：
 *   场景 → sceneRT（全分辨率）
 *   1. 亮部提取 + 降到 1/4 分辨率 → rtA
 *   2. 水平高斯模糊 rtA → rtB
 *   3. 垂直高斯模糊 rtB → rtA
 *   4. 合成 sceneRT + rtA × strength → 屏幕
 * 用 8 位纹理，WebGL1 / WebGL2 通用。UnrealBloomPass 的多级 mip 链要 10+ 个 pass，超预算。
 */
import {
  WebGLRenderTarget, ShaderMaterial, Mesh, PlaneGeometry, OrthographicCamera, Scene, LinearFilter, Vector2
} from 'three';

const quadVertex = /* glsl */ `
varying vec2 v_uv;
void main() { v_uv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const brightFragment = /* glsl */ `
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_threshold;
varying vec2 v_uv;
void main() {
  // 4 次采样做 2×2 盒式降采样，再取亮部
  vec3 c = texture2D(u_tex, v_uv + u_texel * vec2(-0.5, -0.5)).rgb
         + texture2D(u_tex, v_uv + u_texel * vec2( 0.5, -0.5)).rgb
         + texture2D(u_tex, v_uv + u_texel * vec2(-0.5,  0.5)).rgb
         + texture2D(u_tex, v_uv + u_texel * vec2( 0.5,  0.5)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * smoothstep(u_threshold, u_threshold + 0.25, l), 1.0);
}
`;

const blurFragment = /* glsl */ `
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_dir;
varying vec2 v_uv;
void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb * 0.227027;
  c += texture2D(u_tex, v_uv + u_dir * 1.384615).rgb * 0.316216;
  c += texture2D(u_tex, v_uv - u_dir * 1.384615).rgb * 0.316216;
  c += texture2D(u_tex, v_uv + u_dir * 3.230769).rgb * 0.070270;
  c += texture2D(u_tex, v_uv - u_dir * 3.230769).rgb * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}
`;

const compositeFragment = /* glsl */ `
precision mediump float;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_strength;
varying vec2 v_uv;
void main() {
  vec3 c = texture2D(u_scene, v_uv).rgb + texture2D(u_bloom, v_uv).rgb * u_strength;
  // 轻微暗角，让视线落在中央
  float vig = smoothstep(1.25, 0.35, length(v_uv - 0.5) * 1.6);
  gl_FragColor = vec4(c * mix(0.75, 1.0, vig), 1.0);
}
`;

export function createBloom(renderer) {
  const opts = { minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false };
  const sceneRT = new WebGLRenderTarget(1, 1, { ...opts, depthBuffer: true });
  const rtA = new WebGLRenderTarget(1, 1, opts);
  const rtB = new WebGLRenderTarget(1, 1, opts);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new Scene();
  const quad = new Mesh(new PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  quadScene.add(quad);

  const bright = new ShaderMaterial({
    uniforms: { u_tex: { value: sceneRT.texture }, u_texel: { value: new Vector2() }, u_threshold: { value: 0.32 } },
    vertexShader: quadVertex, fragmentShader: brightFragment, depthTest: false, depthWrite: false
  });
  const blur = new ShaderMaterial({
    uniforms: { u_tex: { value: null }, u_dir: { value: new Vector2() } },
    vertexShader: quadVertex, fragmentShader: blurFragment, depthTest: false, depthWrite: false
  });
  const composite = new ShaderMaterial({
    uniforms: { u_scene: { value: sceneRT.texture }, u_bloom: { value: rtA.texture }, u_strength: { value: 1.2 } },
    vertexShader: quadVertex, fragmentShader: compositeFragment, depthTest: false, depthWrite: false
  });
  const size = new Vector2();

  function pass(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, camera);
  }

  return {
    setSize() {
      renderer.getDrawingBufferSize(size);
      const w = Math.max(1, size.x), h = Math.max(1, size.y);
      sceneRT.setSize(w, h);
      const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
      rtA.setSize(qw, qh);
      rtB.setSize(qw, qh);
      bright.uniforms.u_texel.value.set(1 / w, 1 / h);
    },
    set strength(v) { composite.uniforms.u_strength.value = v; },
    render(scene, cam) {
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, cam);
      pass(bright, rtA);
      blur.uniforms.u_tex.value = rtA.texture;
      blur.uniforms.u_dir.value.set(1.6 / rtA.width, 0);
      pass(blur, rtB);
      blur.uniforms.u_tex.value = rtB.texture;
      blur.uniforms.u_dir.value.set(0, 1.6 / rtA.height);
      pass(blur, rtA);
      pass(composite, null);
    },
    dispose() {
      for (const x of [sceneRT, rtA, rtB, bright, blur, composite, quad.geometry]) x.dispose();
    }
  };
}

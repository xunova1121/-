/**
 * GLSL ES 1.00 写法，WebGL1 与 WebGL2 共用（three.js 在 WebGL2 下会自动转写 attribute/varying）。
 * 不依赖 Transform Feedback：所有运动都是时间的解析函数，因此降级到 WebGL1 时不需要另一套 CPU 粒子逻辑。
 */
const common = /* glsl */ `
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
// 便宜的 3D 值噪声 + 有限差分旋度：无散度的流场，粒子像流体一样卷动而不是抖动
float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
vec3 curl(vec3 p) {
  const float e = 0.1;
  vec3 a = vec3(vnoise(p), vnoise(p + 31.4), vnoise(p + 67.1));
  float dy1 = vnoise(p + vec3(0, e, 0)) - a.x, dz1 = vnoise(p + vec3(0, 0, e)) - a.x;
  float dx2 = vnoise(p + 31.4 + vec3(e, 0, 0)) - a.y, dz2 = vnoise(p + 31.4 + vec3(0, 0, e)) - a.y;
  float dx3 = vnoise(p + 67.1 + vec3(e, 0, 0)) - a.z, dy3 = vnoise(p + 67.1 + vec3(0, e, 0)) - a.z;
  return vec3(dy3 - dz2, dz1 - dx3, dx2 - dy1) / e;
}
vec3 hsl2rgb(float h, float s, float l) {
  vec3 rgb = clamp(abs(mod(h / 60.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
}
`;

export const particleVertex = /* glsl */ `
uniform float u_time;
uniform float u_morphFactor;
uniform float u_spin;          // 粒子核心累计旋转角（rad），角速度由情绪调制
uniform float u_yaw;           // 人脸跟随：偏航（rad）
uniform float u_pitch;         // 人脸跟随：俯仰（rad）
uniform float u_sway;          // 人形正面摆动幅度（模型单位）
uniform float u_orbitJitter;   // 轨道倾角抖动（rad）
uniform float u_inward;        // 内部粒子向心流速
uniform float u_breath;        // 呼吸振幅（VAD 音量包络驱动）
uniform float u_radius;        // 粒子核心半径
uniform float u_perspectiveScale;
uniform float u_pointScale;
uniform float u_hue;
uniform float u_motion;        // 0 = 冻结所有运动
uniform float u_flow;          // 旋度噪声流动强度（形变中途最强）
uniform float u_speak;         // 语音输出包络：驱动核心与球面的脉动（输出）

attribute vec3 a_humanPosition;
attribute vec3 a_spherePosition;
attribute vec4 a_meta;

varying vec3 v_color;
varying float v_alpha;
${common}
void main() {
  float kind = a_meta.x;
  float seed = a_meta.y;
  float contour = a_meta.z;
  float ring = a_meta.w;
  float t = u_time * u_motion;
  float humanW = 1.0 - smoothstep(0.0, 0.5, u_morphFactor);

  // —— 人形：0.15Hz 低频正弦摆动 + 人脸跟随朝向
  vec3 h = a_humanPosition;
  h.x += sin(6.2831853 * 0.15 * t) * u_sway * humanW;
  h.y += sin(6.2831853 * 0.075 * t + 1.3) * u_sway * 0.25 * humanW;
  h = rotY(u_yaw) * rotX(u_pitch) * h;

  // —— 粒子核心
  vec3 s;
  float alpha = 1.0;
  float size = 1.0;
  if (kind < 0.5) {
    float br = 1.0 + 0.035 * sin(t * 1.1 + seed * 6.2831853) + u_breath
             + u_speak * 0.06 * (0.6 + 0.4 * sin(seed * 40.0 + t * 9.0));
    s = rotY(u_spin) * (a_spherePosition * u_radius * br);
    size = 0.9 + seed * 0.6;
  } else if (kind < 1.5) {
    float rf = a_spherePosition.x;
    float tilt = a_spherePosition.y + u_orbitJitter * sin(t * 0.7 + ring * 2.1);
    float ang = seed * 6.2831853 + t * 0.5 / rf;
    vec3 local = vec3(cos(ang), 0.0, sin(ang)) * u_radius * rf;
    s = rotY(u_spin * 0.6 + a_spherePosition.z) * rotX(tilt) * local;
    size = 1.1 + seed * 1.4;
  } else {
    // 向心流动：沿半径从外向内循环，“吸入核心”
    float f = fract(seed * 7.31 - t * u_inward);
    s = rotY(u_spin * 1.3) * (a_spherePosition * u_radius * mix(1.0, 0.12, f));
    alpha = sin(f * 3.1415926);
    size = 0.7 + seed * 0.8;
  }

  // 每个粒子错开一点起止时间：形变像流动而不是整体平移。
  // morph=0 时所有粒子 m=0，morph=1 时所有粒子 m=1，端点处不会跳变。
  float m = clamp(u_morphFactor * 1.3 - seed * 0.3, 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  vec3 p = mix(h, s, m);
  // 形变途中流场最强（sin(πm)），静止形态下只留一点微流动，人形轮廓不被扰乱
  float flowAmt = u_flow * (0.08 + 1.0 * sin(3.1415926 * m)) * u_motion;
  if (flowAmt > 0.001) p += curl(p * 0.045 + vec3(0.0, t * 0.12, seed)) * flowAmt;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float humanSize = 0.85 + contour * 0.9;
  size = mix(humanSize, size, m) * u_pointScale;
  gl_PointSize = clamp(size * u_perspectiveScale / -mv.z, 1.0, 24.0);

  float light = 0.52 + 0.28 * contour * (1.0 - m) + (kind > 1.5 ? 0.18 : 0.0) + 0.1 * seed;
  v_color = hsl2rgb(mod(u_hue - 8.0 * seed, 360.0), 0.85, clamp(light, 0.0, 0.92));
  v_alpha = alpha * mix(0.75, 0.9, m) * (1.0 + u_speak * 0.35 * m);
}
`;

export const particleFragment = /* glsl */ `
precision mediump float;
varying vec3 v_color;
varying float v_alpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.0, r);
  vec3 c = v_color + vec3(0.55) * smoothstep(0.18, 0.0, r);
  gl_FragColor = vec4(c, a * a * v_alpha);
}
`;

/** 发光核心：billboard 四边形，径向渐变，强度 u_coreGlow */
export const coreVertex = /* glsl */ `
uniform float u_size;
varying vec2 v_uv;
void main() {
  v_uv = position.xy;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * u_size;
  gl_Position = projectionMatrix * mv;
}
`;

export const coreFragment = /* glsl */ `
precision mediump float;
uniform float u_coreGlow;
uniform float u_hue;
uniform float u_pulse;
varying vec2 v_uv;
${common}
void main() {
  float r = length(v_uv);
  if (r > 1.0) discard;
  float halo = pow(1.0 - r, 3.0) * 0.55;
  float hot = exp(-r * r * 60.0) * (1.0 + u_pulse);
  vec3 tint = hsl2rgb(u_hue, 0.85, 0.6);
  vec3 c = tint * halo + mix(tint, vec3(1.0), 0.75) * hot;
  gl_FragColor = vec4(c * u_coreGlow, (halo + hot) * u_coreGlow);
}
`;

export const starVertex = /* glsl */ `
uniform float u_time;
uniform float u_perspectiveScale;
attribute float a_seed;
varying float v_a;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp((1.2 + a_seed * 2.0) * u_perspectiveScale / -mv.z, 1.0, 4.0);
  v_a = 0.25 + 0.35 * (0.5 + 0.5 * sin(u_time * (0.4 + a_seed) + a_seed * 40.0));
}
`;

export const starFragment = /* glsl */ `
precision mediump float;
uniform float u_hue;
varying float v_a;
${common}
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  gl_FragColor = vec4(hsl2rgb(u_hue, 0.6, 0.7), smoothstep(0.5, 0.0, r) * v_a);
}
`;

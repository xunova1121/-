/**
 * 全息胸像着色器。GLSL ES 1.00 写法，WebGL1 / WebGL2 共用（three.js 在 WebGL2 下自动转写）。
 *
 * 所有“身体”部件（网格 / 线框 / 点阵 / 电路线 / 眼睛）共用同一段顶点变换 HOLO_TRANSFORM：
 *   - 人脸跟随：只转头 —— 按高度权重（颈部以上 1、肩部 0）混合旋转，脖子自然扭转、肩膀不动；
 *   - 待机时头部轻微摆动；
 *   - 聆听：表面沿法线随麦克风包络起伏（输入）；
 *   - 故障切片：按水平条带随机横移（警觉 / 愉悦时更频繁）。
 */
const common = /* glsl */ `
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
float hash1(float n) { return fract(sin(n) * 43758.5453); }
vec3 hsl2rgb(float h, float s, float l) {
  vec3 rgb = clamp(abs(mod(h / 60.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
}
`;

const transformUniforms = /* glsl */ `
uniform float u_time;
uniform float u_motion;   // 0 = 冻结运动
uniform float u_yaw;      // 人脸跟随偏航（rad）
uniform float u_pitch;    // 人脸跟随俯仰（rad）
uniform float u_neckY;    // 头颈分界高度
uniform float u_breath;   // 麦克风输入包络
uniform float u_glitch;   // 故障强度 0..1
`;

/** 输入 p（模型坐标）、n（法线），输出变换后的 p、n */
const HOLO_TRANSFORM = /* glsl */ `
  float t = u_time * u_motion;
  float headW = smoothstep(u_neckY - 10.0, u_neckY + 6.0, p.y);
  float idleYaw = sin(t * 0.31) * 0.06 + sin(t * 0.17 + 1.0) * 0.03;
  float idlePitch = sin(t * 0.23 + 2.0) * 0.025;
  mat3 R = rotY((u_yaw + idleYaw) * headW) * rotX((u_pitch + idlePitch) * headW);
  vec3 pivot = vec3(0.0, u_neckY - 6.0, 0.0);
  p = pivot + R * (p - pivot);
  n = R * n;
  p += n * u_breath;
  // 故障：每 1/14 秒重新抽签，命中的水平条带整体横移
  float slice = floor(p.y / 3.5);
  float tick = floor(t * 14.0);
  float hit = step(1.0 - u_glitch * 0.22, hash1(slice * 13.1 + tick * 7.7));
  p.x += hit * (hash1(slice + tick) - 0.5) * 9.0 * u_glitch;
`;

export const holoVertex = /* glsl */ `
${transformUniforms}
uniform float u_pointSize;     // 点阵样式：像素尺度
varying vec3 v_normal;
varying vec3 v_view;
varying float v_y;
${common}
void main() {
  vec3 p = position;
  vec3 n = normal;
  ${HOLO_TRANSFORM}
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  v_normal = normalize(normalMatrix * n);
  v_view = normalize(-mv.xyz);
  v_y = position.y;
  gl_Position = projectionMatrix * mv;
#ifdef DOTS
  gl_PointSize = clamp(u_pointSize / -mv.z, 1.0, 4.0);
#endif
}
`;

const holoShading = /* glsl */ `
uniform float u_time;
uniform float u_hue;
uniform float u_glow;      // 情绪发光强度
uniform float u_speak;     // 播报包络（输出）
uniform float u_scanSpeed; // 扫描光带速度（专注时更快）
uniform float u_bottom;    // 胸像底部：向下渐隐进投影光柱
uniform float u_scanBase;
varying vec3 v_normal;
varying vec3 v_view;
varying float v_y;
${common}
vec4 holo(float fill, float rimPow) {
  float fres = pow(1.0 - abs(dot(normalize(v_normal), normalize(v_view))), rimPow);
  float lines = smoothstep(0.82, 1.0, 0.5 + 0.5 * sin(v_y * 2.4 - u_time * 5.0)) * 0.10;
  float sy = fract((v_y - u_scanBase) / 130.0 - u_time * u_scanSpeed);
  float band = exp(-pow((sy - 0.5) * 22.0, 2.0)) * 0.55;
  float fade = smoothstep(u_bottom, u_bottom + 14.0, v_y);
  float flicker = 0.95 + 0.05 * sin(u_time * 47.0) * sin(u_time * 13.0);
  float k = (fill + fres * (1.1 + 0.6 * u_speak) * (0.6 + u_glow) + lines + band) * fade * flicker;
  vec3 base = hsl2rgb(u_hue, 0.85, 0.55);
  vec3 col = base * k + vec3(0.75, 0.9, 1.0) * pow(fres, 3.0) * 0.5 * fade;
  return vec4(col, k);
}
`;

export const holoFragment = /* glsl */ `
${holoShading}
void main() {
#ifdef DOTS
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  gl_FragColor = holo(0.16, 1.6) * 0.55;
#else
  gl_FragColor = holo(0.07, 2.2);
#endif
}
`;

/** 线框样式 / 电路线：没有法线，亮度来自自身 */
export const lineVertex = /* glsl */ `
${transformUniforms}
attribute float a_t;     // 沿折线的弧长参数（电路线上的数据流脉冲用）
varying float v_y;
varying float v_t;
${common}
void main() {
  vec3 p = position;
  vec3 n = vec3(0.0, 0.0, 1.0);
  ${HOLO_TRANSFORM}
  v_y = position.y;
  v_t = a_t;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const lineFragment = /* glsl */ `
uniform float u_time;
uniform float u_hue;
uniform float u_glow;
uniform float u_intensity;
uniform float u_pulse;      // 1 = 电路线：沿线流动的数据脉冲
uniform float u_bottom;
uniform float u_scanBase;
uniform float u_scanSpeed;
varying float v_y;
varying float v_t;
${common}
void main() {
  float fade = smoothstep(u_bottom, u_bottom + 14.0, v_y);
  float sy = fract((v_y - u_scanBase) / 130.0 - u_time * u_scanSpeed);
  float band = exp(-pow((sy - 0.5) * 22.0, 2.0));
  float pulse = u_pulse * 1.4 * exp(-pow((fract(v_t - u_time * 0.25) - 0.5) * 9.0, 2.0));
  float k = (u_intensity * (0.6 + 0.5 * u_glow) + band * 0.5 + pulse) * fade;
  gl_FragColor = vec4(hsl2rgb(u_hue, 0.8, 0.6 + 0.2 * pulse) * k, k);
}
`;

/** 眼睛：两个大光点 */
export const eyeVertex = /* glsl */ `
${transformUniforms}
uniform float u_size;
${common}
void main() {
  vec3 p = position;
  vec3 n = vec3(0.0, 0.0, 1.0);
  ${HOLO_TRANSFORM}
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = u_size / -mv.z;
}
`;

export const eyeFragment = /* glsl */ `
uniform float u_hue;
uniform float u_intensity;
${common}
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float core = exp(-r * r * 18.0);
  float halo = pow(1.0 - r, 2.5) * 0.45;
  vec3 c = mix(hsl2rgb(u_hue, 0.9, 0.62), vec3(1.0), core * 0.85);
  float a = (core + halo) * u_intensity;
  gl_FragColor = vec4(c * a, a);
}
`;

/** 投影光柱：从底座射向胸像的锥形光，自下而上渐隐，带上行条纹 */
export const coneVertex = /* glsl */ `
varying vec3 v_normal;
varying vec3 v_view;
varying float v_h;
void main() {
  v_h = uv.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  v_normal = normalize(normalMatrix * normal);
  v_view = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const coneFragment = /* glsl */ `
uniform float u_time;
uniform float u_hue;
uniform float u_intensity;
varying vec3 v_normal;
varying vec3 v_view;
varying float v_h;
${common}
void main() {
  float facing = abs(dot(normalize(v_normal), normalize(v_view)));
  float edge = pow(1.0 - facing, 1.5);
  float stripes = 0.65 + 0.35 * sin(v_h * 40.0 - u_time * 3.0);
  float k = (1.0 - v_h) * (1.0 - v_h) * (0.12 + edge * 0.35) * stripes * u_intensity;
  gl_FragColor = vec4(hsl2rgb(u_hue, 0.85, 0.6) * k, k);
}
`;

/**
 * 全息装置线框（一个 LineSegments）：底座同心环 + 头后光环与刻度。
 * a_anim = (中心 y, 中心 z, 旋转轴 0=Y/1=Z, 角速度)；a_bright 为该段亮度。
 */
export const rigVertex = /* glsl */ `
uniform float u_rigTime;
attribute vec4 a_anim;
attribute float a_bright;
varying float v_bright;
${common}
void main() {
  float ang = u_rigTime * a_anim.w;
  float c = cos(ang), s = sin(ang);
  vec3 p = position;
  if (a_anim.z < 0.5) p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  else p = vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
  p += vec3(0.0, a_anim.x, a_anim.y);
  v_bright = a_bright;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const rigFragment = /* glsl */ `
uniform float u_hue;
uniform float u_opacity;
varying float v_bright;
${common}
void main() { gl_FragColor = vec4(hsl2rgb(u_hue, 0.8, 0.55 + 0.25 * v_bright) * v_bright * u_opacity, v_bright * u_opacity); }
`;

/** 底座光盘：亮环 + 中心光斑 + 缓慢旋转的放射纹 */
export const padVertex = /* glsl */ `
varying vec2 v_uv;
void main() { v_uv = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export const padFragment = /* glsl */ `
uniform float u_hue;
uniform float u_time;
uniform float u_intensity;
varying vec2 v_uv;
${common}
void main() {
  float r = length(v_uv);
  if (r > 1.0) discard;
  float rim = exp(-pow((r - 0.42) * 26.0, 2.0)) + 0.5 * exp(-pow((r - 0.75) * 40.0, 2.0));
  float center = exp(-r * r * 9.0) * 0.6;
  float a = atan(v_uv.y, v_uv.x);
  float spokes = smoothstep(0.75, 1.0, sin(a * 24.0 + u_time * 0.4)) * smoothstep(0.45, 0.6, r) * smoothstep(0.75, 0.62, r) * 0.25;
  float v = (rim + center + spokes) * u_intensity;
  gl_FragColor = vec4(hsl2rgb(u_hue, 0.85, 0.6) * v, v);
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
  gl_PointSize = clamp((1.2 + a_seed * 2.0) * u_perspectiveScale / -mv.z, 1.0, 3.0);
  v_a = 0.15 + 0.3 * (0.5 + 0.5 * sin(u_time * (0.4 + a_seed) + a_seed * 40.0));
}
`;

export const starFragment = /* glsl */ `
uniform float u_hue;
varying float v_a;
${common}
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  gl_FragColor = vec4(hsl2rgb(u_hue, 0.5, 0.7) * v_a, v_a * smoothstep(0.5, 0.0, r));
}
`;

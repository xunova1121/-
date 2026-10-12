/**
 * 全息胸像着色器。GLSL ES 1.00 写法，WebGL1 / WebGL2 共用（three.js 在 WebGL2 下自动转写）。
 *
 * 两种主体：
 *   光核（默认）：发光能量球 + 着色器里画的一双会变形状的眼睛（orbVertex / orbFragment）；
 *   胸像：全息头像（全息 / 线框），以下部件共用同一段顶点变换 HOLO_TRANSFORM：
 *   - 人脸跟随：只转头 —— 按高度权重（颈部以上 1、肩部 0）混合旋转，脖子自然扭转、肩膀不动；
 *   - 待机时头部轻微摆动；
 *   - 聆听：表面沿法线随麦克风包络起伏（输入）；
 *   - 故障切片：按水平条带随机横移（警觉 / 愉悦时更频繁）。
 */
const common = /* glsl */ `
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
float hash1(float n) { return fract(sin(n) * 43758.5453); }
float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}
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
// 正面柔光 + 轮廓光：脸的正面整体是亮的（像发光的雕塑），而不是只有边缘发光的“暗脸”——
// 后者在暗背景里很像骷髅，看着吓人
vec4 holo(float fill, float rimPow) {
  float facing = abs(dot(normalize(v_normal), normalize(v_view)));
  float fres = pow(1.0 - facing, rimPow);
  float front = pow(facing, 1.6) * 0.3;
  float lines = smoothstep(0.85, 1.0, 0.5 + 0.5 * sin(v_y * 2.4 - u_time * 3.0)) * 0.05;
  float sy = fract((v_y - u_scanBase) / 130.0 - u_time * u_scanSpeed);
  float band = exp(-pow((sy - 0.5) * 18.0, 2.0)) * 0.3;
  float fade = smoothstep(u_bottom, u_bottom + 14.0, v_y);
  float k = (fill + front + fres * (0.9 + 0.5 * u_speak) * (0.6 + u_glow) + lines + band) * fade;
  vec3 base = hsl2rgb(u_hue, 0.8, 0.6);
  vec3 col = base * k + vec3(0.8, 0.93, 1.0) * (pow(fres, 3.0) * 0.3 + front * 0.25) * fade;
  return vec4(col, k);
}
`;

export const holoFragment = /* glsl */ `
${holoShading}
void main() {
  gl_FragColor = holo(0.1, 2.6);
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

/** 眼睛：横向的柔和椭圆光，会眨眼（u_blink 1 = 睁开，接近 0 = 闭上） */
export const eyeFragment = /* glsl */ `
uniform float u_hue;
uniform float u_intensity;
uniform float u_blink;
${common}
void main() {
  vec2 d = (gl_PointCoord - 0.5) * 2.0;
  d.y *= 2.4 / max(u_blink, 0.06);
  float r = length(d);
  if (r > 1.0) discard;
  float core = exp(-r * r * 5.0) * 0.75;
  float halo = pow(1.0 - r, 2.0) * 0.35;
  vec3 c = mix(hsl2rgb(u_hue, 0.8, 0.65), vec3(0.95, 0.98, 1.0), core * 0.6);
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

/**
 * 光核：发光能量球。表面有缓慢流动的柔光纹理；聆听时随麦克风起伏（输入），播报时整体脉动（输出）。
 */
export const orbVertex = /* glsl */ `
uniform float u_time;
uniform float u_motion;
uniform float u_breath;
uniform float u_speak;
varying vec3 v_dir;
varying vec3 v_normal;
varying vec3 v_view;
${common}
void main() {
  float t = u_time * u_motion;
  vec3 dir = normalize(position);
  float ripple = (vnoise(dir * 3.0 + vec3(0.0, t * 1.5, 0.0)) - 0.5) * u_breath * 2.2;
  vec3 p = position * (1.0 + u_speak * 0.035 * (0.6 + 0.4 * sin(t * 18.0))) + dir * ripple;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  v_dir = dir;
  v_normal = normalize(normalMatrix * normal);
  v_view = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * 眼睛在“注视坐标系”里画：把球面方向转到注视方向下，前半球的 (x, y) 就是脸的平面坐标。
 * 注视方向 = 人脸跟随 / 待机时随机张望，所以眼睛会在球面上滑动，像在看你。
 * 形状：椭圆眼（宽 / 高 / 眨眼），可混合成 “^” 笑眼（happy）或 “∪” 闭眼（calm）。
 */
export const orbFragment = /* glsl */ `
uniform float u_time;
uniform float u_hue;
uniform float u_glow;
uniform float u_speak;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_eyeW;
uniform float u_eyeH;
uniform float u_eyeY;
uniform float u_happy;
uniform float u_calm;
uniform float u_blink;
uniform float u_glitch;
varying vec3 v_dir;
varying vec3 v_normal;
varying vec3 v_view;
${common}
float arcEye(vec2 e, float dir) {
  // 抛物线弧：dir = +1 为 “^”，-1 为 “∪”
  float x = clamp(e.x / u_eyeW, -1.0, 1.0);
  float yc = dir * (u_eyeH * 0.55) * (1.0 - x * x) - dir * u_eyeH * 0.2;
  float d = abs(e.y - yc);
  float th = 0.045;
  return (1.0 - smoothstep(th * 0.5, th, d)) * (1.0 - smoothstep(0.9, 1.05, abs(e.x) / u_eyeW));
}
float eye(vec2 f, float side) {
  vec2 e = f - vec2(side * 0.3, u_eyeY);
  float h = max(u_eyeH * u_blink, 0.012);
  float ell = 1.0 - smoothstep(0.82, 1.0, length(e / vec2(u_eyeW, h)));
  float m = mix(ell, arcEye(e, 1.0), u_happy);
  return mix(m, arcEye(e, -1.0), u_calm);
}
void main() {
  float t = u_time;
  float facing = abs(dot(normalize(v_normal), normalize(v_view)));
  float fres = pow(1.0 - facing, 2.4);
  float inner = pow(facing, 1.8);

  // 柔光流纹：两层噪声相互穿插，慢慢流动
  float n1 = vnoise(v_dir * 2.6 + vec3(t * 0.12, t * 0.07, 0.0));
  float n2 = vnoise(v_dir * 5.0 - vec3(0.0, t * 0.15, t * 0.05));
  float swirl = smoothstep(0.45, 0.85, n1 * 0.65 + n2 * 0.35);

  // 注视坐标系（与人脸跟随同向）
  vec3 q = rotX(-u_pitch) * rotY(-u_yaw) * v_dir;
  float eyes = 0.0;
  if (q.z > 0.2) {
    vec2 f = q.xy;
    // 故障：警觉时眼睛横向轻微抖动
    f.x += (hash1(floor(t * 14.0)) - 0.5) * 0.04 * u_glitch;
    eyes = max(eye(f, 1.0), eye(f, -1.0)) * smoothstep(0.2, 0.45, q.z);
  }

  vec3 base = hsl2rgb(u_hue, 0.85, 0.55);
  // 按感知亮度归一：黄 / 青这类亮色不会糊成一片，眼睛在任何颜色上都看得清
  float luma = dot(base, vec3(0.299, 0.587, 0.114));
  base *= clamp(0.45 / max(luma, 0.05), 0.55, 1.4);
  float k = 0.1 + inner * (0.22 + 0.12 * u_glow) + swirl * inner * 0.22 + fres * (0.8 + 0.6 * u_glow + 0.6 * u_speak);
  vec3 col = base * k + vec3(0.85, 0.95, 1.0) * pow(fres, 3.5) * 0.4;
  // 眼睛：接近白色的亮光，略带主色
  vec3 eyeCol = mix(vec3(1.0), hsl2rgb(u_hue, 0.9, 0.8), 0.25) * (1.1 + 0.4 * u_speak);
  col = mix(col, eyeCol, eyes);
  // 加色混合：alpha 取 1，亮度全部体现在颜色里
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * 粒子体：上万个粒子在两种造型（a_from → a_to）之间变形。
 * 每个粒子有自己的延迟，变形中途向外散开再聚拢；造型带脸时朝向用户（偏航 / 俯仰），否则缓慢自转。
 * a_rand = (延迟种子, 大小 / 亮度, 相位, 是否眼睛粒子)
 */
export const swarmVertex = /* glsl */ `
uniform float u_time;
uniform float u_motion;
uniform float u_mix;
uniform float u_spin;
uniform float u_spinAmt;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_breath;
uniform float u_speak;
uniform float u_energy;
uniform float u_audio;
uniform float u_blink;
uniform float u_eyeAmt;
uniform float u_size;
uniform float u_perspectiveScale;
attribute vec3 a_from;
attribute vec3 a_to;
attribute vec4 a_rand;
varying float v_bright;
varying float v_hueShift;
${common}
void main() {
  // 每个粒子错开出发（0.35 的随机延迟），三次缓动
  float m = clamp((u_mix * 1.35 - a_rand.x * 0.35), 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  vec3 p = mix(a_from, a_to, m);
  float t = u_time * u_motion;
  // 变形中途散开，像被重新“打印”出来
  float mid = sin(3.14159 * m);
  vec3 n3 = vec3(vnoise(p * 0.08 + t * 0.3), vnoise(p * 0.08 + 17.0 + t * 0.3), vnoise(p * 0.08 + 31.0 + t * 0.3)) - 0.5;
  p += n3 * (mid * 26.0 + u_energy * 4.0 + 1.2);
  // 眼睛：眨眼时纵向压扁（只在带脸的造型里）
  if (a_rand.w > 0.5) {
    float ey = 2.7;
    p.y = mix(p.y, ey + (p.y - ey) * u_blink, u_eyeAmt);
  }
  // 呼吸、说话时径向脉动、聆听时随麦克风起伏、思考时高频颤动
  float r = length(p) + 0.0001;
  float pulse = u_speak * (1.6 + 2.2 * sin(t * 13.0 + a_rand.z * 6.28)) + u_audio * 3.0 * sin(t * 9.0 + r * 0.4);
  p += (p / r) * (pulse * (1.0 - a_rand.w * u_eyeAmt) + u_breath * 0.5);
  p += (vec3(hash1(a_rand.z * 91.0 + floor(t * 20.0)), hash1(a_rand.z * 37.0 + floor(t * 20.0)), hash1(a_rand.z * 53.0 + floor(t * 20.0))) - 0.5) * u_energy * 0.8;
  // 朝向：带脸的造型看向用户，其他造型自转
  p = rotX(u_pitch) * rotY(u_yaw + u_spin * u_spinAmt) * p;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float eye = a_rand.w * u_eyeAmt;
  gl_PointSize = clamp(u_size * (0.5 + a_rand.y * 0.8 + eye * 0.9) * u_perspectiveScale / -mv.z, 1.0, 9.0);
  v_bright = 0.35 + a_rand.y * 0.5 + eye * 2.6 + u_speak * 0.25 + mid * 0.3;
  v_hueShift = (a_rand.y - 0.5) * 26.0 + mid * 30.0;
}
`;

export const swarmFragment = /* glsl */ `
uniform float u_hue;
uniform float u_glow;
varying float v_bright;
varying float v_hueShift;
${common}
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  float a = pow(smoothstep(0.5, 0.0, r), 1.6);
  vec3 c = mix(hsl2rgb(u_hue + v_hueShift, 0.85, 0.58), vec3(0.92, 0.97, 1.0), clamp(v_bright - 1.0, 0.0, 1.0) * 0.7);
  float k = a * v_bright * (0.32 + 0.38 * u_glow);
  gl_FragColor = vec4(c * k, k);
}
`;

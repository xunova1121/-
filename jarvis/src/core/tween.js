export const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const easeInOut = (x) => 0.5 - Math.cos(Math.PI * x) / 2;
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;

/** 色相按最短弧插值（HSL 空间），避免 RGB 插值经过灰色 */
export function lerpHue(a, b, t) {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + d * t) % 360) + 360) % 360;
}

/**
 * 一组数值参数的缓动过渡。目标变化时从“当前插值值”出发，过渡中途换目标不会跳变。
 * hueKeys 中的键走色相最短弧插值。
 */
export class ParamTween {
  constructor(initial, { duration = 400, ease = easeInOutCubic, hueKeys = ['hue'] } = {}) {
    this.value = { ...initial };
    this.from = { ...initial };
    this.to = { ...initial };
    this.duration = duration;
    this.ease = ease;
    this.hueKeys = new Set(hueKeys);
    this.start = 0;
    this.active = false;
  }

  set(target, now) {
    this.from = { ...this.value };
    this.to = { ...this.to, ...target };
    this.start = now;
    this.active = true;
  }

  update(now) {
    if (!this.active) return this.value;
    const t = this.duration <= 0 ? 1 : clamp((now - this.start) / this.duration, 0, 1);
    const k = this.ease(t);
    for (const key of Object.keys(this.to)) {
      this.value[key] = this.hueKeys.has(key)
        ? lerpHue(this.from[key], this.to[key], k)
        : lerp(this.from[key], this.to[key], k);
    }
    if (t >= 1) this.active = false;
    return this.value;
  }
}

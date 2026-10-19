import { describe, it, expect } from 'vitest';
import { lerpHue, ParamTween, easeInOutCubic } from '../src/core/tween.js';
import { Spring } from '../src/core/spring.js';
import { SentenceChunker, clean } from '../src/core/sentenceChunker.js';
import { yawPitchFromMatrix, followTarget, smoothToward } from '../src/core/faceMath.js';
import { VadGate, SILENCE_BY_SENSITIVITY } from '../src/core/vadGate.js';
import { loadSettings, saveSettings, DEFAULT_SETTINGS, wantsReducedMotion } from '../src/core/settings.js';

describe('色相插值', () => {
  it('走最短弧：350° → 10° 经过 0°，而不是绕回 180°', () => {
    expect(lerpHue(350, 10, 0.5)).toBeCloseTo(0);
    expect(lerpHue(10, 350, 0.25)).toBeCloseTo(5);
    expect(lerpHue(200, 35, 1)).toBeCloseTo(35);
  });
});

describe('ParamTween（情绪 400ms 过渡）', () => {
  it('400ms 后到达目标，中途连续变化', () => {
    const tw = new ParamTween({ hue: 200, glow: 0.6 }, { duration: 400 });
    tw.set({ hue: 0, glow: 1.0 }, 0);
    const mid = tw.update(200);
    expect(mid.glow).toBeCloseTo(0.8);
    // 200° → 0° 的最短弧是向上经过 280°（160°），而不是向下经过 100°（200°）
    expect(mid.hue).toBeGreaterThan(200);
    expect(mid.hue).toBeLessThan(360);
    expect(tw.update(400)).toEqual({ hue: 0, glow: 1.0 });
  });

  it('过渡中途换目标从当前值出发，不跳变', () => {
    const tw = new ParamTween({ glow: 0 }, { duration: 400 });
    tw.set({ glow: 1 }, 0);
    const v = tw.update(100).glow;
    tw.set({ glow: 0 }, 100);
    expect(tw.update(100).glow).toBeCloseTo(v);
  });
});

describe('缓动', () => {
  it('easeInOutCubic 端点与中点', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(1)).toBe(1);
  });
});

describe('Spring', () => {
  it('收敛到目标并在约 600ms 内基本归位', () => {
    const s = new Spring(10);
    s.target = 0;
    for (let i = 0; i < 36; i++) s.step(1000 / 60);
    expect(Math.abs(s.value)).toBeLessThan(0.6);
    for (let i = 0; i < 200; i++) s.step(1000 / 60);
    expect(s.settled).toBe(true);
  });
});

describe('SentenceChunker', () => {
  it('凑够一句就吐出，跨 delta 拼接', () => {
    const c = new SentenceChunker();
    expect(c.push('你好，我')).toEqual([]);
    expect(c.push('是未央。今天')).toEqual(['你好，我是未央。']);
    expect(c.push('天气不错！要出门吗？')).toEqual(['今天天气不错！', '要出门吗？']);
    expect(c.flush()).toEqual([]);
  });

  it('结尾没有标点的残句在 flush 时吐出', () => {
    const c = new SentenceChunker();
    c.push('最后一句没有句号');
    expect(c.flush()).toEqual(['最后一句没有句号']);
  });

  it('不切断小数与版本号', () => {
    const c = new SentenceChunker();
    expect(c.push('圆周率约 3.14，版本 v2.0 已发布. Next')).toEqual(['圆周率约 3.14，版本 v2.0 已发布.']);
  });

  it('长句在逗号处提前切分', () => {
    const c = new SentenceChunker({ maxLen: 10 });
    expect(c.push('这是一个相当相当相当长的句子，后面还有')).toEqual(['这是一个相当相当相当长的句子，']);
  });

  it('清理 Markdown 记号', () => {
    expect(clean('**重点** 见 [文档](http://x)')).toBe('重点 见 文档');
    expect(clean('```js\ncode\n```')).toBe('');
  });
});

/** 构造列主序的 Ry(yaw)·Rx(pitch)·Rz(roll) */
function matrix(yawDeg, pitchDeg, rollDeg = 0) {
  const r = (d) => (d * Math.PI) / 180;
  const [y, p, z] = [r(yawDeg), r(pitchDeg), r(rollDeg)];
  const Ry = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
  const Rx = [[1, 0, 0], [0, Math.cos(p), -Math.sin(p)], [0, Math.sin(p), Math.cos(p)]];
  const Rz = [[Math.cos(z), -Math.sin(z), 0], [Math.sin(z), Math.cos(z), 0], [0, 0, 1]];
  const mul = (A, B) => A.map((row, i) => B[0].map((_, j) => row.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
  const R = mul(mul(Ry, Rx), Rz);
  const m = new Array(16).fill(0);
  for (let c = 0; c < 3; c++) for (let rr = 0; rr < 3; rr++) m[c * 4 + rr] = R[rr][c];
  m[15] = 1;
  return m;
}

describe('人脸跟随数学', () => {
  it('从变换矩阵还原偏航/俯仰，且不受横滚影响', () => {
    for (const [y, p, roll] of [[30, 0, 0], [-20, 10, 0], [15, -12, 35], [0, 0, -40]]) {
      const out = yawPitchFromMatrix(matrix(y, p, roll));
      expect(out.yaw).toBeCloseTo(y, 4);
      expect(out.pitch).toBeCloseTo(p, 4);
    }
  });

  it('超出 ±45° / ±25° 时回到正面', () => {
    expect(followTarget({ yaw: 30, pitch: 5 })).toEqual({ yaw: -30, pitch: 5, inRange: true });
    expect(followTarget({ yaw: 50, pitch: 0 })).toMatchObject({ yaw: 0, pitch: 0, inRange: false });
    expect(followTarget({ yaw: 0, pitch: -30 })).toMatchObject({ yaw: 0, pitch: 0, inRange: false });
  });

  it('每帧插值 12%，与帧率无关', () => {
    expect(smoothToward(0, 100, 0.12)).toBeCloseTo(12);
    let a = 0;
    a = smoothToward(a, 100, 0.12, 1000 / 120);
    a = smoothToward(a, 100, 0.12, 1000 / 120);
    expect(a).toBeCloseTo(12);
  });

  it('关闭后约 600ms 内回到正面（剩余 < 5%）', () => {
    let a = 30;
    for (let i = 0; i < 36; i++) a = smoothToward(a, 0);
    expect(Math.abs(a)).toBeLessThan(30 * 0.05);
  });

});

describe('VadGate', () => {
  function rig(opts) {
    const ev = [];
    const g = new VadGate({
      ...opts,
      onOnset: () => ev.push('onset'),
      onConfirm: () => ev.push('confirm'),
      onCancel: () => ev.push('cancel'),
      onCommit: () => ev.push('commit')
    });
    return { g, ev, feed: (from, to, p) => { for (let t = from; t < to; t += 32) g.update(p, t); } };
  }

  it('说话 300ms 后确认，静默 800ms 后提交（32ms 帧精度内）', () => {
    const { g, ev } = rig();
    const times = {};
    const orig = g.onConfirm;
    g.onConfirm = () => { times.confirm = t; orig(); };
    const origC = g.onCommit;
    g.onCommit = () => { times.commit = t; origC(); };
    let t = 0;
    for (; t < 2000; t += 32) g.update(0.9, t);
    const stopAt = t;
    for (; t < 4000; t += 32) g.update(0.05, t);
    expect(ev).toEqual(['onset', 'confirm', 'commit']);
    expect(times.confirm).toBeGreaterThanOrEqual(300);
    expect(times.confirm).toBeLessThan(500);
    expect(times.commit - stopAt).toBeGreaterThanOrEqual(800);
    expect(times.commit - stopAt).toBeLessThan(1000);
  });

  it('300ms 内停下视为误触发', () => {
    const { ev, feed } = rig();
    feed(0, 200, 0.9);
    feed(200, 1500, 0.05);
    expect(ev).toEqual(['onset', 'cancel']);
  });

  it('句中短停顿（< 静默阈值）不提交', () => {
    const { ev, feed } = rig();
    feed(0, 1000, 0.9);
    feed(1000, 1600, 0.05);
    feed(1600, 2500, 0.9);
    expect(ev).toEqual(['onset', 'confirm']);
  });

  it('迟滞：在阈值之间徘徊不算静默', () => {
    const { ev, feed } = rig();
    feed(0, 1000, 0.9);
    feed(1000, 3000, 0.42);
    expect(ev).toEqual(['onset', 'confirm']);
  });

  it('灵敏度映射', () => {
    expect(SILENCE_BY_SENSITIVITY).toEqual({ 低: 1200, 中: 800, 高: 500 });
    const { ev, feed } = rig({ silenceMs: SILENCE_BY_SENSITIVITY.高 });
    feed(0, 1000, 0.9);
    feed(1000, 1560, 0.05);
    expect(ev).toEqual(['onset', 'confirm', 'commit']);
  });
});

describe('设置持久化', () => {
  const mem = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  };

  it('默认值与往返', () => {
    const s = mem();
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.faceFollow).toBe(false);
    expect(DEFAULT_SETTINGS.directVoice).toBe(false);
    expect(DEFAULT_SETTINGS.speechOutput).toBe(true);
    saveSettings({ ...DEFAULT_SETTINGS, faceFollow: true, vadSensitivity: '高' }, s);
    expect(loadSettings(s)).toMatchObject({ faceFollow: true, vadSensitivity: '高' });
  });

  it('损坏或类型不符的存储回退到默认值', () => {
    const s = mem();
    s.setItem('jarvis.settings.v1', '{not json');
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
    s.setItem('jarvis.settings.v1', JSON.stringify({ faceFollow: 'yes', focusView: true }));
    expect(loadSettings(s)).toMatchObject({ faceFollow: false, focusView: true });
  });

  it('减少动画：手动覆盖优先于系统偏好', () => {
    expect(wantsReducedMotion({ reducedMotion: 'system' }, { matches: true })).toBe(true);
    expect(wantsReducedMotion({ reducedMotion: 'off' }, { matches: true })).toBe(false);
    expect(wantsReducedMotion({ reducedMotion: 'on' }, { matches: false })).toBe(true);
  });
});

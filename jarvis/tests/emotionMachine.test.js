import { describe, it, expect, beforeEach } from 'vitest';
import { EmotionMachine, TASK_DEFAULT } from '../src/core/emotionMachine.js';
import { EMOTIONS, EMOTION_KEYWORDS, EMOTION_PARAMS } from '../src/core/emotions.js';
import { scoreWindow, WINDOW_CHARS } from '../src/core/keywordScanner.js';

function rig() {
  let t = 0;
  const changes = [];
  const m = new EmotionMachine({ now: () => t, onChange: (s, src) => changes.push([s, src]) });
  return { m, changes, advance: (ms) => { t += ms; return m.tick(); }, at: () => t };
}

describe('情绪参数表', () => {
  it('七种情绪都有完整参数，且数值与需求 4.2 一致', () => {
    expect(EMOTIONS).toHaveLength(7);
    for (const e of EMOTIONS) {
      expect(Object.keys(EMOTION_PARAMS[e]).sort()).toEqual(['glow', 'hue', 'jitter', 'morph', 'spin']);
    }
    expect(EMOTION_PARAMS.平静).toMatchObject({ hue: 200, spin: 0.15, morph: 0.85, glow: 0.6 });
    expect(EMOTION_PARAMS.警觉).toMatchObject({ hue: 0, spin: 0.55, morph: 0.3, glow: 1.0 });
    expect(EMOTION_PARAMS.安抚.jitter).toBeLessThan(EMOTION_PARAMS.平静.jitter);
    expect(EMOTION_PARAMS.愉悦.jitter).toBeGreaterThan(EMOTION_PARAMS.专注.jitter);
  });
});

describe('关键词打分', () => {
  it('每个关键词都能命中对应情绪', () => {
    for (const [emotion, words] of Object.entries(EMOTION_KEYWORDS)) {
      for (const w of words) expect(scoreWindow(`嗯，${w}。`)).toBe(emotion);
    }
  });

  it('无命中返回 null', () => {
    expect(scoreWindow('今天的天气是多云。')).toBeNull();
    expect(scoreWindow('')).toBeNull();
  });

  it('只看最近 200 字：被挤出窗口的关键词不再计分', () => {
    const text = '危险' + '。'.repeat(WINDOW_CHARS);
    expect(scoreWindow(text)).toBeNull();
    expect(scoreWindow('危险' + '。'.repeat(WINDOW_CHARS - 2))).toBe('警觉');
  });

  it('同等次数时越靠后的命中权重越高', () => {
    expect(scoreWindow('出现错误。没关系，已经恢复。')).toBe('安抚');
    expect(scoreWindow('没关系，但是又出现错误')).toBe('警觉');
  });

  it('次数多的情绪胜出', () => {
    expect(scoreWindow('太好了，恭喜！注意休息')).toBe('愉悦');
  });

  it('关键词跨 token 拼接也能命中', () => {
    const r = rig();
    r.m.setTaskState('listening');
    r.m.feedResponseText('不用');
    r.m.feedResponseText('担心');
    r.advance(800);
    expect(r.m.state).toBe('安抚');
  });
});

describe('第三层：任务状态推断', () => {
  it.each(Object.entries(TASK_DEFAULT))('%s → %s', (task, emotion) => {
    const r = rig();
    r.m.setTaskState(task);
    expect(r.m.state).toBe(emotion);
  });

  it('对话结束 → 亲和保持 3 秒后回落平静', () => {
    const r = rig();
    r.m.setTaskState('processing');
    r.m.setTaskState('done');
    expect(r.m.state).toBe('亲和');
    expect(r.advance(2999)).toBe('亲和');
    expect(r.advance(1)).toBe('平静');
  });

  it('未知任务状态被忽略', () => {
    const r = rig();
    r.m.setTaskState('processing');
    r.m.setTaskState('bogus');
    expect(r.m.state).toBe('专注');
  });
});

describe('第二层：关键词 800ms 防抖', () => {
  let r;
  beforeEach(() => {
    r = rig();
    r.m.setTaskState('listening');
  });

  it('候选持续不足 800ms 不切换', () => {
    r.m.feedResponseText('太好了');
    expect(r.advance(799)).toBe('聆听');
    expect(r.advance(1)).toBe('愉悦');
    expect(r.changes.at(-1)).toEqual(['愉悦', 'keyword']);
  });

  it('候选在 800ms 内被别的情绪取代时计时重来', () => {
    r.m.feedResponseText('太好了');
    r.advance(500);
    r.m.feedResponseText('！但是出现错误，错误码 42，警告');
    expect(r.advance(500)).toBe('聆听');
    expect(r.advance(300)).toBe('警觉');
  });

  it('已生效的关键词情绪保持，直到新候选稳定 800ms', () => {
    r.m.feedResponseText('欢迎回来');
    r.advance(800);
    expect(r.m.state).toBe('亲和');
    r.m.feedResponseText('，我们来计算一下');
    expect(r.advance(400)).toBe('亲和');
    expect(r.advance(400)).toBe('专注');
  });

  it('回合结束清空关键词，回到任务推断', () => {
    r.m.feedResponseText('出现异常');
    r.advance(800);
    expect(r.m.state).toBe('警觉');
    r.m.setTaskState('done');
    expect(r.m.state).toBe('亲和');
  });
});

describe('第一层：API 显式注入', () => {
  it('流式 emotion_hint 压过关键词与任务状态', () => {
    const r = rig();
    r.m.setTaskState('listening');
    r.m.feedResponseText('出现错误');
    r.advance(1000);
    expect(r.m.state).toBe('警觉');
    r.m.setStreamHint('安抚');
    expect(r.m.state).toBe('安抚');
    expect(r.m.source).toBe('hint');
  });

  it('无效的 hint（null / 未知值）被忽略', () => {
    const r = rig();
    r.m.setTaskState('processing');
    r.m.setStreamHint(null);
    r.m.setStreamHint('狂喜');
    expect(r.m.state).toBe('专注');
  });

  it('流式 hint 只在本轮有效', () => {
    const r = rig();
    r.m.setStreamHint('愉悦');
    r.m.setTaskState('done');
    expect(r.m.state).toBe('亲和');
  });

  it('注入端点的信号 ttl 到期后回落', () => {
    const r = rig();
    r.m.setTaskState('processing');
    r.m.inject('警觉', 5000);
    expect(r.m.state).toBe('警觉');
    expect(r.m.source).toBe('inject');
    expect(r.advance(4999)).toBe('警觉');
    expect(r.advance(1)).toBe('专注');
  });

  it('注入优先级高于流式 hint', () => {
    const r = rig();
    r.m.setStreamHint('愉悦');
    r.m.inject('警觉', 1000);
    expect(r.m.state).toBe('警觉');
    expect(r.advance(1000)).toBe('愉悦');
  });
});

describe('手动覆盖', () => {
  it('锁定期间自动规则不生效，点“自动”解除', () => {
    const r = rig();
    r.m.setManual('安抚');
    r.m.setTaskState('error');
    r.m.inject('警觉', 10000);
    r.m.feedResponseText('太好了');
    r.advance(1000);
    expect(r.m.state).toBe('安抚');
    expect(r.m.source).toBe('manual');
    r.m.setManual(null);
    expect(r.m.state).toBe('警觉');
  });

  it('锁定任意一种情绪都生效', () => {
    const r = rig();
    for (const e of EMOTIONS) expect(r.m.setManual(e)).toBe(e);
  });
});

describe('对话联动（需求 6.3）', () => {
  it('说话 → 聆听；发请求 → 专注；回复关键词 → 安抚；播报完 → 亲和 → 3 秒后平静', () => {
    const r = rig();
    r.m.beginUserTurn();
    expect(r.m.state).toBe('聆听');
    r.m.setTaskState('processing');
    expect(r.m.state).toBe('专注');
    r.m.setTaskState('listening');
    r.m.feedResponseText('别着急，我们一步一步来。');
    r.advance(800);
    expect(r.m.state).toBe('安抚');
    r.m.setTaskState('done');
    expect(r.m.state).toBe('亲和');
    expect(r.advance(3000)).toBe('平静');
  });

  it('新一轮输入清掉上一轮残留的关键词候选', () => {
    const r = rig();
    r.m.setTaskState('listening');
    r.m.feedResponseText('危险');
    r.m.beginUserTurn();
    expect(r.advance(2000)).toBe('聆听');
  });

  it('onChange 只在状态真正变化时回调', () => {
    const r = rig();
    r.m.setTaskState('idle');
    r.m.tick();
    expect(r.changes).toEqual([]);
    r.m.setTaskState('processing');
    r.m.setTaskState('processing');
    expect(r.changes).toEqual([['专注', 'task']]);
  });
});

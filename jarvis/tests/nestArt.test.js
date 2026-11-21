import { describe, expect, it } from 'vitest';
import { nestArt, nestFigure, nestIsDark, nestNeedsSprite } from '../src/ui/nestArt.js';

describe('小窝内的工作与生活画面', () => {
  it('真实任务先于猫的邀请，人物图随任务所在工位变化', () => {
    expect(nestFigure('sleep', 'archive', true, true)).toBe('archive');
    expect(nestFigure('tv', 'review', true, true)).toBe('news');
    expect(nestFigure('work', 'bench', true, true, 'shred')).toBe('shred');
    expect(nestFigure('work', 'bench', true, true, 'stomp')).toBe('stomp');
    expect(nestFigure('sleep', 'bench', true, true)).toBe('work');
    expect(nestFigure('rest', 'bench', true, false)).toBe('cat');
    expect(nestFigure('cat-visit', 'bench', false, false)).toBe('tv');
  });

  it('没有内置角色整幅图的动作保留自己的道具和姿势', () => {
    for (const activity of ['coffee', 'eat', 'shred', 'sing', 'think', 'rest']) {
      expect(nestFigure(activity, 'bench', false, false)).toBe(activity);
      expect(nestNeedsSprite(activity)).toBe(true);
    }
    for (const pose of ['work', 'news', 'sleep', 'tv', 'cat', 'trip']) {
      expect(nestNeedsSprite(pose)).toBe(false);
      expect(nestArt(pose, false)).not.toBe(nestArt(pose, true));
    }
  });

  it('室内日光与熄灯状态明确，夜间的主动开灯先于自然作息', () => {
    const daylight = {lightMode: 'auto', lampOn: false, night: false, period: 'day', activity: 'plan'};
    expect(nestIsDark(daylight)).toBe(false);
    expect(nestIsDark({...daylight, lightMode: 'off'})).toBe(true);
    expect(nestIsDark({...daylight, activity: 'sleep', night: true})).toBe(true);
    expect(nestIsDark({...daylight, lightMode: 'on', lampOn: true, night: true})).toBe(false);
  });
});

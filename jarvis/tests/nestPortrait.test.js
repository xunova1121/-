import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createNestPortrait, portraitActor, portraitArt, portraitCat } from '../src/ui/nestPortrait.js';
import { nestFootPosition } from '../src/ui/nestSofa.js';

describe('竖幅小窝的家具与角色分层', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {createElement: () => ({dataset: {}, hidden: true})});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('看电视、放大电视、就地休息、入睡的落脚位置相同，桌边写字及抚猫各有落点', () => {
    const sofa = nestFootPosition('tv', true, true);
    for (const [pose, viewing] of [['tv', false], ['rest', false], ['sleep', false], ['news', true]]) {
      expect(nestFootPosition(pose, viewing, true)).toBe(sofa);
    }
    expect(nestFootPosition('work', false, true)).not.toBe(sofa);
    expect(nestFootPosition('cat', false, true)).not.toBe(sofa);
    expect(nestFootPosition('tv', true, false)).toBe(nestFootPosition('sleep', false, false));
  });

  it('真实工作用书桌姿势，同一条新闻休闲阅读时才回到沙发', () => {
    expect(portraitActor('news', '')).toBe('work');
    expect(portraitActor('news', 'news')).toBe('read');
    expect(portraitActor('coffee', '')).toBe('');
  });

  it('猫主动凑近、闻手和擦脸使用各自的姿势', () => {
    expect(portraitCat('alert')).toBe('cat');
    expect(portraitCat('listening')).toBe('cat-sleep');
    expect(portraitCat('sniff')).toBe('cat-sniff');
    expect(portraitCat('groom')).toBe('cat-groom');
  });

  it('切换节目和睡觉只更换人物图，睡着的猫可一直留在地毯上', () => {
    const floor = {append: vi.fn()};
    const portrait = createNestPortrait(floor);
    const [[actor], [cat]] = floor.append.mock.calls;
    portrait.draw('work', '', 'asleep');
    expect(actor.src).toBe(portraitArt('work'));
    const sleepingCat = cat.src;
    portrait.draw('tv', 'tv', 'asleep');
    expect(actor.src).toBe(portraitArt('watch'));
    portrait.draw('sleep', '', 'deep');
    expect(actor.src).toBe(portraitArt('sleep'));
    expect(cat.src).toBe(sleepingCat);
    expect(sleepingCat).toBe(portraitArt('cat-sleep'));
    portrait.draw('coffee', '', 'alert');
    expect(actor.hidden).toBe(true);
    expect(cat.src).toBe(portraitArt('cat'));
    portrait.hide();
    expect(cat.hidden).toBe(true);
  });
});

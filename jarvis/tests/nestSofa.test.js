import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNestSofa } from '../src/ui/nestSofa.js';

function mount({safe = false, reduced = false, paced = false} = {}) {
  const animation = { cancel: vi.fn() };
  const walker = { dataset: {}, style: {}, animate: vi.fn(() => animation),
    getBoundingClientRect: () => ({left: 270, width: 60, bottom: 280}) };
  const scene = { setAttribute: vi.fn(), removeAttribute: vi.fn(), hasAttribute: name => paced && name === 'data-paced-motion' };
  const floor = { clientWidth: 600, clientHeight: 400, append: vi.fn(), querySelector: () => walker,
    getBoundingClientRect: () => ({left: 0, top: 0, width: 600, height: 400}) };
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  vi.stubGlobal('document', {
    createElement: () => ({ setAttribute: vi.fn() }),
    documentElement: { classList: { contains: () => safe } },
    body: { classList: { contains: () => false } }
  });
  return { sofa: createNestSofa(floor, scene), walker, scene, animation };
}

afterEach(() => vi.unstubAllGlobals());
describe('小窝固定沙发', () => {
  it('走向后排坐垫时收到工作，从当前脚下转向书桌；桌边步骤接续同一段路', () => {
    const { sofa, walker, scene, animation } = mount();
    sofa.enter('rest', 'work', false);
    expect(walker.dataset.facing).toBe('left');
    expect(scene.setAttribute).toHaveBeenCalledWith('data-sofa-walk', '');
    sofa.enter('news', 'rest', false);
    expect(animation.cancel).toHaveBeenCalledOnce();
    expect(walker.dataset.facing).toBe('right');
    const start = walker.animate.mock.calls[1][0][0].transform;
    const [x, y] = start.match(/-?[\d.]+/g).map(Number);
    expect(x).toBeCloseTo(300 - 600 * .62);
    expect(y).toBeCloseTo(280 - 400 * .631);
    sofa.enter('work', 'news', false);
    expect(walker.animate).toHaveBeenCalledTimes(2);
    animation.onfinish();
    expect(scene.removeAttribute).toHaveBeenLastCalledWith('data-sofa-walk');
    sofa.enter('think', 'news', true);
    expect(walker.dataset.facing).toBe('right');
    animation.onfinish();
    expect(scene.removeAttribute).toHaveBeenLastCalledWith('data-sofa-walk');
  });
  it('刚打开、睡醒、在同一沙发换姿势时直接就座', () => {
    const { sofa, walker } = mount();
    for (const previous of ['', 'sleep', 'rest', 'think']) sofa.enter('rest', previous, false);
    expect(walker.animate).not.toHaveBeenCalled();
  });
  it.each([{safe: true}, {reduced: true}, {paced: true}])('需要静态显示时直接坐下 %j', options => {
    const { sofa, walker } = mount(options);
    sofa.enter('rest', 'coffee', false);
    expect(walker.animate).not.toHaveBeenCalled();
  });
});

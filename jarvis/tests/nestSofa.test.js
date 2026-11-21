import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNestSofa } from '../src/ui/nestSofa.js';

function mount({safe = false, reduced = false} = {}) {
  const animation = { cancel: vi.fn() };
  const walker = { dataset: {}, animate: vi.fn(() => animation) };
  const scene = { setAttribute: vi.fn(), removeAttribute: vi.fn() };
  const floor = { clientWidth: 600, clientHeight: 400, append: vi.fn(), querySelector: () => walker };
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
  it('从书桌和前排沙发向不同方向回到同一坐垫，中途开始工作会停止走动', () => {
    const { sofa, walker, scene, animation } = mount();
    sofa.enter('rest', 'work', false);
    expect(walker.dataset.facing).toBe('left');
    expect(scene.setAttribute).toHaveBeenCalledWith('data-sofa-walk', '');
    sofa.enter('news', 'rest', false);
    expect(animation.cancel).toHaveBeenCalledOnce();
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
  it.each([{safe: true}, {reduced: true}])('需要静态显示时直接坐下 %j', options => {
    const { sofa, walker } = mount(options);
    sofa.enter('rest', 'coffee', false);
    expect(walker.animate).not.toHaveBeenCalled();
  });
});

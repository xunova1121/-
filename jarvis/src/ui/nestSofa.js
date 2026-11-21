import './nestSofa.css';

// 走路以两脚落地的位置为准。后排沙发的坐垫和猫身后的观影沙发使用同一幅房间的坐标。
const backCushion = { x: .373, y: .597 };
const carpet = { x: .428, y: .774 };
const frontCushion = { x: .306, y: .766 };
const desk = { x: .62, y: .631 };

export function createNestSofa(floor, scene) {
  for (const name of ['rest', 'walk']) {
    const part = document.createElement('span');
    part.className = 'ws-nest-sofa-' + name;
    part.setAttribute('aria-hidden', 'true');
    floor.append(part);
  }
  const walker = floor.querySelector('.ws-nest-sofa-walk');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let walk = null;

  function settle() {
    if (walk) {
      walk.onfinish = null;
      walk.cancel();
      walk = null;
    }
    scene.removeAttribute('data-sofa-walk');
  }

  function enter(pose, previous, viewing) {
    settle();
    if (pose !== 'rest' && pose !== 'think') return;
    if (!previous || ['rest', 'think', 'sleep'].includes(previous)) return;
    if (reduced.matches || document.body.classList.contains('reduced-motion') ||
        document.documentElement.classList.contains('safe-render') || !walker.animate) return;
    const from = viewing ? frontCushion : previous === 'cat' ? carpet : desk;
    const dx = (from.x - backCushion.x) * floor.clientWidth;
    const dy = (from.y - backCushion.y) * floor.clientHeight;
    if (!dx && !dy) return;
    walker.dataset.facing = dx < 0 ? 'right' : 'left';
    scene.setAttribute('data-sofa-walk', '');
    // 绕到沙发前侧再坐下；只移动小人物，背景、家具和镜头始终固定。
    walk = walker.animate([
      {transform: `translate(${dx}px,${dy}px)`},
      {transform: `translate(${dx * .44}px,${Math.max(dy, 0) + .024 * floor.clientHeight}px)`, offset: .56},
      {transform: 'translate(0,0)'}
    ], { duration: 720, easing: 'ease-in-out' });
    walk.onfinish = settle;
  }
  return { enter, settle };
}

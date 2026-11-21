import './nestSofa.css';

// 走路以两脚落地的位置为准。后排沙发的坐垫和猫身后的观影沙发使用同一幅房间的坐标。
const backCushion = { x: .373, y: .597 };
const carpet = { x: .428, y: .774 };
const frontCushion = { x: .306, y: .766 };
const desk = { x: .62, y: .631 };

// 以脚底而不是头像中心定位。竖幅家具与猫、角色都在同一个固定画布内。
const portraitFeet = {
  desk: {x: .748, y: .549}, front: {x: .631, y: .725}, cat: {x: .316, y: .707}
};

export function nestFootPosition(pose, viewing, upright) {
  if (pose === 'cat') return upright ? portraitFeet.cat : carpet;
  if (viewing || pose === 'tv' || pose === 'sleep') return upright ? portraitFeet.front : frontCushion;
  if (pose === 'rest' || pose === 'think') return upright ? portraitFeet.front : backCushion;
  return upright ? portraitFeet.desk : desk;
}

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

  function enter(pose, previous, viewing, {upright = false, viewing: nextViewing = false} = {}) {
    settle();
    if (!previous) return;
    // 横幅书桌角色属于原画；到书桌时直接接回原画，避免走动与写字重影。
    if (!upright && !nextViewing && !['rest', 'think', 'sleep', 'tv'].includes(pose)) return;
    if (!upright && (pose === 'rest' || pose === 'think') && previous === 'sleep') return;
    if (reduced.matches || document.body.classList.contains('reduced-motion') ||
        document.documentElement.classList.contains('safe-render') || !walker.animate) return;
    const from = nestFootPosition(previous, viewing, upright);
    const to = nestFootPosition(pose, nextViewing, upright);
    const dx = (from.x - to.x) * floor.clientWidth;
    const dy = (from.y - to.y) * floor.clientHeight;
    if (!dx && !dy) return;
    if (walker.style) {
      walker.style.left = (to.x * 100) + '%';
      walker.style.bottom = (100 - to.y * 100) + '%';
      walker.style.translate = '-50% 0';
    }
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

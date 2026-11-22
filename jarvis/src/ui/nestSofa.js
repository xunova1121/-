import './nestSofa.css';

// 走路以两脚落地的位置为准。后排沙发的坐垫和猫身后的观影沙发使用同一幅房间的坐标。
const backCushion = { x: .373, y: .597 };
const carpet = { x: .428, y: .774 };
const frontCushion = { x: .306, y: .766 };
const desk = { x: .62, y: .631 };
const foreground = { x: .65, y: .80 };

// 以脚底而不是头像中心定位。竖幅家具与猫、角色都在同一个固定画布内。
const portraitFeet = {
  desk: {x: .748, y: .549}, front: {x: .631, y: .725}, cat: {x: .316, y: .707}, foreground: {x: .53, y: .63}
};

export function nestFootPosition(pose, viewing, upright) {
  if (pose === 'cat') return upright ? portraitFeet.cat : carpet;
  if (viewing || pose === 'tv' || pose === 'sleep') return upright ? portraitFeet.front : frontCushion;
  if (pose === 'rest' || pose === 'think') return upright ? portraitFeet.front : backCushion;
  if (['eat','sing','shred'].includes(pose)) return upright ? portraitFeet.foreground : foreground;
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
  let destination = null;

  function settle() {
    if (walk) {
      walk.onfinish = null;
      walk.cancel();
      walk = null;
    }
    destination = null;
    scene.removeAttribute('data-sofa-walk');
  }

  function enter(pose, previous, viewing, {upright = false, viewing: nextViewing = false} = {}) {
    if (!previous || document.hidden || reduced.matches || document.body.classList.contains('reduced-motion') ||
        document.documentElement.classList.contains('safe-render') || scene.hasAttribute('data-paced-motion') || !walker.animate) return settle();
    // 横幅抚猫图自带人物，其余原画可用空椅纹理先遮住桌前的人。
    if (!upright && (pose === 'cat' || (pose === 'rest' || pose === 'think') && previous === 'sleep')) return settle();
    const to = nestFootPosition(pose, nextViewing, upright);
    if (walk && destination === to) return;
    let from = nestFootPosition(previous, viewing, upright);
    if (walk) {
      // 中途收到任务或切到另一件家具，从此刻的脚下转向；近看时两者使用同一缩放坐标。
      const bounds = floor.getBoundingClientRect();
      const feet = walker.getBoundingClientRect();
      if (bounds.width && bounds.height) from = {
        x: (feet.left + feet.width / 2 - bounds.left) / bounds.width,
        y: (feet.bottom - bounds.top) / bounds.height
      };
      settle();
    }
    const dx = (from.x - to.x) * floor.clientWidth;
    const dy = (from.y - to.y) * floor.clientHeight;
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    if (walker.style) {
      walker.style.left = (to.x * 100) + '%';
      walker.style.bottom = (100 - to.y * 100) + '%';
      walker.style.translate = '-50% 0';
    }
    walker.dataset.facing = dx < 0 ? 'right' : 'left';
    destination = to;
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

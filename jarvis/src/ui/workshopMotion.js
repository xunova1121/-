// 已记录的动作决定工位；暂停和失败停在原来的工作地点。
const poseStation = { idle: 'rest', edit: 'bench', think: 'bench', run: 'bench', repair: 'review' };
export const stationNames = { rest: '待命区', archive: '资料架', bench: '制作台', review: '检验台' };

export function stationForStep(entries, index) {
  for (let i = index; i >= 0; i--) {
    const step = entries[i];
    if (Object.hasOwn(stationNames, step.station)) return step.station;
    if (step.status !== 'waiting' && step.status !== 'stopped' && Object.hasOwn(poseStation, step.pose)) return poseStation[step.pose];
  }
  return 'rest';
}

export function createWorkshopMotion(scene, actor) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const canTranslate = typeof actor.animate === 'function' && CSS.supports('translate', '0px');
  let walk = null;
  let previous = null;

  function preferenceChanged(event) {
    if (event.matches) stop();
  }

  function stop() {
    if (walk) {
      walk.onfinish = null;
      walk.cancel();
      walk = null;
      reduced.removeEventListener?.('change', preferenceChanged);
    }
    actor.dataset.walking = 'false';
  }

  return {
    reset() {
      stop();
      previous = null;
    },
    show(station, { travel, working, gesture }) {
      scene.dataset.motion = working ? 'working' : gesture ? 'gesture' : 'still';
      const mayWalk = travel && canTranslate && !reduced.matches && !document.body.classList.contains('reduced-motion');
      if (previous === station) {
        if (!mayWalk) stop();
        return;
      }

      // 新回执可以在路上抵达。从此刻脚下的位置转向下一工位，旧动画随即释放。
      const from = previous && mayWalk ? actor.getBoundingClientRect() : null;
      stop();
      previous = station;
      scene.dataset.station = station;
      if (!from) return;
      const to = actor.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.bottom - to.bottom;
      const distance = Math.hypot(dx, dy);
      if (distance < 4) return;
      actor.dataset.facing = dx > 0 ? 'left' : 'right';
      actor.dataset.walking = 'true';
      const duration = Math.min(1050, Math.max(200, distance * 3.2));
      walk = actor.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }], { duration, easing: 'ease-in-out' });
      walk.onfinish = stop;
      reduced.addEventListener?.('change', preferenceChanged);
    }
  };
}

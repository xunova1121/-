// 已记录的动作决定工位；暂停和失败停在原来的工作地点。
const poseStation = { idle: 'rest', edit: 'bench', think: 'bench', run: 'bench', repair: 'review' };
export const stationNames = { rest: '待命区', archive: '资料架', bench: '制作台', review: '检验台' };
export const routineStations = {
  plan: { station: 'bench', operation: 'write' },
  tidy: { station: 'archive', operation: 'archive' },
  study: { station: 'review', operation: 'type' },
  news: { station: 'review', operation: 'type' }
};

export function stationForStep(entries, index) {
  for (let i = index; i >= 0; i--) {
    const step = entries[i];
    if (Object.hasOwn(stationNames, step.station)) return step.station;
    if (step.status !== 'waiting' && step.status !== 'stopped' && Object.hasOwn(poseStation, step.pose)) return poseStation[step.pose];
  }
  return 'rest';
}

// 两次真实回执可能在同一帧抵达。只给已经完成的最近一项留一轮手部动作，消息列表立即更新。
const WORK_CYCLE = 640;

// 以房间原画为坐标系，即使电视镜头正在跟拍，也能从角色眼前的位置接续走动。
export function feetInRoom(actor, floor) {
  const room = floor.getBoundingClientRect();
  if (!room.width || !room.height || !actor) return null;
  const box = actor.getBoundingClientRect();
  return { x: (box.left + box.width / 2 - room.left) / room.width, y: (box.bottom - room.top) / room.height };
}

export function walkAcrossRoom(actor, dx, dy, duration) {
  const options = { duration, easing: 'ease-in-out' };
  const walk = actor.animate([{ translate: dx + 'px ' + dy + 'px' }, { translate: '0px 0px' }], options);
  if (actor.parentElement.parentElement?.dataset.roomView === 'nest' || !CSS.supports('selector(:has(*))')) return walk;
  // 两条轨迹共用同一时钟。只有电视镜头应用反向平移，全景依旧让人走过整间屋子。
  const pan = actor.parentElement.animate([{ translate: -dx + 'px ' + -dy + 'px' }, { translate: '0px 0px' }], options);
  walk.addEventListener('cancel', () => pan.cancel(), { once: true });
  return walk;
}

export function createWorkshopMotion(scene, actor) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const canTranslate = typeof actor.animate === 'function' && CSS.supports('translate', '0px');
  const reduceMotion = () => reduced.matches || document.body.classList.contains('reduced-motion');
  let walk = null;
  let station = null;
  let latest = null;
  let displayed = null;
  let workingId = null;
  let workingSince = 0;
  let receiptId = null;
  let lastReceiptId = null;
  let timer = null;

  function stopWalk() {
    if (walk) {
      walk.onfinish = null;
      walk.cancel();
      walk = null;
    }
    actor.dataset.walking = 'false';
  }

  function clearReceipt() {
    clearTimeout(timer);
    timer = null;
    receiptId = null;
  }

  function updateHands() {
    const { entry, working, gesture, routineOperation } = displayed;
    const operation = routineOperation || (entry && ['running', 'done'].includes(entry.status) ? entry.operation : null);
    const acting = Boolean(operation && (working || receiptId) && !reduceMotion());
    const phase = walk ? 'travel' : !operation ? 'idle' : acting ? 'working' : 'snapshot';
    scene.dataset.operation = operation || 'none';
    scene.dataset.workPhase = phase;
    scene.dataset.workReceipt = String(Boolean(receiptId));
    scene.dataset.motion = phase === 'working' ? 'working' : gesture && !operation ? 'gesture' : 'still';
    const id = phase === 'working' ? entry?.id : null;
    if (workingId !== id) {
      workingId = id;
      workingSince = performance.now();
    }
  }

  function present(next, fromLife) {
    displayed = next;
    const mayWalk = (next.travel || fromLife) && !receiptId && canTranslate && !reduceMotion();
    const changesStation = station !== next.station;
    const floor = actor.parentElement;
    const from = fromLife || (changesStation && station && mayWalk ? feetInRoom(actor, floor) : null);
    if (fromLife || changesStation || !mayWalk) stopWalk();
    station = next.station;
    scene.dataset.station = station;
    if (mayWalk && from) {
      // 坐席作业和步态图的画格可以不同，两个位置都以脚下中心为准。
      scene.dataset.workPhase = 'travel';
      const to = actor.getBoundingClientRect();
      const box = floor.getBoundingClientRect();
      const scale = (floor.offsetWidth && box.width / floor.offsetWidth) || 1;
      const x = box.left + box.width * from.x;
      const y = box.top + box.height * from.y;
      const dx = (x - to.left - to.width / 2) / scale;
      const dy = (y - to.bottom) / scale;
      const distance = Math.hypot(dx, dy);
      if (distance >= 4) {
        actor.dataset.facing = dx > 0 ? 'left' : 'right';
        actor.dataset.walking = 'true';
        const duration = Math.min(800, Math.max(150, distance * 2.4));
        walk = walkAcrossRoom(actor, dx, dy, duration);
        walk.onfinish = () => { stopWalk(); updateHands(); };
      }
    }
    updateHands();
  }

  function preferenceChanged() {
    if (!latest) return;
    clearReceipt();
    stopWalk();
    present(latest);
  }

  return {
    reset() {
      clearReceipt();
      stopWalk();
      reduced.removeEventListener?.('change', preferenceChanged);
      station = latest = displayed = workingId = lastReceiptId = null;
      scene.dataset.operation = 'none';
      scene.dataset.workPhase = 'idle';
      scene.dataset.workReceipt = 'false';
    },
    show(nextStation, options, fromLife) {
      const { entry, mode, active, entries } = options;
      const before = latest;
      if (!before) reduced.addEventListener?.('change', preferenceChanged);
      latest = { ...options, station: nextStation };
      const id = entry?.id;
      if (mode !== 'live' || !entry || ['error', 'stopped', 'waiting'].includes(entry.status) ||
          (entry.status === 'running' && entry.station && id !== receiptId) ||
          (receiptId && !entries.some(step => step.id === receiptId))) clearReceipt();

      let confirmed = active && entry?.status === 'done' && entry.operation ? latest : null;
      // 流式写回复可能与正常结束落在同一帧，只凭同一轮确实转为 done 的记录补完这一下。
      if (!receiptId && entry?.pose === 'cheer' && before?.active && before.mode === 'live' && before.entry?.operation) {
        const finished = entries.find(step => step.id === before.entry.id && step.status === 'done');
        if (finished) confirmed = { ...before, entry: finished, travel: false };
      }
      if (before && mode === 'live' && confirmed && confirmed.entry.id !== lastReceiptId && !reduceMotion()) {
        clearReceipt();
        lastReceiptId = confirmed.entry.id;
        const seen = workingId === lastReceiptId ? performance.now() - workingSince : 0;
        if (seen < WORK_CYCLE) {
          receiptId = lastReceiptId;
          present(confirmed);
          timer = setTimeout(() => { clearReceipt(); present(latest); }, WORK_CYCLE - seen);
          return;
        }
      }
      if (!receiptId) present(latest, fromLife);
    }
  };
}

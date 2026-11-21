// 一只猫的活动倾向按设备当地时间变化，午间、夜间的安静时段也会醒来。
export function naturalCatState(date) {
  const hour = date.getHours();
  const cycle = (Math.floor(date.getMinutes() / 12) + hour * 5 + date.getDate()) % 10;
  if ((hour >= 5 && hour < 9) || (hour >= 17 && hour < 21)) {
    if (cycle < 7) return 'alert';
    return cycle === 7 ? 'groom' : 'asleep';
  }
  if (hour >= 12 && hour < 16) {
    if (cycle < 7) return 'asleep';
    return cycle < 9 ? 'groom' : 'alert';
  }
  const sleepSlots = hour >= 22 || hour < 5 ? 5 : 4;
  if (cycle < sleepSlots) return 'asleep';
  return cycle < 8 ? 'alert' : 'groom';
}

const restDuration = 90000;
const restKey = 'jarvis.nest.cat.restUntil.v1';
const visitKey = 'jarvis.nest.cat.evening.v1';
const activeVisits = new Set(['sniff', 'welcome', 'pet']);

export function createCatBehavior({ read, write }) {
  let phase = '';
  let deadline = 0;
  let resting = 0;
  let sleeping = 0;
  let alert = 0;
  let visits = 0;
  let limit = 0;
  let strokes = 0;
  let automatic = false;
  let lastEvening = '';

  function current(date) {
    if (phase) return phase;
    const now = date.getTime();
    if (now < resting) return 'rest';
    if (now < sleeping) return 'deep';
    if (now < alert) return 'alert';
    const natural = naturalCatState(date);
    // 清醒时偶尔舔一下前爪。午睡不被这个小动作打断。
    const second = (date.getMinutes() % 3) * 60 + date.getSeconds();
    return natural === 'alert' && second >= 92 && second < 99 ? 'groom' : natural;
  }

  function resume(date) {
    const until = Number(read(restKey));
    const now = date.getTime();
    // 校正系统时钟后，旧记录不能让猫持续数小时都拒绝互动。
    if (until > now && until <= now + restDuration) resting = until;
    if (resting > now + restDuration) resting = 0;
  }

  function leave(date, needsRest = phase === 'pet') {
    phase = '';
    automatic = false;
    deadline = 0;
    if (needsRest) {
      resting = date.getTime() + restDuration;
      write(restKey, String(resting));
    }
  }

  function approach(date, fromRoutine = false) {
    if (current(date) !== 'alert') return false;
    visits++;
    limit = 2 + ((date.getDate() + date.getHours() + Math.floor(date.getMinutes() / 6) + visits) % 3);
    strokes = 0;
    automatic = fromRoutine;
    phase = 'sniff';
    deadline = date.getTime() + 2300;
    return true;
  }

  function visitOnce(date) {
    const day = date.toDateString();
    if (lastEvening === day || read(visitKey) === day) return;
    lastEvening = day;
    write(visitKey, day);
    approach(date, true);
  }

  function interact(date) {
    const state = current(date);
    const now = date.getTime();
    if (state === 'asleep') {
      phase = 'listening';
      deadline = now + 1800;
    } else if (state === 'alert') {
      approach(date);
    } else if (state === 'welcome' || state === 'pet') {
      automatic = false;
      strokes++;
      if (strokes >= limit) leave(date, true);
      else {
        phase = 'pet';
        deadline = now + 35000;
      }
    }
  }

  function advance(date) {
    const now = date.getTime();
    if (!phase || now < deadline) return;
    // 页面冻结很久后回前台时，过时的短互动不会从中间继续。
    if (now - deadline > 45000) {
      leave(date, false);
    } else if (phase === 'listening') {
      leave(date, false);
      if ((date.getMinutes() + date.getDate()) % 3 === 0) sleeping = now + restDuration;
      else alert = now + 60000;
    } else if (phase === 'sniff') {
      const willing = (date.getDate() + date.getHours() + Math.floor(date.getMinutes() / 6)) % 5 !== 0;
      if (!willing) return leave(date, true);
      phase = 'welcome';
      deadline = now + (automatic ? 4500 : 1200);
    } else if (phase === 'welcome') {
      phase = 'pet';
      strokes = 1;
      deadline = now + (automatic ? 14000 : 12000);
    } else {
      leave(date, true);
    }
  }

  function snapshot(date) {
    const now = date.getTime();
    const state = current(date);
    const naturalBoundary = new Date(date);
    naturalBoundary.setMinutes((Math.floor(date.getMinutes() / 12) + 1) * 12, 0, 0);
    const boundaries = [naturalBoundary.getTime(), deadline, resting, sleeping, alert];
    if (!phase && naturalCatState(date) === 'alert') {
      const second = (date.getMinutes() % 3) * 60 + date.getSeconds();
      const next = second < 92 ? 92 : second < 99 ? 99 : 272;
      boundaries.push(now + (next - second) * 1000 - date.getMilliseconds());
    }
    return { state, withCat: activeVisits.has(state), nextAt: Math.min(...boundaries.filter((time) => time > now)) };
  }

  return { snapshot, resume, visitOnce, interact, advance, leave };
}

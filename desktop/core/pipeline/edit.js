/**
 * 剪辑台 —— 成片**出来之后**还能改的那一层。
 *
 * ════════ 为什么需要它 ════════
 *
 * 在这之前，整条链路是**一次性**的：分镜定好 → 出图 → 出视频 → 合成 → 完。
 * 想调节奏、换顺序、砍掉一镜，只能回分镜页改字段**再重跑**——
 * 而重跑是按镜数计费的。
 *
 * 可是"这段太拖，砍掉一秒""第 7 和第 8 对调""这一镜不要了"这些事，
 * **一帧都不用重新生成**。素材已经在盘上了，要动的只是"怎么拼"。
 * 那是 FFmpeg 层的事，十几秒的活，一分钱不花。
 *
 * 所以这个模块只做一件事：把"怎么拼"从**算出来的**变成**可以改的**。
 *
 * ════════ 为什么是纯函数 ════════
 *
 * 剪辑决定会同时影响三样东西：画面怎么切、配音摆在第几秒、字幕什么时候出。
 * 这三样只要有一处用了不同的口径，音、画、字就各走各的 ——
 * 而这种错在成片里表现为"越到后面越对不上"，是最难自己发现的那一类。
 *
 * 所以时间轴只能有**一份**，而这份计算必须便宜到可以被大量断言：
 * 不碰盘、不碰 FFmpeg，喂进去一个对象就能跑。
 *
 * ════════ 存什么 ════════
 *
 *   order  镜头 id 的顺序。空数组 = 按 index 原样
 *   clips  { [shotId]: { in, out, off } }
 *            in/out  手工入点出点（秒）。没设就交给自动剪辑
 *            off     这一镜不进成片。**不是删除** —— 素材还在，随时能放回来
 *
 * ⚠ 只存**差异**。没动过的镜头在 clips 里一条记录都没有，
 * 这样自动剪辑改进之后，没手工调过的那些会自动跟着变好。
 */

/** 一镜最短留多少秒。再短就是一帧闪过，观众只会觉得画面抖了一下 */
export const MIN_SPAN = 0.3;

/**
 * 洗一遍剪辑决定。
 *
 * 洗的是**外面传进来的东西**：界面可能发来一个不存在的镜头 id、
 * 一个负数入点、一个比片段还长的出点。不洗的话这些会一路走到 FFmpeg，
 * 而那一层的报错完全看不出是这儿的问题。
 */
export function normalize(edit, shots = []) {
  const known = new Map(shots.map((s) => [s.id, s]));
  const raw = edit && typeof edit === 'object' ? edit : {};

  // 顺序：只认真实存在的、不重复的；没提到的按 index 补在后面
  const seen = new Set();
  const order = [];
  for (const id of Array.isArray(raw.order) ? raw.order : []) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const s of [...shots].sort((a, b) => (a.index || 0) - (b.index || 0))) {
    if (!seen.has(s.id)) order.push(s.id);
  }

  const clips = {};
  for (const [id, v] of Object.entries(raw.clips || {})) {
    if (!known.has(id) || !v || typeof v !== 'object') continue;
    const one = {};
    if (v.off === true) one.off = true;
    const a = Number(v.in);
    const b = Number(v.out);
    // 夹回合法范围而不是丢掉：丢掉的话"我明明设过入点"和"没设过"
    // 在存下来的东西里长得一模一样，回头没人查得出是被谁清的
    if (Number.isFinite(a)) one.in = Number(Math.max(0, a).toFixed(2));
    if (Number.isFinite(b) && b > 0) one.out = Number(b.toFixed(2));
    // 出点在入点之前是无意义的 —— 与其发给 FFmpeg 一个空片段，不如当没设过
    if (one.in != null && one.out != null && one.out - one.in < MIN_SPAN) {
      delete one.in;
      delete one.out;
    }
    if (Object.keys(one).length) clips[id] = one;
  }
  return { order, clips };
}

/** 这一镜进不进成片 */
export function isOff(edit, shotId) {
  return Boolean(edit?.clips?.[shotId]?.off);
}

/**
 * 按剪辑顺序排好、去掉不用的那几镜。
 *
 * @param shots 已经有视频的那些（没视频的镜头进不了成片，那是另一回事）
 */
export function ordered(edit, shots = []) {
  const norm = normalize(edit, shots);
  const byId = new Map(shots.map((s) => [s.id, s]));
  return norm.order
    .filter((id) => !isOff(norm, id))
    .map((id) => byId.get(id))
    .filter(Boolean);
}

/**
 * 这一镜实际用哪一段：`{ in, out, manual }`。
 *
 * 手工设过就听手工的；没设过就回 null，让调用方交给自动剪辑 ——
 * **不要在这儿替自动剪辑做决定**：那一层要读真视频、要算帧差，
 * 而这个模块的全部价值就在于它不碰那些东西。
 *
 * @param total 这一段素材实际多长。用来把手工值卡回合法范围 ——
 *              素材换过一版（重出）之后，旧的出点可能已经超出去了。
 */
export function windowOf(edit, shot, total = 0) {
  const c = edit?.clips?.[shot?.id];
  if (!c || (c.in == null && c.out == null)) return null;
  const cap = Number(total) > 0 ? Number(total) : Infinity;
  let a = Math.max(0, Math.min(c.in ?? 0, cap));
  let b = Math.min(c.out ?? cap, cap);
  if (!Number.isFinite(b)) return null; // 不知道素材多长，又只给了入点 —— 交给自动剪辑
  if (b - a < MIN_SPAN) {
    // 素材变短了，手工那一段已经不成立。往回挪，挪不动就作废
    a = Math.max(0, b - MIN_SPAN);
    if (b - a < MIN_SPAN) return null;
  }
  return { in: Number(a.toFixed(2)), out: Number(b.toFixed(2)), manual: true };
}

/** 有没有人动过 —— 界面上要据此显示"这部片子剪过" */
export function touched(edit) {
  if (!edit) return false;
  return Boolean(Object.keys(edit.clips || {}).length) || Boolean((edit.order || []).length);
}

/**
 * 一句人话：这次剪辑改了什么。
 *
 * 合成日志里要有这一句 —— 否则"成片怎么和上次不一样"没有任何线索，
 * 而剪辑决定是存在项目里的，几天之后自己都想不起来动过什么。
 */
export function summarize(edit, shots = []) {
  const norm = normalize(edit, shots);
  const off = Object.entries(norm.clips).filter(([, v]) => v.off).map(([id]) => id);
  const trimmed = Object.entries(norm.clips).filter(([, v]) => v.in != null || v.out != null);
  const byId = new Map(shots.map((s) => [s.id, s]));
  const natural = [...shots].sort((a, b) => (a.index || 0) - (b.index || 0)).map((s) => s.id);
  const reordered = norm.order.some((id, i) => natural[i] !== id);

  const bits = [];
  if (reordered) bits.push('调过顺序');
  if (off.length) bits.push(`跳过 ${off.length} 镜（第 ${off.map((id) => byId.get(id)?.index).filter(Boolean).join('、')} 镜）`);
  if (trimmed.length) bits.push(`${trimmed.length} 镜手工设了入出点`);
  if (!bits.length) return null;
  return `剪辑台：${bits.join('，')} —— 这些只影响怎么拼，不重新生成任何素材`;
}

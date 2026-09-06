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
 *   order   片段 key 的顺序。空数组 = 按 index 原样
 *   clips   { [key]: { in, out, off, trans, fx, mute } }
 *             in/out  手工入点出点（秒）。没设就交给自动剪辑
 *             off     这一镜不进成片。**不是删除** —— 素材还在，随时能放回来
 *             trans   进这一镜用什么转场。压过 shot.transition
 *             fx      这一段的画面效果（见 core/fx.js）
 *             mute    这一镜的台词和音效都不要（画面照留）
 *   tracks  { voice, sfx, music } —— 整条音轨的开关。只存**关掉**的那些
 *   music   { path, name, gain, fadeIn, fadeOut, duck, loop } 背景音乐
 *
 * ════════ 什么是 key ════════
 *
 * 一开始 key 就是镜头 id，一镜一段。**用小剪刀切开之后不是了** ——
 * 同一镜会变成两段，各有各的入出点、各有各的转场和效果。
 * 那时候第二段的 key 是 `<shotId>#2`。
 *
 * 为什么不另起一套 id：切开的两段**共用同一个素材文件**，也共用同一句台词、
 * 同一条音效。key 里带着 shotId，"这一段是哪一镜来的"就永远不会丢，
 * 而重出这一镜之后两段会自动跟着换成新素材。
 *
 * ⚠ 台词和音效**只跟第一段走**（timeline 里的 `first`）。
 * 不这么定的话，切一刀就会把同一句话念两遍 —— 而那是没人想要的。
 *
 * ⚠ 只存**差异**。没动过的镜头在 clips 里一条记录都没有，
 * 这样自动剪辑改进之后，没手工调过的那些会自动跟着变好。
 *
 * ⚠ 转场为什么也能记在这儿（shot.transition 明明已经有了）：
 * 分镜上那个字段是**模型给的建议**，而剪辑台上改的是**这一版成片**的决定。
 * 两者混在一个字段里的话，重跑一次分镜就会把人手调过的转场全冲掉 ——
 * 而重跑分镜是很常见的操作。没在剪辑台上动过的，照旧听分镜的。
 */

import * as transitions from '../transitions.js';
import * as fx from '../fx.js';

/** 一镜最短留多少秒。再短就是一帧闪过，观众只会觉得画面抖了一下 */
export const MIN_SPAN = 0.3;

/**
 * 背景音乐的默认值。
 *
 * gain 0.22 不是随手定的：背景音乐压在台词底下大约要低 12~15dB，
 * 0.22 ≈ −13dB。再响一点点，观众就会觉得"听不清在说什么"却说不出为什么 ——
 * 这是自己配乐时最常犯的错，因为单独听音乐时它一点都不响。
 *
 * duck（自动避让）打开的话，有人说话时音乐会再自动压下去一截，
 * 说完自己回来。这是广播和影视里的标准做法，比手动摆关键帧靠谱得多。
 */
export const MUSIC_DEFAULTS = {
  gain: 0.22,
  fadeIn: 1.5,
  fadeOut: 2.5,
  duck: true,
  loop: true
};

/** 三条音轨。默认都开着，所以只存"被关掉"的那些 */
export const TRACKS = ['voice', 'sfx', 'music'];

export const TRACK_LABELS = { voice: '台词配音', sfx: '音效', music: '背景音乐' };

/**
 * 洗一遍剪辑决定。
 *
 * 洗的是**外面传进来的东西**：界面可能发来一个不存在的镜头 id、
 * 一个负数入点、一个比片段还长的出点。不洗的话这些会一路走到 FFmpeg，
 * 而那一层的报错完全看不出是这儿的问题。
 */
/** 片段 key → 它是哪一镜。`s1` → `s1`，`s1#2` → `s1` */
export function shotIdOf(key) {
  const k = String(key ?? '');
  const i = k.indexOf('#');
  return i === -1 ? k : k.slice(0, i);
}

/**
 * 给某一镜再要一个没被占用的 key。切开时用。
 *
 * 从 #2 往上找第一个空号，**不是"现有个数 + 1"** —— 中间删掉过一段的话，
 * 按个数算会撞上一个还在的号，直接把它盖掉。
 */
export function nextKey(edit, shotId, shots = []) {
  const used = new Set([
    ...(Array.isArray(edit?.order) ? edit.order : []),
    ...Object.keys(edit?.clips || {})
  ].filter((k) => shotIdOf(k) === shotId));
  void shots;
  for (let n = 2; n < 999; n += 1) {
    const k = `${shotId}#${n}`;
    if (!used.has(k)) return k;
  }
  return `${shotId}#${Date.now()}`;
}

export function normalize(edit, shots = []) {
  const known = new Map(shots.map((s) => [s.id, s]));
  const raw = edit && typeof edit === 'object' ? edit : {};

  // 顺序：只认真实存在的、不重复的；一镜都没提到的按 index 补在后面
  const seen = new Set();
  const order = [];
  const covered = new Set();
  for (const key of Array.isArray(raw.order) ? raw.order : []) {
    const sid = shotIdOf(key);
    if (!known.has(sid) || seen.has(key)) continue;
    seen.add(key);
    covered.add(sid);
    order.push(key);
  }
  /**
   * ⚠ 补的判据是"这一镜**一段都没有**"，不是"这个 id 不在 order 里"。
   *
   * 切开之后 order 里是 `s1` 和 `s1#2`，两段都在。按 id 找的话
   * `s1` 在、没事；但要是人把第一段删了、只留 `s1#2`，
   * 按 id 找就会以为这一镜没排到，又给它补一段完整的回来 ——
   * 表现是"删掉的那半截自己长回来了"。
   */
  for (const s of [...shots].sort((a, b) => (a.index || 0) - (b.index || 0))) {
    if (!covered.has(s.id)) order.push(s.id);
  }

  const clips = {};
  for (const [id, v] of Object.entries(raw.clips || {})) {
    if (!known.has(shotIdOf(id)) || !v || typeof v !== 'object') continue;
    const one = {};
    if (v.off === true) one.off = true;
    if (v.mute === true) one.mute = true;
    // 认不出来的转场／效果名一律丢掉，**不要留着** —— 留着的话它会一路走到
    // FFmpeg，在那儿变成一条谁也看不懂的滤镜报错，而真正的原因在这里
    if (transitions.ALL_KINDS.includes(v.trans) && v.trans !== 'cut') one.trans = v.trans;
    if (fx.has(v.fx)) one.fx = v.fx;
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

  // 音轨开关：只存"关掉"的。默认全开，所以 tracks 里没有的键 = 开着
  const tracks = {};
  for (const name of TRACKS) {
    if (raw.tracks && raw.tracks[name] === false) tracks[name] = false;
  }

  return { order, clips, tracks, music: normalizeMusic(raw.music) };
}

/**
 * 洗一遍背景音乐。
 *
 * 音量必须夹在 [0, 1.5]：界面上是个滑块，但请求体是可以手写的，
 * 一个 gain=40 会让整条音轨爆掉 —— 而爆音是**不可逆**的，
 * 混完就没法从成片里救回来了。
 */
export function normalizeMusic(raw) {
  if (!raw || typeof raw !== 'object' || !raw.path) return null;
  const num = (v, fallback, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Number(Math.min(hi, Math.max(lo, n)).toFixed(3)) : fallback;
  };
  return {
    path: String(raw.path),
    name: String(raw.name || '').slice(0, 120),
    seconds: Number(raw.seconds) > 0 ? Number(Number(raw.seconds).toFixed(2)) : null,
    gain: num(raw.gain, MUSIC_DEFAULTS.gain, 0, 1.5),
    fadeIn: num(raw.fadeIn, MUSIC_DEFAULTS.fadeIn, 0, 10),
    fadeOut: num(raw.fadeOut, MUSIC_DEFAULTS.fadeOut, 0, 20),
    duck: raw.duck !== false,
    loop: raw.loop !== false
  };
}

/** 这条音轨开着吗 */
export function trackOn(edit, name) {
  return edit?.tracks?.[name] !== false;
}

/** 这一段的声音要不要（画面照留）*/
export function isMuted(edit, key) {
  return Boolean(edit?.clips?.[key]?.mute);
}

/**
 * 进这一段用什么转场。
 *
 * 剪辑台上改过的优先；没改过的听分镜的。两级的理由见文件开头 ——
 * 重跑分镜不该冲掉人手调的转场，而人没调过的应该跟着分镜一起变。
 */
export function transitionOf(edit, key, shot) {
  const manual = edit?.clips?.[key]?.trans;
  if (transitions.ALL_KINDS.includes(manual)) return manual;
  /**
   * ⚠ 切出来的后半段**不继承分镜上那个转场**。
   *
   * 分镜说"这一镜用叠化进来"，说的是这一镜和**上一镜**之间。
   * 让后半段也去读它，等于在这一镜自己中间插一处叠化 ——
   * 画面会莫名其妙地叠一下，而且还会吃掉半秒，把后面整条时间轴推歪。
   * 后半段默认硬切（就是它本来的样子：同一段画面接着往下走）。
   */
  if (key !== shotIdOf(key)) return 'cut';
  return transitions.kindOf(shot);
}

/** 这一段的画面效果。没设过回 'none' */
export function fxOf(edit, key) {
  const id = edit?.clips?.[key]?.fx;
  return fx.has(id) ? id : 'none';
}

/** 背景音乐（已洗过）。没有回 null */
export function musicOf(edit) {
  if (!trackOn(edit, 'music')) return null;
  return normalizeMusic(edit?.music);
}

/** 这一段进不进成片 */
export function isOff(edit, key) {
  return Boolean(edit?.clips?.[key]?.off);
}

/**
 * 按剪辑顺序排好、去掉不用的那几段。回的是 `{ key, shot }`。
 *
 * ⚠ 同一镜被切开之后会**出现不止一次**（key 不同、shot 是同一个）。
 * 所以这里不能只回 shot —— 调用方要靠 key 才找得到这一段的入出点。
 *
 * @param shots 已经有视频的那些（没视频的镜头进不了成片，那是另一回事）
 */
export function ordered(edit, shots = []) {
  const norm = normalize(edit, shots);
  const byId = new Map(shots.map((s) => [s.id, s]));
  return norm.order
    .filter((key) => !isOff(norm, key))
    .map((key) => ({ key, shot: byId.get(shotIdOf(key)) }))
    .filter((x) => x.shot);
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
export function windowOf(edit, key, total = 0) {
  const c = edit?.clips?.[key];
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

/**
 * 成片的时间轴：每一镜从第几秒开始、占多长。
 *
 * ════════ 为什么这一份要放在这里 ════════
 *
 * 它同时是**四样东西的依据**：画面怎么切、配音摆在第几秒、字幕什么时候出、
 * 以及剪辑台上那条时间线画多长。
 *
 * 前三样在服务端算，第四样在浏览器里画。在界面里另写一份算法是最自然的写法，
 * 也是错的 —— 两份算法一定会漂（少减一次叠化的重叠、时长策略读的是另一个字段），
 * 而漂开的表现是"时间线上量的和出来的片子对不上"：
 * 界面说第 7 镜在第 22 秒，成片里它在第 20.5 秒。这种错没有报错，
 * 只能靠人拿秒表去比，而没人会那么做。
 *
 * 所以服务端和浏览器**跑的是这一个函数**（服务端 import，浏览器走 /edit.js
 * 那条把原件原样发过去的路）。一份代码，不可能漂。
 *
 * @param policy  'keep' 保留模型给的完整片段 / 'trim' 按分镜时长裁剪
 */
export function timeline(project, { policy = 'keep' } = {}) {
  const withVideo = (project?.shots || []).filter((s) => s.videoPath);
  const parts = ordered(project?.edit, withVideo);
  const rows = [];
  const usedShots = new Set();
  let at = 0;
  for (const { key, shot } of parts) {
    /**
     * 重叠类转场（叠化、推、划……）会**吃掉**重叠的那半秒 —— 全片因此变短。
     *
     * 这一行必须在这里，不能只写在合成那一层：配音按绝对时间点摆、
     * 字幕也按绝对时间算，两者都来自这个函数。少了它，一处叠化之后
     * 的每一句台词都会晚半秒，而且叠化越多错得越多。
     */
    const trans = rows.length ? transitionOf(project?.edit, key, shot) : 'cut';
    if (rows.length) at -= transitions.overlapOfKind(trans);
    /**
     * 手工设过入出点的，长度就是那一段 —— 它压过时长策略。
     * 人明确说了"这一镜只要 2.4 秒"，没有任何理由再去按计划值或实出时长算。
     */
    const total = Number(shot.actualDuration) || Number(shot.duration) || 0;
    const win = windowOf(project?.edit, key, total);
    const span = win
      ? Number((win.out - win.in).toFixed(2))
      : (policy === 'trim'
        ? Number(shot.duration) || Number(shot.actualDuration) || 0
        : Number(shot.actualDuration) || Number(shot.duration) || 0);
    /**
     * ⚠ 台词和音效**只跟这一镜的第一段走**。
     *
     * 切一刀之后同一镜出现两次，而它的配音只有一条。两段都摆的话，
     * 同一句话会被念两遍 —— 那不是任何人想要的，而且第二遍还会盖到
     * 后面镜头的台词上。字幕同理。
     */
    const first = !usedShots.has(shot.id);
    usedShots.add(shot.id);
    rows.push({
      key,
      shot,
      first,
      start: Number(at.toFixed(3)),
      span,
      win,
      total,
      trans,
      fx: fxOf(project?.edit, key),
      muted: isMuted(project?.edit, key)
    });
    at += span;
  }
  return rows;
}

/** 成片总长（秒）。时间线要按它画刻度，播放头要按它封顶 */
export function totalSeconds(project, opts) {
  const rows = timeline(project, opts);
  if (!rows.length) return 0;
  const last = rows[rows.length - 1];
  return Number((last.start + last.span).toFixed(2));
}

/** 有没有人动过 —— 界面上要据此显示"这部片子剪过" */
export function touched(edit) {
  if (!edit) return false;
  return Boolean(Object.keys(edit.clips || {}).length)
    || Boolean((edit.order || []).length)
    || Boolean(edit.music?.path)
    || TRACKS.some((t) => edit.tracks?.[t] === false);
}

/**
 * 一句人话：这次剪辑改了什么。
 *
 * 合成日志里要有这一句 —— 否则"成片怎么和上次不一样"没有任何线索，
 * 而剪辑决定是存在项目里的，几天之后自己都想不起来动过什么。
 */
export function summarize(edit, shots = []) {
  const norm = normalize(edit, shots);
  const off = Object.entries(norm.clips).filter(([, v]) => v.off).map(([key]) => key);
  const trimmed = Object.entries(norm.clips).filter(([, v]) => v.in != null || v.out != null);
  const byId = new Map(shots.map((s) => [s.id, s]));
  const natural = [...shots].sort((a, b) => (a.index || 0) - (b.index || 0)).map((s) => s.id);
  const reordered = norm.order.length !== natural.length || norm.order.some((key, i) => natural[i] !== key);
  const splits = norm.order.filter((key) => key !== shotIdOf(key)).length;

  const muted = Object.entries(norm.clips).filter(([, v]) => v.mute);
  const withTrans = Object.entries(norm.clips).filter(([, v]) => v.trans);
  const withFx = Object.entries(norm.clips).filter(([, v]) => v.fx);

  const bits = [];
  if (reordered) bits.push('调过顺序');
  if (splits) bits.push(`用小剪刀切开了 ${splits} 处`);
  if (off.length) bits.push(`跳过 ${off.length} 段（第 ${[...new Set(off.map((key) => byId.get(shotIdOf(key))?.index).filter(Boolean))].join('、')} 镜）`);
  if (trimmed.length) bits.push(`${trimmed.length} 镜手工设了入出点`);
  if (muted.length) bits.push(`${muted.length} 镜静音`);
  if (withTrans.length) bits.push(`${withTrans.length} 处手改了转场`);
  if (withFx.length) bits.push(`${withFx.length} 镜加了画面效果`);
  for (const t of TRACKS) {
    if (norm.tracks[t] === false) bits.push(`关掉了${TRACK_LABELS[t]}`);
  }
  if (norm.music) bits.push(`加了背景音乐（${norm.music.name || '未命名'}，音量 ${(norm.music.gain * 100).toFixed(0)}%${norm.music.duck ? '，说话时自动避让' : ''}）`);
  if (!bits.length) return null;
  /**
   * ⚠ "不重新生成任何素材"这句要准确。
   *
   * 加了画面效果的那几段**要重压一遍**，比平时慢 —— 但慢和花钱是两件事，
   * 而人只会为后者犹豫。所以这里如实分开说，不含糊过去。
   */
  const cost = withFx.length
    ? `—— 这些只影响怎么拼；其中 ${withFx.length} 段因为加了效果要重压一遍（慢一点，但不重新生成素材、不花钱）`
    : '—— 这些只影响怎么拼，不重新生成任何素材';
  return `剪辑台：${bits.join('，')} ${cost}`;
}

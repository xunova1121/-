/**
 * 预演台：把"镜头"从一句话变成一组数。
 *
 * ── 补的是哪个洞 ──
 *
 * 分镜里的 camera 字段一直是纯文本：`"中景"`、`"镜头缓推"`。
 * 这句话每一镜都要模型自己脑补成一个**具体机位**，于是：
 *
 *   · 第 6 镜人往右走出画，第 7 镜又从右边走进来 —— 观众觉得他掉头了（越轴）
 *   · 第一段慢走、第二段突然加速 —— 两段各自挑了个速度
 *   · 说"中景"，出来一会儿近景一会儿全景 —— "中景"本来就没有确切含义
 *
 * 这些都不是模型不听话，是**我们没给够信息**。"中景"不是机位，
 * "机位在人物右前方 45°、齐胸高、85mm" 才是。
 *
 * ── 为什么是俯视排位，不是 3D 白模 ──
 *
 * 白模预演真正值钱的用法是把灰模渲染图当结构图喂进去（类似 depth/ControlNet）。
 * 查了一圈：现在配的这几家（可灵、Vidu、方舟、秘塔/海螺）**都没有**
 * 公开的结构控制通道。所以那条路的产出送不进去，3D 只剩一个预览。
 *
 * 而"精确的机位文字"这条路每一家都吃，可灵还能吃结构化的六个数。
 * 一张俯视图就够生成它 —— 花两周做 3D 只为了同样的产出，不划算。
 *
 * ── 这个模块只做计算 ──
 *
 * 不碰文件、不碰网络、不碰设置。喂进去几个坐标，吐出景别、机位关系、
 * 越轴判断和三种译法。所以它能在自检里被大量地、便宜地验证 ——
 * 而几何算错了是最难靠肉眼发现的那类 bug。
 *
 * ── 坐标怎么定 ──
 *
 * 俯视图，单位**米**。x 向右，y 向上（往画面深处）。
 * 朝向 facing 用角度：0° 朝上（+y），顺时针增大，90° 朝右。
 * 这和界面上拖出来的方向一致，省掉一层换算 —— 换算是错误的温床。
 */

/** 全画幅底片高度（毫米）。景别换算的基准，换机型不换这个数就行 */
const SENSOR_H = 24;

/** 一个人有多高（米）。景别说的就是"这个人占了画面多少" */
export const PERSON_H = 1.7;

/** 眼睛高度（米）。判平视/俯拍/仰拍拿它比，不是拿身高比 */
const EYE_H = 1.6;

export const DEFAULT_LENS = 35;

/**
 * 这个镜头在这个距离上，画面里能装下多高（米）。
 *
 * 这才是景别的本体。同样说"中景"，35mm 站 2 米和 85mm 站 5 米
 * 是完全不同的两张画（后者背景压缩、透视平），
 * 而文本字段 `camera: "中景"` 把这个差别整个抹掉了。
 */
export function framedHeight(distanceM, lensMm = DEFAULT_LENS) {
  const f = Math.max(1, Number(lensMm) || DEFAULT_LENS);
  const d = Math.max(0.01, Number(distanceM) || 0);
  return (d * SENSOR_H) / f;
}

const SIZES = [
  { id: 'closeup', label: '特写', max: 0.5 },
  { id: 'medium-closeup', label: '近景', max: 1.0 },
  { id: 'medium', label: '中景', max: 1.7 },
  { id: 'full', label: '全景', max: 2.8 },
  { id: 'wide', label: '远景', max: Infinity }
];

/** 景别：按"画面装得下多高"分档，而不是按感觉 */
export function shotSize(distanceM, lensMm = DEFAULT_LENS) {
  const h = framedHeight(distanceM, lensMm);
  const hit = SIZES.find((s) => h <= s.max);
  return { id: hit.id, label: hit.label, framedHeight: Number(h.toFixed(2)) };
}

export function distance(a, b) {
  return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
}

/** 角度归一到 (-180, 180]，方便判"偏左还是偏右" */
export function norm180(deg) {
  let d = ((Number(deg) || 0) + 180) % 360;
  if (d < 0) d += 360;
  return d - 180;
}

/** 从 a 看向 b 的方位角。0° 朝上，顺时针 */
export function bearing(a, b) {
  const dx = (b?.x || 0) - (a?.x || 0);
  const dy = (b?.y || 0) - (a?.y || 0);
  return norm180((Math.atan2(dx, dy) * 180) / Math.PI);
}

/**
 * 机位在这个人的哪一边 —— 这一条直接决定该发哪张设定图。
 *
 * 返回的 sheet 就是 angles.js 里的角度 id：机位绕到人背后，
 * 参考图就该发背面那张。这比"描述里有没有'背对'这两个字"可靠得多 ——
 * 关键词判断是猜的，几何是算的。
 */
export function facingRelation(cam, subject) {
  // 人脸朝向 facing，机位在 subject → cam 这个方位上。两者的夹角就是关系
  const toCam = bearing(subject, cam);
  const rel = Math.abs(norm180(toCam - (Number(subject?.facing) || 0)));
  if (rel <= 30) return { id: 'front', label: '正面', sheet: 'primary', deg: Math.round(rel) };
  if (rel <= 60) return { id: 'three-quarter', label: '斜侧', sheet: 'side', deg: Math.round(rel) };
  if (rel <= 120) return { id: 'profile', label: '正侧面', sheet: 'side', deg: Math.round(rel) };
  if (rel <= 150) return { id: 'back-three-quarter', label: '侧后', sheet: 'back', deg: Math.round(rel) };
  return { id: 'back', label: '背面', sheet: 'back', deg: Math.round(rel) };
}

/** 机位高度相对眼睛：平视 / 俯拍 / 仰拍 */
export function heightRelation(camHeightM) {
  const h = Number(camHeightM);
  if (!Number.isFinite(h)) return { id: 'eye', label: '平视' };
  if (h >= EYE_H + 0.45) return { id: 'high', label: '俯拍' };
  if (h <= EYE_H - 0.45) return { id: 'low', label: '仰拍' };
  return { id: 'eye', label: '平视' };
}

/**
 * 轴线（180° 线）：机位在哪一侧。
 *
 * ── 这是"人物莫名其妙掉头"的根因 ──
 *
 * 两个人对话，他们之间那条连线就是轴线。机位只要一直待在轴线的同一侧，
 * 观众看到的左右关系就是稳的：A 永远在左、B 永远在右。
 * 一旦跨到另一侧，两人在画面上左右对调 —— 而观众读到的不是"换了个机位"，
 * 是"他俩换了位置"或者"他掉头了"。
 *
 * 一个人的时候用他的**朝向**当轴线：他往右走，机位就该一直在同一侧，
 * 否则下一镜他就变成往左走了。
 *
 * 回 +1 / -1 表示两侧，0 表示正好在轴线上（这种机位本来就该避免，
 * 它是唯一一个"两侧都算"的位置，下一镜往哪边都不算越轴，但画面很别扭）。
 */
export function axisSide(cam, subjects = []) {
  if (!cam || !subjects.length) return 0;
  const a = subjects[0];
  let ax;
  let ay;
  if (subjects.length >= 2) {
    ax = (subjects[1].x || 0) - (a.x || 0);
    ay = (subjects[1].y || 0) - (a.y || 0);
  } else {
    const rad = ((Number(a.facing) || 0) * Math.PI) / 180;
    ax = Math.sin(rad);
    ay = Math.cos(rad);
  }
  const cx = (cam.x || 0) - (a.x || 0);
  const cy = (cam.y || 0) - (a.y || 0);
  const cross = ax * cy - ay * cx;
  // 极小的叉积当作"在轴线上"：浮点噪声不该被读成"换边了"
  if (Math.abs(cross) < 1e-6) return 0;
  return cross > 0 ? 1 : -1;
}

/**
 * 运镜。六个量和可灵的 camera_control 一一对应 ——
 * 刻意用它的字段名，免得多一层翻译，而翻译层是错误的温床。
 *
 * 取值 -10 ~ 10，负正表方向。全 0 表示固定镜头。
 */
export const MOVE_KEYS = ['horizontal', 'vertical', 'pan', 'tilt', 'roll', 'zoom'];

const MOVE_WORDS = {
  horizontal: ['向左横移', '向右横移'],
  vertical: ['下降', '上升'],
  pan: ['向下俯摇', '向上仰摇'],
  tilt: ['向左摇', '向右摇'],
  roll: ['逆时针滚转', '顺时针滚转'],
  zoom: ['收窄视野（推近）', '放宽视野（拉远）']
};

/**
 * 海螺 / 秘塔那一路吃的是提示词里的方括号指令。
 *
 * ⚠ 这张表按各家公开文档整理，**没有在真接口上逐条验证过**。
 * 单独放成一张表就是为了改起来只动这里 —— 哪条不认，改一个词就行，
 * 不用去翻散落在提示词各处的字符串。
 */
const MOVE_BRACKETS = {
  horizontal: ['[左移]', '[右移]'],
  vertical: ['[下降]', '[上升]'],
  pan: ['[下摇]', '[上摇]'],
  tilt: ['[左摇]', '[右摇]'],
  roll: ['[逆时针旋转]', '[顺时针旋转]'],
  zoom: ['[推进]', '[拉远]']
};

export function normalizeMove(move = {}) {
  const out = {};
  for (const k of MOVE_KEYS) {
    const v = Number(move?.[k]);
    out[k] = Number.isFinite(v) ? Math.max(-10, Math.min(10, v)) : 0;
  }
  return out;
}

export function isStatic(move) {
  const m = normalizeMove(move);
  return MOVE_KEYS.every((k) => m[k] === 0);
}

/** 强度词。同一个方向，2 和 9 是完全不同的两个镜头 */
function strength(v) {
  const a = Math.abs(v);
  if (a >= 7) return '快速';
  if (a >= 4) return '';
  return '缓慢';
}

/**
 * 这一镜的完整解读：景别、机位关系、轴线、运镜。
 *
 * subjects 里第一个是**主体**（景别按他算）。没有主体时只有运镜可说 ——
 * 空镜也是镜头，不该因为没人就算不出东西。
 */
export function readShot({ cam, subjects = [] } = {}) {
  const move = normalizeMove(cam?.move);
  const lens = Number(cam?.lens) || DEFAULT_LENS;
  const main = subjects[0] || null;

  const d = main ? distance(cam, main) : null;
  return {
    lens,
    distance: d === null ? null : Number(d.toFixed(2)),
    size: d === null ? null : shotSize(d, lens),
    facing: main ? facingRelation(cam, main) : null,
    height: heightRelation(cam?.height),
    side: axisSide(cam, subjects),
    move,
    static: isStatic(move)
  };
}

/**
 * 译法一：精确中文。所有厂商都吃这个 —— 它就是提示词的一部分。
 */
export function toChinese(read, { subjectName = '人物' } = {}) {
  const parts = [];
  if (read.size && read.facing) {
    parts.push(`${read.size.label}，机位在${subjectName}${sideWord(read)}${read.facing.label}方向、${read.height.label}，${read.lens}mm`);
  } else {
    parts.push(`${read.height.label}，${read.lens}mm`);
  }
  const moves = MOVE_KEYS
    .filter((k) => read.move[k] !== 0)
    .map((k) => `${strength(read.move[k])}${MOVE_WORDS[k][read.move[k] > 0 ? 1 : 0]}`);
  parts.push(moves.length ? moves.join('、') : '固定机位，不要移动');
  return parts.join('，');
}

/** 轴线在左还是在右，说人话 */
function sideWord(read) {
  if (!read.side) return '';
  return read.side > 0 ? '右侧' : '左侧';
}

/**
 * 译法二：可灵的 camera_control。
 *
 * ⚠ 可灵那边 camera_control 和**首尾帧、运动笔刷三选一**，不能同用。
 * 也就是说标了「连续动作」要锁尾帧的镜，在可灵上就用不了结构化运镜。
 * 这个冲突必须由调用方处理 —— 这里只负责把数算出来，
 * 顺手把 conflictsWithEndFrame 标出来，免得调用方忘了这回事。
 */
export function toKling(read) {
  if (read.static) return null;
  return {
    type: 'simple',
    config: { ...read.move },
    conflictsWithEndFrame: true
  };
}

/**
 * 译法三：海螺 / 秘塔那一路的方括号指令。
 *
 * 只取**最强的那两个**方向。全塞进去的话一句提示词里挂着六个指令，
 * 模型基本会挑着执行，而挑哪个你控制不了 —— 还不如自己选主次。
 */
export function toBrackets(read, { max = 2 } = {}) {
  return MOVE_KEYS
    .filter((k) => read.move[k] !== 0)
    .sort((a, b) => Math.abs(read.move[b]) - Math.abs(read.move[a]))
    .slice(0, max)
    .map((k) => MOVE_BRACKETS[k][read.move[k] > 0 ? 1 : 0])
    .join('');
}

const LIMIT = 6;

function clampM(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-LIMIT, Math.min(LIMIT, Number(n.toFixed(2))));
}

/**
 * 把界面传上来的排位规整成可信的形状。
 *
 * ── 为什么必须有这一步 ──
 *
 * 分镜的可改字段是按"文本框"设计的：不认识的键一律 `String(value).trim()`。
 * 于是排位这种**对象**存进去会变成字符串 `"[object Object]"` ——
 * 接口回 200、界面上看着像存住了，下次读出来是一坨没法用的字符。
 * 这正是那份白名单注释里警告过的"改了没反应"，只是这次更坏：它不是没存，
 * 是存了个错的进去。
 *
 * 顺带把坐标夹回范围、把角度归一 —— 手改过 project.json 的人不少，
 * 一个 NaN 混进来会让整条几何链算出 NaN，而 NaN 不报错，只是哪儿都不对。
 */
export function normalizeStage(stage) {
  if (!stage || typeof stage !== 'object') return null;
  const cam = stage.cam && typeof stage.cam === 'object' ? stage.cam : null;
  if (!cam) return null;

  const subjects = (Array.isArray(stage.subjects) ? stage.subjects : [])
    .filter((s) => s && typeof s === 'object')
    .slice(0, 8)
    .map((s) => ({
      name: String(s.name ?? '').trim().slice(0, 24),
      x: clampM(s.x),
      y: clampM(s.y),
      facing: norm180(s.facing)
    }));

  return {
    cam: {
      x: clampM(cam.x),
      y: clampM(cam.y, -3),
      // 机位高度不该被夹到 ±6：它是**离地高度**，只可能是正的
      height: Math.max(0, Math.min(8, Number.isFinite(Number(cam.height)) ? Number(cam.height) : 1.6)),
      lens: Math.max(8, Math.min(400, Number(cam.lens) || DEFAULT_LENS)),
      move: normalizeMove(cam.move)
    },
    subjects
  };
}

/**
 * 下一镜的排位从哪儿开始 —— **接着上一镜，不是从零开始**。
 *
 * ── 为什么这条是必须的 ──
 *
 * 同一场戏里，人不会在两镜之间瞬移。第 4 镜他站在门口，第 5 镜他还在门口，
 * 变的只是机位。每一镜都从一张空白图重新摆的话：
 *
 *   · 光是重复劳动就足以让人不用这个功能
 *   · 更坏的是**轴线会跟着变**。人的位置一变，两人之间那条线就转了，
 *     于是"机位在同一侧"这个判断整个失去意义 —— 越轴检查会开始乱报，
 *     而乱报的检查比没有检查更糟
 *
 * 所以继承的是**人的位置和朝向**，机位也一并带过来当起点：
 * 起点落在上一镜同一侧，默认就是不越轴的，要越轴得自己把它拖过去。
 *
 * ⚠ 只在**同一场次**内继承。跨场次是另一个地方、另一段时间，
 * 把上一场的站位搬过来是错的，而且错得很隐蔽。
 */
export function inheritStage(prevStage, names = []) {
  const base = normalizeStage(prevStage);
  if (!base) return null;

  const want = (names || []).map((n) => String(n).trim()).filter(Boolean);
  if (!want.length) return { cam: { ...base.cam }, subjects: base.subjects.map((s) => ({ ...s })) };

  /**
   * 这一镜的人 = 剧本里写的那几个。上一镜有位置的沿用，
   * 这一镜新出现的排在场地中间等着被拖走。
   *
   * 反过来 —— 上一镜有、这一镜没有的人要**丢掉**：把不在这一镜里的人
   * 留在图上，算景别时可能挑到他当主体，于是整镜的景别都是照错人算的。
   */
  const subjects = want.map((name, i) => {
    const old = base.subjects.find((s) => s.name === name);
    if (old) return { ...old };
    return { name, x: clampM((i - (want.length - 1) / 2) * 1.2), y: 0, facing: 180 };
  });
  return { cam: { ...base.cam }, subjects };
}

/**
 * 这一镜的机位，写成一句可以直接塞进提示词的话。
 *
 * 没排位就回 null —— 调用方据此退回原来那个 `camera` 文本字段。
 * **不能假装有**：编一句"机位在人物右前方"而实际上没人摆过，
 * 比笼统的"中景"更坏，它是一个听起来很精确的谎。
 */
export function cameraLine(shot, subjectName = null) {
  const stage = shot?.stage;
  if (!stage?.cam) return null;
  const read = readShot(stage);
  const who = subjectName || stage.subjects?.[0]?.name || '人物';
  return toChinese(read, { subjectName: who });
}

/**
 * 这一镜该给这个人发哪张角度设定图 —— **算出来的**，不是猜的。
 *
 * angles.pickAngle 靠关键词（描述里有没有"背对"）。那是在没有机位信息时
 * 唯一能做的事，但它经常判不准：「他望着窗外」既可能是侧脸也可能是背影，
 * 而排过位之后这件事根本不用猜 —— 机位绕到人背后了，那就是背影。
 *
 * 没排位、或者这一镜里没有这个人，就回 null，让关键词那条路继续兜底。
 */
export function sheetHintFor(shot, personName) {
  const cam = shot?.stage?.cam;
  const subs = shot?.stage?.subjects;
  if (!cam || !Array.isArray(subs) || !subs.length) return null;
  const who = subs.find((s) => s?.name === personName);
  if (!who) return null;
  return facingRelation(cam, who).sheet;
}

/**
 * 技法卡和排位打架的地方。
 *
 * ── 冲突是怎么产生的 ──
 *
 * 技法卡里有一整组是**在描述机位**：平视 / 仰拍 / 俯拍 / 顶视 / 大特写，
 * 还有一组在**描述运镜**：推镜 / 拉镜 / 摇镜 / 跟拍 / 固定镜头。
 * 而排过位之后，机位高度、景别、运镜方向全是**算出来的**。
 *
 * 两者会一起进同一条提示词，而且挨着：
 *
 *   低机位仰拍，被摄者显得高大具有压迫感，……，镜头：全景，机位在强雄正面方向、平视，35mm
 *
 * 模型收到两句互相打架的话，只能挑一句听 —— 挑哪句你控制不了。
 * 表现是"排了位好像没生效"，或者"选了仰拍怎么出来是平的"，
 * 而**没有任何报错**：两句话各自都是合法的。
 *
 * ── 为什么是报，不是自动删 ──
 *
 * 和分镜体检同一条规矩：悄悄改用户选的东西，会让他看着一个自己没选过的
 * 结果想不明白哪儿来的。这里只把冲突指出来、说清楚会怎样，改不改他定。
 *（自动挑技法那一步是另一回事 —— 那是我们替他挑的，就该一开始别挑到，
 *  见 studio.js 里 assignSkills 的过滤。）
 *
 * ⚠ 只列**真的对不上**的。选了「平视」而排位也是平视，那是一致，不是冲突 ——
 * 把一致的也报出来，这个检查就变成噪音了。
 */
const CARD_AGREES = {
  'eye-level': (r) => r.height.id === 'eye',
  'low-angle': (r) => r.height.id === 'low',
  'high-angle': (r) => r.height.id === 'high',
  'birds-eye': (r) => r.height.id === 'high',
  'close-up': (r) => r.size?.id === 'closeup',
  static: (r) => r.static,
  'push-in': (r) => r.move.zoom < 0,
  'pull-out': (r) => r.move.zoom > 0,
  // ⚠ 这两条的字面意思是反的：可灵的 pan 是**俯仰**转、tilt 是**左右**转，
  // 而技法卡里「摇镜」是水平扫、「俯仰摇」是垂直扫。照字面对会全接反。
  pan: (r) => r.move.tilt !== 0,
  tilt: (r) => r.move.pan !== 0,
  tracking: (r) => r.move.horizontal !== 0,
  crane: (r) => r.move.vertical !== 0
};

/** 这几张卡说的是排位说不了的东西（环绕、变焦特效、手持质感），不算冲突 */
export const SKILLS_BEYOND_STAGE = ['orbit', 'dolly-zoom', 'handheld', 'dutch', 'ots'];

/** 排过位之后，这几张卡就轮不到它们说了 —— 自动挑技法时直接别挑 */
export const SKILLS_OWNED_BY_STAGE = Object.keys(CARD_AGREES);

export function conflictingSkills(shot) {
  if (!shot?.stage?.cam) return [];
  const read = readShot(shot.stage);
  return (shot.skills || [])
    .filter((id) => CARD_AGREES[id] && !CARD_AGREES[id](read))
    .map((id) => ({ id, said: describeFor(id, read) }));
}

/** 排位在这一项上到底说的是什么 —— 报冲突时要能指着说 */
function describeFor(id, read) {
  if (['eye-level', 'low-angle', 'high-angle', 'birds-eye'].includes(id)) return read.height.label;
  if (id === 'close-up') return read.size ? read.size.label : '（这一镜没有主体，算不出景别）';
  return read.static ? '固定机位' : toChinese(read).split('，').pop();
}

/**
 * 「连续动作」两镜之间，机位跳了多少。
 *
 * ── 为什么这一条非查不可 ──
 *
 * 标了「连续动作」的镜，首帧**就是上一段视频的真实末帧**（seam 那条路）。
 * 也就是说画面的起点已经定死了 —— 它长什么样由上一镜决定，不由这一镜的排位决定。
 *
 * 而提示词里那句机位是**这一镜排位算出来的**。两者一冲突就成了：
 *
 *   首帧递过来的是一张全景，而提示词说"近景，机位在人物右前方、85mm"
 *
 * 模型只能二选一：要么无视首帧硬切成近景（接缝白做了），
 * 要么听首帧、无视你排的位（排位白做了）。**两种都不报错。**
 *
 * ── 这其实是标错了衔接关系 ──
 *
 * 「连续动作」的含义是"上一帧的下一瞬间"。同一瞬间里机位不会瞬移，
 * 也不会从全景变特写 —— 那是**剪辑**，是硬切。
 * 所以查出来的多半不是排位排错了，是这两镜本来就该是 cut。
 *
 * 回 null 表示没跳（或者信息不足，比如有一边没排位 —— 那就无从比较）。
 */
export function cameraJump(prevStage, stage) {
  const a = normalizeStage(prevStage);
  const b = normalizeStage(stage);
  if (!a || !b) return null;

  const ra = readShot(a);
  const rb = readShot(b);
  const moved = Number(distance(a.cam, b.cam).toFixed(2));

  /**
   * ⚠ 判景别变没变，**不能比档位名**。
   *
   * 第一版就是比「全景 / 特写」这几个词，结果假警报当场出现：
   * 机位只挪了 0.3 米，而画面高度正好跨过 2.8 米那条档位线，
   * 于是「全景」变「远景」—— 报了一条谁也看不懂的警报。
   *
   * 档位是给人读的，边界上一厘米的抖动就能翻档。真正该量的是
   * **画面装得下多高**变了多少倍，那是连续的，没有悬崖。
   *
   * 1.4 倍：相邻两档之间大约差 1.6 倍，取略低一点，
   * 既抓得住真的景别跳，又容得下拖动时的手抖。
   */
  const hA = ra.size?.framedHeight;
  const hB = rb.size?.framedHeight;
  const ratio = hA && hB ? Math.max(hA, hB) / Math.min(hA, hB) : 1;
  const sizeChanged = ratio >= 1.4;

  // 一米同理，是给"手抖"留的余地：拖出来的排位差十几厘米没有意义
  if (moved <= 1 && !sizeChanged) return null;
  return {
    moved,
    sizeFrom: ra.size?.label || null,
    sizeTo: rb.size?.label || null,
    sizeChanged,
    ratio: Number(ratio.toFixed(2))
  };
}

/**
 * 越轴检查：同一场戏里，相邻两镜的机位不能跨到轴线另一侧。
 *
 * 只在**同一场次**内查 —— 换了场次就是另一场戏，轴线本来就重新算。
 * 这条规矩之前只写在提示词里求模型遵守，而模型根本不知道机位在哪，
 * 那句话等于没说。现在它是算出来的，能当场报。
 */
export function crossesAxis(prevRead, nextRead) {
  if (!prevRead || !nextRead) return false;
  if (!prevRead.side || !nextRead.side) return false;
  return prevRead.side !== nextRead.side;
}

/**
 * 一整场戏走一遍，把越轴的地方挑出来。
 * shots 要按顺序给，每个形如 { index, segment, stage }。
 */
export function lintSequence(shots = []) {
  const issues = [];
  let prev = null;
  for (const shot of shots) {
    if (!shot?.stage?.cam) {
      prev = null; // 没排位的镜断开链条，不拿它和隔壁比
      continue;
    }
    const read = readShot(shot.stage);
    if (prev && Number(prev.shot.segment || 1) === Number(shot.segment || 1) && crossesAxis(prev.read, read)) {
      issues.push({
        kind: 'crosses-axis',
        from: prev.shot.index,
        to: shot.index,
        message:
          `第 ${prev.shot.index} → ${shot.index} 镜越轴了：机位跨到了轴线另一侧。`
          + '成片上的表现是两个人左右对调、或者人物突然掉头 —— 观众读不出"换了机位"，只会觉得穿帮。'
          + '把机位挪回同一侧，或者中间插一个正对轴线的过渡镜。'
      });
    }
    prev = { shot, read };
  }
  return issues;
}

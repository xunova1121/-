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

/** 全画幅底片宽度。判"这东西落在画面左边还是右边"要用横向视角 */
const SENSOR_W = 36;

/**
 * ════════ 场景的东南西北 ════════
 *
 * 俯视图上把 **+y 定成「北」**。它不是真的地理方向，是**给这一场戏定一个基准** ——
 * 有了基准，"机位在房间的西南角、朝东北拍"才是一句每一镜都对得上的话。
 *
 * ── 为什么非要有它 ──
 *
 * 原来算出来的机位是**相对人的**："机位在人物右前方 45°"。
 * 这句话在单独一镜里是准的，可它经不起下一镜：人一转身，"右前方"
 * 指向房间里完全不同的地方。于是同一场戏里，模型每一镜都在重新想象这个房间 ——
 * 窗一会儿在左一会儿在右，门一会儿在背后一会儿在侧面。
 *
 * 而观众读一场戏靠的正是这些**不动的东西**。它们乱了，人物走位再准也没用。
 *
 * 所以场景要有地标（门、窗、桌），机位要有方位。这两样都不动，
 * 人才有得参照 —— 这也是"随便调机位，下一镜衔接幅度很大"的根治办法：
 * 不是不让调，是调完之后能算出**画面里那些不动的东西有没有跟着乱**。
 */
export const COMPASS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

/** 方位角 → 八个方位里的哪一个。0° 是北，顺时针 */
export function compassOf(deg) {
  const d = ((Number(deg) || 0) % 360 + 360) % 360;
  return COMPASS[Math.round(d / 45) % 8];
}

/** 一个人有多高（米）。景别说的就是"这个人占了画面多少" */
export const PERSON_H = 1.7;

/** 眼睛高度（米）。判平视/俯拍/仰拍拿它比，不是拿身高比 */
const EYE_H = 1.6;

export const DEFAULT_LENS = 35;

/**
 * 一支镜头在指定画幅里真正能看见多少。
 *
 * 3D 取景锥、摄影机画面、控制包和提示词必须以同一套光学数据为准；否则导演台里
 * 看着是中景，导出首帧却成了近景。16:9 并不是把 3:2 全画幅硬拉伸，而是从它
 * 的有效成像面裁出对应高度（竖幅时反过来裁宽度）。
 */
export function cameraFieldOfView(lensMm = DEFAULT_LENS, aspect = 16 / 9) {
  const lens = Math.max(8, Math.min(400, Number(lensMm) || DEFAULT_LENS));
  const ratio = Math.max(.25, Math.min(4, Number(aspect) || 16 / 9));
  const fullAspect = SENSOR_W / SENSOR_H;
  const sensorWidth = ratio >= fullAspect ? SENSOR_W : SENSOR_H * ratio;
  const sensorHeight = ratio >= fullAspect ? SENSOR_W / ratio : SENSOR_H;
  const fovX = 2 * Math.atan(sensorWidth / (2 * lens));
  const fovY = 2 * Math.atan(sensorHeight / (2 * lens));
  return {
    lensMm: lens, aspect: ratio, sensorWidth, sensorHeight, fovX, fovY,
    fovXDeg: Number((fovX * 180 / Math.PI).toFixed(2)),
    fovYDeg: Number((fovY * 180 / Math.PI).toFixed(2))
  };
}

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

/**
 * ══════════ 景别：术语 + 一句可执行的说明 ══════════
 *
 * ⚠ 光给术语不够。"特写"两个字要和几百字的外貌、环境描述抢注意力，
 * 而且它是个**行话**——模型对它的理解未必和你一样，各家理解也不一致。
 *
 * 现象是"标了特写，出来是整个广场的大远景"。当时的提示词里，
 * 景别就只有孤零零一个词，排在风格锚 + 人物外貌（60~90 字）+
 * 场景描述之后。而参考图那边是一张现成的广角构图 —— 一边是两个字，
 * 一边是一整张图，输得不冤。
 *
 * 所以每个档位配一句**画面上能验的话**："人物全身完整入镜，头顶到脚"
 * 比"全景"具体得多，也难被无视得多。
 */
const SIZES = [
  { id: 'closeup', label: '特写', max: 0.5, how: '画面只到肩膀以上，脸占据主要面积，背景大幅虚化' },
  { id: 'medium-closeup', label: '近景', max: 1.0, how: '画面到胸口以上，能看清表情，背景轻度虚化' },
  { id: 'medium', label: '中景', max: 1.7, how: '画面到腰部以上，人物动作和上半身姿态清晰' },
  { id: 'full', label: '全景', max: 2.8, how: '人物全身完整入镜，头顶到鞋子都在画面内' },
  { id: 'wide', label: '远景', max: Infinity, how: '人物在环境中显得较小，环境占据画面主体' }
];

/**
 * 一个景别词 → 那句可执行的说明。
 *
 * 用**包含**匹配而不是全等：用户手填的是"特写"、"大特写"、"中近景"
 * 这类自由文本，全等的话十有八九匹配不上，而匹配不上时这个功能就等于没有。
 * 长的先匹配（"大特写"要先于"特写"命中，否则"大特写"会被当成"特写"）。
 */
const SIZE_WORDS = [
  ...SIZES.map((s) => ({ word: s.label, how: s.how })),
  { word: '大特写', how: '画面只有面部局部（眼睛或嘴），占满整个画面' }
]
  /**
   * ⚠ **长的必须先匹配。**
   *
   * 上面那个数组是按档位从近到远写的，"特写"排在"大特写"前面 ——
   * 不排序的话，"大特写"会先命中"特写"，拿到一句松得多的说明，
   * 而**没有任何地方会报错**：它只是让大特写变成普通特写。
   *
   * 这一行曾经形同虚设：我把"大特写"手写在数组第一位，于是排不排序
   * 结果都一样，金丝雀把排序删掉之后测试照样全绿。现在顺序反过来写，
   * 这条排序才是真的在干活、也才验得出来。
   */
  .sort((a, b) => b.word.length - a.word.length);

export function framingHint(cameraText) {
  const t = String(cameraText || '');
  if (!t) return '';
  const hit = SIZE_WORDS.find((x) => t.includes(x.word));
  return hit ? hit.how : '';
}

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

  /**
   * 地标：门、窗、桌、床…… 场景里**不动的那些东西**。
   *
   * 它们才是观众用来定位的参照物。人物走位再准，窗户一会儿在画面左、
   * 一会儿在画面右，这场戏就散了 —— 而这一点在只排了人的图上完全看不出来。
   */
  /**
   * 地标有**两种**，而且数学上完全不同：
   *
   *   近处的（门、窗、桌、车）  有坐标。机位挪三米，它在画面里就挪一大截
   *   远处的（山、塔、海、天际线）**只有方位**。机位挪三米，它在画面里纹丝不动
   *
   * ⚠ 这个区别不是学术性的 —— 外景基本上只有远处的那种。
   * 硬给一座山编一个"离主体 4 米"的坐标，算出来的画面位置全是错的：
   * 机位一动它就在画面里乱跑，而真山不会。
   *
   * 所以远景地标存的是**方位角**（deg），算画面位置时只看镜头轴向、不算视差。
   */
  const marks = (Array.isArray(stage.marks) ? stage.marks : [])
    .filter((m) => m && typeof m === 'object')
    .slice(0, 10)
    .map((m) => {
      const name = String(m.name ?? '').trim().slice(0, 12);
      if (m.far || (m.deg !== undefined && m.x === undefined)) {
        return { name, far: true, deg: norm180(m.deg) };
      }
      /**
       * ⚠ **道具和地标不是一回事，得分开。**
       *
       * 地标（门窗桌床）不会因为换机位就搬家，所以整场戏原样继承 ——
       * 那正是"画面左边是窗"这句话能跨镜成立的原因。
       * 而设定集道具是**被人拿着走的**：柴刀在第 3 镜出现，
       * 不等于第 4 镜到最后一镜都该有刀。
       *
       * 混在一个数组里的后果是：摆过一次，后面每一镜都带着它，
       * 而且提示词里会一直写着「它在画面上」—— 一把凭空多出来的刀。
       */
      return { name, x: clampM(m.x), y: clampM(m.y), ...(m.prop ? { prop: true } : {}) };
    })
    .filter((m) => m.name);

  /**
   * 光位。**外景最要紧的那一样，比任何地标都要紧。**
   *
   * 室内的光是布的，两镜之间不会自己变；外景的光是太阳给的，
   * 而观众对它极其敏感：上一镜逆光、这一镜顺光，读出来是"换了个时间拍的"。
   * 而模型不知道太阳在哪 —— 除非我们每一镜都告诉它。
   *
   *   deg   光**从哪个方位来**（太阳所在的方位角）
   *   elev  高度：low 早晚斜射长影 / mid / high 正午顶光
   */
  const rawSun = stage.sun && typeof stage.sun === 'object' ? stage.sun : null;
  const sun = rawSun && Number.isFinite(Number(rawSun.deg))
    ? { deg: norm180(rawSun.deg), elev: ['low', 'mid', 'high'].includes(rawSun.elev) ? rawSun.elev : 'mid' }
    : null;

  return {
    marks,
    sun,
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
export function inheritStage(prevStage, names = [], props = null) {
  const base = normalizeStage(prevStage);
  if (!base) return null;

  const want = (names || []).map((n) => String(n).trim()).filter(Boolean);
  /**
   * ⚠ 地标**原样带过去，一个都不删**。
   *
   * 人是按这一镜的剧本来的（这一镜没有的人要丢掉，见下面），
   * 但门窗桌椅不会因为换了个机位就搬家。它们正是同一场戏里
   * 唯一不该变的东西 —— 丢了它们，"画面左边是窗"这句话下一镜就没了。
   *
   * ⚠ **设定集道具走人的那条规矩，不走地标这条。**
   *
   * 柴刀是被人拿着走的：第 3 镜出现不等于往后每一镜都该有刀。
   * 原来它和地标共用一个数组、跟着一起原样继承 —— 摆过一次之后
   * 每一镜都带着，提示词里也一直说它在画面上。
   * 用户的原话是"预演台上的道具，没有添加，为啥还会有"。
   *
   * 所以按**这一镜自己的道具清单**（shot.props）筛：清单里有才留。
   * 不传清单时保持老行为全留 —— 调用方没升级不该被悄悄改掉。
   */
  const keepProp = Array.isArray(props)
    ? new Set(props.map((x) => String(x).trim()).filter(Boolean))
    : null;
  const marks = base.marks
    .filter((m) => !m.prop || !keepProp || keepProp.has(m.name))
    .map((m) => ({ ...m }));
  // 太阳更不会因为换机位就挪窝 —— 它是这一场戏里最不该变的东西
  const sun = base.sun ? { ...base.sun } : null;
  if (!want.length) return { marks, sun, cam: { ...base.cam }, subjects: base.subjects.map((s) => ({ ...s })) };

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
  return { marks, sun, cam: { ...base.cam }, subjects };
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
  const base = toChinese(read, { subjectName: who });

  /**
   * ⚠ 再补一句**相对房间**的方位。
   *
   * 上面那句是相对**人**的（"机位在人物右前方"）—— 单独一镜里很准，
   * 可它经不起下一镜：人一转身，"右前方"就指向房间里完全不同的地方。
   * 于是同一场戏里模型每一镜都在重新想象这个房间，窗一会儿在左一会儿在右。
   *
   * 房间不会转。所以再给一句"机位在场景西南侧、朝东北拍"，
   * 外加画面里那几样不动的东西各在哪边 —— 这才是让连续几镜长在
   * **同一个空间**里的那句话。
   *
   * 没摆地标就只说方位，不硬编 —— 编一句"画面左边是窗"而实际上没人摆过，
   * 比不说更坏：它是一个听起来很具体的谎。
   */
  const f = framing(stage);
  if (!f) return base;
  const bits = [`机位在场景${f.camAt}侧、朝${f.looking}拍`];
  const seen = f.marks.filter((m) => m.side && m.side !== '画外');
  if (seen.length) {
    bits.push(seen.map((m) => {
      const where = m.side === '正中' ? '画面正中' : m.side;
      // 远的要说"远处" —— 不说的话模型会把一座山画成近景里的一块石头
      return `${where}${m.far ? '远处' : ''}是${m.name}`;
    }).join('、'));
  }
  /**
   * ⚠ 光位放在最后，而且**每一镜都要有**。
   *
   * 外景的一致性主要不是靠地标 —— 一片海滩上没有门窗桌椅。
   * 真正把几镜钉在一起的是光：上一镜逆光、这一镜顺光，观众读出来是
   * "这两镜不是同一时间拍的"。而模型不知道太阳在哪，除非每一镜都说一遍。
   */
  if (f.light) {
    bits.push(
      `${f.light.kind}${f.light.from ? `，光从${f.light.from}来` : ''}，${f.light.elev}`
    );
  }
  return `${base}。${bits.join('，')}`;
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
/**
 * 远景地标的常用名字，**两块画布共用这一份**。
 *
 * ── 为什么必须是一份 ──
 *
 * 排位画布（一个场景内部）和场地图（几个场景之间）各有一排"远景"按钮。
 * 而跨场景那条检查是**按名字配对**的：从山门外看「主峰」在北，
 * 从大殿看「主峰」在南 —— 这才叫同一座山跑了。
 *
 * 两边各写各的清单，就会出现这样的局面：场地图上摆的叫「主峰」，
 * 场景里摆的叫「山」，于是它们永远配不上对，那条检查**一次也不会响** ——
 * 而界面上两边都摆得好好的，谁也看不出来少了什么。
 *
 * 后面那两个（`路口`、`灯塔`）是给外景补的，前面几个是最常用的。
 * 加新名字往后加，不要改前面的字 —— 改了字就等于把已经存下的那些标记
 * 从配对里踢出去，而它们还在图上好端端地画着。
 *
 * deg 只是**第一次摆上来时的落点**，摆上去就该拖到该在的方位。
 */
export const FAR_PRESETS = [
  { name: '山', deg: -45 },
  { name: '塔', deg: 45 },
  { name: '海', deg: 180 },
  { name: '天际线', deg: 90 },
  { name: '路口', deg: -135 },
  { name: '灯塔', deg: 135 },
  { name: '城墙', deg: -90 }
];

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
 * 这一镜的**镜头轴向**：机位在往哪个方位看。
 *
 * 看的是主体；没有主体就看地标的重心；都没有就朝北。
 * 空镜也是镜头，不该因为没人就算不出方位。
 */
export function aimBearing(stage) {
  const st = normalizeStage(stage);
  if (!st) return null;
  const target = st.subjects[0] || centroid(st.marks);
  if (!target) return 0;
  return bearing(st.cam, target);
}

/** 一堆点的重心。空的回 null —— 不要拿 (0,0) 冒充"中心" */
function centroid(points = []) {
  const list = (points || []).filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
  if (!list.length) return null;
  return {
    x: list.reduce((n, p) => n + Number(p.x), 0) / list.length,
    y: list.reduce((n, p) => n + Number(p.y), 0) / list.length
  };
}

/**
 * 某个东西落在画面里的横向位置：−1 最左、0 正中、+1 最右。
 *
 * 出画（超出 ±1）照样把数算出来，让调用方自己决定怎么说 ——
 * "刚出画一点点"和"在身后"是两回事，直接回 null 就把这个差别抹掉了。
 * 真在机位**背后**（偏角 ≥ 90°）才回 null：那时候"左右"没有意义。
 */
export function screenX(cam, aimDeg, target) {
  if (!cam || !target) return null;
  const off = norm180(bearing(cam, target) - (Number(aimDeg) || 0));
  if (Math.abs(off) >= 89) return null;
  const lens = Math.max(8, Number(cam.lens) || DEFAULT_LENS);
  const halfFov = Math.atan(SENSOR_W / 2 / lens);
  const v = Math.tan((off * Math.PI) / 180) / Math.tan(halfFov);
  return Number(v.toFixed(3));
}

/**
 * 一个地标落在画面的哪儿。近的算视差，远的只看方位。
 *
 * ⚠ 这两条**不能合成一条**。远景地标没有坐标（一座山的"坐标"是编不出来的），
 * 硬编一个出来的后果是：机位挪三米，画面里那座山跟着横移半个屏 —— 而真山不会。
 */
export function markScreenX(cam, aimDeg, mark) {
  if (!mark) return null;
  if (mark.far) {
    const off = norm180(Number(mark.deg) - (Number(aimDeg) || 0));
    if (Math.abs(off) >= 89) return null;
    const lens = Math.max(8, Number(cam?.lens) || DEFAULT_LENS);
    const halfFov = Math.atan(SENSOR_W / 2 / lens);
    return Number((Math.tan((off * Math.PI) / 180) / Math.tan(halfFov)).toFixed(3));
  }
  return screenX(cam, aimDeg, mark);
}

/**
 * 光位：太阳在画面的哪一边、是顺光还是逆光。
 *
 * ════════ 为什么外景非有它不可 ════════
 *
 * 室内的光是布的，两镜之间不会自己变。外景的光是太阳给的，
 * 而观众对它极其敏感：上一镜逆光、这一镜顺光，读出来是"这两镜不是同一时间拍的"。
 *
 * 而模型**不知道太阳在哪** —— 除非每一镜都告诉它。这就是为什么外景的
 * 一致性靠地标不够：一片海滩上没有门窗桌椅，真正把几镜钉在一起的是光。
 *
 * ⚠ 这里**不做相邻两镜的光位检查**。一场戏只有一个太阳（sun 存在场景上、
 * 逐镜继承），所以"光位跳变"由构造保证不会发生；而正反打里一边顺光一边逆光
 * 本来就是正常的，报它只会变成噪音 —— 噪音会让人学会无视所有警报。
 * 光位的价值全在**写进每一镜的提示词**。
 */
export function lightOf(stage) {
  const st = normalizeStage(stage);
  if (!st?.sun) return null;
  const aim = aimBearing(st);
  // 太阳所在方位 相对 镜头轴向
  const rel = norm180(st.sun.deg - aim);
  const a = Math.abs(rel);
  const kind = a <= 40 ? '逆光' : a >= 140 ? '顺光' : (a <= 75 || a >= 105 ? '侧逆光' : '侧光');
  // ⚠ 顺光/逆光时"从哪边来"没有意义（太阳基本在轴上），说了反而误导
  const from = a <= 25 || a >= 155 ? null : (rel > 0 ? '画面右' : '画面左');
  const elev = { low: '低角度（早晚，影子拉得很长）', mid: '中等高度', high: '接近顶光（正午，影子很短）' }[st.sun.elev];
  return { kind, from, elev, deg: st.sun.deg, rel: Number(rel.toFixed(1)) };
}

/** −1..1 说人话。画面正中那一小条不算左也不算右 */
export function sideOfScreen(x) {
  if (x === null || x === undefined) return null;
  if (Math.abs(x) > 1.05) return '画外';
  if (Math.abs(x) <= 0.12) return '正中';
  return x < 0 ? '画面左' : '画面右';
}

/**
 * 这一镜"在这个房间里的什么位置、朝哪儿拍、画面里看得见哪些不动的东西"。
 *
 * 这三样合起来才是**场景方位**。只说"机位在人物右前方"是不够的 ——
 * 人一转身那句话就指向别处了，而房间不会转。
 */
export function framing(stage) {
  const st = normalizeStage(stage);
  if (!st) return null;
  const aim = aimBearing(st);
  // 场景中心 = 地标和人的重心。没有地标时就是人所在的地方
  const center = centroid([...st.marks, ...st.subjects]) || { x: 0, y: 0 };
  const camAt = compassOf(bearing(center, st.cam));
  const looking = compassOf(aim);
  const marks = st.marks.map((m) => {
    const x = markScreenX(st.cam, aim, m);
    return { name: m.name, far: Boolean(m.far), x, side: sideOfScreen(x), behind: x === null };
  });
  return { aim: Number(aim.toFixed(1)), camAt, looking, marks, light: lightOf(st) };
}

/**
 * 相邻两镜之间**动了多大**。
 *
 * ── 为什么单看越轴不够 ──
 *
 * 越轴查的是"有没有跨过那条线"。可**没跨线也能把人看晕**：
 * 机位绕着人转了 120°，画面里的一切都换了位置，只是恰好没跨过轴线。
 * 观众在两镜之间失去方位感，而每一镜单独看都挑不出毛病。
 *
 * 反过来也有：机位只挪了 10°、景别也没变 —— 那不叫换机位，叫跳切，
 * 看上去像播放器卡了一下。这是剪辑里最基本的「三十度原则」。
 *
 * 所以这里量三个数：绕主体转了多少度、景别差几倍、画面里那些不动的东西
 * 有没有换边。回 null 表示比不了（有一边没排位）。
 */
export function continuityBetween(prevStage, stage) {
  const a = normalizeStage(prevStage);
  const b = normalizeStage(stage);
  if (!a || !b) return null;

  /**
   * ⚠ 绕的是**同一个人**。
   *
   * 两镜的主体不是同一个人时，"机位绕了多少度"没有意义 ——
   * 那本来就是两个不同的参照点。按名字对上才算，对不上就不算这一项。
   */
  const mainA = a.subjects[0] || null;
  const mainB = mainA ? b.subjects.find((s) => s.name && s.name === mainA.name) : null;
  const swing = mainA && mainB
    ? Math.abs(norm180(bearing(mainB, b.cam) - bearing(mainA, a.cam)))
    : null;

  const ra = readShot(a);
  const rb = readShot(b);
  const hA = ra.size?.framedHeight;
  const hB = rb.size?.framedHeight;
  const sizeRatio = hA && hB ? Number((Math.max(hA, hB) / Math.min(hA, hB)).toFixed(2)) : null;

  // 画面里那些**不动的东西**换没换边 —— 这是观众真正用来定位的参照物
  const fa = framing(a);
  const fb = framing(b);
  const flips = [];
  for (const m of fa.marks) {
    const after = fb.marks.find((x) => x.name === m.name);
    if (!after || !m.side || !after.side) continue;
    if (m.side === '画外' || after.side === '画外') continue;
    if (m.side === '正中' || after.side === '正中') continue;
    if (m.side !== after.side) flips.push({ name: m.name, from: m.side, to: after.side });
  }

  return {
    swing: swing === null ? null : Number(swing.toFixed(1)),
    sizeRatio,
    flips,
    camFrom: fa.camAt,
    camTo: fb.camAt
  };
}

/** 摆到这个度数以上，观众会在两镜之间失去方位感 */
export const SWING_LOST = 100;
/** 摆不到这个度数、景别又没变，那不叫换机位，叫跳切（三十度原则）*/
export const SWING_JUMPCUT = 30;
/** 景别一步跨这么多倍，观众接不上（全景直接切特写）*/
export const SIZE_LEAP = 4;

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
 * 相邻两镜之间"动得合不合适"。**越轴之外的那几条都在这儿。**
 *
 * ── 为什么单查越轴不够 ──
 *
 * 越轴查的是"有没有跨过那条线"。可没跨线一样能把人看晕，而且方式不止一种：
 *
 *   摆太狠    机位绕着人转了 120°，画面里一切都换了位置，只是恰好没跨轴线。
 *             观众在两镜之间失去方位，而每一镜单独看都挑不出毛病
 *   摆太少    只挪了 10°、景别也没变 —— 那不叫换机位，叫跳切，
 *             看上去像播放器卡了一下。剪辑里最基本的「三十度原则」
 *   跳太远    全景直接切特写，中间少一档，观众接不上
 *   参照物换边 背景里的窗从画面左边跑到右边 —— 观众定位用的就是这些不动的东西
 *
 * 这四条都要**排过位才算得出来**，而排过位之后它们都是算术，不是感觉。
 *
 * 回的是描述性的条目，由调用方决定怎么展示（分镜体检 / 预演台画布）——
 * 两处各写一份判断迟早会漂。
 */
export function continuityIssues(prevStage, stage) {
  const c = continuityBetween(prevStage, stage);
  if (!c) return [];
  const out = [];

  if (c.swing !== null && c.swing >= SWING_LOST) {
    out.push({
      kind: 'camera-swing',
      severity: 'normal',
      what: `机位绕着主体转了 ${Math.round(c.swing)}°（从场景${c.camFrom}侧摆到${c.camTo}侧）`,
      why: '转过一百度，画面里的一切都换了位置 —— 背景、光的方向、人朝哪边看，全变了。'
        + '观众在这两镜之间会短暂失去方位感，而逐镜看每一张都没毛病，只有连起来放才别扭。',
      fix: '要么把机位挪回来一点，要么在中间插一个能交代空间的镜（全景/过肩），先告诉观众"房间长这样"，再摆过去。'
    });
  }

  if (c.swing !== null && c.swing < SWING_JUMPCUT && c.sizeRatio !== null && c.sizeRatio < 1.4) {
    out.push({
      kind: 'jump-cut',
      severity: 'normal',
      what: `机位只转了 ${Math.round(c.swing)}°、景别也几乎没变`,
      why: '两张画面太像，切过去观众读不出"换了机位"，只会觉得画面抖了一下、或者播放器卡了一下。'
        + '这就是剪辑里的三十度原则：要换机位，就换得让人看得出来。',
      fix: `把机位再挪开一些（绕主体转到 ${SWING_JUMPCUT}° 以上），或者干脆换一档景别。`
    });
  }

  if (c.sizeRatio !== null && c.sizeRatio >= SIZE_LEAP) {
    out.push({
      kind: 'size-leap',
      severity: 'normal',
      what: `景别一步跨了 ${c.sizeRatio} 倍`,
      why: '全景直接切特写，观众要重新找"这是谁、在哪儿"。偶尔用是强调，连着用就是没编排。',
      fix: '中间加一档（全景 → 中景 → 特写），或者把这一刀留给真正需要强调的地方。'
    });
  }

  if (c.flips.length) {
    const one = c.flips[0];
    out.push({
      kind: 'landmark-flip',
      severity: 'high',
      what: `画面里的「${one.name}」从${one.from}跑到了${one.to}`
        + (c.flips.length > 1 ? `（还有 ${c.flips.length - 1} 处同样情况）` : ''),
      why: '观众判断"人在房间里的哪儿"，靠的就是门窗桌椅这些不动的东西。它们左右对调，'
        + '整场戏的空间就塌了 —— 表现出来是"这两镜好像不在同一个屋里"，但说不出哪儿不对。',
      fix: '把机位挪回参照物同一侧；真要拍对面，中间插一个能交代空间的镜。'
    });
  }
  return out;
}

/**
 * 一整场戏走一遍，把接不上的地方挑出来。
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
    const sameSegment = prev && Number(prev.shot.segment || 1) === Number(shot.segment || 1);
    if (sameSegment && crossesAxis(prev.read, read)) {
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
    if (sameSegment) {
      for (const one of continuityIssues(prev.shot.stage, shot.stage)) {
        issues.push({
          kind: one.kind,
          from: prev.shot.index,
          to: shot.index,
          message: `第 ${prev.shot.index} → ${shot.index} 镜：${one.what}。${one.why}${one.fix}`
        });
      }
    }
    prev = { shot, read };
  }
  return issues;
}

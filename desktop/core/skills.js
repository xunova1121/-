/**
 * 技法库：镜头运用、机位、光线、动作、氛围。
 *
 * 解决的是一件很具体的事 —— **每一镜都要重新想"运镜该怎么写"**。
 * 模型拆出来的 motion 大多是"镜头缓慢推进"这种放之四海皆准的话，
 * 而真正让画面有电影感的是具体的技法：伦勃朗光、荷兰角、希区柯克变焦。
 * 这些术语你未必天天记得住，模型却认得很准 —— 那就把它们做成卡片。
 *
 * 三层价值，一层比一层实在：
 *   ① 省得每次手写；
 *   ② 术语标准化 —— 同一个技法每次发给模型的措辞完全一致，结果才可复现；
 *   ③ 批量套用 —— 十个动作镜一次性全上"跟拍 + 手持微晃"。
 *
 * ── 和 shot.camera / shot.motion 的关系 ──
 *
 * 不重复、不打架：分镜表里的 camera 是**景别**（特写/中景/全景），
 * motion 是模型写的一句自由文本。技法卡是**在它们之上追加**的具体手法，
 * 按 slot 拼到提示词的不同位置，不是把那两个字段覆盖掉。
 *
 * ── slot：为什么不能一股脑堆在末尾 ──
 *
 * 提示词里越靠后的描述越容易被稀释（这个项目里已经踩过一次：
 * 风格锚放末尾几乎不起作用）。所以每张卡自己声明该去哪儿：
 *   look    构图/机位/光线 → 出图和出视频都要，插在画面描述附近
 *   action  人物动作       → 两边都要，紧跟画面描述
 *   mood    氛围情绪       → 两边都要，放画面之后
 *   motion  运镜           → **只进视频**，出图那步说运镜没有意义
 *
 * ── exclusive：互斥组 ──
 *
 * 不能既"推镜"又"拉镜"，不能同时是仰拍和俯拍。同组只留一张，
 * 而且在界面上就做成单选 —— 让人选出一个自相矛盾的组合再去报错，是很差的设计。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export const SKILL_GROUPS = [
  { id: 'move', name: '运镜', hint: '镜头怎么动。只影响视频，出图那步用不上', exclusive: true, slot: 'motion' },
  { id: 'angle', name: '机位角度', hint: '从哪儿拍。直接改变构图，出图就生效', exclusive: true, slot: 'look' },
  { id: 'light', name: '光线', hint: '布光方式。最能拉开"像照片"和"像电影"的一项', exclusive: true, slot: 'look' },
  { id: 'action', name: '动作', hint: '人物在做什么。可多选', exclusive: false, slot: 'action' },
  { id: 'mood', name: '氛围', hint: '整体情绪基调。可多选', exclusive: false, slot: 'mood' },
  { id: 'edge', name: '出入画', hint: '开头结尾怎么交接。和「镜间衔接」配合用', exclusive: false, slot: 'motion' }
];

/**
 * 内置技法卡。
 *
 * fragment 是**真正发给模型的那句话**，所以写得具体：
 * "低机位仰拍"比"仰拍"稳，"暗面颧骨下形成三角形光斑"比"伦勃朗光"稳 ——
 * 模型对术语的理解有强有弱，把术语和它的**视觉结果**一起给，命中率高得多。
 */
export const BUILTIN_SKILLS = [
  // ── 运镜（只进视频）──
  { id: 'push-in', group: 'move', name: '推镜', hint: '向前推进，收紧景别', fragment: '镜头缓慢向前推进，景别由宽逐渐收紧到主体' },
  { id: 'pull-out', group: 'move', name: '拉镜', hint: '后拉，视野打开', fragment: '镜头缓慢向后拉开，视野逐渐展开露出环境' },
  { id: 'pan', group: 'move', name: '摇镜', hint: '水平扫过', fragment: '镜头水平匀速摇动扫过场景，机位不动' },
  { id: 'tilt', group: 'move', name: '俯仰摇', hint: '垂直扫过', fragment: '镜头垂直摇动，从下往上（或从上往下）扫过' },
  { id: 'tracking', group: 'move', name: '跟拍', hint: '跟着人物走', fragment: '镜头跟随人物同向平移，人物在画面中的位置保持稳定' },
  { id: 'orbit', group: 'move', name: '环绕', hint: '绕着主体转', fragment: '镜头绕主体缓慢环绕，背景相对主体横向滑动' },
  { id: 'crane', group: 'move', name: '升降', hint: '垂直升起或降下', fragment: '镜头垂直升起，视角由平视变为俯视' },
  { id: 'handheld', group: 'move', name: '手持微晃', hint: '纪实感、呼吸感', fragment: '手持拍摄的轻微晃动与呼吸感，不规则微幅位移' },
  { id: 'static', group: 'move', name: '固定镜头', hint: '机位不动，只有画面内运动', fragment: '镜头完全固定不动，只有画面内的人物和环境在运动' },
  {
    id: 'dolly-zoom', group: 'move', name: '希区柯克变焦', hint: '眩晕、心理冲击',
    fragment: '镜头前推的同时焦距后拉（Dolly Zoom），主体大小不变而背景透视被压缩，产生眩晕感'
  },

  // ── 机位角度 ──
  { id: 'eye-level', group: 'angle', name: '平视', hint: '中性、客观', fragment: '平视机位，视线与被摄者等高，中性客观' },
  { id: 'low-angle', group: 'angle', name: '仰拍', hint: '人物高大、有压迫感', fragment: '低机位仰拍，被摄者显得高大具有压迫感，背景多为天空或天花板' },
  { id: 'high-angle', group: 'angle', name: '俯拍', hint: '人物渺小、被审视', fragment: '高机位俯拍，被摄者显得渺小无助' },
  { id: 'birds-eye', group: 'angle', name: '顶视', hint: '上帝视角、图形感', fragment: '正上方垂直俯瞰的顶视构图，画面呈现强烈的图形秩序' },
  { id: 'dutch', group: 'angle', name: '荷兰角', hint: '倾斜、不安', fragment: '画面明显倾斜的荷兰角构图，制造失衡与不安' },
  { id: 'ots', group: 'angle', name: '过肩', hint: '对话戏标准机位', fragment: '过肩镜头，前景是一方的肩与后脑虚化，焦点在对面的人物脸上' },
  { id: 'close-up', group: 'angle', name: '大特写', hint: '情绪、细节', fragment: '面部大特写，五官占满画面，浅景深，强调微表情' },

  // ── 光线 ──
  { id: 'rembrandt', group: 'light', name: '伦勃朗光', hint: '经典人像布光', fragment: '伦勃朗布光：侧上方主光，暗侧颧骨下方形成一小块三角形光斑，明暗过渡柔和' },
  { id: 'rim', group: 'light', name: '逆光轮廓', hint: '剪影感、氛围', fragment: '强逆光勾出人物轮廓的发光边缘，主体正面压暗，空气中可见光束' },
  { id: 'top-light', group: 'light', name: '顶光', hint: '压抑、审讯感', fragment: '顶部硬光直射，眼窝与鼻下形成深黑阴影，压抑' },
  { id: 'blinds', group: 'light', name: '百叶窗光', hint: '黑色电影标配', fragment: '百叶窗投下的条状阴影横贯人物面部与墙面，明暗条纹分明' },
  { id: 'neon', group: 'light', name: '霓虹混光', hint: '赛博、夜戏', fragment: '洋红与青蓝两色霓虹光源交叠打在人物两侧，湿润表面有彩色反光' },
  { id: 'golden', group: 'light', name: '黄金时刻', hint: '温暖、怀旧', fragment: '日落前的低角度暖金色阳光，长投影，空气中有浮尘' },
  { id: 'moonlight', group: 'light', name: '月光冷调', hint: '夜戏', fragment: '冷蓝色低照度月光，高光被压制，暗部保留细节' },
  { id: 'practical', group: 'light', name: '实用光源', hint: '真实、有来源', fragment: '画面内可见的灯具（台灯、招牌、烛火）作为主要光源，光线有明确来源方向' },
  { id: 'silhouette', group: 'light', name: '纯剪影', hint: '强反差', fragment: '人物完全压成黑色剪影，背景明亮，只保留轮廓线' },

  // ── 动作（可多选）──
  { id: 'act-fight', group: 'action', name: '打斗', hint: '', fragment: '激烈的近身打斗，动作幅度大，衣摆与发丝随动作甩动' },
  { id: 'act-run', group: 'action', name: '奔跑', hint: '', fragment: '全速奔跑，身体前倾，手臂摆动，脚下扬起尘土' },
  { id: 'act-turn', group: 'action', name: '回眸', hint: '', fragment: '缓缓转头回望，视线最终落在镜头方向' },
  { id: 'act-draw', group: 'action', name: '拔刀 / 掏枪', hint: '', fragment: '果断的拔刀（掏枪）动作，手部动作清晰可辨' },
  { id: 'act-fall', group: 'action', name: '倒地', hint: '', fragment: '失去平衡向后倒下，重心明显偏移' },
  { id: 'act-embrace', group: 'action', name: '拥抱', hint: '', fragment: '两人相拥，肢体接触自然，力度可见' },
  { id: 'act-cry', group: 'action', name: '落泪', hint: '', fragment: '眼眶泛红，泪水沿脸颊滑落，表情克制' },
  { id: 'act-smoke', group: 'action', name: '点烟 / 吸烟', hint: '', fragment: '点燃香烟，烟雾在光束中缓缓升腾' },

  // ── 氛围（可多选）──
  { id: 'mood-tense', group: 'mood', name: '紧张压抑', hint: '', fragment: '紧张压抑的氛围，空间局促，色调偏冷' },
  { id: 'mood-serene', group: 'mood', name: '平静悠远', hint: '', fragment: '平静悠远的氛围，留白充分，节奏舒缓' },
  { id: 'mood-melancholy', group: 'mood', name: '忧郁', hint: '', fragment: '忧郁的氛围，低饱和，光线柔而弱' },
  { id: 'mood-joyful', group: 'mood', name: '明快', hint: '', fragment: '明快轻松的氛围，光线通透，色彩饱和' },
  { id: 'mood-eerie', group: 'mood', name: '诡异不安', hint: '', fragment: '诡异不安的氛围，光源方向反常，暗部占比大' },
  { id: 'mood-epic', group: 'mood', name: '史诗恢弘', hint: '', fragment: '史诗恢弘的氛围，大景别，人物在环境中显得渺小' },

  // ── 出入画（和镜间衔接配合）──
  {
    id: 'exit-frame', group: 'edge', name: '结尾出画', hint: '给下一镜留硬切点',
    fragment: '结尾时人物走出画面边缘，画面短暂留空'
  },
  {
    id: 'enter-frame', group: 'edge', name: '开头入画', hint: '接上一镜的出画',
    fragment: '开头画面为空，人物随后从画面边缘进入'
  },
  {
    id: 'whip-out', group: 'edge', name: '结尾甩出', hint: '甩镜转场的前半段',
    fragment: '结尾镜头快速横向甩动，画面拉出运动模糊'
  }
];

const USER_FILE = path.join(DATA_DIR, 'skills.json');

/**
 * 自定义技法卡存在**数据目录**里，不挂在项目上 ——
 * 你总结出来的手法应该跨项目复用，而不是换个项目就得重写一遍。
 */
export function userSkills() {
  try {
    const list = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveUser(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${USER_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, USER_FILE);
  return list;
}

export function allSkills() {
  return [...BUILTIN_SKILLS, ...userSkills().map((s) => ({ ...s, custom: true }))];
}

export function getSkill(id) {
  return allSkills().find((s) => s.id === id) || null;
}

export function addUserSkill({ name, fragment, group = 'mood', hint = '' }) {
  const clean = String(name || '').trim();
  const frag = String(fragment || '').trim();
  if (!clean) throw new Error('技法要有名字');
  if (!frag) throw new Error('要写清楚发给模型的那句话，否则这张卡不起作用');
  if (!SKILL_GROUPS.some((g) => g.id === group)) throw new Error(`没有这个分类：${group}`);

  const list = userSkills();
  // id 用名字派生，重名就直接覆盖 —— 同名两张卡只会让人选错
  const id = `my-${Buffer.from(clean).toString('hex').slice(0, 12)}`;
  const card = { id, group, name: clean, hint: String(hint || '').trim(), fragment: frag };
  const i = list.findIndex((s) => s.id === id);
  if (i === -1) list.push(card);
  else list[i] = card;
  saveUser(list);
  return card;
}

export function removeUserSkill(id) {
  const list = userSkills();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  saveUser(next);
  return true;
}

/**
 * 把一组 id 规整成合法组合：去掉不认识的、互斥组只留第一张。
 *
 * 在**保存时**就规整，而不是在出图时才处理 —— 存下一个自相矛盾的组合，
 * 界面上就会显示两个互斥的技法都被选中，而实际只有一个生效。
 * 界面和事实不一致，比少一个功能糟糕得多。
 */
export function normalize(ids = []) {
  const seenGroup = new Set();
  const out = [];
  const dropped = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const card = getSkill(id);
    if (!card) {
      dropped.push({ id, why: '没有这张技法卡' });
      continue;
    }
    const group = SKILL_GROUPS.find((g) => g.id === card.group);
    if (group?.exclusive) {
      if (seenGroup.has(card.group)) {
        dropped.push({ id, why: `「${group.name}」只能选一个` });
        continue;
      }
      seenGroup.add(card.group);
    }
    if (out.includes(id)) continue;
    out.push(id);
  }
  return { ids: out, dropped };
}

/**
 * 取出某一镜的技法片段，按 slot 分好。
 * `for` 给 'image' 时不返回 motion 类 —— 对一张静态图说"镜头缓慢推进"没有意义，
 * 只会占掉画面描述的权重。
 */
export function fragmentsFor(ids = [], { target = 'video' } = {}) {
  const bySlot = { look: [], action: [], mood: [], motion: [] };
  for (const id of Array.isArray(ids) ? ids : []) {
    const card = getSkill(id);
    if (!card) continue;
    const group = SKILL_GROUPS.find((g) => g.id === card.group);
    const slot = card.slot || group?.slot || 'mood';
    if (slot === 'motion' && target === 'image') continue;
    bySlot[slot]?.push(card.fragment);
  }
  return bySlot;
}

/** 给界面用：分组好的完整清单 */
export function catalogForUI() {
  const all = allSkills();
  return SKILL_GROUPS.map((g) => ({
    ...g,
    skills: all.filter((s) => s.group === g.id)
  }));
}

/** 名字，给分镜卡片上的小标签用 */
export function labelsFor(ids = []) {
  return (Array.isArray(ids) ? ids : []).map((id) => getSkill(id)?.name).filter(Boolean);
}

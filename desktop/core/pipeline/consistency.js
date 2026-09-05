/**
 * 一致性引擎 —— 这个应用和其他同类工具最主要的区别就在这个文件。
 *
 * 常见做法是把角色外貌写进每一镜的提示词，指望模型自己记住。这条路走不通：
 * 扩散模型没有跨次调用的记忆，同一段描述两次采样出来的脸就是两张脸。
 *
 * 这里用四层手段叠加，从"碰运气"变成"可复现"：
 *
 *   ① 设定锁定（Bible）  角色/场景/道具的外貌描述只由模型生成一次，之后冻结成
 *                        结构化字段，人工可改。后续所有提示词都从这里取，不再重新发挥。
 *   ② 种子锁定（Seed）    每个角色、每个场景派生一个稳定种子（由项目 ID + 名字哈希得到），
 *                        同一角色在所有镜头里用同一颗种子，把随机性摁住。
 *   ③ 参考图引用（Ref）   先出一张角色设定图 / 场景基准图存起来，后续镜头走图生图、
 *                        参考图生视频通道把它带上。这是四层里最关键的一层 ——
 *                        像素级参照比任何文字描述都稳。
 *   ④ 视觉复核（Verify）  出图后用多模态模型把成图和设定图放在一起比对，打分 + 指出偏差，
 *                        低于阈值自动重试并加大参考权重。别人做到 ③ 就收工了，
 *                        这一层是把"大概率对"变成"错了能自己发现"。
 */
import crypto from 'node:crypto';
import * as adapters from '../providers/adapters.js';
import * as settings from '../settings.js';
import * as continuity from './continuity.js';
import * as skills from '../skills.js';
import * as speaker from './speaker.js';
import * as variants from './variants.js';
import * as anglesLib from './angles.js';
import * as previz from './previz.js';
import { resolveStyle } from '../styles.js';
import * as outlineLib from './outline.js';

/** 由项目和名字派生稳定种子。同一项目里同一角色，永远同一颗种子。 */
export function deriveSeed(projectId, name) {
  const hash = crypto.createHash('sha256').update(`${projectId}::${name}`).digest();
  // 各家 seed 的上限不一，统一压到 31 位正整数最安全
  return hash.readUInt32BE(0) % 2147483647;
}

const BIBLE_PROMPT = `你是动画片的美术总监。基于剧本，为每个角色和场景写一份**冻结设定**。

这份设定会被原样注入到之后每一个镜头的绘图提示词里，所以：
- 只写**看得见的、不会随剧情变化的**特征：脸型、发型发色、瞳色、体型、常穿服装的款式与配色、标志性配饰；
- 不要写情绪、动作、剧情（那些是分镜的事）；
- 每个角色的 appearance 控制在 60~90 个字，太短锁不住，太长会稀释镜头本身的描述；
- 服装配色要给具体颜色词（"藏青立领制服、袖口两道银线"），不要写"帅气的制服"。

严格只输出 JSON，不要任何解释、不要代码块：

{
  "style": {
    "anchor": "全片统一画风的一句话，会出现在每一条提示词开头。只准写光影、色调、质感、笔触、镜头语言、时代氛围；严禁出现具体地点、具体物体、天气、时间段 —— 那些属于场景设定，写进这里会在内景镜头里画出外景",
    "palette": "主色调描述",
    "negative": "全片统一的负向提示词，逗号分隔"
  },
  "characters": [
    {
      "name": "角色名",
      "appearance": "冻结的外貌描述（60~90字）",
      "sheetPrompt": "留空。出图提示词由 appearance 现推，这里填了反而会顶掉描述",
      "role": "在故事里的身份"
    }
  ],
  "scenes": [
    {
      "name": "场景名",
      "appearance": "冻结的环境描述：建筑/地貌、光线方向与色温、天气、标志物",
      "sheetPrompt": "用于生成该场景基准图的完整提示词：无人物的空镜、广角"
    }
  ],
  "props": [
    {
      "name": "道具名",
      "appearance": "外观描述（30字内）",
      "sheetPrompt": "用于生成该道具参考图的提示词：单个物体、纯色背景、无人物、产品图视角"
    }
  ]
}`;

/**
 * 只扫一段**新来的**正文，把里面出现的角色/场景/道具认出来。
 *
 * ════════ 为什么必须和 buildBible 分开 ════════
 *
 * 剧本一章一章往里加时，第二章会冒出第一章没有的人和地方。
 * 而重跑 buildBible 是**不能接受**的：它回的是一份全新的设定集，
 * 所有 sheetPath 都是 null —— 于是老角色的参考图全被清空、全部重出。
 * 那既花钱，又冒着"重出的那张和之前那张不一样"的风险，
 * 而观众对主角换脸这件事最敏感。
 *
 * 所以这里只回**模型读出来的原始清单**，谁是新的由调用方比对，
 * 老条目一个字都不碰。
 *
 * ⚠ 回的是原始形状（没有 seed、没有 sheetPath），不是一份设定集。
 * 让它长得像设定集的话，早晚有人直接把它存进 project.bible ——
 * 那就等于把老条目全覆盖了。形状不一样，这种误用就写不出来。
 */
export async function scanCast(project, { source, onEvent } = {}) {
  const routing = adapters.resolvedRouting();
  const style = resolveStyle(project);
  const text0 = String(source || '').trim();
  if (!text0) return { characters: [], scenes: [], props: [] };

  onEvent?.({ type: 'note', message: `扫描新增角色与场景（${routing.chat.provider} / ${routing.chat.model}）…` });

  // ⚠ 超长要出声：只扫到前一万二的话，后半段才出场的人物**一个都进不了设定集**，
  //   而且没有任何提示 —— 后面出图时那些人就没有参考图，画成谁都不知道
  const cap = outlineLib.capScript(text0);
  if (cap.note) onEvent?.({ type: 'note', message: cap.note });

  const { text } = await adapters.chat({
    providerId: routing.chat.provider,
    model: routing.chat.model,
    system: BIBLE_PROMPT,
    user: `画风要求：${style.anchor}\n\n剧本：\n${cap.sent}`,
    temperature: 0.6,
    jsonMode: true,
    label: '扫描新增设定'
  });
  const parsed = extractJSON(text);
  const clean = (list) => (Array.isArray(list) ? list : [])
    .filter((x) => x && typeof x === 'object' && String(x.name || '').trim())
    .map((x) => ({ name: String(x.name).trim(), role: x.role || '', appearance: x.appearance || '' }));
  return {
    characters: clean(parsed.characters),
    scenes: clean(parsed.scenes),
    props: clean(parsed.props)
  };
}

/**
 * 把扫出来的清单并进已有设定集 —— **只加没见过的，老条目一个字都不碰**。
 *
 * 就地改 bible，回新增了哪几条。
 *
 * ⚠ 判重按**名字**，不做相似度合并。模型给同一个人换个称呼
 *（"老周" vs "周叔"）时会漏判，于是多出一个重复条目。宁可这样：
 * 漏判的代价是多一条能手动删掉的设定；而按相似度合并的代价是
 * **把两个真的不同的人合成一个**，那是不可逆的，且要到成片里才看得出来。
 *
 * ⚠ seed 走和全量那条路**同一个推导**（项目 id + `类型:名字`）。
 * 另写一套的话，同一个角色"先建的"和"后补的"会拿到两个 seed ——
 * 表现是同名角色两张脸，而这正是整套一致性引擎要防的第一件事。
 */
export function mergeCast(bible, found, projectId) {
  const added = [];
  if (!bible || !found) return added;
  // ⚠ 数组要先建出来。`bible.characters || []` 那种写法拿到的是新数组，
  // 往里 push 完就丢了 —— 表现是"日志说补了几条，设定集里一条没多"
  if (!Array.isArray(bible.characters)) bible.characters = [];
  if (!Array.isArray(bible.scenes)) bible.scenes = [];
  if (!Array.isArray(bible.props)) bible.props = [];

  const buckets = [
    ['char', found.characters, bible.characters],
    ['scene', found.scenes, bible.scenes],
    ['prop', found.props, bible.props]
  ];
  for (const [kind, list, bucket] of buckets) {
    for (const one of list || []) {
      const name = String(one?.name || '').trim();
      if (!name || bucket.some((x) => x.name === name)) continue;
      bucket.push({
        name,
        ...(kind === 'char' ? { role: one.role || '', voice: '' } : {}),
        appearance: one.appearance || '',
        seed: deriveSeed(projectId, `${kind}:${name}`),
        sheetPrompt: '',
        sheetPath: null,
        sheetUrl: null
      });
      added.push({ kind, name });
    }
  }
  return added;
}

/**
 * 第一步：让模型把设定"写死"。
 * 注意这一步只跑一次，跑完就冻结 —— 每次重新生成设定，人设就会漂一次。
 */
export async function buildBible(project, { onEvent } = {}) {
  const routing = adapters.resolvedRouting();
  const style = resolveStyle(project);
  onEvent?.({ type: 'note', message: `生成设定集（${routing.chat.provider} / ${routing.chat.model}）…` });

  // 长篇只把前若干字交给模型定人设：设定集要的是"谁长什么样"，
  // 不是完整剧情，喂全文既超上下文又稀释重点。
  /**
   * ⚠ 这里的截断只发生在**分章**那一支，单剧本那一支是整篇发出去的 ——
   * 这个不一致是原样保留的（改了会让长单篇项目从"能跑"变成"被砍"），
   * 但截了就必须说。
   */
  const whole = project.chapters?.length
    ? project.chapters.map((c) => c.script).join('\n\n')
    : String(project.script || '');
  const capped = project.chapters?.length
    ? outlineLib.capScript(whole, undefined, '各章剧本合起来')
    : { sent: whole, dropped: 0, note: null };
  if (capped.note) onEvent?.({ type: 'note', message: capped.note });
  const source = capped.sent;

  const { text } = await adapters.chat({
    providerId: routing.chat.provider,
    model: routing.chat.model,
    system: BIBLE_PROMPT,
    user: `画风要求：${style.anchor}\n\n剧本：\n${source}`,
    temperature: 0.6,
    jsonMode: true,
    label: '生成设定集'
  });

  const parsed = extractJSON(text);

  const bible = {
    frozenAt: new Date().toISOString(),
    style: {
      // 用户选的预设优先于模型的发挥 —— 他挑「赛博朋克」就是要赛博朋克，
      // 不该被模型读完剧本后改成别的
      anchor: style.anchor || parsed.style?.anchor || '电影感构图',
      palette: style.palette || parsed.style?.palette || '',
      negative:
        style.negative ||
        parsed.style?.negative ||
        '模糊, 低质量, 畸变, 多余手指, 文字水印, 崩脸, 五官不对称, 风格突变'
    },
    characters: (parsed.characters || []).map((c) => ({
      name: c.name,
      role: c.role || '',
      appearance: c.appearance || '',
      // 刻意**不**存模型给的 sheetPrompt。它一旦有值就会顶掉 appearance，
      // 于是改描述再重出图，画的还是旧描述 —— 这个坑踩过一次。
      // 出图提示词由 appearance 现推（见 studio.sheetPrompt），
      // 这个字段留空，只有用户明确写了覆盖才有值。
      sheetPrompt: '',
      seed: deriveSeed(project.id, `char:${c.name}`),
      /**
       * 音色。和 seed 一样是**身份的一部分**：全片同一个角色同一个声音。
       *
       * 这里先留空，由 studio.assignVoices 按当前配音服务商的音色表分配 ——
       * 目录里的音色 id 各家不一样，写死在这儿会在换服务商时全错。
       */
      voice: '',
      sheetPath: null,
      sheetUrl: null
    })),
    scenes: (parsed.scenes || []).map((s) => ({
      name: s.name,
      appearance: s.appearance || '',
      sheetPrompt: '',
      seed: deriveSeed(project.id, `scene:${s.name}`),
      sheetPath: null,
      sheetUrl: null
    })),
    // 道具和角色/场景一样也出参考图：一把刀、一枚徽章，跨镜头长得不一样同样出戏
    props: (parsed.props || []).map((p) => ({
      name: p.name,
      appearance: p.appearance || '',
      sheetPrompt: '',
      seed: deriveSeed(project.id, `prop:${p.name}`),
      sheetPath: null,
      sheetUrl: null
    }))
  };

  onEvent?.({
    type: 'note',
    message: `设定已冻结：${bible.characters.length} 个角色、${bible.scenes.length} 个场景、${bible.props.length} 件道具`
  });
  return bible;
}

/**
 * 提示词装配。
 *
 * 顺序：风格锚 → **画面描述** → 角色 → 场景 → 道具 → 技法 → 镜头 → 主色调。
 * 越靠后越容易被稀释，所以排在前两位的是"整体观感"和"这一镜到底在演什么"。
 * 人设由参考图压（第③层），不靠在提示词里堆字数 —— 见函数体里的说明。
 */
export function assemblePrompt(bible, shot, { includeStyle = true } = {}) {
  /**
   * ══════════ 提示词是一摞层，不是一根字符串 ══════════
   *
   * 借的是 Blender 的 Modifier Stack：原始数据不动，上面叠一串
   * **可开关、有名字、看得见自己塞了什么**的层。
   *
   * ── 为什么这件事对这个应用特别值 ──
   *
   * 这一摞层的顺序是被反复争论出来的：画面描述曾经被埋在 150 字之后
   *（"人是对的、可就是没在演这一镜"）、景别曾经被参考图的构图压过去
   *（"标了特写，出来是整个广场"）、两句话打架过（"都要完整出现"撞特写）。
   *
   * 每一次的结论都只活在注释里 —— 你看不见，也验不了，只能信我。
   * 摊成一摞层之后，"场景那段抢戏"这种判断你自己关掉一层出张图就知道了，
   * 不用等我推理。
   *
   * ── 关掉 ≠ 删掉 ──
   *
   * 静音的层**照样出现在列表里**，只是不进提示词。删掉的话它从界面上
   * 消失，人就再也打不开了 —— 那不是非破坏性，那是破坏性带个开关。
   */
  const muted = new Set(Array.isArray(shot?.promptMute) ? shot.promptMute : []);
  const layers = [];
  const parts = [];
  /**
   * @param id   稳定的层名。存在 shot.promptMute 里，所以**不能随便改**——
   *             改了等于把用户关掉的层全部打开，而且不报错。
   * @param name 人话，界面上显示的
   */
  const add = (id, name, text) => {
    if (!text) return;
    const off = muted.has(id);
    layers.push({ id, name, text, muted: off });
    if (!off) parts.push(text);
  };

  if (includeStyle && bible?.style?.anchor) add('style', '画风锚', bible.style.anchor);

  const cast = matchCharacters(bible, shot);
  const scene = matchScene(bible, shot);
  const props = matchProps(bible, shot);

  /**
   * ⚠ 顺序改过一次，因为原来那版有个很实际的毛病：**画面描述被埋了**。
   *
   * 原来是「风格锚 → 每个角色 60~90 字外貌 → 场景 90 字 → 道具 → 画面描述」，
   * 两个角色一个场景就是 250 字，而这一镜真正要画的那句话往往只有二十来字，
   * 排在第 150 字之后。模型读到那儿时权重已经被稀释干净了 ——
   * 出来的图"人是对的、可就是没在演这一镜"。
   *
   * 现在画面描述紧跟风格锚，**它才是这一镜的主语**。
   *
   * 那人设靠什么压住？靠参考图 —— 像素级的参照本来就比文字强得多（第③层）。
   * 所以带得动参考图时，角色只给「名字 + 一句话特征」，把版面让给画面内容；
   * 只有在没有参考图可用时，才把完整外貌铺开兜底。
   * 这和视频提示词的做法是一致的（见 assembleVideoPrompt）。
   */
  const refs = collectReferences(bible, shot);
  /**
   * ⚠ 这里必须问的是"参考图**会不会真的发出去**"，不是"设定集里有没有图"。
   *
   * 曾经只判了后者，于是分镜图默认不带参考图之后出现了最坏的一种组合：
   * 提示词被压成三段、末尾还挂着一句"外貌以参考图为准"——
   * **而那张参考图根本没发**。模型既没拿到图，又被砍掉了"袖口两道银线、
   * 左胸编号牌"这些真正锁得住身份的细节，出来的人当然谁也不像。
   * 表现就是"完全没按设定集出图，提示词是不是没用"。
   *
   * 所以这三个条件缺一不可：有图、没关掉参考图、而且这一步真的会发图。
   */
  const plan = refPlan();
  const kept = pickRefs(refs, plan);
  const hasRefs = kept.images.length > 0;
  /** 这一镜带的参考图里，有没有用户自己传的照片 */
  const hasPhoto = kept.uploaded > 0;

  add('description', '这一镜演什么', shot.description || '');

  /**
   * ══════════ 这一镜画面里有几个人 ══════════
   *
   * 提示词原来从头到尾没说过这件事。两个【角色】段落只是**隐含**信号 ——
   * 而"画面里有几个人"恰恰是扩散模型最容易漏的约束之一：
   * 它会把两段人物描述**揉成一个人**，或者干脆只画写在前面那个。
   *
   * 真实事故（第 6 镜）：「父亲伸手从怀里掏出几块灵石，塞进我手里」，
   * 出来只有父亲一个人，没有接的那个。那一镜的成因里有名字对不上那条
   *（已修），但即使名字对上了，靠两段描述去暗示"这里有两个人"仍然很弱。
   *
   * ── 为什么只报数和名字，不写"两人同框"「都要完整出现」 ──
   *
   * 那会和景别打架。这一镜要是特写，"两个人都要完整出现"就是一条
   * 和「特写」直接矛盾的指令，而两句矛盾的话一起发过去，模型挑哪句
   * 你控制不了 —— 这个项目已经为"两句话打架"单独做过一条诊断了。
   *
   * 报数是**事实陈述**（shot.characters 就是这么写的），
   * 取景交给景别那句管，各说各的、不互相压。
   *
   * 一个人时不说：那是废话，还白占提示词字数（视频精准模式只有 200 字）。
   */
  if (cast.length > 1) {
    add('headcount', '画面里有几个人', `画面里有 ${cast.length} 个人：${cast.map((c) => c.name).join('、')}`);
  }

  /**
   * 变体：这一镜里这个人穿哪套、这个场景是什么时段。
   * 完整描述 = 身份锚 + 这一版变的那部分，身份永远在前
   * （见 pipeline/variants.js 里为什么不能拆成两个条目）。
   */
  for (const c of cast) {
    const v = variants.pickVariant(c, shot);
    const full = variants.describeWith(c, v);
    if (hasPhoto) {
      /**
       * ⚠ 带的是**真人照片**时，说法要反过来：脸照着图，衣服照着字。
       *
       * 用户的原话："建议上传的人物脸保留、衣服是描述中的衣服"。
       *
       * 只说一句"外貌以参考图为准"的话，模型会把照片里的**衣服也一起抄过来** ——
       * 而那多半是一件跟这部片子毫无关系的现代便装。于是每一镜都穿着那身，
       * 设定集里写的"藏青立领制服"一次都没出现过。
       *
       * 所以这里把两件事分开点名：五官/发型/肤色跟着照片，
       * 服装/配饰/场景跟着文字。而且服装那段要**完整给**，不能像下面那样
       * 截前三段 —— 它现在是唯一的服装来源了。
       */
      add('cast', '人物长相', `【${c.name}】脸、发型、肤色以参考图那个人为准；`
        + `服装与配饰按这里写的来：${full || '按设定集'}`);
    } else if (hasRefs) {
      // 留三段而不是两段：第三段往往正好是服装配色，而配色是最强的身份线索之一。
      // 参考图给的是设定图（另一个姿势、另一个背景），文字仍然要把关键特征点住。
      const brief = full.split(/[，,。]/).slice(0, 3).join('，');
      add('cast', '人物长相', brief ? `【${c.name}】${brief}，外貌以参考图为准` : `【${c.name}】外貌以参考图为准`);
    } else {
      add('cast', '人物长相', `【${c.name}】${full}`);
    }
  }

  if (scene) {
    const sv = variants.pickVariant(scene, shot);
    const full = variants.describeWith(scene, sv);
    const brief = full.split(/[，,。]/).slice(0, 3).join('，');
    add('scene', '场景环境', `【场景·${scene.name}】${hasRefs ? brief : full}`);
  }

  for (const prop of props) {
    add('props', '关键道具', `【${prop.name}】${prop.appearance}`);
  }

  /**
   * 技法卡。位置是有讲究的：紧跟画面描述，在主色调之前。
   * 越靠后的描述越容易被稀释，而机位和光线是**直接决定这张图长什么样**的，
   * 不能排在"主色调"后面陪跑。运镜类不进出图提示词 ——
   * 对一张静态图说"镜头缓慢推进"没有意义，只会占掉画面描述的权重。
   */
  const skillParts = skills.fragmentsFor(shot.skills, { target: 'image' });
  for (const t of [...skillParts.look, ...skillParts.action, ...skillParts.mood]) add('skills', '技法卡', t);

  /**
   * 排过位的话，机位用**算出来的那句**，而不是 `camera: "中景"`。
   *
   * "中景"没有确切含义 —— 35mm 站 2 米和 85mm 站 5 米都能叫中景，
   * 而两张画完全不同（后者背景压缩、透视平）。模型每一镜自己挑一个，
   * 于是同一场戏里景别忽远忽近，看起来像"模型不稳定"，
   * 其实是我们从来没说清楚过。
   */
  const staged = previz.cameraLine(shot, cast[0]?.name);
  if (staged) add('camera', '机位与景别', `镜头：${staged}`);
  else if (shot.camera) add('camera', '机位与景别', `镜头：${shot.camera}`);
  /**
   * ⚠ 景别后面补一句**画面上能验的话**。
   *
   * "特写"是个行话，两个字要和几百字的外貌、环境描述抢注意力，
   * 而且各家模型对它的理解不一致。"画面只到肩膀以上，脸占据主要面积"
   * 具体得多，也难被无视得多 —— 这是"提示词说了算"这条路能不能走通的关键。
   */
  const framing = previz.framingHint(shot.camera);
  add('framing', '景别怎么算数（画面上验得出的那句）', framing);
  /**
   * ══════════ 焦段 ══════════
   *
   * 借 Blender 的相机：景别不是一个形容词，是**焦距 + 距离**算出来的。
   * "中景"没有确切含义 —— 35mm 站 2 米和 85mm 站 5 米都叫中景，
   * 而两张画完全不同（后者背景压缩、透视平）。
   *
   * ⚠ 排过位的以**排位里那个焦段**为准（它更具体）；没排位的用这一镜
   * 自己选的。两个都没有就一个字不说 —— 补一句默认的 35mm 说明，
   * 等于替用户做了一个他没做过的决定，而且是一个听起来很具体的谎。
   */
  const lensMm = shot?.stage?.cam?.lens ?? shot?.lens;
  add('lens', '焦段（背景压缩、透视）', previz.lensHint(lensMm));
  /**
   * ══════════ 参考图管"是什么"，文字管"怎么拍" ══════════
   *
   * ⚠ 这一句必须**每次带参考图时都说**，不能只在特写时说。
   *
   * ── 我在这儿绕了两版弯路 ──
   *
   * 现象是"标了特写，出来是整个广场的大远景"。场景基准图是
   * 「空镜无人物、广角」出的，天生是远景构图，而它排在参考图第一位、
   * 权重最高 —— 文字说特写、图说广角，图赢。
   *
   * 我先是**不发那张图**（结果环境没了基准，模型自己编了个广场），
   * 又改成**降权到最后**（治标，而且每来一种新情况就要再加一个特例）。
   * 两次都是在拿参考图当杠杆去修构图 —— 用错了地方。
   *
   * 正确的分工是一条线，不是一堆特例：
   *   参考图  长相、服装、环境、色调  —— 是什么
   *   文字    景别、机位、构图、动作  —— 怎么拍
   *
   * 那就把这条线**明写出来**。模型不会自己知道我们是这么分的。
   */
  if (kept.images.length) {
    add('ref-policy', '参考图管"是什么"、文字管"怎么拍"',
      '参考图只用来确定人物长相、服装、场景环境和色调；'
      + '**画面的景别、机位、构图完全按上面的文字来，不要沿用参考图的取景**');
  }
  add('palette', '主色调', bible?.style?.palette ? `主色调：${bible.style.palette}` : '');

  return {
    prompt: parts.filter(Boolean).join('，'),
    /** 这一摞层：界面上摊开给人看、给人关。关掉的也在里面（标着 muted） */
    layers,
    negative: bible?.style?.negative || '',
    // 镜头种子 = 角色种子（有主角时）+ 镜号偏移。
    // 完全用同一颗种子会导致每镜构图雷同，加镜号偏移既保风格又留变化。
    seed: (cast[0]?.seed ?? scene?.seed ?? 0) + (shot.index || 0),
    refImages: refs.images,
    refLabels: refs.labels,
    /** 和 refImages 一一对应：每张图是"你传的"还是"模型出的" */
    refSources: refs.sources,
    /** 和 refImages 一一对应：每张图是景 / 角色 / 道具。挑"锁脸用的那一张"靠它 */
    refKinds: refs.kinds,
    /** 带来源的标签，供界面在"一张都没发"时说清那几张分别是谁 */
    refDetailed: refs.detailed,
    // 和 refImages 一一对应。限时地址过期时靠它重新签一个（见 studio.js 的 refreshRefs）
    refPaths: refs.paths,
    cast: cast.map((c) => c.name),
    scene: scene?.name || null
  };
}

/**
 * 这一镜该带哪些设定集参考图。
 *
 * 单独重出一张图或一段视频时，最容易出的错就是"只带了角色设定图" ——
 * 于是人对了，可背景换了个地方、手里的刀换了个样式，接回全片照样出戏。
 * 参考图必须和提示词取自同一份设定集，否则重出的那一镜就是全片里唯一的孤儿。
 *
 * 顺序有讲究：场景基准图放第一张。多数厂商对首张参考图给的权重最高，
 * 而人物已经被首帧图锁住了，最需要被"提醒"的反倒是环境。
 *
 * limit 默认 9，是目前收图最多的 H3 的上限；别家在适配层里会自己再截断。
 */
export function collectReferences(bible, shot, { limit = 9 } = {}) {
  const picked = [];
  // 带的是**这一镜选中那个变体**的图：夜戏就该带夜景基准图，
  // 带白天那张等于给了模型一条互相打架的指令
  /**
   * 连**本地那张图在哪**一起带出去。
   *
   * sheetUrl 可能是对象存储的**限时**地址。设定集是几天前建的，
   * 而限时地址默认只活 6 小时 —— 于是"今天重出昨天那一镜"必然 403，
   * 而报出来的样子是厂商说"下载不到你给的图"，完全指不到过期这件事上。
   *
   * 光判断"过期了"没用，得能**重新签一个**，而重新签就需要本地那张图。
   * sheetPath 一直都存着（见 variants.js），以前只是没往外传。
   */
  const ref = (kind, item) => {
    const v = variants.pickVariant(item, shot);

    /**
     * 这一镜该发哪个角度的图。
     *
     * 人背对镜头的时候发一张正脸过去，等于告诉模型"背面长这样"——
     * 它只能自己编，于是后脑勺的发型、衣服背面每一镜都在变，
     * 而且**不报错**，表现就是"他一转身就换了个人"。
     * 补过背面图的话，这里就该发那张。
     */
    const setKey = kind === 'character' ? 'char' : kind;
    // 排过位就用机位算出来的关系（准），没排就退回读描述里的关键词（猜）
    const hint = kind === 'character' ? previz.sheetHintFor(shot, item.name) : null;
    const angleId = anglesLib.pickAngle(setKey, shot, { available: anglesLib.availableOn(v), hint });
    const angle = anglesLib.sheetOf(v, angleId);

    const url = angle?.sheetUrl || v?.sheetUrl || item.sheetUrl;
    const localPath =
      angle?.sheetPath || (v?.sheetUrl ? v?.sheetPath : null) || item.sheetPath || null;
    if (!url) return;

    // 标签上带出角度，用户才知道这一镜为什么像 / 不像
    const base = variants.labelOf(item, v) || item.name;
    const name = angleId === anglesLib.PRIMARY ? base : `${base}·${anglesLib.labelOf(setKey, angleId)}`;
    /**
     * 带上**这张图哪来的**。
     *
     * "你自己传的照片"和"模型出的设定图"是两种东西，下游要分开对待：
     * 传照片是一句毫不含糊的"我要这张脸"，而模型出的设定图只是一个近似。
     * 不区分的话，"要不要发参考图"就只能一刀切 —— 而一刀切正是
     * 上传功能形同虚设的原因（见下面 refMode）。
     */
    const src = angle?.sheetSource || v?.sheetSource || item.sheetSource || null;
    picked.push({ kind, name, url, path: localPath, source: src });
  };
  const scene = matchScene(bible, shot);
  if (scene) ref('scene', scene);
  for (const c of matchCharacters(bible, shot)) ref('character', c);
  for (const p of matchProps(bible, shot)) ref('prop', p);

  const seen = new Set();
  const unique = picked.filter((r) => !seen.has(r.url) && seen.add(r.url)).slice(0, limit);
  const glyph = { scene: '景', character: '角', prop: '道' };
  return {
    refs: unique,
    images: unique.map((r) => r.url),
    // 和 images 一一对应；过期的那张要靠它重新签（见 studio.js 的 refreshRefs）
    paths: unique.map((r) => r.path || null),
    // 界面上直接显示"这次带了谁"，用户才知道重出为什么像/不像
    labels: unique.map((r) => `${glyph[r.kind]}·${r.name}`),
    /** 每张是"你传的照片"还是"模型出的设定图"。refMode 靠它筛。 */
    sources: unique.map((r) => r.source || null),
    /**
     * 每张是景 / 角色 / 道具。
     *
     * ⚠ 有些厂商的**身份通道只收一张图**：海螺的 subject_reference
     * （字面写着 type: 'character'）、万相的 ref_img。而这个数组的顺序是
     * 场景在最前、角色在后 —— 取 refImages[0] 就等于把**场景图**当成
     * "这个人长什么样"发过去。那条通道是专门用来锁脸的，收错了就白开，
     * 而且不报任何错：出来的人照旧不像，看不出是我们发错了图。
     */
    kinds: unique.map((r) => r.kind),
    /**
     * 带来源的标签，界面直接用。
     *
     * ⚠ 只说"有 3 张可以带"是不够的 —— 用户传了照片、结果一张没发，
     * 他需要知道的是**那三张分别是谁、哪张是他传的**。
     * 很可能他的照片压根不在这三张里（挂到了别的条目上、
     * 或者这一镜引用的角色名和设定集对不上），而那是完全另一个问题。
     * 只报一个数字，等于让他继续猜。
     */
    detailed: unique.map((r) => `${glyph[r.kind]}·${r.name}${r.source === 'upload' ? '（你传的）' : '（模型出的）'}`)
  };
}

/**
 * ══════════ 出分镜图时，哪些参考图该发出去 ══════════
 *
 * 用户的原话："传本地图，出的分镜和自传图没有任何关系"。
 *
 * 他说的完全对，而且原因是结构性的：`useEditModelForShots` 这个开关
 * 把**两件独立的事**捆在了一起 ——
 *
 *   ① 要不要带参考图
 *   ② 要不要把模型换成图生图（编辑）模型
 *
 * 默认关掉它的理由（写在下面那段注释里）全是冲着 ② 去的：SeedEdit 这类
 * 编辑模型拿到一张图是在**那张图上改**，出来的像"被改过的设定图"而不是那一场戏。
 * 那个理由是对的。但它把 ① 也一起关掉了 —— 于是默认设置下，
 * 出分镜图时**一张参考图都不发**，用户传的照片影响是零。
 *
 * 拆开之后：
 *   auto（默认） 只发**你自己传的那些图**，模型不换。
 *                传一张照片上去是一句毫不含糊的"我要这张脸"，
 *                而模型出的设定图只是个近似，没必要冒 ② 那个险。
 *   all          所有设定图都当参考发，模型不换。
 *   edit         老行为：换成编辑模型 + 发图。构图会被带跑，慎用。
 *   off          一张都不发（纯文字 + 稳定种子）。
 *
 * ⚠ 老的 useEditModelForShots=true 仍然等价于 edit —— 那些人的行为不能被悄悄改掉。
 */

/**
 * ══════════ 这一镜是按哪一版规矩出的 ══════════
 *
 * 镜头卡上"带了哪几张参考图"那行，读的全是**出图那一刻存下来的**字段。
 * 它是一份历史记录，不是当前状态 —— 改了代码、改了设置，它一个字都不会变，
 * 除非把这一镜重出一次。
 *
 * 这件事坑过一整轮：上传图不再受开关管之后，用户更新了程序，
 * 卡片上照旧写着"你传的那张没发出去，去改设置"—— 因为那行是**上一次出图时**
 * 写下的，而上一次出图确实没发。他照着去改设置，改完还是那句话，
 * 于是更确信"这功能是坏的"。而真正该做的只是重出一次。
 *
 * 所以每次出图都盖一个戳，界面靠它分清两件完全不同的事：
 *   没有戳 → 这条记录是旧版留下的，它说什么都不作数，重出一次再看
 *   有戳还是没发 → 那是真出了问题，得看请求记录，不是去改设置
 */
export const REF_POLICY = 'uploads-always';

export function refPlan() {
  const legacy = settings.get('useEditModelForShots') === true;
  const mode = legacy ? 'edit' : (settings.get('refMode') || 'auto');
  const refsOn = settings.get('useReferenceImages') !== false;
  /**
   * ⚠ **拦住参考图的开关有两个**，而它们在界面上隔着两个面板：
   *
   *   useReferenceImages  「设置 → 一致性引擎 → 出镜头图时带上角色设定图」（老开关）
   *   refMode             「设置 → 画面规格 → 出分镜图时带哪些参考图」（新的）
   *
   * 关掉任何一个，结果都是"一张都没发"，而现象一模一样。
   *
   * 第一版的提示语只提了后者 —— 于是用户照着去改了那一项，
   * 而真正关着的是前者，改完照旧不发。他会以为"改了没用，这功能是坏的"。
   *
   * 所以返回值里带上**到底是谁拦的**，界面照着说，不猜。
   */
  /**
   * ══════════ 你自己传的照片，任何开关都拦不住 ══════════
   *
   * 到这里为止，一张上传的照片要被用上得闯过**四道关卡**：
   *   ① useReferenceImages 得开着
   *   ② refMode 不能是 off
   *   ③ refMode 得是 auto 或 all
   *   ④ 中途不能被"重出设定图"覆盖掉
   * 任何一道没过，现象都一样：出来的脸跟他传的图毫无关系，
   * 而界面（在补了几轮提示之前）一个字都不说。
   *
   * 用户为此来回折腾了七八轮，最后一句是"我服了"。他是对的 ——
   * 问题不在他没找对开关，在于**这件事根本不该有开关**。
   *
   * 上传一张照片是一句**指名道姓的指令**："这个角色就长这样"。
   * 而那两个开关表达的是**泛泛的偏好**："一般来说要不要带参考图"。
   * 具体的指令压过泛泛的偏好 —— 这是设置该有的层级，反过来就是耍人。
   *
   * 所以：关掉开关只影响**模型自己出的**那些设定图；
   * 用户亲手传的那张，永远发。真不想要，就在设定集里把它删掉/重出 ——
   * 那才是"我不要这张图"的正确说法，而且是可见、可撤销的。
   */
  if (!refsOn) {
    return {
      mode: 'uploaded-only', send: true, useEditModel: false, onlyUploaded: true,
      blockedBy: null,
      note: '「出镜头图时把角色设定图作为参考图带上」是关着的，所以模型出的设定图不发；'
        + '但你自己传的照片照发 —— 传一张图是指名道姓的指令，开关管不着它。'
    };
  }
  if (mode === 'off') {
    return {
      mode: 'uploaded-only', send: true, useEditModel: false, onlyUploaded: true,
      blockedBy: null,
      note: '「出分镜图时带哪些参考图」选的是「一张都不发」，所以模型出的设定图不发；'
        + '但你自己传的照片照发 —— 传一张图是指名道姓的指令，开关管不着它。'
    };
  }
  if (mode === 'edit') return { mode, send: true, useEditModel: true, onlyUploaded: false, blockedBy: null };
  if (mode === 'all') return { mode, send: true, useEditModel: false, onlyUploaded: false, blockedBy: null };
  return { mode: 'auto', send: true, useEditModel: false, onlyUploaded: true, blockedBy: null };
}

/**
 * ══════════ 一次最多发几张参考图 ══════════
 *
 * ⚠ **上限不是省钱，是保效果。**
 *
 * 参考图不是越多越好。九张图发过去，模型要在九个目标之间找平衡，
 * 每一张的权重都被摊薄 —— 最要紧的那张脸反而不像了。
 * 走 /images/edits 那条路更直接：它会把九张**拼**进画面。
 *
 * 用户报的原话是"他一下给我喂了9张图"。九正好是 collectReferences 的
 * 收集上限 —— 也就是说，能收多少就发多少，一张没筛。
 *
 * 4 张是一个保守的档：身份 1~2 张 + 场景 1 张 + 最要紧的道具 1 张。
 * 想要更多去「设置 → 画面规格」调。
 */
export const DEFAULT_MAX_REFS = 4;

/**
 * 谁该留下来。数字越小越先留。
 *
 * ⚠ **用户亲手传的排第一。**那是他指名道姓说"这个人就长这样"的那张，
 * 被上限挤掉的话，这个人的脸就又回到"由文字决定"了 —— 而那正是
 * 他传这张照片要解决的问题。
 */
function refRank(kind, source) {
  if (source === 'upload') return 0;
  if (kind === 'character') return 1;
  if (kind === 'scene') return 2;
  return 3;
}

/** 按当前策略筛一遍：auto 只留用户自己传的那些 */
export function pickRefs({ images = [], labels = [], paths = [], sources = [], kinds = [] }, plan) {
  if (!plan.send) return { images: [], labels: [], paths: [], kinds: [], sources: [], uploaded: 0 };
  const keep = images.map((_, i) => (plan.onlyUploaded ? sources[i] === 'upload' : true));

  /**
   * ⚠ 上限要**按优先级砍**，不能直接 slice 前 N 张。
   *
   * 参考图的排列顺序是场景在最前（多数厂商对首张权重最高，出分镜时
   * 最该被提醒的是环境）。直接砍前 N 张的话，第一个被留下的是场景，
   * 而**最容易被挤掉的恰恰是排在后面的角色**——脸没了，环境留着。
   */
  const cap = Math.max(1, Number(settings.get('maxRefs')) || DEFAULT_MAX_REFS);
  const survivors = images
    .map((_, i) => i)
    .filter((i) => keep[i])
    .sort((a, b) => refRank(kinds[a], sources[a]) - refRank(kinds[b], sources[b]))
    .slice(0, cap);
  // 砍完之后**恢复原来的顺序**：顺序本身是有意义的（场景在前），
  // 按优先级排出来的顺序会把场景推到最后
  const live = new Set(survivors);
  const idxs = images.map((_, i) => i).filter((i) => keep[i] && live.has(i));

  return {
    images: idxs.map((i) => images[i]),
    labels: idxs.map((i) => labels[i]),
    paths: idxs.map((i) => paths[i]),
    // 一起筛，否则下游按下标去认"哪张是脸"时会整体错位
    kinds: idxs.map((i) => kinds[i]),
    sources: idxs.map((i) => sources[i]),
    uploaded: idxs.filter((i) => sources[i] === 'upload').length,
    /** 被上限挤掉了几张。界面要说出来，不然人只会觉得"设定集里的图没发" */
    capped: idxs.length < images.filter((_, i) => keep[i]).length
      ? images.filter((_, i) => keep[i]).length - idxs.length
      : 0
  };
}

/**
 * ══════════ 哪一张是"这个人长什么样" ══════════
 *
 * 有些厂商的身份通道**只收一张图**：海螺的 subject_reference（字面就写着
 * type: 'character'）、万相的 ref_img。这些通道是专门用来锁脸的，
 * 是目前云端唯一真能做到"换场景但还是这个人"的东西。
 *
 * 而参考图数组的顺序是**场景在最前**（多数厂商对首张权重最高，而出分镜时
 * 最需要被提醒的是环境）。于是 refImages[0] 是场景图 —— 把它塞进
 * "这个角色长这样"的字段，那条通道就等于没开。而且不报任何错：
 * 出来的人照旧不像，看不出是我们发错了图。
 *
 * 挑选顺序：用户亲手传的角色照 > 模型出的角色设定图 > 退回第一张。
 * 用户传的排前面，因为那是他指名道姓说"这个人就长这样"的那一张。
 */
export function identityRef({ images = [], kinds = [], sources = [] } = {}) {
  if (!images.length) return null;
  const at = (pred) => {
    const i = images.findIndex((_, n) => pred(n));
    return i === -1 ? null : images[i];
  };
  return at((i) => kinds[i] === 'character' && sources[i] === 'upload')
    || at((i) => kinds[i] === 'character')
    || images[0];
}

/**
 * 视频提示词装配。
 *
 * 早期版本这里只发「运镜 + 镜头语言」，等于告诉模型"镜头缓推"却不说推的是什么 ——
 * 模型只好自己脑补内容，出来的片段自然和剧本对不上。图生视频虽然有首帧兜底，
 * 但首帧只定住第一格，后面几秒演什么完全由提示词决定。
 *
 * 所以这里把三样东西都给足：
 *   画面在发生什么（description）→ 决定内容
 *   角色是谁、什么打扮（简版锚）  → 决定人别在中途变样
 *   怎么拍（camera + motion）     → 决定镜头运动
 *
 * 和出图提示词的区别是刻意的：这里**不重复完整外貌描述**。
 * 首帧图已经把人锁死了，再堆一遍长描述只会挤占运镜指令的权重，
 * 反而让模型分心去"重画"人物。
 *
 * 第四样东西是**上下文**（prev / next）：模型只看得见一张图和一句描述时，
 * 它不知道自己是一部片子里的第 7 镜，于是每一镜都从头起势、各演各的。
 * 这就是"逐镜都对、连起来不像一部片子"的根因。见 pipeline/continuity.js。
 *
 * ── 两条后来才发现的坑（"出的视频和描述不一致、说的话也不一致"）──
 *
 * ① **静态构图类的技法不能再说一遍**。机位（仰拍/俯拍）和光线（伦勃朗光/顶光）
 *    在**出图**那一步就已经烧进首帧图里了。图生视频时再讲一遍
 *    "低机位仰拍，背景多为天空"，等于要求模型**重新构一次图** ——
 *    而首帧已经把构图定死了，两边一打架，模型就开始偏离首帧自己发挥。
 *    更糟的是这两类描述特别长（一条就四五十字），把真正该说的
 *    "这一镜在演什么"从 20% 的篇幅挤到 8%。
 *    所以带首帧时只发**运镜 + 动作 + 氛围**，构图交给那张已经审过的图。
 *
 * ② **要说什么话必须写出来**。旧版本只说了一句"人物在说话，口型与表情自然"，
 *    却从不告诉模型**说的是哪句、谁在说**。于是：画面里两个人，
 *    模型随便挑一个张嘴；台词是旁白的，画面里的人也跟着念。
 *    这就是"说话的内容也不一致"。台词本来就在手上，发过去不要钱。
 *
 * ── 两种详略（videoPromptMode）──
 *
 * 提示词长不等于说得清。带首帧时，**图已经回答了一大半问题** ——
 * 人长什么样、穿什么、在哪儿、什么光、什么景别，全在那张图里。
 * 再用文字把这些复述一遍，模型就要在"照着图"和"照着字"之间选边，
 * 而它经常选错。所以默认走**精准**：只说图回答不了的那部分 ——
 * 演什么动作、镜头怎么动、谁在说什么、和上一镜怎么接。
 *
 *   precise（默认）  描述 + 动作 + 运镜 + 说话 + 一句衔接。八十来字。
 *   full             再加上角色外貌锚、场景、景别、氛围、完整衔接约束。
 *                    没有首帧的纯文生视频、或者厂商不吃首帧时用它。
 *
 * 没有首帧时**自动按 full 走**：那时候文字是唯一的信息来源，省不得。
 */
export function assembleVideoPrompt(
  bible,
  shot,
  { maxChars = 0, prev = null, next = null, link = null, firstFrame = Boolean(shot?.imagePath), mode = null } = {}
) {
  const parts = [];
  // 没有首帧时文字是唯一信息源，再"精准"也没法省
  const full = !firstFrame || (mode || settings.get('videoPromptMode') || 'precise') === 'full';
  const cap = maxChars || (full ? 380 : 200);

  // 没有首帧（纯文生视频）时，画风只能靠这句话带 —— 有首帧的话它已经在图里了，
  // 再说一遍纯属占字数
  if (!firstFrame && bible?.style?.anchor) parts.push(bible.style.anchor);

  if (shot.description) parts.push(shot.description);

  // 角色外貌、场景、景别：**首帧图里全都有**，精准模式一律不说。
  // 说了不但白占字数，还会让模型在"照着图"和"照着字"之间选边
  if (full) {
    const cast = matchCharacters(bible, shot);
    for (const c of cast.slice(0, 2)) {
      const brief = (c.appearance || '').split(/[，,。]/).slice(0, 2).join('，');
      parts.push(brief ? `${c.name}（${brief}）保持外貌不变` : `${c.name} 保持外貌不变`);
    }

    const scene = matchScene(bible, shot);
    if (scene) {
      const brief = (scene.appearance || '').split(/[，,。]/).slice(0, 2).join('，');
      if (brief) parts.push(brief);
    }

    // 同上：排过位就用精确机位，没排就用原来那句话
    const staged = previz.cameraLine(shot, cast[0]?.name);
    if (staged) parts.push(staged);
    else if (shot.camera) parts.push(shot.camera);
  }

  // 技法卡：运镜替代那句泛泛的默认运镜 ——
  // 选了具体运镜还保留"镜头缓慢推进"，等于给模型两条互相打架的指令。
  //
  // 机位和光线（look）**带首帧时不发**：它们已经在那张图里了，
  // 再讲一遍是让模型重新构图，反而会偏离首帧（见函数头注释①）。
  const sk = skills.fragmentsFor(shot.skills, { target: 'video' });
  if (!firstFrame) parts.push(...sk.look);
  // 动作是"接下来几秒演什么"，永远要发；氛围（色调、留白）已经在图里，精准模式省掉
  parts.push(...sk.action);
  if (full) parts.push(...sk.mood);
  if (sk.motion.length) parts.push(...sk.motion);
  else parts.push(shot.motion || '镜头缓慢推进');

  parts.push(speechLine(bible, shot));

  // 衔接约束放在最后：它是对整段的约束，不是画面内容。
  // 放前面会挤掉"演什么"的权重 —— 那才是这一镜的主语。
  parts.push(...continuity.continuityLines(shot, { prev, next, link, brief: !full }));

  let prompt = parts.filter(Boolean).join('，');
  // 视频模型的提示词普遍比图像模型短，超长会被截断或稀释，主动收一下
  if (prompt.length > cap) prompt = `${prompt.slice(0, cap - 1)}…`;
  return prompt;
}

/**
 * 谁在说话、说的是哪句、其他人该不该张嘴。
 *
 * 三件事都要明说，少一件就会出对应的毛病：
 *   不说"要不要说话" → 没台词的镜头人物也在那儿一张一合地瞎说；
 *   不说"谁在说"     → 画面里两个人，模型随便挑一个张嘴；
 *   不说"说什么"     → 口型和台词对不上（能出声的模型更是直接念错内容）。
 *
 * 但前提是**画面里有人**。没人的时候这三件事一件都不存在，
 * 而多说一句"人物不说话"反倒可能给你招来一个人 —— 见函数体里那段。
 *
 * 旁白是最容易被忽略的一种：它有台词，但**画面里的人不该开口** ——
 * 旧版本一律按"人物在说话"处理，于是每条旁白都配上一个跟着念的哑剧演员。
 */
/**
 * 这一镜的画面里**到底有没有人**。
 *
 * 和 matchCharacters 不是一回事，区别只在一处、但很要紧：
 * matchCharacters 在 characters 为空时，会退回去**扫描画面描述里的人名** ——
 * 那对"该注入谁的外貌"是对的（描述里写了"李队"就该带上他的设定），
 * 对"画面里有没有人"却是**错的**：
 *
 *     场景名叫「明锋的办公室走廊」，而这一镜是个空走廊。
 *     扫描一命中"明锋"，就又判成"画面里有人"了。
 *
 * 分镜表里的 characters 是权威的 —— 拆分镜的提示词明写着"空镜给空数组"。
 * 明确给了空数组就信它。只有**老项目**（压根没有这个字段）才退回扫描。
 */
/**
 * 这一镜画面里有谁 —— **提示词**那一路用的就是它。
 *
 * ⚠ 这里原来自己抄了一份"全等匹配 + filter(Boolean)"，和 matchCharacters
 * 那份一模一样的毛病 —— 同一件事两条代码路径，只修一条等于没修。
 *
 * ── 漏在这里的具体后果 ──
 *
 * 下游只问它一句"画面里到底有没有人"（见 speechLine）。所以一镜里
 * **所有**角色名都对不上时，cast 是空的 → 这一镜被当成空镜 →
 * "嘴唇闭合、面部安静"那句不发。而画面里其实有两个人，
 * 于是他们可能被画成正在说话 —— 明明这一镜没有台词。
 *
 * （长相描述是另一条路：assemblePrompt 直接用 matchCharacters，
 * 那一份已经在上面修好了。别把两者记混。）
 */
function castInFrame(bible, shot) {
  /**
   * 只保留一处差别：**空数组 = 明确"这一镜没人"**（空镜）。
   * 那种情况下不能退回读描述去猜 —— 猜出一个人来，空镜就不空了。
   */
  if (Array.isArray(shot?.characters) && !shot.characters.length) return [];
  return matchCharacters(bible, shot);
}

function speechLine(bible, shot) {
  const cast = castInFrame(bible, shot);
  const said = speaker.spokenText(shot.dialogue);

  /**
   * ⚠ 画面里一个人都没有时，**什么都别说**。
   *
   * 这一条是用户问出来的：「为什么每一镜都有『画面中的人物不说话』这句话」。
   * 因为原来这里不看有没有人 —— 空镜（码头夜色、桌上一支钢笔）照样会被
   * 加上"画面中的人物不说话，嘴部保持闭合"。
   *
   * 三重代价，一重比一重实在：
   *
   *   ① 纯噪音     —— 画面里没有人，这句话不约束任何东西
   *   ② **会招人** —— 提示词里出现"人物"两个字，扩散模型很可能真给你画一个。
   *                   一个空镜里凭空多出半个人影，而你完全想不到是这句话干的
   *   ③ 占字数     —— 视频提示词精准模式只有 200 字，这句 24 字，白吃掉一成多，
   *                   挤掉的是"这一镜到底演什么"
   *
   * 而空镜在一部片子里占三四成 —— 所以它看起来像"总是"出现。
   */
  if (!cast.length) return '';

  /**
   * ── 为什么改成正面说法 ──
   *
   * 原来这句是"画面中的人物不说话，嘴部保持闭合，**不要出现说话口型**"。
   * 扩散模型对否定句是出了名的不灵：它读到的是"说话""口型"这几个词本身，
   * "不要"那两个字的分量小得多。等于在一句要求闭嘴的话里，
   * 反复把"说话"这个概念塞给它。
   *
   * 所以整句改成只描述**想要的状态**：嘴唇闭合、面部安静。
   * 一个"不"字都不出现，也不出现"说话""口型"这些会往反方向拉的词。
   *
   * ⚠ 这一条是基于"否定式提示词效果差"这个通行经验做的判断，
   * 我没有在真厂商上做过 A/B。要是你发现改完之后人物反而开始张嘴，
   * 那就是这个判断错了，回去用否定式 —— 这种事只有真出片才分得出来。
   */
  if (said.kind !== 'speech') {
    return cast.length > 1 ? '所有人嘴唇闭合，面部安静' : '嘴唇闭合，面部安静';
  }

  const r = speaker.resolve({ bible }, shot);
  // 用**推断过**的说话人判类型：分镜没填说话人时，画面里只有一个角色就算他说的
  const kind = speaker.lineKindOf(shot, r.speaker);

  /**
   * ── 四种台词，只有一种要动嘴 ──
   *
   * 漏掉「心里话」是原来这段最实在的缺口：短剧里内心独白到处都是，
   * 而用原来那两种表达不了 ——
   *   把 speaker 填成这个角色 → 画面被要求"口型对上台词"，出来是他在自言自语
   *   把 speaker 留空当旁白   → 声音换成了旁白的音色，不是他自己的
   * 两种都不对，而且**都不报错**。
   *
   * 现在类型和说话人是两个正交的字段：谁的声音 / 嘴动不动，分开说。
   */
  if (kind === 'inner') {
    // 心里话：他自己的声音，但嘴闭着。加一句表情提示，否则模型会画成发呆
    const who = r.speaker || cast[0]?.name;
    const others = cast.filter((c) => c.name !== who);
    return (
      `${who ? `${who}的内心独白` : '内心独白'}，声音是他自己的但不出声，嘴唇闭合，眼神有戏、若有所思`
      + (others.length ? `，${others.map((c) => c.name).join('、')}嘴唇闭合` : '')
    );
  }
  if (kind === 'offscreen') {
    // 画外音：说话人不在这一镜画面里，画面里的人是在听
    return `说话的人不在画面里，声音来自画外，画面中的人在听、嘴唇闭合${
      r.speaker ? `（说话的是${r.speaker}）` : ''}`;
  }
  // 旁白：有台词，但声音来自画外，画面里的人照样闭嘴
  if (kind === 'voiceover' || !r.speaker) return '画外旁白，声音来自画外，画面中的人嘴唇闭合';

  // 台词太长会把提示词吃掉一大块，而口型只需要知道说的是什么、有多长
  const line = said.text.length > 26 ? `${said.text.slice(0, 26)}…` : said.text;
  const others = cast.filter((c) => c.name !== r.speaker);
  return (
    `只有${r.speaker}在说话，口型对上台词「${line}」` +
    // 这半句是正面说法：说的是别人该是什么样，而不是"不要张嘴"
    (others.length ? `，${others.map((c) => c.name).join('、')}嘴唇闭合` : '')
  );
}

/** 分镜里点名了谁。模型有时写"李队"有时写"李队长"，所以用包含匹配而不是全等。 */
/** 去掉名字后面括注的说明："我（无灵根书信摊主）" → "我" */
const bareName = (s) => String(s || '').replace(/[（(【[].*$/, '').trim();

/**
 * 分镜里写的这个名字，是设定集里的哪一个人。
 *
 * ══════════ 为什么不能只认全等 ══════════
 *
 * 设定集里的名字经常带括注 —— 「我（无灵根书信摊主）」「父亲（前宗门执事）」，
 * 那是给人看的身份说明。而分镜是模型拆的，它写的就是「我」「父亲」。
 * 只认全等的话，凡是带括注的角色**一律匹配不上**。
 *
 * 隔壁 matchScene 一直是有模糊匹配的（`includes` 双向）。同一件事两套判据，
 * 场景能对上、角色对不上，而且谁也不报错。
 *
 * ── 三级，越往下越不确定 ──
 *   ① 全等                     —— 不用想
 *   ② 去掉括注之后相等          —— 「我」对「我（无灵根书信摊主）」，完全确定
 *   ③ 互相包含，取最短的那个    —— 最后一招；最短 = 最贴
 *
 * ⚠ ② 里如果有两个人去掉括注后同名，**返回 null 而不是挑一个**。
 * 挑错人的后果是这一镜带着另一个人的脸出图，比不带更糟：不带只是不像，
 * 挑错是**像另一个人**，而看图的人只会觉得"这演员怎么串戏了"。
 */
function resolveCast(bible, name) {
  const list = bible?.characters || [];
  const q = String(name || '').trim();
  if (!q) return null;

  const exact = list.find((c) => c.name === q);
  if (exact) return exact;

  const bare = list.filter((c) => bareName(c.name) === bareName(q));
  if (bare.length === 1) return bare[0];
  if (bare.length > 1) return null; // 同名两个人，不敢替你挑

  const loose = list.filter((c) => c.name.includes(q) || q.includes(c.name));
  if (!loose.length) return null;
  return loose.reduce((best, c) => (c.name.length < best.name.length ? c : best));
}

/**
 * 这一镜有哪些人出镜。
 *
 * ⚠ **逐个解析，不许一个命中就收工。**
 *
 * 原来是这么写的：
 *   const named = (shot.characters || []).map(n => 找全等).filter(Boolean);
 *   if (named.length) return named;
 *
 * `.filter(Boolean)` 把没对上的那些**悄悄扔了**，然后只要还剩一个，
 * 就整个短路返回。真实后果（第 6 镜）：分镜写的是 ['父亲','我']，
 * 设定集里叫「我（无灵根书信摊主）」——「我」对不上被扔掉，「父亲」对上了，
 * 于是直接返回只有父亲那一个。
 *
 * 出来的图里**只有父亲一个人**，那句"塞进我手里"没有接的人。
 * 而全程不报任何错：界面显示"已带上参考图"，带的确实是参考图，
 * 只是少了一个人。
 */
export function matchCharacters(bible, shot) {
  if (!bible?.characters?.length) return [];
  const listed = (shot.characters || []).map((n) => String(n).trim()).filter(Boolean);
  if (listed.length) {
    const out = [];
    for (const n of listed) {
      const hit = resolveCast(bible, n);
      if (hit && !out.includes(hit)) out.push(hit);
    }
    // 一个都没对上才退回读描述 —— 总比一张脸都不带强
    if (out.length) return out;
  }
  const haystack = `${shot.characters?.join(' ') || ''} ${shot.description || ''} ${shot.dialogue || ''}`;
  return bible.characters.filter((c) => haystack.includes(c.name));
}

/**
 * 分镜里点了名、但设定集里找不到的那些角色。
 *
 * 这是上面那个 bug 里**最要命的部分**：对不上不会报错，只会少一张脸。
 * 而少一张脸的表现（"这一镜怎么只有一个人""他怎么又换了张脸"）
 * 看起来像模型不行，没人会想到是名字对不上。
 *
 * 所以要把它挖出来单独说 —— 见 pipeline/diagnose.js 里的 cast-unmatched。
 */
export function unmatchedCast(bible, shot) {
  if (!bible?.characters?.length) return [];
  return (shot?.characters || [])
    .map((n) => String(n).trim())
    .filter((n) => n && !resolveCast(bible, n));
}

export function matchScene(bible, shot) {
  if (!bible?.scenes?.length) return null;
  if (shot.scene) {
    const exact = bible.scenes.find((s) => s.name === shot.scene);
    if (exact) return exact;
    const fuzzy = bible.scenes.find((s) => shot.scene.includes(s.name) || s.name.includes(shot.scene));
    if (fuzzy) return fuzzy;
  }
  return bible.scenes.find((s) => (shot.description || '').includes(s.name)) || null;
}

/**
 * 这一镜要带哪些道具。
 *
 * ⚠ **手填的「关键道具」说了算，描述文本只是没填时的兜底。**
 *
 * 原来只按"道具名在描述文字里出现过"来判。两个毛病：
 *
 *   ① **关不掉。**用户在预演台上把柴刀拿掉了、把它从关键道具里删了，
 *      只要描述里还有"刀"这个字，那张道具设定图照旧会被发出去。
 *      他找不到任何地方能阻止它 —— 用户的原话是"我把道具取消了…还是不行，
 *      他一下给我喂了9张图"。
 *   ② **和别处判据不一致。**「道具消失又回来」那条连续性检查用的是
 *      shot.props（手填的那份），而参考图用的是字符串匹配。
 *      同一件事两套判据，迟早互相矛盾，而矛盾时谁也不报错。
 *
 * shot.props 界面上写着"这一镜画面里**看得见**的关键道具"——
 * 那正是"该不该带这张参考图"要问的问题。它非空时就用它。
 *
 * 空的时候退回字符串匹配（老行为）：多数项目没有逐镜填过道具，
 * 一刀切改成"没填就不带"会让那些项目突然少一层一致性，而且不报错。
 */
export function matchProps(bible, shot) {
  if (!bible?.props?.length) return [];
  const listed = (shot?.props || []).map((x) => String(x).trim()).filter(Boolean);
  if (listed.length) {
    const want = new Set(listed);
    return bible.props.filter((p) => want.has(p.name));
  }
  const haystack = `${shot.description || ''} ${shot.prompt || ''}`;
  return bible.props.filter((p) => haystack.includes(p.name));
}

const VERIFY_PROMPT = `你是动画制片的质检员。第一张图是**角色设定图（基准）**，第二张是**本镜成图**。

基准图是一张**三视图**：一张图里横向排着同一个人的上半身特写、全身正面、全身侧面、全身背面。
四个视角是同一个人，拿哪个视角比对由本镜的机位决定 —— 本镜是背影就比背面那一栏，
是侧脸就比侧面那一栏。**不要**因为成图只有一个视角、而基准有四个，就判成不一致。

判断第二张里的该角色，与基准相比是否是"同一个人"。重点看：发型发色、瞳色、脸型、服装款式与配色、标志性配饰。
全身入镜时还要看：下装款式与长度、鞋子、以及背对时的后脑发型和服装背面 ——
这几样过去没有基准可比，是"一转身就换了个人"最常出的地方。
不要评价构图、姿态、表情、光线 —— 那些本来就该随镜头变化。{{OUTFIT}}

严格只输出 JSON：
{"score": 0到100的整数, "verdict": "pass" 或 "fail", "issues": ["具体偏差，如 '服装配色由藏青变为墨绿'"]}

score ≥ {{THRESHOLD}} 判 pass。没有明显偏差时 issues 给空数组。`;

/**
 * 视觉复核：把成图和设定图一起交给多模态模型比对。
 *
 * 这一步会额外产生一次调用开销，但它换来的是"人设崩了能当场发现并自动重试"，
 * 而不是等全片合成完才看出第三镜换了张脸。可以在设置里关掉。
 */
/**
 * @param ignoreOutfit 基准图和本镜是**不同变体**（不同穿搭）时置真。
 *
 * 不置的话会出现一种必然失败：角色这一镜穿雨夜外套，而基准是制服那张 ——
 * 复核模型会老老实实报"服装配色不符"，分数打不上去，引擎就一直换种子重试，
 * 重到次数用尽还是不过。问题根本不在图上，在于比错了东西。
 */
export async function verifyShot({ shotImageUrl, character, threshold = 75, ignoreOutfit = false, onEvent }) {
  if (!character?.sheetUrl || !shotImageUrl) {
    return { skipped: true, reason: '缺少设定图或成图 URL' };
  }
  const routing = adapters.resolvedRouting();
  if (!routing.vision?.provider) return { skipped: true, reason: '未配置视觉模型' };

  try {
    const { text } = await adapters.chat({
      providerId: routing.vision.provider,
      model: routing.vision.model,
      system: VERIFY_PROMPT.replace('{{THRESHOLD}}', String(threshold)).replace(
        '{{OUTFIT}}',
        ignoreOutfit
          ? '\n\n**注意：这一镜里该角色换了一套装扮，基准图上是另一套。请完全忽略服装和配色的差异，' +
            '只判断脸型、五官、发型发色、瞳色、体型是不是同一个人。**'
          : ''
      ),
      user: `请比对角色「${character.name}」。设定要点：${character.appearance}`,
      images: [character.sheetUrl, shotImageUrl],
      temperature: 0,
      jsonMode: true,
      label: '一致性复核',
      timeoutMs: 90000
    });
    const parsed = extractJSON(text);
    const score = Number(parsed.score) || 0;
    const pass = parsed.verdict === 'pass' || score >= threshold;
    onEvent?.({
      type: 'verify',
      character: character.name,
      score,
      pass,
      issues: parsed.issues || []
    });
    return { skipped: false, score, pass, issues: parsed.issues || [] };
  } catch (err) {
    // 复核本身失败不能卡住生产 —— 记一笔，当作"没复核"放行
    onEvent?.({ type: 'note', message: `一致性复核跳过：${err.message}` });
    return { skipped: true, reason: err.message };
  }
}

/**
 * 带复核的出图：不合格就加大参考权重重试。
 * 重试时把种子也换掉 —— 同种子重采样大概率复现同一个错误。
 */
export async function generateConsistentImage({
  project,
  shot,
  bible,
  maxRetries = 2,
  onEvent,
  /**
   * 参考图地址过期时怎么救 —— 由调用方注入。
   *
   * 这一层自己做不了：重新签地址要用到对象存储和项目落盘，而这个模块
   * 是纯装配逻辑，不该碰 IO（碰了就没法在自检里不联网跑）。
   * 不注入就退回原样，只是过期的那张会照旧发出去然后被厂商拒掉。
   */
  refresh = null
}) {
  const routing = adapters.resolvedRouting();
  const threshold = settings.get('consistencyThreshold') ?? 75;
  const verifyEnabled = settings.get('consistencyVerify') !== false;
  const assembled = assemblePrompt(bible, shot);
  const cast = matchCharacters(bible, shot);

  /**
   * 分镜图默认**不走图生图**。
   *
   * 道理上"带着角色设定图去出这一镜"该更一致，实际不是：
   * SeedEdit 这类是**编辑**模型 —— 拿到一张图是在那张图上改，
   * 而不是照着它另画一个场景。出来的会像"被改过的角色设定图"
   * （人物居中、纯色背景还在），根本不是你要的那一镜。
   *
   * 所以默认走文生图 + 冻结描述 + 稳定种子。参考图那一层留给**出视频**
   * （首帧图 + r2v 通道），那边它是真的有用。
   * 想改这件事去「设置 → 画面规格 → 出分镜图时带哪些参考图」。
   */
  const plan = refPlan();
  const useEdit = plan.useEditModel;
  // ⚠ 先按策略筛，再去续签地址 —— 筛掉的那些没必要费一次签名
  const picked = pickRefs(
    {
      images: assembled.refImages,
      labels: assembled.refLabels,
      paths: assembled.refPaths,
      sources: assembled.refSources,
      kinds: assembled.refKinds
    },
    plan
  );
  // 过期的限时地址在这儿换掉，否则厂商只会回一句"下载不到你给的图"
  // ⚠ kinds / sources 一并传进去：refreshRefs 会筛掉发不出去的那几张，
  // 不一起筛的话，回来的下标就对不上了（详见那边的注释）
  const fresh =
    plan.send && picked.images.length && refresh
      ? await refresh({
        images: picked.images, labels: picked.labels, paths: picked.paths,
        kinds: picked.kinds, sources: picked.sources
      })
      : null;
  const baseRefs = plan.send ? (fresh?.images || picked.images) : [];
  /**
   * 哪一张代表"这个人长什么样"。只有身份通道（海螺 subject_reference、
   * 万相 ref_img）用得上它 —— 那些通道只收一张，而默认的第一张是场景图。
   */
  const faceRef = identityRef({
    images: baseRefs,
    kinds: fresh?.kinds || picked.kinds,
    sources: fresh?.sources || picked.sources
  });

  /**
   * 邻镜参考：让这一镜的光线、色调、质感和同场景的其它镜连得住。
   *
   * ⚠ 参照的是**这一场景的第一张成图**，不是上一镜 —— 详见 continuity.neighborRef。
   * 链式（1→2→3）每一步都在上一步的误差上再加一层，十镜之后参照物本身就不对了；
   * 星形（1→2, 1→3, 1→4）误差是常数。两者"每一镜都和邻镜像"的效果一样，
   * 但一个会漂，一个不会。
   *
   * 排在设定集参考图**后面**：谁是谁由设定集说了算，邻镜只负责"看起来是同一场戏"。
   * 多数厂商对首张参考图权重最高，顺序在这里是有意义的。
   */
  const neighborMode = settings.get('neighborRef') || 'scene-anchor';
  /**
   * 邻镜参考只在**编辑模型**那条路上有意义：它是拿上一张成图去"改"出这一张。
   * 走 auto/all（文生图 + 参考图）时不带它 —— 那条路上的参考图是**身份锚**，
   * 混进一张构图完全不同的邻镜图，只会让模型在两个目标之间摇摆。
   */
  const neighbor = useEdit ? continuity.neighborRef(project, shot, { mode: neighborMode }) : null;
  /**
   * 本地路径 → 模型收得下的引用（公网 URL 或 data URI）。
   *
   * 这一步在 studio.toModelRef 里，而 studio 又 import 了本模块 ——
   * 静态 import 会成环。ESM 能处理环，但环里谁先求值取决于加载顺序，
   * 出问题时是"某个函数莫名是 undefined"，极难查。
   * 延迟到**调用时**再导入就没有这个问题：那时两边都已经加载完了。
   */
  const neighborUrl = neighbor
    ? await (await import('./studio.js')).toModelRef(neighbor.path, { onEvent }).catch(() => null)
    : null;
  const refImages = neighborUrl ? [...baseRefs, neighborUrl] : baseRefs;
  if (neighbor && neighborUrl) assembled.refLabels = [...assembled.refLabels, neighbor.label];

  let attempt = 0;
  let last = null;
  const trail = [];

  while (attempt <= maxRetries) {
    const seed = assembled.seed + attempt * 977; // 换种子，别在同一个坑里反复摔
    onEvent?.({
      type: 'shot',
      shotId: shot.id,
      status: 'running',
      message: attempt === 0 ? `第 ${shot.index} 镜出图…` : `第 ${shot.index} 镜重试（第 ${attempt} 次）…`
    });

    const image = await adapters.generateImage({
      providerId: routing.image.provider,
      model: routing.image.model,
      // 只有明确打开"分镜图用图生图"时才换模型；默认 null = 用路由到的文生图模型
      editModel: useEdit ? undefined : null,

      prompt: assembled.prompt,
      negative: assembled.negative,
      // 画幅跟着项目走：同一个人手上横屏宣传片和竖屏短剧并存是常事
      aspectRatio: project.aspectRatio || null,
      seed,
      refImages,
      // 只收一张的那些身份通道用它，别让它们拿到场景图（见 identityRef）
      identityRef: faceRef,
      label: `出图 #${shot.index}`,
      onEvent
    });
    last = {
      ...image,
      seed,
      prompt: assembled.prompt,
      refLabels: refImages.length ? assembled.refLabels : [],
      // 本来有几张可用（筛之前）。界面靠它分辨"没图"和"有图没发"
      refsAvailable: (assembled.refImages || []).length,
      // 那几张分别是谁、哪张是用户传的 —— 一张都没发时这才是有用的信息
      refsAvailableLabels: assembled.refDetailed || [],
      // 到底是哪个开关拦的。不记的话界面只能猜，而猜错会把人指到另一个面板
      refBlockedHint: plan.blockedHint || ''
    };

    if (!verifyEnabled || !cast.length || !image.url) {
      return { ...last, verification: { skipped: true }, trail };
    }

    /**
     * 复核基准优先取**这一镜用的那个变体**的设定图；
     * 那一版还没出图时退回默认那版，并告诉复核模型忽略服装差异 ——
     * 否则"换了套衣服"必然被判不一致，重试到次数用尽也过不了。
     */
    const cv = variants.pickVariant(cast[0], shot);
    const baseline = cv?.sheetUrl
      ? { ...cast[0], sheetUrl: cv.sheetUrl }
      : cast[0];
    const verification = await verifyShot({
      shotImageUrl: image.url,
      character: baseline,
      threshold,
      ignoreOutfit: !cv?.sheetUrl && Boolean(cv && cv.id !== variants.DEFAULT_VARIANT_ID),
      onEvent
    });
    trail.push({ attempt, seed, score: verification.score ?? null, issues: verification.issues || [] });

    if (verification.skipped || verification.pass) {
      return { ...last, verification, trail };
    }

    onEvent?.({
      type: 'note',
      message: `第 ${shot.index} 镜一致性 ${verification.score} 分（阈值 ${threshold}）：${(verification.issues || []).join('；') || '与设定不符'}`
    });
    attempt += 1;
  }

  onEvent?.({
    type: 'note',
    message: `第 ${shot.index} 镜重试 ${maxRetries} 次仍未达标，保留最后一版并标记待人工确认`
  });
  return { ...last, verification: { pass: false, needsReview: true }, trail };
}

/** 与 studio.js 共用的 JSON 提取（模型总爱包一层代码块） */
export function extractJSON(text) {
  if (!text) throw new Error('模型没有返回内容');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error(`模型返回的不是合法 JSON：${candidate.slice(0, 200)}`);
  }
}

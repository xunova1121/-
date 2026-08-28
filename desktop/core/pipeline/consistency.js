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
  const { text } = await adapters.chat({
    providerId: routing.chat.provider,
    model: routing.chat.model,
    system: BIBLE_PROMPT,
    user: `画风要求：${style.anchor}\n\n剧本：\n${text0.slice(0, 12000)}`,
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
  const source = project.chapters?.length
    ? project.chapters.map((c) => c.script).join('\n\n').slice(0, 12000)
    : project.script;

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
  const parts = [];
  if (includeStyle && bible?.style?.anchor) parts.push(bible.style.anchor);

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
  const willSendRefs = settings.get('useEditModelForShots') === true;
  const hasRefs =
    refs.images.length > 0 && settings.get('useReferenceImages') !== false && willSendRefs;

  parts.push(shot.description || '');

  /**
   * 变体：这一镜里这个人穿哪套、这个场景是什么时段。
   * 完整描述 = 身份锚 + 这一版变的那部分，身份永远在前
   * （见 pipeline/variants.js 里为什么不能拆成两个条目）。
   */
  for (const c of cast) {
    const v = variants.pickVariant(c, shot);
    const full = variants.describeWith(c, v);
    if (hasRefs) {
      // 留三段而不是两段：第三段往往正好是服装配色，而配色是最强的身份线索之一。
      // 参考图给的是设定图（另一个姿势、另一个背景），文字仍然要把关键特征点住。
      const brief = full.split(/[，,。]/).slice(0, 3).join('，');
      parts.push(brief ? `【${c.name}】${brief}，外貌以参考图为准` : `【${c.name}】外貌以参考图为准`);
    } else {
      parts.push(`【${c.name}】${full}`);
    }
  }

  if (scene) {
    const sv = variants.pickVariant(scene, shot);
    const full = variants.describeWith(scene, sv);
    const brief = full.split(/[，,。]/).slice(0, 3).join('，');
    parts.push(`【场景·${scene.name}】${hasRefs ? brief : full}`);
  }

  for (const prop of props) {
    parts.push(`【${prop.name}】${prop.appearance}`);
  }

  /**
   * 技法卡。位置是有讲究的：紧跟画面描述，在主色调之前。
   * 越靠后的描述越容易被稀释，而机位和光线是**直接决定这张图长什么样**的，
   * 不能排在"主色调"后面陪跑。运镜类不进出图提示词 ——
   * 对一张静态图说"镜头缓慢推进"没有意义，只会占掉画面描述的权重。
   */
  const skillParts = skills.fragmentsFor(shot.skills, { target: 'image' });
  parts.push(...skillParts.look, ...skillParts.action, ...skillParts.mood);

  /**
   * 排过位的话，机位用**算出来的那句**，而不是 `camera: "中景"`。
   *
   * "中景"没有确切含义 —— 35mm 站 2 米和 85mm 站 5 米都能叫中景，
   * 而两张画完全不同（后者背景压缩、透视平）。模型每一镜自己挑一个，
   * 于是同一场戏里景别忽远忽近，看起来像"模型不稳定"，
   * 其实是我们从来没说清楚过。
   */
  const staged = previz.cameraLine(shot, cast[0]?.name);
  if (staged) parts.push(`镜头：${staged}`);
  else if (shot.camera) parts.push(`镜头：${shot.camera}`);
  if (bible?.style?.palette) parts.push(`主色调：${bible.style.palette}`);

  return {
    prompt: parts.filter(Boolean).join('，'),
    negative: bible?.style?.negative || '',
    // 镜头种子 = 角色种子（有主角时）+ 镜号偏移。
    // 完全用同一颗种子会导致每镜构图雷同，加镜号偏移既保风格又留变化。
    seed: (cast[0]?.seed ?? scene?.seed ?? 0) + (shot.index || 0),
    refImages: refs.images,
    refLabels: refs.labels,
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
    picked.push({ kind, name, url, path: localPath });
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
    labels: unique.map((r) => `${glyph[r.kind]}·${r.name}`)
  };
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
function castInFrame(bible, shot) {
  if (Array.isArray(shot?.characters)) {
    return shot.characters
      .map((n) => (bible?.characters || []).find((c) => c.name === n))
      .filter(Boolean);
  }
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
export function matchCharacters(bible, shot) {
  if (!bible?.characters?.length) return [];
  const haystack = `${shot.characters?.join(' ') || ''} ${shot.description || ''} ${shot.dialogue || ''}`;
  const named = (shot.characters || [])
    .map((n) => bible.characters.find((c) => c.name === n))
    .filter(Boolean);
  if (named.length) return named;
  return bible.characters.filter((c) => haystack.includes(c.name));
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

export function matchProps(bible, shot) {
  if (!bible?.props?.length) return [];
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
   * 想试图生图的话，「设置 → 画面规格」里有开关。
   */
  const useEdit = settings.get('useEditModelForShots') === true;
  const refsOn = settings.get('useReferenceImages') !== false;
  // 过期的限时地址在这儿换掉，否则厂商只会回一句"下载不到你给的图"
  const fresh =
    useEdit && refsOn && refresh
      ? await refresh({ images: assembled.refImages, labels: assembled.refLabels, paths: assembled.refPaths })
      : null;
  const baseRefs = !useEdit || !refsOn ? [] : (fresh?.images || assembled.refImages);

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
  const neighbor = useEdit && refsOn ? continuity.neighborRef(project, shot, { mode: neighborMode }) : null;
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
      label: `出图 #${shot.index}`,
      onEvent
    });
    last = { ...image, seed, prompt: assembled.prompt, refLabels: refImages.length ? assembled.refLabels : [] };

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

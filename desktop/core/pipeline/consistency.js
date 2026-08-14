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
    "anchor": "全片统一画风的一句话，会出现在每一条提示词开头",
    "palette": "主色调描述",
    "negative": "全片统一的负向提示词，逗号分隔"
  },
  "characters": [
    {
      "name": "角色名",
      "appearance": "冻结的外貌描述（60~90字）",
      "sheetPrompt": "用于生成该角色设定图的完整提示词：正面半身、中性表情、纯色背景、全身可辨识特征",
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

  if (shot.camera) parts.push(`镜头：${shot.camera}`);
  if (bible?.style?.palette) parts.push(`主色调：${bible.style.palette}`);

  return {
    prompt: parts.filter(Boolean).join('，'),
    negative: bible?.style?.negative || '',
    // 镜头种子 = 角色种子（有主角时）+ 镜号偏移。
    // 完全用同一颗种子会导致每镜构图雷同，加镜号偏移既保风格又留变化。
    seed: (cast[0]?.seed ?? scene?.seed ?? 0) + (shot.index || 0),
    refImages: refs.images,
    refLabels: refs.labels,
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
  const ref = (kind, item) => {
    const v = variants.pickVariant(item, shot);
    const url = v?.sheetUrl || item.sheetUrl;
    if (url) picked.push({ kind, name: variants.labelOf(item, v) || item.name, url });
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
 */
export function assembleVideoPrompt(bible, shot, { maxChars = 380, prev = null, next = null, link = null } = {}) {
  const parts = [];

  if (shot.description) parts.push(shot.description);

  // 角色只给名字 + 一句话特征，够让模型知道"画面里这个人要保持住"
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

  if (shot.camera) parts.push(shot.camera);

  // 技法卡：机位光线跟着画面走，运镜替代那句泛泛的默认运镜。
  // 选了具体运镜还保留"镜头缓慢推进"，等于给模型两条互相打架的指令。
  const sk = skills.fragmentsFor(shot.skills, { target: 'video' });
  parts.push(...sk.look, ...sk.action, ...sk.mood);
  if (sk.motion.length) parts.push(...sk.motion);
  else parts.push(shot.motion || '镜头缓慢推进');

  // ── 嘴要不要动，必须明说 ──
  //
  // 不说的话，视频模型默认会让人物讲话 —— 于是没有台词的镜头里，
  // 角色也在那儿一张一合地"瞎说"，配上无声的音轨，像默片配错了画。
  // 反过来，有台词的镜头不提醒，人物又会僵着不动。
  //
  // 判断依据是**净台词**而不是 dialogue 字段本身：
  // "（远处传来汽笛声）"写在台词字段里，那不是台词，嘴不该动。
  const said = speaker.spokenText(shot.dialogue);
  if (said.kind === 'speech') parts.push('人物在说话，口型与表情自然');
  else parts.push('人物不说话，嘴部保持闭合，不要出现说话口型');

  // 衔接约束放在最后：它是对整段的约束，不是画面内容。
  // 放前面会挤掉"演什么"的权重 —— 那才是这一镜的主语。
  parts.push(...continuity.continuityLines(shot, { prev, next, link }));

  let prompt = parts.filter(Boolean).join('，');
  // 视频模型的提示词普遍比图像模型短，超长会被截断或稀释，主动收一下
  if (prompt.length > maxChars) prompt = `${prompt.slice(0, maxChars - 1)}…`;
  return prompt;
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

判断第二张里的该角色，与基准相比是否是"同一个人"。重点看：发型发色、瞳色、脸型、服装款式与配色、标志性配饰。
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
  onEvent
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
  const refImages =
    !useEdit || settings.get('useReferenceImages') === false ? [] : assembled.refImages;

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

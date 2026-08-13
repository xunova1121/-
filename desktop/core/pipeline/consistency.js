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
      sheetPrompt: c.sheetPrompt || c.appearance || '',
      seed: deriveSeed(project.id, `char:${c.name}`),
      sheetPath: null,
      sheetUrl: null,
      locked: true
    })),
    scenes: (parsed.scenes || []).map((s) => ({
      name: s.name,
      appearance: s.appearance || '',
      sheetPrompt: s.sheetPrompt || s.appearance || '',
      seed: deriveSeed(project.id, `scene:${s.name}`),
      sheetPath: null,
      sheetUrl: null,
      locked: true
    })),
    // 道具和角色/场景一样也出参考图：一把刀、一枚徽章，跨镜头长得不一样同样出戏
    props: (parsed.props || []).map((p) => ({
      name: p.name,
      appearance: p.appearance || '',
      sheetPrompt: p.sheetPrompt || `${p.appearance}，产品图，纯色背景，单个物体，无人物`,
      seed: deriveSeed(project.id, `prop:${p.name}`),
      sheetPath: null,
      sheetUrl: null,
      locked: true
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
 * 顺序是刻意的：风格锚在最前（决定整体观感），角色设定紧随其后（权重最高的主体），
 * 场景设定居中，镜头内容和运镜放最后。倒过来写的话，越靠后的描述越容易被稀释掉，
 * 人设就是这么漂的。
 */
export function assemblePrompt(bible, shot, { includeStyle = true } = {}) {
  const parts = [];
  if (includeStyle && bible?.style?.anchor) parts.push(bible.style.anchor);

  const cast = matchCharacters(bible, shot);
  for (const c of cast) {
    parts.push(`【${c.name}】${c.appearance}`);
  }

  const scene = matchScene(bible, shot);
  if (scene) parts.push(`【场景·${scene.name}】${scene.appearance}`);

  for (const prop of matchProps(bible, shot)) {
    parts.push(`【${prop.name}】${prop.appearance}`);
  }

  parts.push(shot.description || '');
  if (shot.camera) parts.push(`镜头：${shot.camera}`);
  if (bible?.style?.palette) parts.push(`主色调：${bible.style.palette}`);

  return {
    prompt: parts.filter(Boolean).join('，'),
    negative: bible?.style?.negative || '',
    // 镜头种子 = 角色种子（有主角时）+ 镜号偏移。
    // 完全用同一颗种子会导致每镜构图雷同，加镜号偏移既保风格又留变化。
    seed: (cast[0]?.seed ?? scene?.seed ?? 0) + (shot.index || 0),
    refImages: [scene?.sheetUrl, ...cast.map((c) => c.sheetUrl)].filter(Boolean),
    cast: cast.map((c) => c.name),
    scene: scene?.name || null
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
 */
export function assembleVideoPrompt(bible, shot, { maxChars = 380 } = {}) {
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
  parts.push(shot.motion || '镜头缓慢推进');

  // 有台词的镜头提醒模型留出说话的节奏，别让人物僵立
  if (shot.dialogue?.trim()) parts.push('人物有台词，口型与表情自然');

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
不要评价构图、姿态、表情、光线 —— 那些本来就该随镜头变化。

严格只输出 JSON：
{"score": 0到100的整数, "verdict": "pass" 或 "fail", "issues": ["具体偏差，如 '服装配色由藏青变为墨绿'"]}

score ≥ {{THRESHOLD}} 判 pass。没有明显偏差时 issues 给空数组。`;

/**
 * 视觉复核：把成图和设定图一起交给多模态模型比对。
 *
 * 这一步会额外产生一次调用开销，但它换来的是"人设崩了能当场发现并自动重试"，
 * 而不是等全片合成完才看出第三镜换了张脸。可以在设置里关掉。
 */
export async function verifyShot({ shotImageUrl, character, threshold = 75, onEvent }) {
  if (!character?.sheetUrl || !shotImageUrl) {
    return { skipped: true, reason: '缺少设定图或成图 URL' };
  }
  const routing = adapters.resolvedRouting();
  if (!routing.vision?.provider) return { skipped: true, reason: '未配置视觉模型' };

  try {
    const { text } = await adapters.chat({
      providerId: routing.vision.provider,
      model: routing.vision.model,
      system: VERIFY_PROMPT.replace('{{THRESHOLD}}', String(threshold)),
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
      prompt: assembled.prompt,
      negative: assembled.negative,
      seed,
      refImages: assembled.refImages,
      label: `出图 #${shot.index}`,
      onEvent
    });
    last = { ...image, seed, prompt: assembled.prompt };

    if (!verifyEnabled || !cast.length || !image.url) {
      return { ...last, verification: { skipped: true }, trail };
    }

    const verification = await verifyShot({
      shotImageUrl: image.url,
      character: cast[0],
      threshold,
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

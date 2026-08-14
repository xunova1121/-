/**
 * 台词是谁说的。
 *
 * ── 为什么这件事必须自动做 ──
 *
 * 每条台词都要挂一个说话人，因为配音要按人取音色、字幕要按人加前缀。
 * 挂错的代价很直接：两个人对话，配音全用同一个声音，观众分不出谁在说话；
 * 或者阿澜的台词用了老周的嗓子 —— 这比画面不一致更出戏。
 *
 * 但让人一条条去选是不现实的：二十镜里有十二条台词，谁愿意点十二次下拉框。
 * 而模型拆分镜时给的 speaker 字段又**经常空着或者写错**：
 *   · 干脆不填；
 *   · 填了个设定集里没有的称呼（"周叔"，而设定集里叫"老周"）；
 *   · 把说话人写进台词里 —— dialogue = "阿澜：设备正常。" 而 speaker 空着。
 *
 * 最后那种最坑：它看起来是有说话人的，实际配音时会把"阿澜冒号设备正常"整句念出来。
 *
 * ── 所以按线索一层层往下找 ──
 *
 *   ① 台词自己带的署名     "阿澜：…" / "阿澜说：…" / "…"阿澜说 / 【阿澜】…
 *   ② 画面描述里的提示     描述里出现"阿澜低声开口"、"老周问道"
 *   ③ 这一镜只有一个人      没有第二个人可选，就是他
 *   ④ 都不成立             算旁白（而不是"随便挑出场角色里的第一个"——
 *                          那个旧的兜底逻辑是错的：两个人在场时必然一半几率挂错人）
 *
 * 找到之后**顺手把署名从台词里摘掉**，配音念的是净台词，字幕显示的也是净台词。
 *
 * ── 名字匹配为什么不能只用全等 ──
 *
 * 模型会写"周叔"、"老周头"、"澜姐"。全等匹配一律匹配不上，于是静悄悄退回旁白 ——
 * 你只会发现"配音怎么全是旁白的声音"，却不知道是名字没对上。
 * 所以先全等、再别名、最后互相包含（两个字以上才算，避免"周"匹配到"周边"）。
 */

/** 说话动词。中文里署名几乎总是跟着它们其中一个。 */
const SPEECH_VERBS = '说|道|问|答|喊|叫|吼|嘟囔|低语|开口|回答|应道|笑道|冷笑|沉声|叹道|念叨';

/** 旁白的各种写法 */
const NARRATOR = ['旁白', '画外音', 'V.O.', 'VO', 'OS'];

export function isNarrator(name) {
  const n = String(name || '').trim();
  return NARRATOR.some((x) => x.toLowerCase() === n.toLowerCase());
}

/**
 * 把一个称呼对到设定集里的角色。
 * 返回角色对象或 null。别名写在 character.aliases（数组）里。
 */
export function matchCharacter(name, characters = []) {
  const n = String(name || '').trim();
  if (!n || isNarrator(n)) return null;
  const list = characters || [];

  const exact = list.find((c) => c.name === n);
  if (exact) return exact;

  const byAlias = list.find((c) => (c.aliases || []).some((a) => String(a).trim() === n));
  if (byAlias) return byAlias;

  // "周叔" ↔ "老周"：把前后缀的称谓剥掉再比。
  // 直接做子串匹配是不行的 —— "老周"和"周叔"互相都不包含对方，
  // 而放宽到单字包含又会把"周"匹配到"周边小贩"这种完全无关的名字上。
  const core = kernel(n);
  if (core) {
    const sameCore = list.filter((c) => c.name && kernel(c.name) === core);
    // 只在**唯一**时才认。同时有"老周"和"周叔"两个人时，"周"指谁都说不准，
    // 这种情况下宁可判不出、交给上层去问模型，也不能挑一个挂上去
    if (sameCore.length === 1) return sameCore[0];
  }
  // "李队" ↔ "李队长" 这种真包含关系，两个字以上才认
  if (n.length >= 2) {
    const loose = list.find((c) => c.name && (c.name.includes(n) || n.includes(c.name)) && c.name.length >= 2);
    if (loose) return loose;
  }
  return null;
}

/** 剥掉称谓前后缀，留下真正指人的那部分："老周" / "周叔" → "周" */
function kernel(name) {
  return String(name || '')
    .trim()
    .replace(/^(?:老|小|阿|大)/, '')
    .replace(/(?:叔叔|阿姨|哥哥|姐姐|先生|女士|老师|大人|同志|队长|老板|叔|哥|姐|姨|爷|奶|婶|嫂|爹|娘|总|队)$/, '')
    .trim();
}

/**
 * 从台词文本里拆出署名和净台词。
 * 拆不出来就原样返回，`who` 为空。
 */
export function parseAttribution(dialogue) {
  const raw = String(dialogue || '').trim();
  if (!raw) return { who: '', line: '' };

  const strip = (s) =>
    String(s || '')
      .trim()
      // 摘掉整句外面的引号，不动句子中间的
      .replace(/^[“"「『]([\s\S]*)[”"」』]$/, '$1')
      .trim();

  // ① 【阿澜】台词
  let m = raw.match(/^[【\[]\s*([^】\]]{1,12})\s*[】\]]\s*[:：]?\s*([\s\S]+)$/);
  if (m) return { who: cleanName(m[1]), line: strip(m[2]) };

  // ② （阿澜）台词 / (旁白) 台词
  m = raw.match(/^[（(]\s*([^）)]{1,12})\s*[）)]\s*[:：]?\s*([\s\S]+)$/);
  if (m) return { who: cleanName(m[1]), line: strip(m[2]) };

  // ③ 阿澜：台词 / 阿澜说：台词 / 阿澜低声道：台词
  m = raw.match(/^([^\s，。！？；：:、“”"'「」]{1,10})[:：]\s*([\s\S]+)$/);
  if (m) return { who: cleanName(m[1]), line: strip(m[2]) };

  // ④ "台词"阿澜说 —— 署名在后面
  m = raw.match(new RegExp(`^[“"「『]([\\s\\S]+?)[”"」』]\\s*[，,]?\\s*([^\\s，。！？]{1,8}?)(?:${SPEECH_VERBS})`));
  if (m) return { who: cleanName(m[2]), line: strip(m[1]) };

  // ⑤ 阿澜说："台词" —— 署名在前，台词带引号
  m = raw.match(new RegExp(`^([^\\s，。！？：:]{1,8}?)(?:${SPEECH_VERBS})[：:，,]?\\s*[“"「『]([\\s\\S]+?)[”"」』]`));
  if (m) return { who: cleanName(m[1]), line: strip(m[2]) };

  return { who: '', line: strip(raw) };
}

/** 去掉署名尾巴上的说话动词和语气修饰："阿澜低声道" → "阿澜" */
function cleanName(name) {
  let n = String(name || '').trim();
  n = n.replace(new RegExp(`(?:${SPEECH_VERBS})$`), '');
  // "阿澜低声"、"老周冷冷地" 这类修饰
  n = n.replace(/(?:低声|大声|冷冷地?|轻轻地?|缓缓|急忙|连忙|又|才|便|则)$/, '');
  return n.trim();
}

/**
 * 从画面描述里找"谁在说话"的线索。
 * 只认**角色名紧跟说话动词**的写法，避免把"阿澜看着老周说话的样子"里的老周认成说话人。
 */
export function cueFromDescription(description, characters = []) {
  const text = String(description || '');
  if (!text) return null;
  for (const c of characters || []) {
    if (!c?.name) continue;
    const names = [c.name, ...(c.aliases || [])].filter(Boolean);
    for (const n of names) {
      // 名字后面最多隔两个字（"低声"、"冷冷"）就得出现说话动词
      const re = new RegExp(`${escapeRe(n)}.{0,3}?(?:${SPEECH_VERBS})`);
      if (re.test(text)) return c;
    }
  }
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 这一镜的台词该挂给谁。
 *
 * 返回 { speaker, line, by, confident }：
 *   speaker   角色名；旁白是空字符串（和 shot.speaker 的约定一致）
 *   line      摘掉署名后的净台词
 *   by        依据 —— 界面要能说清楚"凭什么挂给他"
 *   confident 有明确线索为 true；靠兜底猜出来的为 false（这些交给模型再判一次）
 */
export function resolve(project, shot, { trustExisting = true } = {}) {
  const chars = project?.bible?.characters || [];
  const { who, line } = parseAttribution(shot?.dialogue);
  const out = (speaker, by, confident) => ({ speaker, line, by, confident });

  if (!String(shot?.dialogue || '').trim()) return out('', 'no-dialogue', true);

  // 台词字段里写的是音效/提示（"（远处传来汽笛声）"）——
  // 它压根不是台词，不该有说话人，更不该为它去问模型
  if (spokenText(shot.dialogue).kind !== 'speech') return out('', 'sound-cue', true);

  // 手选过的一律不动 —— 包括手动选成旁白。
  // 少了这一条，"我特意选了旁白"会被下面的线索推翻，而且推翻得毫无提示
  if (shot?.speakerBy === 'manual') {
    const manual = matchCharacter(shot.speaker, chars);
    return out(manual?.name || '', manual ? 'manual' : 'manual-narrator', true);
  }

  // ① 已经标好的（模型填的或者人手选的）。能对上设定集才算数 ——
  // 对不上的称呼继续往下找，而不是静悄悄退回旁白
  if (trustExisting && String(shot?.speaker || '').trim()) {
    const hit = matchCharacter(shot.speaker, chars);
    if (hit) return out(hit.name, 'existing', true);
    if (isNarrator(shot.speaker)) return out('', 'narrator-marked', true);
  }

  // ② 台词自己带的署名
  if (who) {
    if (isNarrator(who)) return out('', 'narrator-marked', true);
    const hit = matchCharacter(who, chars);
    if (hit) return out(hit.name, 'dialogue-tag', true);
  }

  // ③ 画面描述里的提示
  const cue = cueFromDescription(shot?.description, chars);
  if (cue) return out(cue.name, 'description-cue', true);

  // ④ 这一镜只有一个人在场，没有第二个人可选
  const present = (shot?.characters || []).map((n) => matchCharacter(n, chars)).filter(Boolean);
  if (present.length === 1) return out(present[0].name, 'only-one', true);

  // ⑤ 都不成立。**不猜**"出场角色里的第一个" —— 两个人在场时那是一半几率挂错人。
  // 挂成旁白至少是个说得清的默认，而且 confident=false 会让它进模型复判那一批。
  return out('', present.length > 1 ? 'ambiguous' : 'fallback-narrator', false);
}

/**
 * 这一镜到底要不要出声、出声念什么。
 *
 * ── "没有台词还瞎说" ──
 *
 * 台词字段里经常塞的不是台词：
 *   "（远处传来汽笛声）"  —— 音效提示
 *   "【无】"、"—"         —— 占位
 *   "（低声）设备正常"    —— 前半截是表演提示
 * 直接丢给 TTS，第一种会被一字不落地念出来 —— 画面里没人张嘴，
 * 声音里却在念"远处传来汽笛声"，这就是"没台词还瞎说"。
 *
 * ── "有台词还说不清楚" ──
 *
 * 署名和提示没摘干净："阿澜：设备正常。" 会被念成"阿澜冒号设备正常"；
 * "设备正常（顿了顿）后面呢" 会把"顿了顿"念出来。
 * 摘干净之后念的才是净台词。
 *
 * 返回 kind：speech = 真台词，该配音；sound = 音效/提示，不配音也不做口型；
 * empty = 什么都不剩。
 */
export function spokenText(dialogue) {
  const raw = String(dialogue || '').trim();
  if (!raw) return { text: '', kind: 'empty', dropped: [] };

  const { line } = parseAttribution(raw);
  const dropped = [];

  // 整句都在括号里 → 这是音效或动作提示，不是台词
  if (/^[（(【\[][\s\S]*[）)】\]]$/.test(line.trim())) {
    return { text: '', kind: 'sound', dropped: [line.trim()] };
  }

  let text = line;
  // 摘掉任何位置的括注：台词字段里的括号内容几乎总是表演提示
  text = text.replace(/[（(][^）)]{0,20}[）)]/g, (m) => (dropped.push(m), ''));
  text = text.replace(/[【\[][^】\]]{0,20}[】\]]/g, (m) => (dropped.push(m), ''));
  // 音效标记
  text = text.replace(/^(?:SFX|音效|画外音效)\s*[:：]\s*/i, (m) => (dropped.push(m), ''));
  // 占位符
  if (/^(?:无|没有|—+|-+|\.+|。+)$/.test(text.trim())) {
    return { text: '', kind: 'sound', dropped: [text.trim()] };
  }
  // 一连串省略号会让不少 TTS 卡顿或者硬念"点点点"
  text = text.replace(/[.．。]{3,}/g, '……').replace(/…{3,}/g, '……');
  text = text.replace(/\s+/g, ' ').trim();

  if (!text) return { text: '', kind: 'sound', dropped };
  return { text, kind: 'speech', dropped };
}

export const BY_LABELS = {
  existing: '已标注',
  'dialogue-tag': '台词里带的署名',
  'description-cue': '画面描述里的提示',
  'only-one': '这一镜只有他一个人',
  'narrator-marked': '明确标了旁白',
  ambiguous: '在场不止一个人，看不出是谁',
  'fallback-narrator': '没有线索，按旁白算',
  model: '模型按上下文判的',
  manual: '你手选的',
  'manual-narrator': '你手选的旁白',
  'no-dialogue': '没有台词',
  'sound-cue': '这条是音效/提示，不是台词'
};

/** 全片跑一遍（纯函数，不写盘）。返回每镜的判定，供上层决定写不写。 */
export function bindAll(project, { trustExisting = true } = {}) {
  return (project?.shots || [])
    .filter((s) => String(s.dialogue || '').trim())
    .map((s) => ({ id: s.id, index: s.index, ...resolve(project, s, { trustExisting }) }));
}

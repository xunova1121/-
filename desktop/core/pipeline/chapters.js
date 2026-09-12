/**
 * 章节拆分 —— 长篇内容的必要前提。
 *
 * 为什么长篇非拆不可：
 *   · 上下文     十万字塞不进任何模型；硬塞会丢细节，剧情就散了
 *   · 可恢复性   几百个分镜一次跑完不现实，中途失败重来的代价无法接受
 *   · 成本控制   按章跑能随时叫停，看完第一章的效果再决定要不要继续烧
 *
 * 为什么设定集**不能**跟着拆：
 *   人设一旦按章各自生成，第二章的主角就换了张脸。所以设定集挂在项目上，
 *   全片唯一，所有章节共享 —— 这正是一致性引擎在长篇上的延伸。
 *
 * 镜号做全局编号（章序 × 1000 + 章内序），既保证文件名不撞，
 * 也让"第 3 章第 12 镜"能一眼从 3012 认出来。
 */

/** 常见的章节标题写法。顺序有讲究：先匹配最明确的，再退到宽松的。 */
const CHAPTER_PATTERNS = [
  /^\s*第\s*[一二三四五六七八九十百千零〇\d]+\s*[章回节幕]\s*.*$/gm,
  /^\s*Chapter\s+\d+.*$/gim,
  /^\s*#{1,3}\s+.+$/gm // Markdown 标题
];

/** 一章大致多少字比较合适：够撑起情节，又不至于超上下文 */
const TARGET_CHARS = 3000;
const MIN_CHARS = 800;

/**
 * 自动拆章。
 * 优先认作者自己写的章节标题；找不到就按段落攒到目标字数再切 ——
 * 硬按字数切会把一段对话拦腰截断，攒段落至少能切在段落边界上。
 */
export function autoSplit(script, { targetChars = TARGET_CHARS } = {}) {
  const text = String(script || '').trim();
  if (!text) return [];

  for (const pattern of CHAPTER_PATTERNS) {
    pattern.lastIndex = 0;
    const marks = [...text.matchAll(pattern)];
    // 只认出一个标题说明它多半是书名而不是章节标题，不算数
    if (marks.length >= 2) {
      const chunks = [];
      for (let i = 0; i < marks.length; i++) {
        const start = marks[i].index;
        const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
        const body = text.slice(start, end).trim();
        if (body) chunks.push({ title: marks[i][0].trim().slice(0, 60), script: body });
      }
      return numbered(chunks);
    }
  }

  // 没有章节标题：按空行分段，攒够字数就切一章
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  const chunks = [];
  let buffer = [];
  let size = 0;

  for (const p of paragraphs) {
    buffer.push(p);
    size += p.length;
    if (size >= targetChars) {
      chunks.push({ title: '', script: buffer.join('\n\n') });
      buffer = [];
      size = 0;
    }
  }
  if (buffer.length) {
    // 尾巴太短就并进上一章，避免出现一个只有两行的"章节"
    if (chunks.length && size < MIN_CHARS) {
      chunks[chunks.length - 1].script += `\n\n${buffer.join('\n\n')}`;
    } else {
      chunks.push({ title: '', script: buffer.join('\n\n') });
    }
  }

  return numbered(chunks);
}

/**
 * 只按**章节标题**切，不按字数兜底。
 *
 * ── 和 autoSplit 的分工 ──
 *
 * autoSplit 是"给我一整本书，想办法切成章"：认不出标题就按字数攒。
 * 那个兜底在整本书上是对的，在**追加**这个场景里是错的 ——
 * 人贴的是"接下来这几章"，一次贴三章就该出三章；
 * 而贴一章长的（三千字以上）不该被拦腰劈成两半，那不是他要的。
 *
 * 所以这里只认标题：认出 ≥2 个就按标题切，否则整段算一章。
 *
 * ⚠ "只认出一个标题就不算数"那条规矩在这儿**不适用**。
 * 那条是为了防止把书名当章节标题，而追加时贴进来的第一行
 * 本来就极可能是「第二章 出海」—— 拿它当标题正是对的。
 */
export function splitByHeadings(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  for (const pattern of CHAPTER_PATTERNS) {
    pattern.lastIndex = 0;
    const marks = [...raw.matchAll(pattern)];
    if (marks.length < 2) continue;
    const out = [];
    for (let i = 0; i < marks.length; i += 1) {
      const start = marks[i].index;
      const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
      const body = raw.slice(start, end).trim();
      if (body) out.push({ title: marks[i][0].trim().slice(0, 60), script: body });
    }
    if (out.length >= 2) return out;
  }
  return [{ title: '', script: raw }];
}

/**
 * 把长文切成一个个窗口，交给模型逐段判断断章点。
 *
 * 十万字塞不进任何模型，所以只能分段问。**窗口之间要重叠**：
 * 断章点正好落在窗口边界上时，两边都只看到半截，谁也认不出来。
 * 重叠一段就能保证每个位置至少被完整看过一次。
 */
export function windowsOf(text, { size = 8000, overlap = 800 } = {}) {
  const s = String(text || '');
  if (!s) return [];
  if (s.length <= size) return [{ start: 0, end: s.length, text: s }];

  const out = [];
  let start = 0;
  const step = Math.max(1, size - overlap);
  while (start < s.length) {
    const end = Math.min(s.length, start + size);
    out.push({ start, end, text: s.slice(start, end) });
    if (end >= s.length) break;
    start += step;
  }
  return out;
}

/**
 * 按"锚句"切章。
 *
 * 为什么让模型回**原文片段**而不是字符位置：模型数不准字数。
 * 让它报"第 12480 个字符处断章"，得到的数字基本是错的；
 * 让它回"新的一章从『三日后，渡口起了雾』这句开始"，
 * 我们自己 indexOf 一下就精确了 —— 把模型不擅长的事留给代码。
 *
 * 纯函数，不依赖模型，所以这段逻辑能脱离网络单独测。
 */
export function splitAtAnchors(script, anchors = [], { minChars = MIN_CHARS } = {}) {
  const text = String(script || '').trim();
  if (!text) return [];

  const points = [];
  for (const a of anchors) {
    const quote = String(a?.anchor || '').trim();
    if (quote.length < 4) continue; // 太短的片段会命中一堆无关位置
    const at = text.indexOf(quote);
    // 找不到就丢掉：模型偶尔会"顺手润色"引文，那种锚点不能用，
    // 与其猜一个位置，不如少切一刀
    if (at <= 0) continue;
    points.push({ at, title: String(a.title || '').trim(), summary: String(a.summary || '').trim() });
  }

  points.sort((x, y) => x.at - y.at);

  // 去重 + 去掉挨得太近的：重叠窗口会把同一个断点报两次
  const kept = [];
  for (const p of points) {
    const prev = kept[kept.length - 1];
    if (prev && p.at - prev.at < minChars) continue;
    kept.push(p);
  }
  if (!kept.length) return [];

  const chunks = [];
  let cursor = 0;
  let pending = { title: '', summary: '' };
  for (const p of kept) {
    const body = text.slice(cursor, p.at).trim();
    if (body) chunks.push({ title: pending.title, summary: pending.summary, script: body });
    cursor = p.at;
    pending = { title: p.title, summary: p.summary };
  }
  const tailBody = text.slice(cursor).trim();
  if (tailBody) {
    // 尾巴太短就并进上一章，避免出现一个只有两行的"章节"
    if (chunks.length && tailBody.length < minChars) {
      chunks[chunks.length - 1].script += `\n\n${tailBody}`;
    } else {
      chunks.push({ title: pending.title, summary: pending.summary, script: tailBody });
    }
  }
  return numbered(chunks);
}

function numbered(chunks) {
  return chunks.map((c, i) => ({
    id: `ch-${String(i + 1).padStart(2, '0')}`,
    index: i + 1,
    title: c.title || `第 ${i + 1} 章`,
    // 模型分章时顺带给的一句话梗概。按字数切没有这个，留空
    summary: c.summary || '',
    script: c.script,
    chars: c.script.length,
    stageStatus: { script: 'pending', assets: 'pending', video: 'pending', voice: 'pending', compose: 'pending' },
    outputs: {}
  }));
}

/** 全局镜号：章序 × 1000 + 章内序。3012 一眼看出是第 3 章第 12 镜。 */
export function globalShotIndex(chapterIndex, shotIndex) {
  return chapterIndex > 0 ? chapterIndex * 1000 + shotIndex : shotIndex;
}

export function shotIdFor(chapterId, shotIndex) {
  const suffix = String(shotIndex).padStart(3, '0');
  return chapterId ? `${chapterId}-shot-${suffix}` : `shot-${suffix}`;
}

/** 长到什么程度才值得分章。低于这个字数分章只是徒增操作步骤。 */
export const LONG_FORM_THRESHOLD = 6000;

export function suggestsChapters(script) {
  const text = String(script || '');
  if (text.length >= LONG_FORM_THRESHOLD) return true;
  // 明确写了章节标题的，哪怕短也按作者意图分
  for (const pattern of CHAPTER_PATTERNS) {
    pattern.lastIndex = 0;
    if ([...text.matchAll(pattern)].length >= 2) return true;
  }
  return false;
}

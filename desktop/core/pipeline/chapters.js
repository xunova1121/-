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

function numbered(chunks) {
  return chunks.map((c, i) => ({
    id: `ch-${String(i + 1).padStart(2, '0')}`,
    index: i + 1,
    title: c.title || `第 ${i + 1} 章`,
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

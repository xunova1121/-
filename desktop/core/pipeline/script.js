/**
 * 剧本体检与整理 —— 在整条流水线开跑**之前**，把剧本本身的毛病挑出来。
 *
 * ── 为什么值得单独一步 ──
 *
 * 剧本是整条流水线唯一的输入。它里面的毛病不会停在这一步，
 * 会一路往下走，而且越往下越贵、越难看出来：
 *
 *   台词里的英文引号   拆大纲、拆分镜时原样抄进 JSON 字符串 → 整步解析失败
 *                     （用户真机上连撞两次：position 180、position 924）
 *   错别字             会被抄进台词，配音那一步照着念出来
 *   太长               大纲那一步只看得到前一万多字，后半本悄悄消失
 *
 * 三样都是**跑之前几秒钟就能查出来**的事，跑完再发现要重跑一遍，
 * 而重跑一遍是几分钟加一次钱。
 *
 * ── 分成"免费的"和"要花钱的"两层 ──
 *
 *   scan()   纯本地，零成本，保存剧本时就跑。查得出引号、长度、该不该分章。
 *   模型那层  只用来挑错别字 —— 那件事本地做不了。要花钱，所以得人点。
 *
 * ⚠ 模型那层回的是**一串改动**，不是整篇重写。三个原因：
 *
 *   1. 整篇重写的输出长度 = 剧本长度，长剧本必然撞输出上限，写到一半断掉。
 *   2. 重写完没人看得出它到底动了哪儿 —— 它顺手"润色"掉一句台词，
 *      你要等配音出来才发现。
 *   3. 一串改动可以逐条摊开让人勾，和大纲那边「商量着改」是同一个道理：
 *      "模型建议"和"实际改动"必须是两件事。
 */

/** 剧本长到该分章的门槛。和 smartSplitChapters 的默认目标字数对齐 */
export const CHAPTER_THRESHOLD = 3000;

/**
 * 会让 JSON 当场解析失败的字符。
 *
 * ⚠ 只列**真的会出事**的那几个。
 * 把全角引号、破折号之类一起报出来的话，一份正常剧本能报出上百条，
 * 而人看到上百条告警的第一反应是把整个功能关掉 —— 那就等于没有。
 */
const RISKY = [
  {
    id: 'dquote',
    re: /"/g,
    what: '英文双引号 "',
    why: '台词里的 " 会被原样抄进 JSON 字符串，让拆大纲、拆分镜整步解析失败',
    fix: '换成中文的「」'
  },
  {
    id: 'backslash',
    re: /\\/g,
    what: '反斜杠 \\',
    why: 'JSON 字符串里 \\ 是转义符，抄进去会让后面那个字符被吃掉或者直接解析失败',
    fix: '删掉，或者换成别的写法'
  }
];

/** 一段文字在第几行第几列（给人看的定位，从 1 开始） */
function whereAt(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const col = index - (before.lastIndexOf('\n') + 1) + 1;
  return { line, col };
}

/**
 * 体检：纯本地，零成本。
 *
 * 回的是**事实**，不是判断 —— 该不该分章、要不要改引号，都由人决定。
 */
export function scan(script) {
  const text = String(script || '');
  const chars = text.replace(/\s/g, '').length;

  const risky = [];
  for (const rule of RISKY) {
    rule.re.lastIndex = 0;
    const hits = [];
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (hits.length < 20) {
        const at = whereAt(text, m.index);
        hits.push({
          ...at,
          // 前后各截十几个字，人一眼能认出是哪一句
          around: text.slice(Math.max(0, m.index - 14), m.index + 14).replace(/\n/g, ' ')
        });
      }
      // 空匹配保护：正则写错时 exec 会原地打转
      if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1;
    }
    if (hits.length) {
      rule.re.lastIndex = 0;
      const total = (text.match(rule.re) || []).length;
      risky.push({ id: rule.id, what: rule.what, why: rule.why, fix: rule.fix, count: total, hits });
    }
  }

  const needChapters = chars > CHAPTER_THRESHOLD;
  const suggestChapters = needChapters ? Math.ceil(chars / CHAPTER_THRESHOLD) : 0;

  const notes = [];
  if (!text.trim()) notes.push('剧本是空的 —— 后面每一步都跑不了。');
  for (const one of risky) {
    notes.push(`有 ${one.count} 处${one.what}：${one.why}。${one.fix}。`);
  }
  if (needChapters) {
    notes.push(
      `全文 ${chars} 字，超过一次能好好处理的量（${CHAPTER_THRESHOLD} 字）——`
      + `建议先分成 ${suggestChapters} 章左右，后面每一步都能按章单独跑，`
      + '断在哪一章都不用从头再来。'
    );
  }

  return { chars, risky, needChapters, suggestChapters, notes, clean: !risky.length && !needChapters };
}

/**
 * 把模型给的一串改动落到剧本上。
 *
 * ⚠ 一条改动只有在 find **在原文里唯一出现**时才做。
 *
 * 出现零次说明模型记错了（或者顺手"润色"了引文），出现多次说明它没说清
 * 要改哪一处 —— 两种都不能猜。猜错的代价是**改了一句你没看的台词**，
 * 而这种错在成片出来之前完全看不见。
 */
export function applyFixes(script, fixes = []) {
  let text = String(script || '');
  const applied = [];
  const refused = [];

  for (const fix of Array.isArray(fixes) ? fixes : []) {
    const find = String(fix?.find ?? '');
    const replace = String(fix?.replace ?? '');
    if (!find) { refused.push({ fix, why: '没说要改哪一段' }); continue; }
    if (find === replace) { refused.push({ fix, why: '改前改后一模一样' }); continue; }

    let n = 0;
    let at = text.indexOf(find);
    const first = at;
    while (at !== -1) { n += 1; at = text.indexOf(find, at + find.length); }

    if (n === 0) { refused.push({ fix, why: `原文里找不到「${find.slice(0, 20)}」` }); continue; }
    if (n > 1) { refused.push({ fix, why: `原文里有 ${n} 处「${find.slice(0, 20)}」，说不清改哪一处` }); continue; }

    text = text.slice(0, first) + replace + text.slice(first + find.length);
    applied.push(fix);
  }

  return { script: text, applied, refused };
}

/**
 * 摊给人看的一条改动：改之前是什么、改之后是什么。
 *
 * ⚠ 必须两边都说。只说"第 3 行改成…"，人没法判断该不该勾 ——
 * 和大纲那边「60 → 120」是同一条规矩。
 */
export function describeFix(fix) {
  const kind = { typo: '错别字', quote: '引号', punct: '标点', other: '' }[fix?.kind] || '';
  const head = kind ? `${kind}：` : '';
  return `${head}「${String(fix?.find || '').slice(0, 40)}」→「${String(fix?.replace || '').slice(0, 40)}」`
    + (fix?.why ? `（${String(fix.why).slice(0, 40)}）` : '');
}

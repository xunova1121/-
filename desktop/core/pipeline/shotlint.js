/**
 * 分镜体检 —— 在花钱出图之前，先把"注定会画错"的那几镜挑出来。
 *
 * ── 为什么需要它 ──
 *
 * 用户报过一个场面：老师坐在办公室，听到敲门，说"请进"，客人推门进来，然后坐下。
 * 出来的片子是：**门本来就开着**，有敲门声，老师在说话。整场戏的逻辑是反的。
 *
 * 这不是模型不行，是分镜写错了，而且错得很典型：
 *
 *   ① 一镜塞了四件事    —— 每镜只有一张静止首帧图，一张图画不出一串先后发生的事
 *   ② "敲门声"写进了画面 —— 出图模型画不出声音，就去画那个声音最像的东西：一扇开着的门
 *   ③ 写的是动作的终点   —— "客人推门进来"出的图是人已经站在屋里，视频就没得动了
 *
 * 三条都是**看文字就能发现**的，不需要等图出来。而等图出来才发现，
 * 一镜的钱已经花掉了，重出还要再花一次。
 *
 * ── 这里只报，不改 ──
 *
 * 有很强的诱惑去自动把"敲门声"从画面描述里删掉。不做，原因有两个：
 * 一是括号里的东西不一定都是音效（"（二十年前）"是时间提示，删了就丢了信息）；
 * 二是**悄悄改用户的文字**这件事本身就不该做 —— 他会看着一句自己没写过的话，
 * 想不明白哪里来的。报出来，让他自己决定拆成几镜。
 */

/** 只听得见、看不见的东西。写进画面描述里，出图模型只能瞎画 */
const SOUND_WORDS = [
  '敲门声', '脚步声', '开门声', '关门声', '汽笛', '铃声', '手机响', '电话响',
  '雷声', '雨声', '风声', '哭声', '笑声', '喊声', '尖叫', '枪声', '爆炸声',
  '音乐响起', '响起', '传来.{0,4}声', '.{1,4}声传来', '听到', '听见', '声音'
];

/** 这些词一出现，多半是"然后又发生了什么" —— 一镜装不下 */
const SEQUENCE_WORDS = ['然后', '接着', '随后', '之后', '紧接着', '先.{1,8}再', '一边.{1,8}一边'];

/**
 * 动作已经做完了。首帧图会画成终点，视频就没得演了。
 *
 * 只收**动作完成**的说法，不收"已经""之后"这种泛词 ——
 * "桌上已经堆满文件"是个静态状态，完全正常，报它就是噪音。
 * 而一个乱报的检查等于没有检查：人看两次假警报之后就再也不看了。
 */
const COMPLETED_WORDS = ['走了进来', '推门进来', '走进来', '坐了下来', '坐下后', '说完', '完毕', '结束后'];

const re = (list) => new RegExp(`(${list.join('|')})`);

/**
 * 一镜里装了几件事。
 *
 * 用"动词短句"数：句号、逗号、顿号切开之后，含动词的段落数。
 * 数不准，但方向是对的 —— 这里要的是"值不值得看一眼"，不是精确判定。
 * 宁可多报几镜让人扫一眼，也不要漏掉那个会毁掉整场戏的。
 */
function beatsOf(text) {
  return String(text || '')
    .split(/[，,。；;、]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3).length;
}

/**
 * 体检一镜。返回若干条问题，没问题就是空数组。
 *
 * 每条都带 fix —— 只说"这里不对"是没用的，人下一秒就要问"那该怎么写"。
 */
export function lintShot(shot) {
  const issues = [];
  const desc = String(shot?.description || '');
  if (!desc.trim()) return issues;

  const soundHit = desc.match(re(SOUND_WORDS));
  if (soundHit) {
    issues.push({
      kind: 'sound-in-frame',
      severity: 'high',
      what: `画面描述里写了「${soundHit[1]}」`,
      why: '出图模型画不出声音，它会去画那个声音最像的东西 —— "敲门声"最常见的下场是画出一扇**开着的门**，而这一镜的前提恰恰是门还关着。',
      fix: '把这句挪到「画外音效」栏，画面描述里只留看得见的东西。'
    });
  }

  const seqHit = desc.match(re(SEQUENCE_WORDS));
  const beats = beatsOf(desc);
  /**
   * 两条路各管一种情况：
   *   有"然后""接着"     —— 明说了是先后两件事，一条就够，不管写了几段
   *   段落数 ≥ 5         —— 没有连接词但一口气写了一长串
   *
   * 纯数段落的门槛定得比直觉高一档。一句丰满的画面描述本来就会有三四个分句
   *（"老师伏在桌前，台灯的光落在作业本上，窗外是深夜"），
   * 按 4 报的话每份分镜表都会红一片 —— 然后没人再看它。
   */
  if (seqHit || beats >= 5) {
    issues.push({
      kind: 'too-many-beats',
      severity: 'high',
      what: seqHit ? `画面描述里有「${seqHit[1]}」，这是两件先后发生的事` : `这一镜一口气写了 ${beats} 段，多半塞了好几件事`,
      why: '每一镜只拿得到**一张静止的首帧图**。一张图画不出一串先后发生的事，模型只能挑一个瞬间画，剩下的全丢。',
      fix: '拆成几镜，一镜一个动作。「听到敲门」「说请进」「门被推开」「客人坐下」是四镜。'
    });
  }

  const doneHit = desc.match(re(COMPLETED_WORDS));
  if (doneHit) {
    issues.push({
      kind: 'end-state',
      severity: 'normal',
      what: `写的是动作做完之后的样子（「${doneHit[1]}」）`,
      why: '首帧图是这一镜的**起点**。写"客人推门进来"，出的图是人已经站在屋里 —— 视频从那儿开始就没得动了。',
      fix: '改成正在发生的一瞬：「门把手正在转动，门开了一条缝」。'
    });
  }

  return issues;
}

/** 体检整份分镜表。只回有问题的那几镜 */
export function lintShots(shots = []) {
  return shots
    .map((s) => ({ id: s.id, index: s.index, issues: lintShot(s) }))
    .filter((r) => r.issues.length);
}

/**
 * 把体检结果说成人话，一镜一行。
 *
 * 全说完会刷屏（二十镜可能报出四十条），所以只详细展开前几镜，
 * 剩下的报个数 —— 看到前三条就已经知道是哪类毛病了。
 */
export function summarize(results, { detail = 3 } = {}) {
  if (!results.length) return null;
  const lines = results.slice(0, detail).map((r) => {
    const parts = r.issues.map((i) => `${i.what} —— ${i.fix}`);
    return `第 ${r.index} 镜：${parts.join('；')}`;
  });
  const rest = results.length - Math.min(detail, results.length);
  return (
    `${results.length} 镜有问题（出图之前改掉，比出完再重出便宜）：\n` +
    lines.join('\n') +
    (rest > 0 ? `\n…另外还有 ${rest} 镜，到「分镜」页逐个看` : '')
  );
}

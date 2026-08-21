/**
 * 自动剪辑 —— 给每段视频挑一个**入点**，而不是永远从第 0 秒开始切。
 *
 * ── 补的是哪个洞 ──
 *
 * 图生视频有一个几乎所有厂商都有的毛病：**开头那零点几秒是不动的**。
 * 模型拿到首帧之后要"起势"，前几帧基本是首帧的复制，然后才开始动。
 *
 * 一段这样是察觉不到的。二十段连起来，每一镜开头都顿一下，整部片子就有一种
 * 说不上来的黏滞感 —— 而逐段看每一段都没问题，这正是最难自己发现的那类。
 *
 * 而合成那一步原来永远切 `[0, 时长]`：把最该扔的那一截原封不动留着，
 * 反倒把结尾真正在动的部分裁掉了。
 *
 * ── 怎么找那个入点 ──
 *
 * 每隔一小段取一帧，算相邻两帧的差（感知哈希的汉明距离）。开头那些"差≈0"的
 * 就是没动的帧，跳过它们。第一个动起来的地方就是入点。
 *
 * 用哈希而不是像素差：哈希对压缩噪点和整体亮度变化不敏感，
 * 而那两样在视频里到处都是 —— 拿像素差判的话，一段完全静止的画面
 * 也会因为编码噪声显示出"在动"。
 *
 * ── 这个模块不碰 FFmpeg，也不碰盘 ──
 *
 * 取帧和算哈希都由调用方注入。所以它能在自检里用几个数组跑完，
 * 而"入点挑错了"是那种肉眼很难复核的错 —— 它必须被大量而便宜地验证。
 */

/**
 * 采样间隔（秒）。
 *
 * 0.2 秒是权衡出来的：再密一倍，取帧的开销翻倍而结论几乎不变；
 * 再稀一倍，就分不清"停了 0.3 秒"和"停了 0.6 秒"，而这两者观感差别很明显。
 */
export const STEP = 0.2;

/**
 * "没动"的判据是**相对这一段自己的运动量**，不是一个绝对数。
 *
 * ⚠ 第一版写的是绝对阈值（汉明距离 ≤ 3 算静止），拿真视频一跑就露馅：
 * 一段从第一帧就在动的片子，相邻帧差只有 **2~4** —— 低于那个阈值，
 * 于是整段被判成"开头一秒没动"，白白剪掉一秒真内容。
 *
 * 差值的量级取决于画面内容和采样分辨率（我们缩到 64 像素宽算哈希），
 * 没有一个数能同时适配"夜戏里一只手慢慢抬起"和"打斗"。
 *
 * 而真正的废头有一个不依赖量级的特征：**它比这一段本身的运动量小得多**。
 * 所以拿这一段自己的中位数当基准，低于四分之一的才算没动。
 * 再压一个下限 1：全片纹丝不动时中位数是 0，没有下限的话一帧都判不出来。
 */
export const STILL_RATIO = 0.25;
export const STILL_FLOOR = 1;

function median(list) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 最多从头上砍掉多少秒。
 *
 * 这是一条**安全带**，不是参数。万一判断出错（比如整段本来就是一个静止空镜），
 * 没有它就会把整段砍光。宁可少剪一点，也不要剪掉真内容 ——
 * 多留半秒观众未必看得出来，剪掉了却是实打实的内容损失。
 */
export const MAX_HEAD = 1.0;

/**
 * 从一串相邻帧差里，算出该从第几秒进。
 *
 * frames 是按时间顺序的哈希数组，第 i 个对应 `i * step` 秒。
 */
export function headTrim(diffs, { step = STEP, max = MAX_HEAD } = {}) {
  const floor = Math.max(STILL_FLOOR, median(diffs) * STILL_RATIO);
  let dead = 0;
  for (const d of diffs) {
    if (d >= floor) break;
    dead += 1;
  }
  const seconds = dead * step;
  // 整段都没动（静止空镜）——那就是它本来的样子，一帧都不剪
  if (dead >= diffs.length) return 0;
  return Math.min(seconds, max);
}

/**
 * 这一段该切哪一段：`{ in, out, deadHead }`，单位秒。
 *
 * @param hashes  按时间顺序采样出来的帧哈希
 * @param total   这一段实际多长
 * @param want    这一镜要多长（分镜表里那个数）。给 0 表示不裁，只去头
 */
export function pickWindow(hashes, total, want, { step = STEP, hamming, ...opts } = {}) {
  const diffs = [];
  for (let i = 1; i < hashes.length; i += 1) diffs.push(hamming(hashes[i - 1], hashes[i]));

  const dead = headTrim(diffs, { step, ...opts });
  const length = want > 0 ? want : Math.max(0, total - dead);

  /**
   * 去完头之后不够长了，就把入点往回挪。
   *
   * 优先保证**时长够** —— 时长不够会触发补帧（把最后一帧冻住撑时间），
   * 那比开头顿一下难看得多：画面彻底静止，观众一眼就看出是凑数的。
   */
  let start = dead;
  if (start + length > total) start = Math.max(0, total - length);

  return {
    in: Number(start.toFixed(2)),
    out: Number(Math.min(total, start + length).toFixed(2)),
    deadHead: Number(dead.toFixed(2)),
    // 想剪但没剪成（片子不够长）时，如实标出来 —— 不然日志会说剪了而实际没剪
    trimmed: Number(start.toFixed(2)) > 0
  };
}

/**
 * 一整批的说明文字。
 *
 * 只报**真剪掉了**的那些。一条都没剪时回 null，让调用方别打这行 ——
 * "0 镜被剪"这种话每次合成都印一遍，纯噪音。
 */
export function summarize(cuts = []) {
  const real = cuts.filter((c) => c && c.trimmed && c.deadHead > 0);
  if (!real.length) return null;
  const total = real.reduce((sum, c) => sum + c.in, 0);
  const head = real.slice(0, 5).map((c) => `#${c.index}（去掉开头 ${c.in}s）`).join('、');
  return (
    `自动剪辑：${real.length} 镜开头是不动的，已经跳过 —— ${head}${real.length > 5 ? ' 等' : ''}，` +
    `合计 ${total.toFixed(1)} 秒。图生视频的开头几帧基本是首帧的复制，` +
    `一段看不出来，二十段连起来就是整片发黏。`
  );
}

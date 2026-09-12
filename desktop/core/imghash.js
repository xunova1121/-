/**
 * 感知哈希：判断"两张图是不是同一张画面"。
 *
 * 用途只有一个 —— **首帧核对**：厂商到底有没有吃我们给的首帧图。
 *
 * 图生视频名义上是"以这张图为第一帧往下演"，但实际不总是这样：
 * 有的厂商在提示词和图打架时会自己重画第一帧；有的在参数不对时
 * 悄悄退化成文生视频，只把图当成一个"风格参考"。两种情况的表现
 * 都是**片子和分镜图对不上**，而任务本身是"成功"的 —— 不去比一比，
 * 你只会觉得"这家模型不行"，而不会知道它压根没用你那张图。
 *
 * 为什么不送多模态模型判断：
 *   ① 这是个像素问题，不是语义问题。"这两张是不是同一个构图"不需要理解力；
 *   ② 每一镜都判一次就是每一镜都花一次钱，而它本该是免费的；
 *   ③ 模型的答案不可复现，今天 pass 明天 fail，没法当阈值用。
 *
 * 解码交给 FFmpeg —— 反正合成那步已经依赖它了，不必为了读一张 PNG
 * 再引一个图像库进来（这个项目零第三方依赖）。
 *
 * 算法用 dHash（差值哈希）而不是 aHash（均值哈希）：
 * dHash 比的是**相邻像素谁更亮**，对整体亮度和对比度的变化不敏感 ——
 * 而视频编码后整体偏暗一点点是常态，用 aHash 会把这种无害差异算成不匹配。
 */
import * as ffmpeg from './ffmpeg.js';

/** 缩到 9×8 灰度：每行 9 个点两两相比得 8 位，8 行共 64 位 */
const W = 9;
const H = 8;

/**
 * 从一段灰度原始像素算 dHash。
 *
 * 单独抽出来是为了能脱离 FFmpeg 测：哈希本身是纯计算，
 * 不该因为跑测试的机器上没装 FFmpeg 就测不了。
 */
export function dHashFromGray(buf, w = W, h = H) {
  if (!buf || buf.length < w * h) {
    throw new Error(`灰度数据不够：拿到 ${buf?.length || 0} 字节，需要 ${w * h}`);
  }
  const bits = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      bits.push(buf[y * w + x] > buf[y * w + x + 1] ? 1 : 0);
    }
  }
  // 拼成十六进制，方便存进 project.json 和在界面上显示
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
  }
  return hex;
}

/** 两个哈希差多少位。0 = 一模一样，64 位哈希下随机两张图平均在 32 左右。 */
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/**
 * 判定阈值。
 *
 * 这几个数是按"失败长什么样"定的，不是拍脑袋：
 *   · 同一张图重编码一遍   → 0~6，编码器改不动相邻像素的大小关系
 *   · 首帧被轻微重绘       → 7~16，构图还在，细节动了
 *   · 完全另起炉灶         → 20 以上，和随机两张图（≈32）拉不开太远
 *
 * 卡在 12：宁可把"轻微重绘"放过去，也不要把正常的编码差异报成失败 ——
 * 误报会让人不敢信这个指标，而不敢信的指标等于没有。
 */
export const MATCH_THRESHOLD = 12;

/** 相似度，给界面显示用。距离 0 → 100%，距离 64 → 0% */
export function similarity(distance) {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.round(((64 - distance) / 64) * 100));
}

/** 哈希里有几个 1 */
export function bitCount(hex) {
  let n = 0;
  for (const ch of String(hex || '')) {
    let x = parseInt(ch, 16) || 0;
    while (x) {
      n += x & 1;
      x >>= 1;
    }
  }
  return n;
}

/**
 * 这张图的哈希有没有信息量。
 *
 * 大片纯色（夜戏、纯黑开场、白背景的道具图）算出来的哈希几乎全是 0 ——
 * 而**两个全 0 的哈希距离也是 0**，看上去像"完全一致"。
 * 这是 dHash 的固有短板：它比的是相邻像素谁更亮，画面里没有明暗变化时它无话可说。
 *
 * 所以信息量太低时不给结论，如实说"判断不了"。
 * 宁可承认测不准，也不要给一个反过来的答案 —— 后者比没有更糟。
 */
const MIN_ENTROPY_BITS = 6;

export function informative(hex) {
  const n = bitCount(hex);
  // 全 0 和全 1 一样没信息量，两头都要看
  return n >= MIN_ENTROPY_BITS && n <= 64 - MIN_ENTROPY_BITS;
}

/** 一张图片文件的哈希 */
export async function hashImage(file) {
  const gray = await ffmpeg.runCapture([
    '-v', 'error', '-i', file,
    '-vf', `scale=${W}:${H}:flags=area,format=gray`,
    '-frames:v', '1', '-f', 'rawvideo', '-'
  ]);
  return dHashFromGray(gray);
}

/**
 * 一段视频某一帧的哈希。
 * `at` 给 'first' 取第一帧，给 'end' 取最后一帧，给数字则按秒定位。
 */
export async function hashVideoFrame(file, { at = 'first' } = {}) {
  const seek =
    at === 'first' ? [] : at === 'end' ? ['-sseof', '-0.2'] : ['-ss', String(Number(at) || 0)];
  const gray = await ffmpeg.runCapture([
    '-v', 'error', ...seek, '-i', file,
    '-vf', `scale=${W}:${H}:flags=area,format=gray`,
    '-frames:v', '1', '-f', 'rawvideo', '-'
  ]);
  return dHashFromGray(gray);
}

/**
 * 首帧核对：这段视频的第一帧，是不是我们给的那张图。
 *
 * 返回 null 表示"没法判断"（没装 FFmpeg、文件缺失），
 * 和"判断了、不匹配"是两回事 —— 界面上不能混为一谈：
 * 前者该说"没检查"，后者才该报警。
 */
export async function compareFirstFrame(videoPath, imagePath) {
  if (!ffmpeg.locate().available) return null;
  const [videoHash, imageHash] = await Promise.all([
    hashVideoFrame(videoPath, { at: 'first' }),
    hashImage(imagePath)
  ]);
  const distance = hamming(videoHash, imageHash);
  const measurable = informative(videoHash) && informative(imageHash);
  const verdict = !measurable ? 'inconclusive' : distance <= MATCH_THRESHOLD ? 'ok' : 'mismatch';
  return {
    verdict,
    // ok 只在真的判出"对上了"时为 true。判不了的时候它是 false，
    // 但界面**不该**因此报警 —— 报警只看 verdict === 'mismatch'
    ok: verdict === 'ok',
    distance,
    similarity: similarity(distance),
    videoHash,
    imageHash,
    at: new Date().toISOString()
  };
}

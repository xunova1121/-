/**
 * 画面指纹 —— 用一串数字回答"这一镜和全片是不是同一个调子"。
 *
 * ════════ 先说清楚这东西**不是**什么 ════════
 *
 * 它**不是人脸识别**。那份架构文档里提的 face embedding 需要一个人脸模型，
 * 而这个项目零依赖、不带 GPU、不装 Python —— 本地跑不了那种模型。
 * 拿一个色彩指纹去冒充"人像不像"的判据，是在骗自己。
 *
 * 它回答的是另一个问题，而那个问题**目前完全没有自动检查**：
 *
 *     "从第 6 镜开始画风变了" —— 色调偏了、对比度跳了、饱和度不一样了。
 *
 * 这类漂移逐镜看每张都正常，连起来才露馅，而那时候钱已经花完了。
 * 现在能自动发现它的只有一条"全片是不是同一个模型出的"的粗判断，
 * 而换模型只是原因之一：换种子、改提示词、厂商悄悄升级，都会漂。
 *
 * ════════ 为什么值得做 ════════
 *
 * ① **免费**。纯本地计算，不调任何模型。
 * ② **可复现**。同样两张图永远同一个分数 —— 而视觉模型打的分会飘，
 *    同一对图两次能差好几分，那种分数没法当阈值用。
 * ③ **能当预筛**。视觉复核是这条流水线上除了出图出视频之外最贵的调用。
 *    本地指纹先把"明显没问题"和"明显有问题"的挑出来，剩下拿不准的
 *    才花钱去问模型 —— 一部 20 镜的片子能省掉大半次调用。
 *
 * ════════ 指纹里有什么 ════════
 *
 * 把图缩到 8×8 的 RGB，然后算三样：
 *   · 每个通道 8 档的直方图（24 维）—— 整体色调分布
 *   · 三个通道各自的均值（3 维）—— 偏暖还是偏冷
 *   · 亮度的标准差（1 维）—— 对比度是强是弱
 *
 * 一共 28 维。刻意不用结构信息（那是 imghash 干的事）——
 * 不同镜头本来就该有不同构图，拿构图去比会把"正常的镜位变化"报成漂移。
 */
import * as ffmpeg from './ffmpeg.js';

const SIDE = 8;
const BINS = 8;

/**
 * 从一段 RGB 原始像素算指纹。
 *
 * 抽成纯函数是为了能脱离 FFmpeg 测 —— 指纹本身是纯计算，
 * 不该因为跑测试的机器上没装 FFmpeg 就测不了（imghash 也是这么分的）。
 */
export function fingerprintFromRGB(buf, side = SIDE) {
  const need = side * side * 3;
  if (!buf || buf.length < need) {
    throw new Error(`像素数据不够：拿到 ${buf?.length || 0} 字节，需要 ${need}`);
  }
  const hist = new Array(BINS * 3).fill(0);
  const sum = [0, 0, 0];
  const lum = [];

  for (let i = 0; i < side * side; i += 1) {
    const r = buf[i * 3];
    const g = buf[i * 3 + 1];
    const b = buf[i * 3 + 2];
    hist[Math.min(BINS - 1, (r / 256) * BINS | 0)] += 1;
    hist[BINS + Math.min(BINS - 1, (g / 256) * BINS | 0)] += 1;
    hist[BINS * 2 + Math.min(BINS - 1, (b / 256) * BINS | 0)] += 1;
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
    // Rec.601 亮度：比简单平均更接近人眼感受
    lum.push(0.299 * r + 0.587 * g + 0.114 * b);
  }

  const n = side * side;
  const mean = lum.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(lum.reduce((a, b) => a + (b - mean) ** 2, 0) / n);

  return [
    // 直方图归一化成比例，这样不同尺寸的图也能比
    ...hist.map((c) => c / n),
    sum[0] / n / 255,
    sum[1] / n / 255,
    sum[2] / n / 255,
    sd / 128
  ];
}

/** 余弦相似度。两个指纹都非零时才有意义 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 两个指纹有多像，0~100。
 *
 * 余弦本身在 0.9 以上挤成一团（色彩直方图天然都很像），直接乘 100
 * 会得到"什么都是 95 分"这种没有分辨力的数。所以把 0.90~1.00 这一段
 * 拉开到 0~100 —— 低于 0.90 的一律算 0，那已经是完全不同的两张图。
 */
export function score(a, b) {
  const c = cosine(a, b);
  if (!Number.isFinite(c)) return 0;
  return Math.max(0, Math.min(100, Math.round(((c - 0.9) / 0.1) * 100)));
}

/**
 * 算一张图的指纹。没装 FFmpeg 就返回 null。
 *
 * ⚠ null 是"**没法判断**"，不是"不匹配" —— 界面上这两件事必须分开说：
 * 前者该说"没检查"，后者才该报警。把没检查说成通过，是这类功能最常见的骗局。
 */
export async function fingerprintOf(file) {
  try {
    const rgb = await ffmpeg.runCapture([
      '-v', 'error', '-i', file,
      '-vf', `scale=${SIDE}:${SIDE}:flags=area,format=rgb24`,
      '-frames:v', '1', '-f', 'rawvideo', '-'
    ]);
    return fingerprintFromRGB(rgb);
  } catch {
    return null;
  }
}

/**
 * 这一镜和全片的基准调子差多少。
 *
 * 基准取的是**已有指纹的那些镜头的平均**，而不是第一镜 ——
 * 第一镜万一本身就是个夜戏特写，后面每一镜都会被判成漂移。
 * 平均值稳得多，而且随着片子跑下去会越来越准。
 */
export function baselineOf(shots = []) {
  const vecs = shots.map((s) => s.palette).filter((v) => Array.isArray(v) && v.length);
  if (!vecs.length) return null;
  const out = new Array(vecs[0].length).fill(0);
  for (const v of vecs) for (let i = 0; i < out.length; i += 1) out[i] += v[i] / vecs.length;
  return out;
}

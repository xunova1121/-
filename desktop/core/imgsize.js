/**
 * 读一张图的宽高。只看文件头，不解码像素，也不引任何依赖。
 *
 * ── 为什么需要它 ──
 *
 * 画幅（16:9 还是 9:16）是**在下手之前**就必须定对的东西：竖屏短剧出成横的，
 * 整条流水线白跑。我们确实把尺寸参数发出去了，但"发出去了"和"厂商听了"是两回事：
 *   · 有的厂商不认这个字段，默默按自己的默认出；
 *   · 有的只支持几个固定尺寸，给了别的就近似到最像的那个；
 *   · 中转平台常常把这个参数整个丢掉。
 * 三种情况的表现完全一样：任务成功、图也回来了，**只是比例不对**。
 * 而下一步图生视频会继承首帧图的比例 —— 于是错误一路传到成片。
 *
 * 所以出完图立刻量一下真实宽高，和你要的画幅一比，对不上就当场说出来。
 * 这一层是免费的：读文件头几十个字节，不调模型、不花钱。
 */
import fs from 'node:fs';

/** 读文件头。够覆盖 PNG / JPEG / WebP 的尺寸字段。 */
function head(file, bytes = 65536) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

export function readSize(file) {
  if (!fs.existsSync(file)) return null;
  let b;
  try {
    b = head(file);
  } catch {
    return null;
  }

  // PNG：IHDR 固定在第 16 字节起，宽高各 4 字节大端
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }

  // WebP：RIFF....WEBP，之后分 VP8 / VP8L / VP8X 三种，各有各的写法
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: (b.readUIntLE(24, 3) & 0xffffff) + 1, height: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }

  // JPEG：一段一段地跳，直到遇到 SOF0~SOF15（不含 DHT/DAC/RST 那几个）
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSOF) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

/** "1280*720" / "1280x720" → 1.777… */
export function ratioOf(w, h) {
  return w && h ? w / h : 0;
}

/**
 * 出来的图是不是你要的那个画幅。
 *
 * 容差给到 4%：厂商会把 720×1280 出成 704×1280 这种对齐到 16 倍数的尺寸，
 * 那不算"比例不对"，不该为此报一次警。真正要抓的是横竖搞反、
 * 或者 16:9 出成 1:1 这种一眼可见的偏差。
 */
export function matchesRatio(size, wanted, { tolerance = 0.04 } = {}) {
  if (!size?.width || !size?.height) return null;
  const [w, h] = String(wanted || '16:9').split(':').map(Number);
  if (!w || !h) return null;
  const want = w / h;
  const got = size.width / size.height;
  const off = Math.abs(got - want) / want;
  return {
    ok: off <= tolerance,
    // 横竖搞反是最刺眼的一种，单独标出来
    flipped: (want > 1) !== (got > 1),
    got: `${size.width}×${size.height}`,
    offPercent: Math.round(off * 100)
  };
}

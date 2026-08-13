/**
 * 生成应用图标 build/icon.ico。
 *
 *     node scripts/make-icon.mjs
 *
 * 为什么自己画而不是拖一个 png 进来：这个仓库里不该出现来源不明的二进制素材，
 * 而且图标要跟界面同一套配色（钨丝暖底 + 场记板斜纹 + 日光冷蓝）。
 * 纯 Node 手写 PNG 编码器 + ICO 封装，零依赖。
 *
 * 生成结果已提交进版本库，CI 直接用，不用每次重跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build');

// 与 ui/app.css 同源的配色
const GROUND = [0x16, 0x13, 0x0f];
const SLATE = [0xe8, 0xdf, 0xd0];
const BEAM = [0x6b, 0xa8, 0xdc];

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素数组 → PNG。每行前面补一个 0 表示"不使用滤波"，够用且解码最快。 */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 色彩类型 RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * 画一格图标。
 *
 * 构图：整块钨丝暖底，上半部斜切场记板条纹，底部压一道日光冷蓝。
 * 斜纹角度和界面里 .brand-slate 一致（115deg），缩到 16px 仍能认出是场记板。
 */
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.18; // 圆角，贴合 Windows 11 的观感
  const stripeW = size / 7;
  const clapperBottom = size * 0.46;
  const beamTop = size * 0.82;

  const set = (x, y, [r, g, b], a = 255) => {
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 圆角：四个角之外的像素透明
      const cx = Math.min(x, size - 1 - x);
      const cy = Math.min(y, size - 1 - y);
      if (cx < radius && cy < radius) {
        const dx = radius - cx;
        const dy = radius - cy;
        if (dx * dx + dy * dy > radius * radius) {
          set(x, y, GROUND, 0);
          continue;
        }
      }

      if (y > beamTop) {
        set(x, y, BEAM);
      } else if (y < clapperBottom) {
        // 斜纹：沿 x + y*tan 方向切条，和界面的 115deg 同向
        const band = Math.floor((x + y * 0.5) / stripeW);
        set(x, y, band % 2 === 0 ? SLATE : GROUND);
      } else {
        set(x, y, GROUND);
      }
    }
  }
  return px;
}

/** ICO 容器：每一格都以 PNG 形式内嵌（Vista 之后都支持，体积比 BMP 小得多）。 */
function encodeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留
  header.writeUInt16LE(1, 2); // 类型 1 = 图标
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  const blobs = [];
  let offset = 6 + images.length * 16;

  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 256 要写成 0
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // 调色板色数
    e[3] = 0;
    e.writeUInt16LE(1, 4); // 色彩平面
    e.writeUInt16LE(32, 6); // 位深
    e.writeUInt32BE(0, 8);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, png: encodePNG(size, size, draw(size)) }));

fs.mkdirSync(OUT_DIR, { recursive: true });
const ico = encodeICO(images);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
// electron-builder 在部分场景下会找 png，一并出一张最大的
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), images.at(-1).png);

console.log(`已生成 ${path.join(OUT_DIR, 'icon.ico')}（${sizes.join('/')}，共 ${(ico.length / 1024).toFixed(1)} KB）`);

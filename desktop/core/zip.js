/**
 * 打包成 zip。只用 node: 内置模块，不引任何依赖。
 *
 * ── 为什么要有它 ──
 *
 * 成片、每一镜的片段、字幕、每条配音 —— 一部二十镜的片子有四十来个文件。
 * 逐个"存到手机"要点四十次，没人会这么干。而这些素材的意义正在于
 * **一起拿走**：进剪映之后按顺序拖进时间线，那是初剪的起点。
 *
 * ── 为什么不压缩（STORE）──
 *
 * 包里几乎全是 mp4 / png / mp3，它们本身已经压过了，再压一遍省不下几个百分点，
 * 却要为此吃掉 CPU 和内存 —— 一部片子几百 MB，deflate 一遍是几十秒的事。
 * 所以一律 STORE（method 0）：边读边写，内存占用是常数，速度就是磁盘速度。
 *
 * ── 为什么读两遍 ──
 *
 * zip 的本地文件头里要写 CRC32 和大小，而它排在文件数据**前面**。
 * 要么先算一遍 CRC（读两遍），要么用 data descriptor 把 CRC 挪到数据后面
 * （读一遍，但有些老解压工具不认）。这里选读两遍：本地磁盘、系统还有缓存，
 * 代价很小；而"用户下下来解不开"是不能接受的。
 */
import fs from 'node:fs';
import path from 'node:path';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf, seed = 0) {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function crc32File(file) {
  return new Promise((resolve, reject) => {
    let c = 0;
    const rs = fs.createReadStream(file);
    rs.on('data', (chunk) => {
      c = crc32(chunk, c);
    });
    rs.on('end', () => resolve(c));
    rs.on('error', reject);
  });
}

/** DOS 时间戳。zip 的时间精度是 2 秒，这不是 bug，是格式本来就这样。 */
function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * zip 里的中文名。
 *
 * 必须打上 flag 的第 11 位（0x0800）表示"名字是 UTF-8"。不打的话，
 * Windows 的资源管理器会按本地代码页去解，中文名变成一串乱码 ——
 * 而这个包里全是「第 03 镜」这种名字，乱码等于白打包。
 */
const UTF8_FLAG = 0x0800;

/**
 * 把若干本地文件打成一个 zip，边写边发。
 *
 * entries: [{ file, name }]，name 是包内路径（可以带目录，用 /）。
 * 找不到的文件直接跳过 —— 少一段配音不该让整个包下不下来。
 */
export async function writeZip(entries, out) {
  const central = [];
  let offset = 0;
  const write = (buf) =>
    new Promise((resolve, reject) => {
      out.write(buf, (err) => (err ? reject(err) : resolve()));
    });

  const usable = entries.filter((e) => e?.file && fs.existsSync(e.file));

  for (const entry of usable) {
    const stat = fs.statSync(entry.file);
    const crc = await crc32File(entry.file);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const { time, date } = dosTime(stat.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压需要的版本
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // 0 = STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stat.size, 18);
    local.writeUInt32LE(stat.size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    await write(local);
    await write(nameBuf);

    // 数据本身流式过一遍，内存里不留整份文件
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(entry.file);
      rs.on('error', reject);
      rs.on('end', resolve);
      rs.pipe(out, { end: false });
    });

    central.push({ crc, size: stat.size, nameBuf, time, date, offset });
    offset += local.length + nameBuf.length + stat.size;
  }

  const cdStart = offset;
  for (const c of central) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); // 打包方版本
    head.writeUInt16LE(20, 6); // 解压需要的版本
    head.writeUInt16LE(UTF8_FLAG, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(c.time, 12);
    head.writeUInt16LE(c.date, 14);
    head.writeUInt32LE(c.crc, 16);
    head.writeUInt32LE(c.size, 20);
    head.writeUInt32LE(c.size, 24);
    head.writeUInt16LE(c.nameBuf.length, 28);
    head.writeUInt16LE(0, 30); // extra
    head.writeUInt16LE(0, 32); // comment
    head.writeUInt16LE(0, 34); // 起始磁盘号
    head.writeUInt16LE(0, 36); // 内部属性
    head.writeUInt32LE(0, 38); // 外部属性
    head.writeUInt32LE(c.offset, 42);
    await write(head);
    await write(c.nameBuf);
    offset += head.length + c.nameBuf.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  end.writeUInt16LE(0, 20);
  await write(end);

  return { count: central.length, bytes: offset };
}

/**
 * 包内文件名。
 *
 * 编号放最前面：解压出来按名字排序就是分镜顺序，拖进剪映时间线不用再对着表找。
 * 描述截短并去掉路径里不能用的字符 —— Windows 对 \\ / : * ? " < > | 一律不收，
 * 而这些字在中文描述里出现得并不少（"他说：'走'"）。
 */
export function zipName(index, text, ext, prefix = '') {
  const clean = String(text || '')
    .replace(/[\\/:*?"<>|\n\r\t]/g, '')
    .trim()
    .slice(0, 16);
  const no = String(index).padStart(2, '0');
  return `${prefix}${no}${clean ? `_${clean}` : ''}${ext}`;
}

export function safeZipEntry(file, name) {
  return { file, name: name.replace(/^[/\\]+/, '') };
}

export { path };

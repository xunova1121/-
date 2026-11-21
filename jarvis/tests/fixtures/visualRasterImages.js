import { deflateSync } from 'node:zlib';

// 独立生成2×2红色PNG，坏压缩数据也重新计算CRC，以区分结构校验与真实解码。
function chunk(kind, data) {
  const content = Buffer.concat([Buffer.from(kind), data]);
  let crc = -1;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? crc >>> 1 ^ 0xedb88320 : crc >>> 1;
  }
  const header = Buffer.alloc(4), footer = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  footer.writeUInt32BE((crc ^ -1) >>> 0);
  return Buffer.concat([header, content, footer]);
}

export function visualRasterPng({ badCrc = false, badData = false } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  const compressed = deflateSync(pixels);
  if (badData) compressed[0] = 0;
  const data = chunk('IDAT', compressed);
  if (badCrc) data[data.length - 1] ^= 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), data, chunk('IEND', Buffer.alloc(0))]);
}

export const visualRasterImageTag = bytes => `<image width="640" height="360" href="data:image/png;base64,${bytes.toString('base64')}"/>`;

/** 尺寸可控、带真实压缩像素和CRC的人像流程夹具；不伪造大尺寸IHDR。 */
export function sizedRasterPng(width, height, color = [230, 210, 193]) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error('测试图片尺寸无效');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let index = 1; index < row.length; index += 3) { row[index] = color[0]; row[index + 1] = color[1]; row[index + 2] = color[2]; }
  const pixels = Buffer.alloc(row.length * height);
  for (let index = 0; index < height; index++) row.copy(pixels, row.length * index);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

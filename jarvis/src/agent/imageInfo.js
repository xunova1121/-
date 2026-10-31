/**
 * 从图片文件头读出格式和宽高（PNG / JPEG / GIF / BMP），不解码整张图。
 * Word / PPT 插图时用来按版心等比缩放。认不出来返回 null。
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{ type: 'png'|'jpg'|'gif'|'bmp', width: number, height: number } | null}
 */
export function imageInfo(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const u16be = (i) => (b[i] << 8) | b[i + 1];
  const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u32le = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  if (b.length < 24) return null;
  // PNG：IHDR 在第 16 字节起
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ok('png', u32be(16), u32be(20));
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ok('gif', u16le(6), u16le(8));
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d) return ok('bmp', u32le(18), Math.abs(u32le(22) | 0));
  // JPEG：找 SOF 段
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = u16be(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return ok('jpg', u16be(i + 7), u16be(i + 5));
      i += 2 + len;
    }
  }
  return null;
}

function ok(type, width, height) {
  return width > 0 && height > 0 && width < 100000 && height < 100000 ? { type, width, height } : null;
}

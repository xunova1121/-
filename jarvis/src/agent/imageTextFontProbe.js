/** 自包含工厂供离线编辑器复用；逐字哨兵检查，不以fonts.check冒充字形覆盖。 */
export function createCanvasFontProbe(sentinelBase64) {
  return async function check(checked) {
    if (typeof FontFace === 'undefined' || !document.fonts) throw new Error('当前浏览器不能核验字体');
    const id = Math.random().toString(36).slice(2),
      name = 'WeiyangMissing' + id,
      canvas = document.createElement('canvas');
    const sentinel = new FontFace(
      name,
      Uint8Array.from(atob(sentinelBase64), (ch) => ch.charCodeAt(0))
    );
    canvas.width = canvas.height = 80;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = (ch, font) => {
      ctx.clearRect(0, 0, 80, 80);
      ctx.font = font;
      ctx.fillStyle = '#000';
      ctx.fillText(ch, 8, 58);
      return ctx.getImageData(0, 0, 80, 80).data;
    };
    const same = (a, b) => a.every((v, i) => v === b[i]);
    const glyphs = [...new Set([...checked.text].filter((ch) => !/\s/u.test(ch)))];
    if (glyphs.length > 6000) throw new Error('文案超过6000字');
    try {
      await sentinel.load();
      document.fonts.add(sentinel);
      const mark = pixels('A', `48px "${name}"`);
      if (!mark.some(Boolean) || !same(mark, pixels('中', `48px "${name}"`))) throw new Error('缺字检测不可用');
      for (const family of checked.families) {
        const probe = new FontFace('WeiyangProbe' + id, `local("${family}")`);
        try {
          try {
            await probe.load();
          } catch {
            continue;
          }
          document.fonts.add(probe);
          let covered = true;
          for (const weight of checked.weights) {
            const missing = pixels('A', `${weight} 48px "${name}"`);
            for (let i = 0; i < glyphs.length; i++) {
              const actual = pixels(glyphs[i], `${weight} 48px "${family}", "${name}"`);
              if (!actual.some(Boolean) || same(actual, missing)) {
                covered = false;
                break;
              }
              if (i % 32 === 31) await new Promise((resolve) => setTimeout(resolve, 0));
            }
            if (!covered) break;
          }
          if (covered) return family;
        } finally {
          document.fonts.delete(probe);
        }
      }
      throw new Error('设备缺少能覆盖全文的中文字体，请安装思源黑体/Noto简体中文字体');
    } finally {
      document.fonts.delete(sentinel);
      canvas.width = canvas.height = 0;
    }
  };
}

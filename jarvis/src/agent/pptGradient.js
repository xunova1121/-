/**
 * PPT 原生渐变（用户 2026-11-05：政企汇报的封面、章节、结尾用整页渐变）。
 * pptxgenjs 不支持渐变填充：先画一个纯色形状，名字写成 wy-grad-颜色1-颜色2[-颜色3]-角度，
 * 生成后把这个形状的纯色填充改写成 PowerPoint 原生 <a:gradFill>。PowerPoint、WPS 里打开就是真渐变，可在“设置形状格式”里改。
 * 改写失败（找不到形状、包损坏）时保留原纯色，不影响文件能打开。
 */
const NAME = /^wy-grad-((?:[0-9A-F]{6}-){1,3}[0-9A-F]{6})-(\d{1,3})$/;

/** 渐变形状的名字：颜色 2–4 个（六位十六进制），角度 0–359（0 从左到右，90 从上到下） */
export function gradientName(colors, angle = 45) {
  const list = colors.map(c => String(c).toUpperCase()).filter(c => /^[0-9A-F]{6}$/.test(c)).slice(0, 4);
  if (list.length < 2) throw new Error('渐变至少两个颜色');
  return `wy-grad-${list.join('-')}-${Math.round(((angle % 360) + 360) % 360)}`;
}

const gradFill = (colors, angle) => `<a:gradFill rotWithShape="1"><a:gsLst>${colors.map((c, i) => `<a:gs pos="${Math.round(i * 100000 / (colors.length - 1))}"><a:srgbClr val="${c}"/></a:gs>`).join('')}</a:gsLst><a:lin ang="${angle * 60000}" scaled="0"/></a:gradFill>`;

/** 改写一页幻灯片 XML 里所有渐变形状；返回 { xml, count } */
export function rewriteGradients(xml) {
  let count = 0;
  const out = String(xml).replace(/<p:sp>[\s\S]*?<\/p:sp>/g, sp => {
    const name = sp.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/)?.[1] || '';
    const m = NAME.exec(name);
    if (!m) return sp;
    const colors = m[1].split('-');
    const angle = Math.min(359, Number(m[2]));
    const next = sp.replace(/(<p:spPr>[\s\S]*?)<a:solidFill>[\s\S]*?<\/a:solidFill>/, (_, head) => head + gradFill(colors, angle))
      .replace(/<a:ln\b([^>]*)>[\s\S]*?<\/a:ln>/, '<a:ln$1><a:noFill/></a:ln>');
    if (next !== sp) count++;
    return next;
  });
  return { xml: out, count };
}

/** 生成后的整份 PPT：有渐变形状才改写；出错时原样返回 */
export async function applyGradients(blob, { expected = 0 } = {}) {
  if (!expected) return { blob, count: 0 };
  try {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    let count = 0;
    for (const path of Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))) {
      const r = rewriteGradients(await zip.file(path).async('string'));
      if (r.count) { zip.file(path, r.xml); count += r.count; }
    }
    if (!count) return { blob, count };
    return { blob: new Blob([await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })], { type: blob.type || 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), count };
  } catch {
    return { blob, count: 0 };
  }
}

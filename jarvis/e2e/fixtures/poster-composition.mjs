/** 原创几何汤碗与固定文案：仅用于合成验收，不冒充GPT生成的底图。 */
export const backgroundSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
<rect width="1200" height="900" fill="#DFB987"/>
<rect x="0" y="0" width="160" height="900" fill="#7B573F"/>
<rect x="1040" y="0" width="160" height="900" fill="#62827A"/>
<circle cx="600" cy="400" r="264" fill="#815E43"/>
<circle cx="600" cy="380" r="250" fill="#F8EDD4"/>
<circle cx="600" cy="380" r="210" fill="#B16B32"/>
<circle cx="600" cy="380" r="191" fill="#D8974C"/>
<ellipse cx="540" cy="325" rx="58" ry="32" fill="#F3DCAD"/>
<ellipse cx="674" cy="430" rx="65" ry="37" fill="#F3DCAD"/>
<ellipse cx="493" cy="440" rx="38" ry="25" fill="#A14B30"/>
<ellipse cx="686" cy="301" rx="36" ry="24" fill="#A14B30"/>
<ellipse cx="590" cy="445" rx="18" ry="48" fill="#5F764C" transform="rotate(30 590 445)"/>
<ellipse cx="637" cy="340" rx="18" ry="45" fill="#5F764C" transform="rotate(-32 637 340)"/>
<rect x="790" y="95" width="13" height="630" rx="6" fill="#79513B" transform="rotate(12 790 95)"/>
<rect x="823" y="95" width="13" height="630" rx="6" fill="#79513B" transform="rotate(12 823 95)"/>
<circle cx="310" cy="752" r="50" fill="#8B6849"/><circle cx="310" cy="742" r="46" fill="#F5E3BE"/>
</svg>`;

export const samples = [
  { id: 'portrait-bottom-sans', title: '秋季养生汤', subtitle: '一碗温润，慢享秋日', lines: ['莲藕 · 山药 · 红枣', '家常食材，暖心滋味'], footer: '原创合成底图 · 中文由程序排版', width: 1024, height: 1536, text_position: 'bottom', text_fraction: 1 / 3, font_family: 'sans' },
  { id: 'landscape-left-sans', title: '秋日好汤', subtitle: '把暖意带回家', lines: ['温润清甜', '慢炖一锅家常好味'], footer: '原创合成验收样例', width: 1536, height: 1024, text_position: 'left', text_fraction: 0.4, font_family: 'sans' },
  { id: 'square-long-serif', title: '秋季养生汤：把一整个秋天的温润与暖意盛进碗里', subtitle: '随四时而食，尝日常之美', lines: ['莲藕、山药、红枣，用平凡食材煮出温暖', '认真吃饭，慢慢生活'], footer: '原创合成验收样例 · 宋体长标题', width: 1200, height: 1200, text_position: 'bottom', text_fraction: 0.6, font_family: 'serif' }
].map(sample => ({ ...sample, text_color: '#24170D', panel_color: '#FFF8EC', background_color: '#DFB987' }));

export const fixtureHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>中文海报真实渲染验收</title>
<style>*{box-sizing:border-box}body{margin:0;background:#e8e2d8;color:#30271e;font:16px system-ui}main{max-width:1280px;margin:auto;padding:20px}h1{font-size:22px;margin:0 0 8px}p{line-height:1.5}#preview{display:block;max-width:100%;height:auto;margin:auto;background:white;box-shadow:0 3px 18px #0003}#inspection{position:absolute;left:-12000px;top:0}#preview.grid{max-height:80vh;width:auto}</style>
<main><h1>中文海报 · 实际成品</h1><p id="description">合成底图，真实字体和实际像素；未调用外部图像模型。</p><img id="preview" alt="当前验收海报"></main><div id="inspection"></div></html>`;

/** 浏览器解码后的像素统计；用于服务器PNG、浏览器SVG和Office PDF三方对照。 */
export async function inspectImage({ imageUrl, svg, rows, width, height }) {
  const decode = async url => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(img, 0, 0);
    return { width: canvas.width, height: canvas.height, pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
  };
  const svgUrl = text => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
  const actual = await decode(imageUrl);
  const expected = await decode(svgUrl(svg));
  const withoutText = svg.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, '');
  const plain = await decode(svgUrl(withoutText));
  const delta = (a, b, at) => Math.max(Math.abs(a[at] - b[at]), Math.abs(a[at + 1] - b[at + 1]), Math.abs(a[at + 2] - b[at + 2]));
  let different = 0, left = width, top = height, right = -1, bottom = -1;
  for (let at = 0; at < expected.pixels.length; at += 4) {
    if (delta(actual.pixels, expected.pixels, at) > 32) different++;
    if (delta(expected.pixels, plain.pixels, at) > 48) {
      const x = (at / 4) % width, y = Math.floor(at / 4 / width);
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  const rowPixels = rows.filter(row => row.text.trim()).map(row => {
    let ink = 0, referenceInk = 0, union = 0, mismatch = 0, minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = Math.max(0, Math.floor(row.y)); y < Math.min(height, Math.ceil(row.y + row.h)); y++) {
      for (let x = Math.max(0, Math.floor(row.x)); x < Math.min(width, Math.ceil(row.x + row.w)); x++) {
        const at = (y * width + x) * 4;
        const hasInk = delta(actual.pixels, plain.pixels, at) > 48;
        const reference = delta(expected.pixels, plain.pixels, at) > 48;
        if (hasInk) { ink++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
        if (reference) referenceInk++;
        if (hasInk || reference) union++;
        if ((hasInk || reference) && delta(actual.pixels, expected.pixels, at) > 64) mismatch++;
      }
    }
    return { text: row.text, ink, referenceInk, mismatch: union ? mismatch / union : 1, bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } };
  });
  const holder = document.querySelector('#inspection');
  holder.innerHTML = svg;
  await document.fonts.ready;
  const textBounds = [...holder.querySelectorAll('text')].map(node => {
    const box = node.getBBox();
    return { text: node.textContent, x: box.x, y: box.y, width: box.width, height: box.height, family: getComputedStyle(node).fontFamily };
  });
  holder.replaceChildren();
  return { width: actual.width, height: actual.height, differentRatio: different / (width * height), rowPixels, textBounds, paintedBounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } };
}

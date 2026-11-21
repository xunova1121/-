/** 原图独立保留，所有文案均为可编辑文本对象；不绘制SVG/遮挡形状。 */
export async function composeImageTextPptx(design, imageData, layout, family) {
  const PptxGenJS = (await import('pptxgenjs')).default,
    pptx = new PptxGenJS();
  // PPT单边最多56英寸；统一缩放尺寸及文字，保持所有对象同一比例。
  const ratio = Math.min(1 / 96, 50 / Math.max(design.width, design.height)),
    inch = (value) => value * ratio;
  pptx.defineLayout({ name: 'ORIGINAL_TEXT', width: inch(design.width), height: inch(design.height) });
  pptx.layout = 'ORIGINAL_TEXT';
  pptx.title = design.title;
  pptx.author = '未央';
  pptx.lang = 'zh-CN';
  pptx.subject = '原图完整保留；文字为可编辑对象；字体不嵌入；无SVG';
  const slide = pptx.addSlide();
  slide.addImage({
    data: imageData,
    x: 0,
    y: 0,
    w: inch(design.width),
    h: inch(design.height),
    objectName: 'original-background'
  });
  for (const [index, row] of layout.rows.entries())
    if (row.text)
      slide.addText(row.text, {
        x: inch(row.x),
        y: inch(row.baseline - row.ascent),
        w: inch(row.w + 2),
        h: inch(Math.max(row.h, row.fontSize * 1.1)),
        fontFace: family,
        fontSize: row.fontSize * ratio * 72,
        bold: row.weight === 700,
        color: row.color.slice(1),
        margin: 0,
        breakLine: false,
        wrap: false,
        valign: 'top',
        paraSpaceAfterPt: 0,
        paraSpaceBeforePt: 0,
        lang: 'zh-CN',
        objectName: `text-${row.entryId}-${index}`
      });
  return pptx.write({ outputType: 'blob' });
}

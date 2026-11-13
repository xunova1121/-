import { pngPixels, streamBytes } from './diagramPng.js';

/** PDF与展示PPT复用同一PNG，字体已在共同渲染阶段确定，不让PDF再换字体。 */
export async function makeDiagramPdf(scene, png) {
  const image = await pngPixels(png);
  const compressed = await streamBytes(image.rgb, 'deflate');
  const encoder = new TextEncoder();
  const pageWidth = scene.width * 0.75;
  const pageHeight = scene.height * 0.75;
  const content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;
  const chunks = [encoder.encode('%PDF-1.4\n')];
  const offsets = [0];
  let length = chunks[0].length;
  const add = (index, head, stream) => {
    offsets[index] = length;
    const parts = stream
      ? [encoder.encode(`${index} 0 obj\n${head}\nstream\n`), stream, encoder.encode('\nendstream\nendobj\n')]
      : [encoder.encode(`${index} 0 obj\n${head}\nendobj\n`)];
    for (const part of parts) {
      chunks.push(part);
      length += part.length;
    }
  };
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  add(
    4,
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate false /Filter /FlateDecode /Length ${compressed.length} >>`,
    compressed
  );
  add(5, `<< /Length ${encoder.encode(content).length} >>`, encoder.encode(content));
  const xref = length;
  chunks.push(
    encoder.encode(
      'xref\n0 6\n0000000000 65535 f \n' +
        offsets
          .slice(1)
          .map((value) => String(value).padStart(10, '0') + ' 00000 n \n')
          .join('') +
        `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    )
  );
  return new Blob(chunks, { type: 'application/pdf' });
}

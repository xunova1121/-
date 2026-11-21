import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { createImageTextEngine } from '../src/agent/imageTextEngine.js';

const reply = (result) => process.send(result, () => process.disconnect());
process.once('message', async (work) => {
  try {
    const { action, bytes, design, family, fonts } = work;
    if (action === 'svg') {
      const { Resvg } = await import('@resvg/resvg-js');
      const output = new Resvg(Buffer.from(bytes), {
        font: { fontBuffers: fonts.map(data => Buffer.from(data)), loadSystemFonts: false, defaultFontFamily: family }
      }).render().asPng();
      if (output.length > 24e6) throw new Error('image size');
      reply({ bytes: output });
      return;
    }
    const image = await loadImage(Buffer.from(bytes));
    if (image.width * image.height > 25e6) throw new Error('image pixels');
    if (action === 'inspect') {
      const scale = Math.min(1, 768 / Math.max(image.width, image.height));
      const w = Math.max(1, Math.round(image.width * scale)),
        h = Math.max(1, Math.round(image.height * scale));
      const context = createCanvas(w, h).getContext('2d');
      context.drawImage(image, 0, 0, w, h);
      const data = context.getImageData(0, 0, w, h).data;
      reply({ width: image.width, height: image.height, frame: { width: w, height: h, data } });
    } else {
      for (const data of fonts) if (!GlobalFonts.register(Buffer.from(data))) throw new Error('font register');
      if (!GlobalFonts.has(family)) throw new Error('font family');
      const canvas = createCanvas(design.width, design.height),
        context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, design.width, design.height);
      const before = context.getImageData(0, 0, design.width, design.height).data;
      const engine = createImageTextEngine(),
        layout = engine.colorRows(context, design, engine.plan(context, design, family), before);
      if (!engine.paint(context, layout, family)) reply({ layout });
      else {
        const preview = createCanvas(
          layout.previewWidth,
          Math.ceil((design.height * layout.previewWidth) / design.width)
        );
        preview.getContext('2d').drawImage(canvas, 0, 0, preview.width, preview.height);
        reply({
          layout,
          backgroundCheck: engine.verifyBackground(
            before,
            context.getImageData(0, 0, design.width, design.height).data,
            design,
            layout
          ),
          bytes: await canvas.encode('png'),
          previewBytes: await preview.encode('png')
        });
      }
    }
  } catch {
    reply({ error: true });
  }
});

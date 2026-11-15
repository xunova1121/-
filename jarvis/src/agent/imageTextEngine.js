/** 全端和离线编辑器共用；工厂自包含，打包压缩后仍可安全嵌入HTML。仅绘制文字，绝不绘制遮挡面板。 */
export function createImageTextEngine() {
  const overlap = (a, b) =>
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) + 0.05 &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y) + 0.05;
  const rgbLuma = (r, g, b) => {
    const c = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return c(r) * 0.2126 + c(g) * 0.7152 + c(b) * 0.0722;
  };
  const round = (n) => Math.round(n * 1000) / 1000;
  function wrap(value, width, measure) {
    const lines = [];
    for (const paragraph of value.split('\n')) {
      let line = '';
      for (const ch of Array.from(paragraph)) {
        if (measure(ch).width > width) return null;
        if (line && measure(line + ch).width > width) {
          lines.push(line);
          line = ch;
        } else line += ch;
      }
      lines.push(line);
    }
    return lines;
  }
  function ink(context, value, fontSize) {
    const m = context.measureText(value || '国');
    return {
      ascent: m.actualBoundingBoxAscent || fontSize * 0.88,
      descent: Math.max(0, m.actualBoundingBoxDescent || 0),
      width: m.width,
      left: Math.max(0, m.actualBoundingBoxLeft || 0),
      right: Math.max(m.width, m.actualBoundingBoxRight || 0)
    };
  }
  function plan(context, design, family) {
    const previewWidth = Math.min(design.width, design.reading === 'desktop' ? 1440 : 390),
      scale = design.width / previewWidth;
    const rows = [],
      errors = [],
      slots = design.regions.filter((r) => r.role === 'slot');
    let slotIndex = 0;
    for (const entry of design.entries) {
      const region =
        entry.role === 'slot'
          ? slots.find((r) => r.entryId === entry.id) || slots[slotIndex++]
          : design.regions.find((r) => r.role === entry.role);
      if (!region) {
        errors.push({ id: entry.id, code: 'CANVAS_REGION_MISSING', message: '缺少对应文字区，请在编辑器指定位置' });
        continue;
      }
      const box = {
        x: region.x * design.width,
        y: region.y * design.height,
        w: region.w * design.width,
        h: region.h * design.height
      };
      const padding = Math.max(1, 1.2 * scale),
        width = box.w - 2 * padding,
        height = box.h - 2 * padding;
      const titleCss = entry.role === 'header' ? 28 : entry.role === 'footer' ? 8 : design.titleSize;
      const minimum = entry.role === 'header' ? 18 : entry.role === 'footer' ? 7 : 14;
      let chosen = null;
      for (let css = titleCss; css >= minimum; css -= 0.5) {
        const pieces = [],
          fields = [
            ['title', entry.title, css, 700],
            ...(entry.body ? [['body', entry.body, design.bodySize, 400]] : [])
          ];
        let cy = 0,
          failed = false;
        for (const [role, copy, size, weight] of fields) {
          const fontSize = size * scale;
          context.font = `${weight} ${fontSize}px "${family}"`;
          const lines = wrap(copy, width - 2, (value) => context.measureText(value));
          if (!lines) {
            failed = true;
            break;
          }
          if (pieces.length) cy += Math.max(1, 0.65 * scale);
          for (const line of lines) {
            const metrics = ink(context, line, fontSize),
              lineHeight = Math.max(fontSize * 1.02, metrics.ascent + metrics.descent + fontSize * 0.08);
            pieces.push({
              entryId: entry.id,
              regionId: region.id,
              role,
              text: line,
              fontSize,
              weight,
              x: box.x + padding + metrics.left + 1,
              baseline: box.y + padding + cy + metrics.ascent,
              w: metrics.right + metrics.left + 1,
              h: metrics.ascent + metrics.descent,
              ascent: metrics.ascent,
              cssPixels: size
            });
            cy += lineHeight;
          }
        }
        // 最后一行之后的行距不占用墨迹高度；按实际字形底边计算，避免正常双行文案被误判溢出。
        const inkHeight = Math.max(0, ...pieces.map((row) => row.baseline - row.ascent + row.h - box.y - padding));
        if (!failed && inkHeight <= height + 0.01) {
          const offset = Math.max(0, (height - inkHeight) / 2);
          chosen = pieces.map((row) => ({ ...row, baseline: row.baseline + offset }));
          break;
        }
      }
      if (!chosen) {
        errors.push({
          id: entry.id,
          code: 'CANVAS_TEXT_OVERFLOW',
          message: '全文在可读字号下装不进该槽，请调整文字区或拆版'
        });
        continue;
      }
      for (const row of chosen) {
        const inkBox = { x: row.x - 1, y: row.baseline - row.ascent, w: row.w, h: row.h };
        if (
          inkBox.x < box.x - 0.05 ||
          inkBox.y < box.y - 0.05 ||
          inkBox.x + inkBox.w > box.x + box.w + 0.05 ||
          inkBox.y + inkBox.h > box.y + box.h + 0.05
        )
          errors.push({ id: entry.id, code: 'CANVAS_TEXT_BOUNDS' });
        const blocked = design.protected.some((p) =>
          overlap(inkBox, {
            x: p.x * design.width,
            y: p.y * design.height,
            w: p.w * design.width,
            h: p.h * design.height
          })
        );
        if (blocked)
          errors.push({
            id: entry.id,
            code: 'CANVAS_PROTECTED_OVERLAP',
            message: '文字进入人物/图标保护区，请调整位置'
          });
      }
      rows.push(...chosen);
    }
    if (slots.length !== design.entries.filter((e) => e.role === 'slot').length)
      errors.push({ code: 'CANVAS_SLOT_COUNT', message: '卡槽数与文案条数不一致，未丢掉任何文案' });
    for (let i = 0; i < rows.length; i++)
      for (const b of rows.slice(i + 1)) {
        const a = rows[i];
        if (
          a.text &&
          b.text &&
          overlap(
            { x: a.x, y: a.baseline - a.ascent, w: a.w, h: a.h },
            { x: b.x, y: b.baseline - b.ascent, w: b.w, h: b.h }
          )
        )
          errors.push({ id: a.entryId, code: 'CANVAS_TEXT_OVERLAP' });
      }
    for (const e of design.entries)
      for (const role of ['title', 'body']) {
        const expected = e[role] || '',
          actual = rows
            .filter((r) => r.entryId === e.id && r.role === role)
            .map((r) => r.text)
            .join('');
        if (actual !== expected.replace(/\n/g, '')) errors.push({ id: e.id, code: 'CANVAS_COPY_MISMATCH' });
      }
    return {
      status: errors.length ? 'needs_layout' : 'passed',
      rows,
      errors: errors.slice(0, 20),
      previewWidth,
      minimumBodyPixels: Math.min(...rows.filter((r) => r.role === 'body').map((r) => r.cssPixels), design.bodySize)
    };
  }
  function contrast(pixels, width, height, row, candidate) {
    const rgb = candidate
        .slice(1)
        .match(/../g)
        .map((n) => parseInt(n, 16)),
      text = rgbLuma(...rgb),
      values = [];
    const x0 = Math.max(0, Math.floor(row.x)),
      y0 = Math.max(0, Math.floor(row.baseline - row.ascent));
    const x1 = Math.min(width, Math.ceil(row.x + row.w)),
      y1 = Math.min(height, Math.ceil(row.baseline - row.ascent + row.h));
    const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 600)));
    for (let y = y0; y < y1; y += step)
      for (let x = x0; x < x1; x += step) {
        const i = (y * width + x) * 4;
        if (pixels[i + 3] < 250) return 0;
        const bg = rgbLuma(pixels[i], pixels[i + 1], pixels[i + 2]);
        values.push((Math.max(bg, text) + 0.05) / (Math.min(bg, text) + 0.05));
      }
    values.sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length * 0.1)] : 0;
  }
  function colorRows(context, design, layout, originalPixels) {
    const pixels = originalPixels || context.getImageData(0, 0, design.width, design.height).data,
      failed = [];
    const rows = layout.rows.map((row) => {
      const choices = design.textColor ? [design.textColor] : ['#103B65', '#000000', '#FFFFFF'];
      const options = choices
        .map((color) => ({ color, ratio: contrast(pixels, design.width, design.height, row, color) }))
        .sort((a, b) => b.ratio - a.ratio);
      const minimum = row.fontSize >= 24 ? 4.5 : 7;
      const selected =
        choices.map((color) => options.find((o) => o.color === color)).find((o) => o.ratio >= minimum) || options[0];
      if (row.text && selected.ratio < minimum)
        failed.push({ entryId: row.entryId, code: 'CANVAS_CONTRAST_LOW', ratio: round(selected.ratio), minimum });
      return { ...row, color: selected.color, contrast: round(selected.ratio) };
    });
    return {
      ...layout,
      rows,
      contrast: { status: failed.length ? 'failed' : 'passed', failed },
      status: layout.errors.length || failed.length ? 'needs_layout' : 'passed',
      errors: [...layout.errors, ...failed].slice(0, 20)
    };
  }
  function paint(context, layout, family) {
    if (layout.status !== 'passed') return false;
    context.textBaseline = 'alphabetic';
    context.textAlign = 'left';
    context.globalAlpha = 1;
    for (const row of layout.rows) {
      context.font = `${row.weight} ${row.fontSize}px "${family}"`;
      context.fillStyle = row.color;
      context.fillText(row.text, row.x, row.baseline);
    }
    return true;
  }
  function verifyBackground(before, after, design, layout) {
    const w = design.width,
      h = design.height,
      mask = new Uint8Array(w * h);
    for (const row of layout.rows) {
      const x0 = Math.max(0, Math.floor(row.x - 2)),
        x1 = Math.min(w, Math.ceil(row.x + row.w + 2));
      const y0 = Math.max(0, Math.floor(row.baseline - row.ascent - 2)),
        y1 = Math.min(h, Math.ceil(row.baseline - row.ascent + row.h + 2));
      for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
    }
    let changedOutsideText = 0,
      changedInProtected = 0,
      changed = 0;
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      if (
        before[p] === after[p] &&
        before[p + 1] === after[p + 1] &&
        before[p + 2] === after[p + 2] &&
        before[p + 3] === after[p + 3]
      )
        continue;
      changed++;
      if (!mask[i]) changedOutsideText++;
      const x = (i % w) / w,
        y = Math.floor(i / w) / h;
      if (design.protected.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) changedInProtected++;
    }
    return {
      status: changed > 0 && !changedOutsideText && !changedInProtected ? 'passed' : 'failed',
      changedOutsideText,
      changedInProtected,
      changedPixels: changed
    };
  }
  return { plan, colorRows, paint, verifyBackground };
}

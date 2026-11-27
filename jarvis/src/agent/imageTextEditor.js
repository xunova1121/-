/** 保持原图构图的离线编辑器；显示与导出复用同一Canvas排字引擎，不使用SVG或遮挡面板。 */
import { createImageTextEngine } from './imageTextEngine.js';
import { createCanvasFontProbe } from './imageTextFontProbe.js';
import { SENTINEL_FONT } from './posterFonts.js';
import { canvasFamilies } from './imageTextRaster.js';
const json = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

// 工厂自包含，避免Vite压缩后嵌入HTML引用模块内的短变量。
function editorRuntime(design, imageData, engine, checkFonts, families) {
  const $ = (id) => document.getElementById(id),
    canvas = $('art'),
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = new Image(),
    select = $('entry'),
    status = $('status'),
    stage = $('stage'),
    box = $('box');
  let family,
    layout,
    generation = 0,
    pending,
    lastGlyphs,
    gesture;
  canvas.width = design.width;
  canvas.height = design.height;
  function region() {
    const entry = design.entries[select.selectedIndex];
    return entry.role === 'slot'
      ? design.regions.find((r) => r.role === 'slot' && r.entryId === entry.id)
      : design.regions.find((r) => r.role === entry.role);
  }
  function position() {
    const r = region();
    box.hidden = !r || !$('guides').checked || $('original').checked;
    if (r)
      Object.assign(box.style, {
        left: r.x * 100 + '%',
        top: r.y * 100 + '%',
        width: r.w * 100 + '%',
        height: r.h * 100 + '%'
      });
  }
  function choose() {
    const entry = design.entries[select.selectedIndex];
    $('title').value = entry.title;
    $('body').value = entry.body;
    position();
  }
  function validRegions() {
    return design.regions.every(
      (r) =>
        [r.x, r.y, r.w, r.h].every(Number.isFinite) &&
        r.x >= 0 &&
        r.y >= 0 &&
        r.w > 0 &&
        r.h > 0 &&
        r.x + r.w <= 1.000001 &&
        r.y + r.h <= 1.000001
    );
  }
  async function render() {
    const current = ++generation;
    $('png').disabled = true;
    if (!image.complete || !image.naturalWidth) return;
    if ($('original').checked) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      box.hidden = true;
      status.textContent = '正在对照原图；关闭对照后可继续编辑和导出';
      status.dataset.state = 'original';
      return;
    }
    try {
      const text = design.entries.map((e) => e.title + e.body).join('\n');
      if (text.length > 6000 || !validRegions()) throw new Error('文案超长或文字框越界，请调整');
      if (!family || lastGlyphs !== text) {
        family = await checkFonts({ text, families, weights: ['400', '700'] });
        lastGlyphs = text;
      }
      if (current !== generation) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      layout = engine.colorRows(ctx, design, engine.plan(ctx, design, family), before);
      if (!engine.paint(ctx, layout, family))
        throw new Error(layout.errors[0]?.message || '文字框重叠、缺少或放不下全文，请拖动调整');
      const diff = engine.verifyBackground(
        before,
        ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        design,
        layout
      );
      if (diff.status !== 'passed') throw new Error('底图保护检查未通过');
      $('png').disabled = false;
      status.textContent = '可导出 · 原图完整保留 · 文字逐字排版';
      status.dataset.state = 'passed';
    } catch (error) {
      if (current !== generation) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      status.textContent = error.message;
      status.dataset.state = 'needs_layout';
    } finally {
      if (current === generation) position();
    }
  }
  function schedule() {
    $('png').disabled = true;
    clearTimeout(pending);
    pending = setTimeout(render, 100);
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  for (const [index, entry] of design.entries.entries()) {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = entry.role === 'slot' ? '正文 · ' + entry.title : entry.role === 'header' ? '主标题' : '底注';
    select.append(option);
  }
  select.onchange = choose;
  $('guides').onchange = position;
  for (const field of ['title', 'body'])
    $(field).oninput = () => {
      design.entries[select.selectedIndex][field] = $(field).value;
      schedule();
    };
  $('original').onchange = render;
  $('png').onclick = () => {
    if (!$('png').disabled && layout?.status === 'passed')
      canvas.toBlob((blob) => blob && download(blob, design.title + '.png'), 'image/png');
  };
  $('source').onclick = () =>
    download(new Blob([JSON.stringify(design, null, 2)], { type: 'application/json' }), design.title + '.canvas.json');
  stage.onpointerdown = (event) => {
    if ($('original').checked || event.target.closest('button')) return;
    const rect = stage.getBoundingClientRect(),
      x = (event.clientX - rect.left) / rect.width,
      y = (event.clientY - rect.top) / rect.height;
    let r = region(),
      mode = event.target.dataset.resize ? 'resize' : event.target.closest('#box') ? 'move' : 'new';
    if (mode === 'new') {
      const entry = design.entries[select.selectedIndex];
      if (!r) {
        r = {
          id:
            entry.role === 'slot'
              ? 'slot-' + design.entries.slice(0, select.selectedIndex + 1).filter((e) => e.role === 'slot').length
              : entry.role,
          entryId: entry.id,
          role: entry.role,
          x,
          y,
          w: 0.01,
          h: 0.01
        };
        design.regions.push(r);
      }
    }
    gesture = { r, mode, x, y, initial: { ...r } };
    stage.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  stage.onpointermove = (event) => {
    if (!gesture) return;
    const rect = stage.getBoundingClientRect(),
      x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const { r, mode, initial, x: startX, y: startY } = gesture;
    if (mode === 'move') {
      r.x = Math.max(0, Math.min(1 - r.w, initial.x + x - startX));
      r.y = Math.max(0, Math.min(1 - r.h, initial.y + y - startY));
    } else if (mode === 'resize') {
      r.w = Math.max(0.01, Math.min(1 - r.x, initial.w + x - startX));
      r.h = Math.max(0.01, Math.min(1 - r.y, initial.h + y - startY));
    } else {
      r.x = Math.min(x, startX);
      r.y = Math.min(y, startY);
      r.w = Math.max(0.01, Math.abs(x - startX));
      r.h = Math.max(0.01, Math.abs(y - startY));
    }
    design.detection = { method: 'editor', confidence: 1 };
    position();
    $('png').disabled = true;
  };
  stage.onpointerup = () => {
    if (gesture) {
      gesture = null;
      schedule();
    }
  };
  stage.onpointercancel = () => {
    if (gesture) {
      Object.assign(gesture.r, gesture.initial);
      gesture = null;
      schedule();
    }
  };
  image.onload = () => {
    choose();
    render();
  };
  image.onerror = () => {
    status.textContent = '原图未能加载';
  };
  image.src = imageData;
}
export function createImageTextEditor(design, imageData) {
  return `<!doctype html><html lang="zh-CN" data-weiyang-editor="canvas-image-text-1"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>未央 · 原图填字</title>
<style>*{box-sizing:border-box}body{margin:0;background:#edf2f8;color:#18314b;font:15px system-ui,sans-serif}main{display:grid;grid-template-columns:280px minmax(0,1fr);gap:24px;padding:24px;max-width:1380px;margin:auto}aside{position:sticky;top:24px;height:max-content;background:white;border-radius:16px;padding:20px}h1{font-size:20px;margin:0 0 12px}p{line-height:1.65;color:#607087}label{display:block;margin:14px 0 6px}input,textarea,select,button{font:inherit;width:100%;padding:10px;border:1px solid #ccd9e7;border-radius:8px}textarea{min-height:80px;resize:vertical}button{cursor:pointer;background:#266ae8;color:white;margin-top:10px}button:disabled{opacity:.45;cursor:default}.check input{width:auto}.check{display:flex;gap:8px;align-items:center}#stage{position:relative;touch-action:none;user-select:none;width:100%;max-width:900px;margin:auto;line-height:0}canvas{width:100%;height:auto;display:block}#box{position:absolute;border:2px dashed #1669f4;cursor:move;background:transparent}#box span{position:absolute;right:-7px;bottom:-7px;width:16px;height:16px;border:2px solid white;background:#1669f4;cursor:se-resize}#status{font-size:13px;line-height:1.6;margin-top:12px}#status[data-state=needs_layout]{color:#a35113}@media(max-width:700px){main{grid-template-columns:1fr;padding:12px;gap:12px}aside{position:static}#stage{grid-row:1}textarea{min-height:60px}}</style>
<main><aside><h1>原图填字</h1><p>拖动蓝框调整位置，拖右下角改大小。点空白处拖画可重设所选文字区。边框只在编辑时显示。</p><label for="entry">编辑哪段文字</label><select id="entry"></select><label for="title">标题</label><textarea id="title" maxlength="500"></textarea><label for="body">补充文字</label><textarea id="body" maxlength="1600"></textarea><label class="check"><input id="guides" type="checkbox" checked>显示文字框</label><label class="check"><input id="original" type="checkbox">对照原图</label><button id="png" disabled>导出原尺寸 PNG</button><button id="source">保存可编辑源稿</button><div id="status" role="status">正在加载原图与中文字体…</div><p>源稿重新导入未央时需保留原图；ZIP已附原字节素材。修改后PPTX需由未央从源稿重新导出。导出像素不代表素材原生细节。</p></aside><div id="stage"><canvas id="art" aria-label="海报预览"></canvas><div id="box" hidden><span data-resize="true"></span></div></div></main>
<script>(${editorRuntime.toString()})(${json(design)},${json(imageData)},(${createImageTextEngine.toString()})(),(${createCanvasFontProbe.toString()})(${json(SENTINEL_FONT)}),${json(canvasFamilies(design.fontFamily))});</script></html>`;
}

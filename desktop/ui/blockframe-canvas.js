/**
 * ══════════ 把设定集那些图拼成一张构图底图 ══════════
 *
 * 版式（谁在画面哪儿、多大、谁挡谁）由 core/pipeline/blockframe.js 算，
 * 这里只负责把图画上去、导出成 PNG。几何留在那边是为了能在自检里验 ——
 * 塞进画布代码里就只能靠肉眼看，而"谁挡谁、谁多大"看图是看不准的。
 *
 * ⚠ **图必须走同源地址（/media?…），不能用 sheetUrl。**
 *
 * 配了对象存储之后 sheetUrl 是 OSS 的跨域地址。跨域图画进 canvas 会把它
 * **污染**掉，紧接着 toDataURL() 抛 SecurityError —— 而在此之前一切正常：
 * 图画出来了、看着好好的，只有导出那一下炸。表现是"预览是对的，一保存就失败"，
 * 极难往跨域上想。所以调用方传进来的 url 必须是 /media 那条同源路由。
 */

import * as blockframe from '/blockframe.js';

/** 加载一张图。失败**不抛** —— 少一张图不该让整张底图作废 */
function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
    return undefined;
  });
}

/** 铺满整个画面，多出来的裁掉（背景图和画幅比例往往对不上） */
function drawCover(ctx, img, W, H) {
  const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

/**
 * 没有设定图的那些，画一个带名字的占位框。
 *
 * ⚠ 不能什么都不画。底图上少一个人，用户看到的是"底图画错了"，
 * 而真实原因是"这个角色在设定集里还没出图"—— 两件事的下一步完全不同。
 * 占位框把这件事摆在脸上，而且它对模型也是有用的：那个位置有个东西。
 */
function drawPlaceholder(ctx, rect, name) {
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.font = `${Math.max(11, Math.round(rect.w / 6))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(name || '?', rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.restore();
}

/**
 * 画出来。
 *
 * @param frame  blockframe.layout() 的结果
 * @param urls   { [name]: 同源地址 }。背景也在里面，按 frame.backdrop.name 取
 * @returns { canvas, dataUrl, drawn, missing }
 */
export async function compose(frame, urls = {}, { width = 1024, height = 576 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  /**
   * 底色。没有场景图时它就是全部背景 —— 上深下浅，
   * 至少给模型一条"哪边是天、哪边是地"的线索，比纯黑强
   */
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#2c3340');
  sky.addColorStop(frame?.horizonY ?? 0.5, '#4a5566');
  sky.addColorStop(1, '#23282f');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  if (!frame) return { canvas, dataUrl: canvas.toDataURL('image/png'), drawn: 0, missing: [] };

  const back = frame.backdrop ? await loadImage(urls[frame.backdrop.name]) : null;
  if (back) drawCover(ctx, back, width, height);

  let drawn = 0;
  const missing = [];
  // frame.items 已经按"远的在前"排好了，照着画就是正确的遮挡关系
  for (const item of frame.items) {
    // eslint-disable-next-line no-await-in-loop
    const img = await loadImage(urls[item.name]);
    const aspect = img ? img.naturalWidth / img.naturalHeight : 0.55;
    const rect = blockframe.rectOf(item, { width, height, aspect });
    if (img) {
      ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
      drawn += 1;
    } else {
      drawPlaceholder(ctx, rect, item.name);
      missing.push(item.name);
    }
  }

  /**
   * ⚠ 导出这一下是**唯一**会因为跨域炸掉的地方，而且在此之前一切正常。
   * 把原因说清楚，不然只会看到一句 SecurityError。
   */
  let dataUrl = null;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch (err) {
    throw new Error(
      '底图合成不出来：画布被跨域图片污染了。设定集的图要走本机的 /media 地址，'
      + `不能直接用对象存储那个地址。（原始报错：${err.message}）`
    );
  }
  return { canvas, dataUrl, drawn, missing };
}

/**
 * ══════════ 构图底图那一块界面 ══════════
 *
 * 一张预览 + 一颗「重拼底图」。
 *
 * ⚠ **拼底图这件事必须是显式的一下，不能跟着拖动自动重拼。**
 *
 * 拖一下重拼一次的话：每拖一格就要读一遍所有设定图、画一遍、
 * 传一个几百 KB 的 base64 上去。手感会烂掉，而且服务器上会堆一大堆
 * 中间版本。更要紧的是 —— 用户拖的过程中有大量"路过"的位置，
 * 把它们一一存下来毫无意义。
 *
 * 代价是排位和底图可能对不上，所以那边存了指纹：一旦对不上，
 * 这里会摆明说"这张不作数了"，出图那边也不会发它。
 */
export function blockFramePanel({
  stage, scene = '', assets = {},
  /** 服务端记下的那一版：{ has, stale, url } */
  saved = null,
  onSave = async () => {},
  width = 640
} = {}) {
  const host = document.createElement('div');
  host.className = 'blockframe-panel';

  const head = document.createElement('div');
  head.className = 'previz-row';
  head.append(Object.assign(document.createElement('span'), { className: 'previz-cap', textContent: '构图底图' }));

  const btn = document.createElement('button');
  btn.className = 'btn sm';
  btn.textContent = saved?.has ? '重拼底图' : '拼一张底图';
  head.append(btn);

  const note = document.createElement('div');
  note.className = 'previz-readout';

  const preview = document.createElement('div');
  preview.className = 'blockframe-preview';

  host.append(head, note, preview);

  const say = (msg, tone = '') => {
    note.textContent = msg;
    note.className = `previz-readout${tone ? ` ${tone}` : ''}`;
  };

  if (saved?.has && saved.stale) {
    say('⚠ 排位改过了，这张底图已经不作数 —— 出图时不会发它。点「重拼底图」按现在的排位重拼一张。', 'warn');
  } else if (saved?.has) {
    say('出图时会带上它。模型只照它定构图，画面本身仍按这一镜的描述和风格画。');
  } else {
    say('排好位之后拼一张：把设定集里的人、景、物按机位摆到画面上。这张图是排位唯一能影响出图的通道。');
  }
  if (saved?.url) {
    const img = new Image();
    img.src = saved.url;
    img.className = 'blockframe-img';
    preview.append(img);
  }

  btn.onclick = async () => {
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = '拼图中…';
    try {
      const frame = blockframe.layout(stage, assets, { scene });
      if (!frame) throw new Error('这一镜还没排位');
      const urls = Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, v.url]));
      const { dataUrl, missing } = await compose(frame, urls, { width, height: Math.round(width * 9 / 16) });

      while (preview.firstChild) preview.removeChild(preview.firstChild);
      const img = new Image();
      img.src = dataUrl;
      img.className = 'blockframe-img';
      preview.append(img);

      await onSave(dataUrl);

      /**
       * ⚠ 把 blockframe.issues() 的话原样说出来。
       *
       * 底图上少一个人、有人出画、场景没图 —— 这些**不该拦着**，
       * 但一个字不说的话，用户看到的是"底图画错了"，
       * 而真实原因（那个角色还没出设定图）完全另一回事。
       */
      const iss = blockframe.issues(frame);
      const extra = missing.length ? [`${missing.join('、')} 没有设定图，底图上是占位框`] : [];
      say(['底图拼好了，出图时会带上它。', ...iss, ...extra].join(' '), iss.length || extra.length ? 'warn' : '');
    } catch (err) {
      say(`没拼成：${err.message}`, 'warn');
    } finally {
      btn.disabled = false;
      btn.textContent = was === '拼图中…' ? '重拼底图' : was;
    }
  };

  return host;
}

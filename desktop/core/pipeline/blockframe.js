/**
 * ══════════ 构图底图：把排好的位算成"画面上谁在哪儿" ══════════
 *
 * ── 这个模块存在的理由 ──
 *
 * 预演台排完位之后，那些坐标要怎么影响出图？一个很自然但**错误**的答案是
 * 把坐标写成一段话发给模型：
 *
 *   "摄影机从坐标(-1.23,0.00,2.45)、35mm 运动到(0.42,1.10,1.80)；
 *    人物从(-1.10,0.10)移动到(0.30,0.80)，路径2.34米……"
 *
 * 出图和出视频的模型**不消费世界坐标**。这段话最好的结果是被忽略，
 * 最坏的结果是挤占提示词预算、把真正起作用的那部分（主体、动作、风格）稀释掉。
 * 排了半天位，出来的画一点没变 —— 而没有任何东西会报错。
 *
 * 模型真正吃的是**画面**。所以这里做的事情是：把 previz 那套机位几何
 * 算成一张"谁在画面的哪个位置、多大、谁挡谁"的版式，让浏览器照着它
 * 把设定集里那些图拼成一张构图底图。那张图才是能发出去的东西。
 *
 * ── 为什么不用 3D ──
 *
 * 这个产品手上的资产是**设定集里那些 2D 图**：角色图、场景图、道具图，
 * 而且它们已经是一致的（同一个种子、同一段冻结描述出的）。
 * 拿它们拼一张构图图，人一开始就是对的人。
 *
 * 换成 3D 的话，得先有 3D 角色模型、绑骨骼、配材质 —— 那是一条美术管线，
 * 而且拼出来的人**不是**设定集里那个人。为了一个更准的透视，
 * 把这个产品唯一的长处（一致性）丢掉了。
 *
 * 这里的透视是近似的：地面水平、机位平视、人物是贴在地上的正投影片。
 * 对"谁站左边、谁站右边、谁大谁小、谁挡谁"这几件事，这个近似完全够用 ——
 * 而这几件事正是排位要解决的全部问题。
 */

import * as previz from './previz.js';

/** 人默认多高（米）。设定集里没写身高时用它 —— 亚洲成年人的中位数附近 */
export const DEFAULT_SUBJECT_H = 1.7;
/** 道具默认多高（米）。桌椅箱笼这个量级 */
export const DEFAULT_MARK_H = 0.9;

/**
 * 一个东西落在画面上的什么地方。
 *
 * 返回的都是**画面比例**（0..1，左上角是原点），不是像素 ——
 * 这样同一份版式在缩略图和大图上都成立，浏览器那边乘一下宽高就行。
 *
 *   cx      中心横坐标（0 最左、1 最右）
 *   feetY   **脚底**落在竖直方向的哪儿。不是中心：人是站在地上的，
 *           对齐脚底才能保证"近的人脚在画面下方、远的人脚在上方"这个
 *           最基本的纵深线索。对齐中心的话，所有人的腰会排成一条线
 *   hFrac   这个东西占画面高度的几分之几
 *   depth   离机位多远（米）。排绘制顺序用：远的先画，近的后画才挡得住
 */
function place(cam, aim, target, heightM) {
  const sx = previz.screenX(cam, aim, target);
  if (sx === null) return null; // 在机位背后，画不出来

  const d = previz.distance(cam, target);
  const fh = previz.framedHeight(d, cam.lens);
  if (!(fh > 0)) return null;

  const camH = Number(cam.height);
  // 平视机位：光轴所在的世界高度就是机位高度。
  // 世界高度 h 的一个点，落在画面竖直方向的比例 = 0.5 + (camH − h) / fh
  const feetY = 0.5 + (Number.isFinite(camH) ? camH : 1.6) / fh;

  return {
    cx: 0.5 + sx * 0.5,
    feetY,
    hFrac: heightM / fh,
    depth: d,
    sx
  };
}

/**
 * 整张画面的版式。
 *
 * @param stage  预演台排的位（cam / subjects / marks）
 * @param assets 每个名字对应哪张图。{ [name]: { url, kind } }
 *               没有图的照样算进版式并标出来 —— 界面要说得出"这个人没有设定图，
 *               所以底图上是个占位框"，不然用户只会觉得底图画错了
 * @param scene  这一镜的场景名。它在**镜头**上而不是排位上（一个排位可以
 *               被别的镜头继承），所以得单独传进来当背景
 */
export function layout(stage, assets = {}, { scene = null } = {}) {
  const st = previz.normalizeStage(stage);
  if (!st) return null;
  const aim = previz.aimBearing(st);
  const cam = st.cam;

  const items = [];

  for (const s of st.subjects) {
    const a = assets[s.name] || {};
    const spot = place(cam, aim, s, Number(a.heightM) || DEFAULT_SUBJECT_H);
    if (!spot) continue;
    /**
     * 机位在这个人的哪一边 → 该用四视图的哪一格。
     *
     * ⚠ 单独出过 side / back 那张的话**优先用它**：那本来就是一张完整的
     * 单视角图，比从拼版里裁四分之一清楚得多。裁是退而求其次。
     */
    const view = viewOf(cam, s);
    const own = a.angles?.[view] || null;
    items.push({
      ...spot,
      name: s.name,
      kind: 'character',
      facing: s.facing,
      view,
      url: own || a.url || null,
      // 用的是单独那张就不裁；用拼版才裁，而且只在确知是四视图时裁
      crop: own ? null : cropFor(a.sheetLayout, view),
      /**
       * 能不能抠背景。模型出的设定图是"纯色浅灰背景"，抠了才不会
       * 把一块灰底贴进画面；用户传的真实照片背景千奇百怪，硬抠只会挖出破洞。
       */
      keyable: a.source !== 'upload',
      sheetLayout: a.sheetLayout || null
    });
  }

  for (const m of st.marks) {
    const a = assets[m.name] || {};
    /**
     * ⚠ 远景地标（山、塔、天际线）**没有坐标**，只有方位。
     *
     * 硬给它编一个距离，机位挪三米它就在画面里横移半个屏 —— 而真山不会。
     * 所以远景只算横向位置，纵向按地平线放，大小固定，深度记为无穷远
     * （永远第一个画，谁都挡得住它）。
     */
    if (m.far) {
      const sx = previz.markScreenX(cam, aim, m);
      if (sx === null) continue;
      items.push({
        cx: 0.5 + sx * 0.5, feetY: 0.5, hFrac: 0.18, depth: Infinity, sx,
        name: m.name, kind: 'far', url: a.url || null, crop: null, keyable: a.source !== 'upload'
      });
      continue;
    }
    const spot = place(cam, aim, m, Number(a.heightM) || DEFAULT_MARK_H);
    if (!spot) continue;
    // 道具设定图是"单体居中、纯色背景"的产品图，本来就是单视角，不用裁
    items.push({ ...spot, name: m.name, kind: 'prop', url: a.url || null, crop: null, keyable: a.source !== 'upload' });
  }

  /**
   * ⚠ **远的先画，近的后画。**画反了就是近处的人被远处的箱子挡住 ——
   * 而这恰恰是排位要解决的问题之一，画反了等于把答案弄反。
   */
  items.sort((a, b) => b.depth - a.depth);

  return {
    aim: Number(aim?.toFixed?.(1) ?? aim ?? 0),
    lens: cam.lens,
    camHeight: cam.height,
    backdrop: scene && assets[scene]?.url ? { name: scene, url: assets[scene].url } : null,
    sceneName: scene || null,
    /**
     * 地平线落在画面哪一行。
     *
     * 平视机位下它**永远在正中**，跟机位高多少无关 —— 变的是地面从哪儿开始，
     * 不是地平线在哪儿。（站在凳子上看海，海平线还是在眼睛正前方。）
     */
    horizonY: 0.5,
    items
  };
}

/**
 * ══════════ 四视图设定图：只能取其中一格 ══════════
 *
 * ⚠ **这是两个各自都对的功能凑在一起坏掉的地方。**
 *
 * 角色设定图现在是一张**四视图拼版**（charSheetPrompt 写死了排布：
 * 16:9、横向并排、从左到右 ①上半身特写 ②全身正面 ③全身正侧 ④全身背面）。
 * 而构图底图要往画面上贴"一个人"。整张贴过去的话，那个位置站的是
 * **一个矩形里的四个小人** —— 不是效果差一点，是完全错的，
 * 而且模型会照着那个矩形画。
 *
 * 所以按机位算出该用哪一格，只裁那一格出来。
 *
 * ⚠ 判据是 previz.facingRelation —— **几何算的，不是从描述里猜关键词**。
 * 人背对镜头时贴一张正脸，正是当初做四视图要解决的问题；
 * 在这条新路上再犯一次的话，等于白做。
 */
export const TURNAROUND_4 = 'turnaround-4';

/** 四格从左到右的顺序，和 charSheetPrompt 里写的那句一一对应 */
const TURNAROUND_SLOT = { closeup: 0, primary: 1, side: 2, back: 3 };

/**
 * 机位在这个人的哪一边 → 该用哪一格。
 * 回的是 angles.js 的角度 id（primary / side / back），和别处一致。
 */
export function viewOf(cam, subject) {
  return previz.facingRelation(cam, subject)?.sheet || 'primary';
}

/**
 * 该从原图上裁哪一块（比例，0..1）。不是四视图就回 null（整张用）。
 *
 * ⚠ **只有确知是四视图的才裁。**老项目里的设定图是改版之前出的单视角
 * 半身像，按四分之一去裁会裁出半个肩膀 —— 而那种错看图很难看出来，
 * 只会觉得"底图怪怪的"。所以靠出图时记下的 sheetLayout 判断，不靠猜。
 */
export function cropFor(sheetLayout, view) {
  if (sheetLayout !== TURNAROUND_4) return null;
  const i = TURNAROUND_SLOT[view] ?? TURNAROUND_SLOT.primary;
  return { x: i / 4, y: 0, w: 1 / 4, h: 1 };
}

/**
 * ══════════ 把纯色背景抠掉 ══════════
 *
 * 设定图是**带背景的整张图**（charSheetPrompt 要的是"纯色浅灰背景、
 * 均匀柔光、无投影"）。直接贴上去，等于把那块灰底也贴进画面 ——
 * 底图会是一堆互相叠着的灰矩形，而模型很可能把那些硬边缘当成真实内容画进去。
 *
 * ⚠ **从边缘漫延，不是"按颜色全局筛"。**
 *
 * 全局筛的话，人物身上任何接近底色的部分都会被一起挖空 ——
 * 浅色衬衫、白袖口、灰头发。那种破洞在缩略图上看不出来，
 * 到了成图上表现为"这个人身上有一块背景透出来"，而且查不到原因。
 * 从四条边往里漫延只会吃掉**真正连着边框**的那片背景，
 * 人身上的浅色区域和边框不连通，碰不到。
 *
 * @param img  { data: Uint8ClampedArray|Array, width, height }，就地改 alpha
 * @param tolerance 每个通道允许差多少（0..255）
 * @returns 抠掉了多少个像素
 */
export function keyOutFlatBackground(img, { tolerance = 26 } = {}) {
  const { data, width: w, height: h } = img;
  if (!data || !w || !h) return 0;

  /**
   * 底色取**四个角的中位数**，不是平均值。
   * 平均值会被某个角上探进来的人物边缘拽偏，然后整片背景都抠不干净。
   */
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(([x, y]) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  });
  const mid = (n) => {
    const v = corners.map((c) => c[n]).sort((a, b) => a - b);
    return (v[1] + v[2]) / 2;
  };
  const bg = [mid(0), mid(1), mid(2)];

  /**
   * ⚠ 四个角彼此差太远，说明这压根不是纯色背景（比如用户传的真实照片）——
   * 这时候**什么都别抠**。硬抠的结果是把照片挖得千疮百孔，
   * 比不抠难看得多，而且没人看得出是我们干的。
   */
  const spread = Math.max(...[0, 1, 2].map((n) => {
    const v = corners.map((c) => c[n]);
    return Math.max(...v) - Math.min(...v);
  }));
  if (spread > tolerance * 2) return 0;

  const near = (i) => Math.abs(data[i] - bg[0]) <= tolerance
    && Math.abs(data[i + 1] - bg[1]) <= tolerance
    && Math.abs(data[i + 2] - bg[2]) <= tolerance;

  // 从四条边往里漫延。用显式栈，不用递归 —— 一张 1024 宽的图会把调用栈撑爆
  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x += 1) { stack.push(x, x + (h - 1) * w); }
  for (let y = 0; y < h; y += 1) { stack.push(y * w, w - 1 + y * w); }

  let cleared = 0;
  while (stack.length) {
    const p = stack.pop();
    if (seen[p]) continue;
    seen[p] = 1;
    const i = p * 4;
    if (!near(i)) continue;
    data[i + 3] = 0;
    cleared += 1;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  return cleared;
}

/**
 * 排位的指纹。只取**会影响画面**的那些量。
 *
 * ⚠ 不能直接 JSON.stringify 整个 stage：里面有 move（运镜）这类
 * 不改变静帧构图的字段，还有键序不稳定的风险。那样底图会被判成
 * "过期"而其实没过期，用户每次都被劝去重拼一次，劝多了就不看了。
 */
export function stageStamp(stage) {
  const st = previz.normalizeStage(stage);
  if (!st) return '';
  const n = (v) => Number(v || 0).toFixed(2);
  return [
    `c${n(st.cam.x)},${n(st.cam.y)},${n(st.cam.height)},${n(st.cam.lens)}`,
    ...st.subjects.map((s) => `s${s.name}:${n(s.x)},${n(s.y)}`),
    ...st.marks.map((m) => (m.far ? `f${m.name}:${n(m.deg)}` : `m${m.name}:${n(m.x)},${n(m.y)}`))
  ].join('|');
}

/**
 * 一个条目画在画布上的矩形（像素）。
 *
 * 放在这儿而不是画布那边，是因为它是**几何**，可以在自检里直接验；
 * 塞进 canvas 代码里就只能靠肉眼看了 —— 而"谁挡谁、谁多大"看图是看不准的。
 *
 * @param aspect 这张图本身的宽高比（宽/高）。按高度定尺寸再用它反推宽度，
 *               人才不会被压扁 —— 设定集里的图有 16:9 有 9:16，
 *               统一按同一个宽度画的话，竖图里的人会被拉成矮胖子
 */
export function rectOf(item, { width, height, aspect = 1 }) {
  const h = item.hFrac * height;
  const w = h * aspect;
  /**
   * ⚠ 远景地标按**地平线居中**，近处的东西按**脚底着地**。
   *
   * 一座山不是"站"在地平线上的 —— 它跨在地平线两边。按脚底对齐的话，
   * 整座山会浮到地平线以上，看着像悬空的布景板。
   */
  const top = item.kind === 'far' ? item.feetY * height - h / 2 : item.feetY * height - h;
  return { x: item.cx * width - w / 2, y: top, w, h };
}

/**
 * 这张底图上有没有明显不对劲的地方。
 *
 * ⚠ 这些**不报错、不拦着出图**，只是说出来。排位是创作行为，
 * "人出画了"有时候正是想要的（画外音、只留一只手）。
 * 拦住它等于替导演做决定，而我们并不知道他要什么。
 */
export function issues(frame) {
  if (!frame) return [];
  const out = [];
  const off = frame.items.filter((i) => i.kind !== 'far' && Math.abs(i.sx) > 1);
  if (off.length) {
    out.push(`${off.map((i) => i.name).join('、')} 落在画面外 —— 底图上看不到他们，`
      + '出图时模型也不会画。要他们入画就把机位往那边转一点，或者换个更广的镜头。');
  }
  const tiny = frame.items.filter((i) => i.kind === 'character' && i.hFrac < 0.06);
  if (tiny.length) {
    out.push(`${tiny.map((i) => i.name).join('、')} 在画面里只有一丁点大 —— `
      + '这个距离上模型基本画不出脸。要看清脸就把机位挪近，或者换长焦。');
  }
  const huge = frame.items.filter((i) => i.kind === 'character' && i.hFrac > 2.2);
  if (huge.length) {
    out.push(`${huge.map((i) => i.name).join('、')} 大到画面装不下 —— `
      + '底图上会被切掉大半。这是特写以上的距离，确认一下是不是机位放太近了。');
  }
  if (!frame.backdrop) {
    out.push('这个场景在设定集里还没有图 —— 底图的背景是空的，'
      + '出图时环境全靠文字描述。先去设定集给这个场景出一张。');
  }
  const noSheet = frame.items.filter((i) => !i.url);
  if (noSheet.length) {
    out.push(`${noSheet.map((i) => i.name).join('、')} 在设定集里没有图 —— `
      + '底图上只有一个占位框，模型看不出那是谁。');
  }
  return out;
}

/**
 * 底图配的那句提示词。
 *
 * ⚠ 说的是**"照着这张图的构图"**，不是"照着这张图画"。
 *
 * 这张底图是设定集的图拼出来的：边缘是硬的、光不统一、比例是近似的。
 * 不说清楚的话，模型会把这些拼贴痕迹当成风格一起学过去，
 * 出来是一张"看得出是拼的"的图。要它读的只有一件事：谁在哪儿、多大、谁挡谁。
 */
export function framePrompt(frame) {
  if (!frame?.items?.length) return '';
  const where = frame.items
    .filter((i) => i.kind !== 'far' && Math.abs(i.sx) <= 1)
    .map((i) => `${i.name}在${previz.sideOfScreen(i.sx)}`);
  return '【构图底图】参考图里那张拼贴图**只用来定构图**：'
    + '人物和道具在画面里的位置、大小、前后遮挡关系照它来。'
    + '它的拼贴边缘、光线不统一、比例误差都不要学 —— 画面本身按这一镜的描述和风格重新画。'
    + (where.length ? `（${where.join('，')}）` : '');
}

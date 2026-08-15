/**
 * 画风预设。
 *
 * 让用户从卡片里挑，而不是对着空输入框想"该怎么描述画风"——
 * 后者是新手最容易卡住的一步，写出来的往往也太笼统（"好看的动漫风"）。
 *
 * 每个预设给三样东西：
 *   anchor    会拼到每一条绘图提示词最前面的风格锚
 *   negative  这个风格特有的负向词（水墨怕线条僵硬，写实怕塑料感）
 *   swatch    缩略图的配色与笔触参数，由界面用 CSS 渐变现画
 *
 * 卡片上那张图有三层，优先级从高到低：
 *   ① 你自己模型出的预览图（「生成预览图」按钮）—— 最有用，它回答的是
 *      "这个画风在**我的模型**上长什么样"；
 *   ② 随应用带的示例图 ui/style-img/<id>.webp —— 一眼认出画风用；
 *   ③ swatch/art 参数现画的示意图 —— 前两样都没有时的兜底，离线免费，
 *      新加预设时不至于开天窗。
 *
 * ②这一层的图必须是**自己有权分发**的（用户自备或自己出的）。
 * 从网上找来的图随应用发出去，版权风险落在用它的人头上。
 */

import fs from 'node:fs';
import path from 'node:path';
import { STYLE_DIR, UI_DIR, safeFileName } from './paths.js';

export const STYLE_PRESETS = [
  {
    id: 'ink',
    name: '国风水墨',
    hint: '留白、墨色浓淡、写意',
    anchor: '国风水墨画风，宣纸质感，墨色浓淡分明，大量留白，写意笔触，电影感构图',
    negative: '3D渲染, 塑料质感, 过度饱和, 线条僵硬, 西方油画',
    palette: '墨黑、赭石、青灰',
    swatch: { from: '#F2EDE2', to: '#3A4048', accent: '#6E7B85', texture: 'ink' },
    art: { sky: ['#F7F3EA', '#EFE8DA'], hills: ['#9AA4AD', '#69737E', '#3A4048'], water: '#E6E1D5', glow: '#B9AFA0', ink: '#2A2E33', mode: 'wash', paper: true }
  },
  {
    id: 'anime',
    name: '日式动漫',
    hint: '赛璐璐上色、清晰轮廓线',
    anchor: '日式动画赛璐璐画风，清晰轮廓线，平涂上色，柔和高光，明快色彩',
    negative: '写实照片, 3D渲染, 线条模糊, 过度阴影, 恐怖谷',
    palette: '天蓝、暖橙、樱粉',
    swatch: { from: '#BFE3FF', to: '#FFC9D6', accent: '#FF8A5B', texture: 'flat' },
    art: { sky: ['#BFE3FF', '#FFD9DE'], hills: ['#8FB8D8', '#5E86AC', '#3B5876'], water: '#9FD0EF', glow: '#FF8A5B', ink: '#22354A', mode: 'cel' }
  },
  {
    id: 'guofeng',
    name: '古风工笔',
    hint: '青绿设色、细勾线、云雾留白',
    /**
     * 这一条按"想要的成片长什么样"重写过一遍。
     *
     * 原来只写了"精细勾线、矿物质颜料、绢本设色"—— 都对，但模型据此画出来的
     * 往往是一张**平铺的纹样图**：满构图、没有空气、没有远近。
     * 真正让古风工笔成立的是另外三样，现在都写进去了：
     *   青绿山水的设色（石青石绿打底，赭石压边）
     *   云雾留白（远山三重、雾气切断中景，画面才有纵深）
     *   暖金逆光（日出或日落，人物压成剪影般的深色轮廓）
     * 顺序也讲究：先定画种和技法，再定色，最后定光 —— 越靠前权重越高。
     */
    anchor:
      '中国古风工笔重彩，细笔勾线填色，绢本设色质感，青绿山水配色，'
      + '远山三重云雾缭绕，大面积留白与雾气，暖金色逆光，飞檐楼阁与松柏点缀，电影感构图',
    negative: '现代元素, 简笔, 粗糙线条, 荧光色, 3D渲染, 塑料质感, 满构图无留白, 西方油画笔触',
    palette: '石青、石绿、赭石、暖金',
    swatch: { from: '#F6E7C8', to: '#3E6B63', accent: '#D9A441', texture: 'fine' },
    art: {
      sky: ['#F7E9CC', '#EAD3A2'],
      hills: ['#8FB3AC', '#5E8C84', '#3E6B63'],
      water: '#E3D6B4',
      glow: '#E8B45F',
      ink: '#3A2A1E',
      mode: 'line'
    }
  },
  {
    id: 'modern',
    name: '现代都市',
    hint: '写实光影、当代场景',
    anchor: '现代都市写实风格，自然光影，浅景深，电影级调色，当代服装与建筑',
    negative: '古代服饰, 卡通, 夸张比例, 过曝',
    palette: '冷灰、玻璃蓝、暖黄路灯',
    swatch: { from: '#D6DEE6', to: '#2B3440', accent: '#F2A65A', texture: 'photo' },
    art: { sky: ['#D6DEE6', '#8FA0B2'], hills: ['#6E7E90', '#495A6B', '#2B3440'], water: '#43525F', glow: '#F2A65A', ink: '#1A2028', mode: 'photo' }
  },
  {
    id: 'cinematic',
    name: '电影质感',
    hint: '胶片颗粒、强反差布光',
    anchor: '电影摄影质感，35mm 胶片颗粒，强反差布光，冷暖对比调色，宽银幕构图',
    negative: '平光, 廉价感, 数码噪点, 过度锐化',
    palette: '青影橙调',
    swatch: { from: '#1B2733', to: '#C86B34', accent: '#5FA8D3', texture: 'grain' },
    art: { sky: ['#22303E', '#5A748A'], hills: ['#4A6B85', '#2E4658', '#18242D'], water: '#2A3E4E', glow: '#E08040', ink: '#0B1116', mode: 'film', grain: true, letterbox: true }
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    hint: '霓虹、雨夜、高对比',
    anchor: '赛博朋克风格，霓虹灯牌，雨夜湿滑街道，高对比冷暖光，未来都市天际线',
    negative: '田园, 自然光, 低饱和, 古典建筑',
    palette: '洋红、青蓝、酸绿',
    swatch: { from: '#12071F', to: '#FF2E93', accent: '#00E5FF', texture: 'neon' },
    art: { sky: ['#12071F', '#31103F'], hills: ['#2A1140', '#1C0B2C', '#120719'], water: '#170A25', glow: '#FF2E93', ink: '#00E5FF', mode: 'neon', rain: true }
  },
  {
    id: 'wuxia',
    name: '武侠写意',
    hint: '刀光剑影、山水做底',
    anchor: '武侠写意风格，山水做背景，衣袂翻飞，刀光剑影，水墨与实景结合，气势开阔',
    negative: '现代服装, 科幻元素, 静态呆板',
    palette: '墨青、竹绿、月白',
    swatch: { from: '#E8EDE6', to: '#2F4538', accent: '#8FA98F', texture: 'ink' },
    art: { sky: ['#EDF1EA', '#DDE5DA'], hills: ['#96AC97', '#5F7A66', '#2F4538'], water: '#DCE4D9', glow: '#B7C7B3', ink: '#22301F', mode: 'wash', paper: true }
  },
  {
    id: 'pixar',
    name: '三维动画',
    hint: '圆润造型、次表面散射',
    anchor: '三维动画电影风格，圆润造型，柔和次表面散射，全局光照，材质细腻，色彩明亮',
    negative: '二维平涂, 写实照片, 恐怖谷, 粗糙建模',
    palette: '奶油黄、天青、珊瑚粉',
    swatch: { from: '#FFE9C2', to: '#4A90D9', accent: '#FF7B6B', texture: 'soft' },
    art: { sky: ['#FFE9C2', '#8CC4EE'], hills: ['#7FB3E0', '#4A90D9', '#2F6DAE'], water: '#63A8DC', glow: '#FF7B6B', ink: '#274A6B', mode: 'soft' }
  },
  {
    id: 'noir',
    name: '黑色电影',
    hint: '硬光、百叶窗阴影',
    anchor: '黑色电影风格，高反差黑白或极低饱和，硬光源，百叶窗条状阴影，烟雾，低角度构图',
    negative: '明快色彩, 平光, 甜美, 高饱和',
    palette: '黑白灰，仅保留极少暖色',
    swatch: { from: '#EDEDED', to: '#0B0B0B', accent: '#8A8A8A', texture: 'noir' },
    art: { sky: ['#E4E4E4', '#9A9A9A'], hills: ['#7A7A7A', '#454545', '#141414'], water: '#2C2C2C', glow: '#FFFFFF', ink: '#000000', mode: 'noir', blinds: true }
  },
  {
    id: 'watercolor',
    name: '水彩绘本',
    hint: '透明叠色、纸纹',
    anchor: '水彩绘本风格，透明颜料叠色，纸张纹理，边缘晕染，柔和轮廓，温暖童话感',
    negative: '硬边, 3D, 金属质感, 冷峻',
    palette: '淡黄、湖蓝、玫瑰',
    swatch: { from: '#FFF6E5', to: '#7FB3D5', accent: '#E8A0BF', texture: 'wash' },
    art: { sky: ['#FFF6E5', '#DCEBF6'], hills: ['#B9D6E6', '#8FBFD8', '#7FB3D5'], water: '#CFE4F0', glow: '#E8A0BF', ink: '#5E7C90', mode: 'wash', paper: true }
  },
  {
    id: 'retro',
    name: '港风复古',
    hint: '八九十年代、暖旧色调',
    anchor: '八九十年代港片复古风格，暖旧色调，轻微褪色，霓虹招牌，颗粒感，怀旧氛围',
    negative: '现代高清, 冷色调, 极简, 无颗粒',
    palette: '暖棕、砖红、旧金',
    swatch: { from: '#F0DCC0', to: '#7A3B2E', accent: '#D9A441', texture: 'grain' },
    art: { sky: ['#F0DCC0', '#C79A6E'], hills: ['#A9724F', '#8A4F38', '#5E2E22'], water: '#8A5A3E', glow: '#D9A441', ink: '#3A1D14', mode: 'film', grain: true }
  },
  {
    id: 'custom',
    name: '自定义',
    hint: '自己写风格描述',
    anchor: '',
    negative: '模糊, 低质量, 畸变, 多余手指, 文字水印',
    palette: '',
    swatch: { from: '#CFCFCF', to: '#5A5A5A', accent: '#9A9A9A', texture: 'flat' },
    art: { sky: ['#D8D8D8', '#A8A8A8'], hills: ['#8F8F8F', '#6A6A6A', '#4A4A4A'], water: '#7A7A7A', glow: '#BEBEBE', ink: '#2E2E2E', mode: 'photo' }
  }
];

/**
 * 画风预览图。
 *
 * 卡片上那张缩略图有两种形态：
 *   ① 没出过预览图时，用 style-art.js 现画的示意图（离线、免费、构图统一）；
 *   ② 出过一次之后，就换成**你自己模型出的真图**，一直用下去。
 *
 * 为什么不直接打包一批现成的图：网上找来的是别人的作品，随应用分发出去
 * 版权说不清 —— 出问题的是用它的人。而用你自己的模型出，图是你的，
 * 顺便还回答了一个更要紧的问题：这个画风在**你的模型**上到底长什么样。
 *
 * 十二张用的是同一句场景描述，只换风格锚 —— 和示意图一样的道理，
 * 构图不变，比较的才是风格本身。
 */
const PREVIEW_SCENE =
  '湖畔栈桥的远景：一个人背对镜头站在栈桥尽头远眺，远山三重，天边一轮日月，水面有倒影。' +
  '画面里只有这一个人，不要文字、不要水印、不要分屏';

export function previewPath(id) {
  return path.join(STYLE_DIR, `${safeFileName(id, 'style')}.png`);
}

/** 这个画风出过预览图没有 */
export function previewFor(id) {
  const file = previewPath(id);
  try {
    const stat = fs.statSync(file);
    return { path: file, at: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** 出这一张预览图要发的提示词。风格锚在最前，和流水线里的装配顺序一致。 */
export function previewPrompt(style) {
  const anchor = style.anchor || style.name;
  return {
    prompt: [anchor, PREVIEW_SCENE, style.palette ? `主色调：${style.palette}` : ''].filter(Boolean).join('，'),
    negative: style.negative || '模糊, 低质量, 畸变, 文字水印'
  };
}

/**
 * 随应用带的画风示例图。
 *
 * 在 ui/style-img/ 里放一张 <id>.webp 就会自动生效，不用改代码 ——
 * 由后端**探一下文件在不在**再告诉前端，而不是让前端直接猜路径：
 * 猜错就是一个碎掉的 <img>，而"某个画风没配图"是很正常的状态，
 * 不该长得像出了故障。没有图的那几个照旧退回内置示意图。
 */
export function bundledArt(id) {
  const file = path.join(UI_DIR, 'style-img', `${safeFileName(id, 'style')}.webp`);
  return fs.existsSync(file) ? `/style-img/${encodeURIComponent(id)}.webp` : null;
}

const IMAGE_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp'
};

/**
 * 用**本地图片**当这个画风的示例图。
 *
 * 为什么需要这条：画风卡上那张图有三层（自己出的预览 > 随应用带的示例 > 现画的示意图），
 * 前两层都可能是空的 —— 随应用带的图必须是有权分发的，所以不是每个画风都有。
 * 而你手上往往**正好有一张**想要的参照：截的一帧、客户给的稿、以前做过的成片。
 * 让它直接变成这个画风的示例图，比"再去出一张"快得多，也准得多。
 *
 * 存的位置和模型出的预览图是同一个（STYLE_DIR/<id>.png），所以它天然优先于
 * 随应用带的那张，删掉也是同一个按钮 —— 不给同一件事造两套开关。
 */
export function attachPreview(id, { dataUrl } = {}) {
  const style = getStyle(id);
  if (!style) throw new Error(`没有这个画风：${id}`);
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('没读到图片内容（需要 data:image/...;base64, 开头的内容）');
  if (!IMAGE_MIME[m[1].toLowerCase()]) throw new Error(`不支持这种图片格式：${m[1]}。用 PNG / JPG / WebP。`);
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('图片是空的');

  fs.mkdirSync(STYLE_DIR, { recursive: true });
  const dest = previewPath(id);
  // 统一落成 previewPath 那个名字（扩展名 .png 只是个文件名，浏览器按内容识别）——
  // 换成别的名字就得再维护一套"到底该显示哪一张"的规则
  fs.writeFileSync(dest, buf);
  return { id, path: dest, at: new Date().toISOString(), bytes: buf.length };
}

/** 带上预览图信息的预设列表，前端直接用 */
export function presetsForUI() {
  return STYLE_PRESETS.map((s) => {
    const preview = previewFor(s.id);
    return {
      ...s,
      previewPath: preview?.path || null,
      previewAt: preview?.at || null,
      // 注意不能叫 art —— 那个名字已经被内置示意图的画面参数占了
      sample: bundledArt(s.id)
    };
  });
}

export function getStyle(id) {
  return STYLE_PRESETS.find((s) => s.id === id) || null;
}

/** 从项目里解析出实际要用的风格锚。自定义就用用户自己写的那段。 */
export function resolveStyle(project) {
  const preset = getStyle(project.styleId);
  if (!preset || preset.id === 'custom') {
    return {
      anchor: project.style || '电影感构图',
      negative: preset?.negative || '模糊, 低质量, 畸变',
      palette: ''
    };
  }
  return {
    // 用户在预设基础上补充的描述接在后面，不覆盖预设
    anchor: project.style ? `${preset.anchor}，${project.style}` : preset.anchor,
    negative: preset.negative,
    palette: preset.palette
  };
}

/**
 * 设定集里的风格锚和预设对不上了吗。
 *
 * 风格锚是在跑第 01 步时**冻结**进设定集的 —— 这是对的，后面几十张图都要引用同一段话，
 * 它不能今天一个样明天一个样。但代价是：
 *
 *   ① 换了画风，老设定集里还是旧那段，出图纹丝不动 ——「我明明换成古风工笔了」；
 *   ② 我把某个预设的提示词改好了（比如给古风工笔补上留白和逆光），
 *      已经跑过设定集的项目一辈子拿不到这个改进。
 *
 * 以前这两种情况的答复都是"重跑第 01 步"，但那要重新生成全部角色和场景，
 * 你手改过的外貌描述全没了 —— 为了换一句话，代价大得离谱。
 *
 * 而风格锚本来就**不是模型产出的**，它直接来自预设。所以完全可以只换这一段，
 * 别的一个字不动。这个函数负责认出"该换了"，换不换由用户点。
 */
export function styleDrift(project) {
  if (!project?.bible?.style) return { drifted: false };
  const want = resolveStyle(project);
  const cur = project.bible.style;
  const drifted =
    cur.anchor !== want.anchor || cur.negative !== want.negative || (cur.palette || '') !== (want.palette || '');
  return { drifted, current: cur, preset: want, name: getStyle(project.styleId)?.name || '自定义' };
}

/**
 * 把预设的风格锚盖回设定集。**只动 style 这一块**，角色、场景、道具原封不动。
 *
 * 会覆盖手写的风格描述 —— 所以这件事必须由用户主动点，绝不能在读取项目时
 * 顺手做掉：那样别人在设定集里改的每一个字都会在下次打开时凭空消失。
 */
export function syncBibleStyle(project) {
  const { drifted, preset } = styleDrift(project);
  if (!drifted) return false;
  project.bible.style = { ...project.bible.style, ...preset };
  return true;
}

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
 * 缩略图刻意不用真实图片：一是离线可用、包体不膨胀，二是不会拿别人的作品
 * 当示例。真想看这个风格出什么样，用「生成预览图」按钮拿你自己的模型出一张。
 */

export const STYLE_PRESETS = [
  {
    id: 'ink',
    name: '国风水墨',
    hint: '留白、墨色浓淡、写意',
    anchor: '国风水墨画风，宣纸质感，墨色浓淡分明，大量留白，写意笔触，电影感构图',
    negative: '3D渲染, 塑料质感, 过度饱和, 线条僵硬, 西方油画',
    palette: '墨黑、赭石、青灰',
    swatch: { from: '#F2EDE2', to: '#3A4048', accent: '#6E7B85', texture: 'ink' }
  },
  {
    id: 'anime',
    name: '日式动漫',
    hint: '赛璐璐上色、清晰轮廓线',
    anchor: '日式动画赛璐璐画风，清晰轮廓线，平涂上色，柔和高光，明快色彩',
    negative: '写实照片, 3D渲染, 线条模糊, 过度阴影, 恐怖谷',
    palette: '天蓝、暖橙、樱粉',
    swatch: { from: '#BFE3FF', to: '#FFC9D6', accent: '#FF8A5B', texture: 'flat' }
  },
  {
    id: 'guofeng',
    name: '古风工笔',
    hint: '精细勾线、矿物颜料',
    anchor: '中国古风工笔画，精细勾线，矿物质颜料，绢本设色，繁复纹样，唐宋气韵',
    negative: '现代元素, 简笔, 粗糙线条, 荧光色',
    palette: '朱砂、石青、藤黄',
    swatch: { from: '#F6E7C8', to: '#8C3B32', accent: '#2E5E6B', texture: 'fine' }
  },
  {
    id: 'modern',
    name: '现代都市',
    hint: '写实光影、当代场景',
    anchor: '现代都市写实风格，自然光影，浅景深，电影级调色，当代服装与建筑',
    negative: '古代服饰, 卡通, 夸张比例, 过曝',
    palette: '冷灰、玻璃蓝、暖黄路灯',
    swatch: { from: '#D6DEE6', to: '#2B3440', accent: '#F2A65A', texture: 'photo' }
  },
  {
    id: 'cinematic',
    name: '电影质感',
    hint: '胶片颗粒、强反差布光',
    anchor: '电影摄影质感，35mm 胶片颗粒，强反差布光，冷暖对比调色，宽银幕构图',
    negative: '平光, 廉价感, 数码噪点, 过度锐化',
    palette: '青影橙调',
    swatch: { from: '#1B2733', to: '#C86B34', accent: '#5FA8D3', texture: 'grain' }
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    hint: '霓虹、雨夜、高对比',
    anchor: '赛博朋克风格，霓虹灯牌，雨夜湿滑街道，高对比冷暖光，未来都市天际线',
    negative: '田园, 自然光, 低饱和, 古典建筑',
    palette: '洋红、青蓝、酸绿',
    swatch: { from: '#12071F', to: '#FF2E93', accent: '#00E5FF', texture: 'neon' }
  },
  {
    id: 'wuxia',
    name: '武侠写意',
    hint: '刀光剑影、山水做底',
    anchor: '武侠写意风格，山水做背景，衣袂翻飞，刀光剑影，水墨与实景结合，气势开阔',
    negative: '现代服装, 科幻元素, 静态呆板',
    palette: '墨青、竹绿、月白',
    swatch: { from: '#E8EDE6', to: '#2F4538', accent: '#8FA98F', texture: 'ink' }
  },
  {
    id: 'pixar',
    name: '三维动画',
    hint: '圆润造型、次表面散射',
    anchor: '三维动画电影风格，圆润造型，柔和次表面散射，全局光照，材质细腻，色彩明亮',
    negative: '二维平涂, 写实照片, 恐怖谷, 粗糙建模',
    palette: '奶油黄、天青、珊瑚粉',
    swatch: { from: '#FFE9C2', to: '#4A90D9', accent: '#FF7B6B', texture: 'soft' }
  },
  {
    id: 'noir',
    name: '黑色电影',
    hint: '硬光、百叶窗阴影',
    anchor: '黑色电影风格，高反差黑白或极低饱和，硬光源，百叶窗条状阴影，烟雾，低角度构图',
    negative: '明快色彩, 平光, 甜美, 高饱和',
    palette: '黑白灰，仅保留极少暖色',
    swatch: { from: '#EDEDED', to: '#0B0B0B', accent: '#8A8A8A', texture: 'noir' }
  },
  {
    id: 'watercolor',
    name: '水彩绘本',
    hint: '透明叠色、纸纹',
    anchor: '水彩绘本风格，透明颜料叠色，纸张纹理，边缘晕染，柔和轮廓，温暖童话感',
    negative: '硬边, 3D, 金属质感, 冷峻',
    palette: '淡黄、湖蓝、玫瑰',
    swatch: { from: '#FFF6E5', to: '#7FB3D5', accent: '#E8A0BF', texture: 'wash' }
  },
  {
    id: 'retro',
    name: '港风复古',
    hint: '八九十年代、暖旧色调',
    anchor: '八九十年代港片复古风格，暖旧色调，轻微褪色，霓虹招牌，颗粒感，怀旧氛围',
    negative: '现代高清, 冷色调, 极简, 无颗粒',
    palette: '暖棕、砖红、旧金',
    swatch: { from: '#F0DCC0', to: '#7A3B2E', accent: '#D9A441', texture: 'grain' }
  },
  {
    id: 'custom',
    name: '自定义',
    hint: '自己写风格描述',
    anchor: '',
    negative: '模糊, 低质量, 畸变, 多余手指, 文字水印',
    palette: '',
    swatch: { from: '#CFCFCF', to: '#5A5A5A', accent: '#9A9A9A', texture: 'flat' }
  }
];

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

/**
 * 画风缩略图。
 *
 * 画的是**同一个镜头**：湖畔、远山三重、天上一轮日月、栈桥上一个人影。
 * 十二种画风只改渲染方式和配色，构图完全一致 ——
 * 这样并排看过去，你比较的是"这个风格会把画面变成什么样"，
 * 而不是"这几张图哪张好看"。风格选择器本来就该回答前一个问题。
 *
 * 全部是内联 SVG，理由有三个：
 *   ① 离线可用，打包体积不涨（十二张位图光缩略图就好几百 KB）；
 *   ② 不拿别人的作品当示例 —— 用真实模型出的图做预设封面，版权说不清；
 *   ③ 主题切换、缩放都不糊。
 *
 * 想看这个画风在**你自己的模型**上到底出什么样，去项目页选中它跑一次设定集，
 * 那才是真实结果；这里给的是意向。
 */

let uid = 0;

/** 同一套地形，所有画风共用 —— 构图一致，风格才有可比性 */
const RIDGE_FAR = 'M0,55 L22,42 L40,52 L64,34 L88,50 L112,38 L136,50 L160,42 L160,72 L0,72 Z';
const RIDGE_MID = 'M0,63 L28,52 L54,64 L82,54 L108,66 L134,56 L160,64 L160,72 L0,72 Z';
const RIDGE_NEAR = 'M0,70 L34,61 L70,71 L104,63 L134,70 L160,66 L160,72 L0,72 Z';

/** 栈桥 + 人影：整幅画里唯一的"人"，放在三分线上 */
function jetty(ink, outline) {
  const stroke = outline ? ` stroke="${ink}" stroke-width="0.8"` : '';
  return `
    <g fill="${ink}">
      <rect x="40" y="86" width="52" height="2.4" rx="1"/>
      <rect x="46" y="88" width="1.6" height="7"/>
      <rect x="84" y="88" width="1.6" height="7"/>
      <g${stroke}>
        <circle cx="78" cy="76" r="2.5"/>
        <path d="M78,79 C74.6,79 73.2,81.4 73,86 L83,86 C82.8,81.4 81.4,79 78,79 Z"/>
      </g>
    </g>`;
}

function skyLayer(id, art) {
  return `
    <defs>
      <linearGradient id="sky${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${art.sky[0]}"/>
        <stop offset="100%" stop-color="${art.sky[1]}"/>
      </linearGradient>
      <linearGradient id="wtr${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${art.water}" stop-opacity="0.95"/>
        <stop offset="100%" stop-color="${art.sky[1]}" stop-opacity="0.55"/>
      </linearGradient>
    </defs>
    <rect width="160" height="100" fill="url(#sky${id})"/>`;
}

/** 水面：横向反光条 + 日月的倒影柱。这一条最能定"氛围" */
function water(id, art) {
  const lines = [76, 80, 84, 89, 94]
    .map((y, i) => {
      const w = 30 + i * 16;
      const x = 80 - w / 2 + (i % 2 ? 12 : -14);
      return `<rect x="${x}" y="${y}" width="${w}" height="0.8" fill="${art.glow}" opacity="${0.28 - i * 0.035}"/>`;
    })
    .join('');
  return `
    <rect x="0" y="72" width="160" height="28" fill="url(#wtr${id})"/>
    <rect x="115" y="72" width="6" height="28" fill="${art.glow}" opacity="0.32"/>
    ${lines}`;
}

const MODES = {
  /** 水墨 / 水彩：柔边、低饱和、大量留白，不勾线 */
  wash(id, art) {
    return `
      <defs>
        <filter id="soft${id}" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.6"/>
        </filter>
        <filter id="soft2${id}" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.9"/>
        </filter>
      </defs>
      <circle cx="118" cy="30" r="10" fill="${art.glow}" opacity="0.5" filter="url(#soft${id})"/>
      <path d="${RIDGE_FAR}" fill="${art.hills[0]}" opacity="0.5" filter="url(#soft${id})"/>
      <path d="${RIDGE_MID}" fill="${art.hills[1]}" opacity="0.62" filter="url(#soft2${id})"/>
      <path d="${RIDGE_NEAR}" fill="${art.hills[2]}" opacity="0.78" filter="url(#soft2${id})"/>
      ${water(id, art)}
      ${jetty(art.ink, false)}`;
  },

  /** 赛璐璐：平涂 + 干净的深色轮廓线 */
  cel(id, art) {
    return `
      <circle cx="118" cy="30" r="10" fill="${art.glow}"/>
      <circle cx="118" cy="30" r="10" fill="none" stroke="${art.ink}" stroke-width="1"/>
      <path d="${RIDGE_FAR}" fill="${art.hills[0]}" stroke="${art.ink}" stroke-width="0.9" stroke-linejoin="round"/>
      <path d="${RIDGE_MID}" fill="${art.hills[1]}" stroke="${art.ink}" stroke-width="0.9" stroke-linejoin="round"/>
      <path d="${RIDGE_NEAR}" fill="${art.hills[2]}" stroke="${art.ink}" stroke-width="0.9" stroke-linejoin="round"/>
      ${water(id, art)}
      ${jetty(art.ink, false)}`;
  },

  /** 工笔：极细勾线 + 斜向丝绢纹 */
  line(id, art) {
    return `
      <defs>
        <pattern id="silk${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="${art.ink}" stroke-width="0.35" opacity="0.16"/>
        </pattern>
      </defs>
      <circle cx="118" cy="30" r="10" fill="${art.glow}" opacity="0.85"/>
      <path d="${RIDGE_FAR}" fill="${art.hills[0]}" stroke="${art.ink}" stroke-width="0.45"/>
      <path d="${RIDGE_MID}" fill="${art.hills[1]}" stroke="${art.ink}" stroke-width="0.45"/>
      <path d="${RIDGE_NEAR}" fill="${art.hills[2]}" stroke="${art.ink}" stroke-width="0.45"/>
      ${water(id, art)}
      <rect width="160" height="100" fill="url(#silk${id})"/>
      ${jetty(art.ink, false)}
      <rect x="2" y="2" width="156" height="96" fill="none" stroke="${art.glow}" stroke-width="1.2" opacity="0.55"/>`;
  },

  /** 写实：远景空气透视 + 暗角，近处才实 */
  photo(id, art) {
    return `
      <defs>
        <filter id="haze${id}"><feGaussianBlur stdDeviation="1.2"/></filter>
        <radialGradient id="vig${id}" cx="0.5" cy="0.5" r="0.75">
          <stop offset="55%" stop-color="#000" stop-opacity="0"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.45"/>
        </radialGradient>
      </defs>
      <circle cx="118" cy="30" r="9" fill="${art.glow}" opacity="0.9" filter="url(#haze${id})"/>
      <path d="${RIDGE_FAR}" fill="${art.hills[0]}" opacity="0.6" filter="url(#haze${id})"/>
      <path d="${RIDGE_MID}" fill="${art.hills[1]}" opacity="0.85"/>
      <path d="${RIDGE_NEAR}" fill="${art.hills[2]}"/>
      ${water(id, art)}
      ${jetty(art.ink, false)}
      <rect width="160" height="100" fill="url(#vig${id})"/>`;
  },

  /** 三维动画：圆润造型 + 次表面感的柔光 */
  soft(id, art) {
    return `
      <defs>
        <radialGradient id="sun${id}" cx="0.4" cy="0.35" r="0.75">
          <stop offset="0%" stop-color="#fff" stop-opacity="0.9"/>
          <stop offset="100%" stop-color="${art.glow}"/>
        </radialGradient>
        <filter id="glow${id}" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3"/>
        </filter>
      </defs>
      <circle cx="118" cy="30" r="13" fill="${art.glow}" opacity="0.35" filter="url(#glow${id})"/>
      <circle cx="118" cy="30" r="10" fill="url(#sun${id})"/>
      <path d="M-4,60 Q34,36 72,56 T166,50 L166,74 L-4,74 Z" fill="${art.hills[0]}"/>
      <path d="M-4,68 Q40,50 84,66 T166,60 L166,76 L-4,76 Z" fill="${art.hills[1]}"/>
      <path d="M-4,74 Q46,62 92,73 T166,68 L166,78 L-4,78 Z" fill="${art.hills[2]}"/>
      ${water(id, art)}
      ${jetty(art.ink, false)}`;
  },

  /** 电影 / 港风：青橙分离 + 颗粒 + 上下遮幅 */
  film(id, art) {
    return `
      <defs>
        <filter id="grain${id}">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" result="n"/>
          <feColorMatrix type="saturate" values="0"/>
          <feComponentTransfer><feFuncA type="linear" slope="0.16"/></feComponentTransfer>
        </filter>
        <radialGradient id="vig${id}" cx="0.5" cy="0.5" r="0.78">
          <stop offset="55%" stop-color="#000" stop-opacity="0"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.42"/>
        </radialGradient>
      </defs>
      <circle cx="118" cy="32" r="9" fill="${art.glow}" opacity="0.85"/>
      <path d="${RIDGE_FAR}" fill="${art.hills[0]}" opacity="0.75"/>
      <path d="${RIDGE_MID}" fill="${art.hills[1]}"/>
      <path d="${RIDGE_NEAR}" fill="${art.hills[2]}"/>
      ${water(id, art)}
      ${jetty(art.ink, false)}
      <rect width="160" height="100" fill="url(#vig${id})"/>
      <rect width="160" height="100" filter="url(#grain${id})" opacity="0.6"/>
      <rect x="0" y="0" width="160" height="7" fill="#000"/>
      <rect x="0" y="93" width="160" height="7" fill="#000"/>`;
  },

  /** 赛博朋克：霓虹辉光 + 雨丝 + 山脊描边 */
  neon(id, art) {
    const rain = Array.from({ length: 16 }, (_, i) => {
      const x = 6 + i * 10;
      return `<line x1="${x}" y1="${(i * 13) % 40}" x2="${x - 5}" y2="${((i * 13) % 40) + 26}" stroke="${art.ink}" stroke-width="0.5" opacity="0.22"/>`;
    }).join('');
    return `
      <defs>
        <filter id="bloom${id}" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4"/>
        </filter>
      </defs>
      <circle cx="118" cy="30" r="16" fill="${art.glow}" opacity="0.45" filter="url(#bloom${id})"/>
      <circle cx="118" cy="30" r="9" fill="${art.glow}"/>
      <path d="${RIDGE_FAR}" fill="${art.hills[0]}" stroke="${art.ink}" stroke-width="0.7" opacity="0.9"/>
      <path d="${RIDGE_MID}" fill="${art.hills[1]}" stroke="${art.glow}" stroke-width="0.7" opacity="0.9"/>
      <path d="${RIDGE_NEAR}" fill="${art.hills[2]}" stroke="${art.ink}" stroke-width="0.8"/>
      ${water(id, art)}
      <rect x="0" y="72" width="160" height="0.9" fill="${art.ink}" opacity="0.8"/>
      ${rain}
      ${jetty(art.ink, false)}
      <circle cx="78" cy="76" r="5" fill="${art.ink}" opacity="0.28" filter="url(#bloom${id})"/>`;
  },

  /** 黑色电影：硬光、高反差、百叶窗投影 */
  noir(id, art) {
    // 百叶窗投影是这个风格的招牌，但盖满整幅就只剩条纹、看不见画面了。
    // 只压左上到中部，右下留出光，硬光的方向感反而更清楚。
    const blinds = Array.from({ length: 6 }, (_, i) =>
      `<rect x="-20" y="${6 + i * 14}" width="128" height="4.5" fill="#000" opacity="0.32" transform="rotate(-11 80 50)"/>`
    ).join('');
    return `
      <defs>
        <radialGradient id="vig${id}" cx="0.5" cy="0.45" r="0.75">
          <stop offset="45%" stop-color="#000" stop-opacity="0"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.55"/>
        </radialGradient>
      </defs>
      <circle cx="118" cy="28" r="8" fill="${art.glow}"/>
      <path d="${RIDGE_FAR}" fill="${art.hills[0]}"/>
      <path d="${RIDGE_MID}" fill="${art.hills[1]}"/>
      <path d="${RIDGE_NEAR}" fill="${art.hills[2]}"/>
      ${water(id, art)}
      ${jetty(art.ink, false)}
      ${blinds}
      <rect width="160" height="100" fill="url(#vig${id})"/>`;
  }
};

/** 宣纸 / 水彩纸的纹理，只有需要的画风才叠 */
function paper(id) {
  return `
    <defs>
      <filter id="paper${id}">
        <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="4" result="n"/>
        <feColorMatrix type="saturate" values="0"/>
        <feComponentTransfer><feFuncA type="linear" slope="0.13"/></feComponentTransfer>
      </filter>
    </defs>
    <rect width="160" height="100" filter="url(#paper${id})" opacity="0.7" style="mix-blend-mode:multiply"/>`;
}

/**
 * 生成一张缩略图的 SVG 字符串。
 * id 每次自增：SVG 里的 filter / gradient 是靠 id 引用的，
 * 同一页放十二张，id 撞了就会全部串成同一种滤镜。
 */
export function styleArtSVG(preset) {
  const art = preset?.art;
  if (!art) return '';
  const id = `s${uid++}`;
  const draw = MODES[art.mode] || MODES.photo;
  // xMidYMax：项目卡片上这张是宽横幅，会被裁掉上下。裁天空可以，
  // 裁掉水面和栈桥上那个人影就只剩几座山，风格差别全没了 —— 所以贴底裁。
  return `<svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMax slice" role="img" aria-label="${preset.name}示意">
    ${skyLayer(id, art)}
    ${draw(id, art)}
    ${art.paper ? paper(id) : ''}
  </svg>`;
}

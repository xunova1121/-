/**
 * 画面处理 —— 剪辑台上的「效果」那一栏。
 *
 * ════════ 先把代价说清楚 ════════
 *
 * 顺序、入出点、跳过、转场，这些都只是"怎么拼"，FFmpeg 十几秒就拼完。
 * **效果不一样：它要把这一段的每一帧重新压一遍。**
 *
 * 但重压的只有**加了效果的那几段**，不是整部片子 —— 这一点很重要，
 * 常见的做法是给整条时间线套一个滤镜链，那样二十镜要重压二十段。
 * 这里只动被点过的那几段，其余照走不重编码的快路。
 *
 * 所以代价是**时间，不是钱**：不重新生成任何素材，厂商那边一次调用都不多。
 * 界面上必须这么说 —— "慢一点"和"要花钱"是完全不同的两件事，
 * 而人只会为后者犹豫。
 *
 * ════════ 为什么是这几个，不是四十个 ════════
 *
 * FFmpeg 能做的滤镜有几百个。摆四十个上去，结果是每个都试一遍、
 * 每次都后悔 —— 而短剧真正用得上的调子就那么几类：
 * 冷暖、明暗、浓淡、黑白，外加一个"让呆板的 AI 画面动起来"的缓推。
 *
 * 最后那个是**这批素材特有的**：图生视频经常给回一段几乎静止的画面，
 * 而一个极缓慢的推近能立刻让它像是"拍"出来的。这是本文件里最值钱的一条。
 *
 * ════════ 为什么 vf 是函数 ════════
 *
 * 大部分效果只是一串常量滤镜，和素材无关。但缓推（zoompan）必须知道
 * 这一段的**分辨率和帧率**：不给 s= 的话 zoompan 默认输出 hd720，
 * 一段 1080p 的素材会被悄悄降到 720p；不给 fps= 的话它按 25 帧重采样，
 * 24 帧的素材会抖。
 *
 * 这两样都不会报错，只会让成片变差 —— 所以宁可让整个表接一个参数。
 */

/**
 * 效果表。
 *
 *   id     存在 edit.clips[shotId].fx 里
 *   vf     (info) => FFmpeg 的 -vf 字符串。info = { width, height, fps }
 *   needs  这个效果必须知道素材的哪些信息。缺了就跳过并说一声
 */
export const CATALOG = [
  {
    id: 'none',
    label: '原样',
    why: '不动画面，走不重编码的快路',
    vf: () => null
  },
  {
    id: 'push',
    label: '缓推（慢慢推近）',
    why: 'AI 出的片子经常几乎静止，一个极缓的推近能让它像是"拍"出来的',
    needs: ['width', 'height', 'fps'],
    /**
     * 每帧放大万分之九，封顶 1.10 倍 —— 十秒的片子推到头正好一成，
     * 观众感觉不到"在推"，只觉得画面是活的。
     * 再快就成了变焦，那是另一种东西，而且很廉价。
     */
    vf: ({ width, height, fps }) =>
      `zoompan=z='min(1+0.0009*on,1.10)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
      + `:s=${width}x${height}:fps=${fps}`
  },
  {
    id: 'pull',
    label: '缓拉（慢慢推远）',
    why: '一段的收尾、或者交代环境',
    needs: ['width', 'height', 'fps'],
    vf: ({ width, height, fps }) =>
      `zoompan=z='max(1.10-0.0009*on,1.0)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
      + `:s=${width}x${height}:fps=${fps}`
  },
  {
    id: 'bw',
    label: '黑白',
    why: '回忆、新闻、遗照',
    vf: () => 'hue=s=0'
  },
  {
    id: 'warm',
    label: '暖调',
    why: '室内、黄昏、温情戏',
    vf: () => 'colorbalance=rs=0.08:gs=0.02:bs=-0.06,eq=saturation=1.05'
  },
  {
    id: 'cool',
    label: '冷调',
    why: '夜戏、医院、悬疑',
    vf: () => 'colorbalance=rs=-0.06:gs=-0.01:bs=0.09,eq=saturation=1.02'
  },
  {
    id: 'bright',
    label: '提亮',
    why: '整段偏暗，手机上看不清',
    vf: () => 'eq=brightness=0.06:contrast=1.04:saturation=1.03'
  },
  {
    id: 'dark',
    label: '压暗',
    why: '整段发灰、发白',
    vf: () => 'eq=brightness=-0.06:contrast=1.08'
  },
  {
    id: 'vivid',
    label: '浓郁',
    why: '颜色寡淡的那几镜',
    vf: () => 'eq=saturation=1.35:contrast=1.06'
  },
  {
    id: 'contrast',
    label: '加对比',
    why: '灰蒙蒙、没层次',
    vf: () => 'eq=contrast=1.20:saturation=1.05'
  },
  {
    id: 'soft',
    label: '柔光',
    why: '人物特写、梦境',
    /**
     * 柔光不是"糊一点"，是**把糊的那一层叠回清晰画面上**（screen 混合）。
     * 直接 gblur 出来是失焦，不是柔光 —— 两者在观感上差得很远。
     * -vf 收得下带标签的滤镜图，只要它整体是一进一出。
     */
    vf: () => 'split=2[fxa][fxb];[fxb]gblur=sigma=12[fxblur];[fxa][fxblur]blend=all_mode=screen:all_opacity=0.30'
  },
  {
    id: 'vignette',
    label: '暗角',
    why: '把注意力收到画面中间',
    vf: () => 'vignette=PI/5'
  },
  {
    id: 'sharpen',
    label: '锐化',
    why: '模型出的片子偏肉',
    vf: () => 'unsharp=5:5:0.8:5:5:0'
  },
  {
    id: 'grain',
    label: '胶片颗粒',
    why: '盖住 AI 那种过于干净的塑料感',
    vf: () => 'noise=alls=8:allf=t+u'
  }
];

export const IDS = CATALOG.map((f) => f.id);

const BY_ID = new Map(CATALOG.map((f) => [f.id, f]));

/** 认不认识这个效果 id */
export function has(id) {
  return BY_ID.has(id) && id !== 'none';
}

export function defOf(id) {
  return BY_ID.get(id) || BY_ID.get('none');
}

export function labelOf(id) {
  return defOf(id).label;
}

/**
 * 把一个效果编成 `-vf` 字符串。
 *
 * @param info { width, height, fps } —— 探出来的素材信息
 * @returns { vf } 或 { skip: '为什么做不了' }
 *
 * ⚠ 缺信息时**明确回一个原因**，不是回 null。
 * 回 null 的话调用方只能当"这一段没效果"，而人明明点了一个 ——
 * 于是成片和界面对不上，还没有任何线索。这类沉默是这个项目里
 * 反复出问题的那一类，不能再添一处。
 */
export function compile(id, info = {}) {
  const def = defOf(id);
  if (def.id === 'none') return { vf: null };
  for (const key of def.needs || []) {
    if (!Number.isFinite(Number(info[key])) || Number(info[key]) <= 0) {
      return { skip: `「${def.label}」要知道素材的${{ width: '宽', height: '高', fps: '帧率' }[key] || key}，这一段探不出来` };
    }
  }
  const vf = def.vf(info);
  return vf ? { vf } : { vf: null };
}

/** 一句人话：这次给几镜加了什么效果 */
export function summarize(picks = []) {
  const real = picks.filter((p) => p && has(p.fx));
  if (!real.length) return null;
  const bits = real.slice(0, 6).map((p) => `#${p.index}（${labelOf(p.fx)}）`).join('、');
  return `画面效果：${real.length} 镜 —— ${bits}${real.length > 6 ? ' 等' : ''}。`
    + '加了效果的这几段要重压一遍，比平时慢；但一帧素材都不重新生成，不花钱。';
}

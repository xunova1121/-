/**
 * 场地图 —— 把几个场景摆到**同一片地**上。
 *
 * ════════ 为什么需要这一层 ════════
 *
 * 排位（previz.js）解决的是"一个场景内部"：人在哪、机位在哪、门窗在哪。
 * 场景布局（bible.scenes[].layout）又往上走了一步：同一个场景反复回来时，
 * 门窗和太阳只摆一次。
 *
 * 但这两层都有一个说不出口的前提 —— **每个场景是一座孤岛**。
 *
 * 而外景不是。「山门外」「石阶」「大殿」是同一座山上连着的三个地方：
 *
 *   · 太阳只有一个。山门外是斜逆光、大殿是正顺光，这两场戏就不是同一个下午
 *   · 山不会跑。从山门外看那座主峰在东北，从石阶看它还得在东北 ——
 *     偏个十几度是视差（其实远到没有视差），偏一百八十度是穿帮
 *   · 人是走过去的。大殿在山门外的北边，那么"往北走"的镜头才接得上下一场
 *
 * 这三件事，任何一层"只看一个场景"的检查都发现不了。它们只有在把场景
 * **摆到一起**之后才浮出来 —— 而摆到一起，就是这个模块。
 *
 * ════════ 为什么不做成一个新集合 ════════
 *
 * 最直觉的做法是加一张 `sites` 表，每条有 id、名字、成员列表。
 * 不这么做的原因是**孤儿**：删掉一个场景之后，成员列表里那条引用还在；
 * 改个名字，引用就断了。这类错误从来不报错，只是有一天地图上少了一块。
 *
 * 所以场地不是一张表，是**场景身上的一个标签**：
 *
 *   bible.scenes[i].place = { site: '雪山', x: 0, y: 0 }
 *
 * 同一个 site 名字的场景自动在一张图上。没有 place 的场景就是不在任何图上 ——
 * 老项目一个字都不用改，也不会因为多了这个功能就多出一堆空地图。
 *
 * 场地本身的东西（远景地标、太阳）挂在 `bible.sites['雪山']` 这个对象上，
 * 按名字取，没有 id。多出来一个用不上的键是无害的，断掉一条引用不是。
 *
 * ════════ 单位和方向 ════════
 *
 * 米。+y 是北，和 previz 一致 —— 两套坐标系是这类几何代码最经典的坑，
 * 而且它不报错，只是所有方位都拧着。
 *
 * ⚠ 这个文件要**原样发给浏览器**（/site.js），所以只能 import previz
 * （它在浏览器里是 /previz.js，那条路由是有的）。多 import 一个别的，
 * 浏览器就会去请求一个不存在的地址，而 import 失败会让整块面板不出来。
 */

import * as previz from './previz.js';

/**
 * 场地图的范围（米，半径）。
 *
 * 400 米是一片山坡、一条街、一个村子的量级。再大的话，人在两场之间
 * 不可能是走过去的 —— 那是"另一个地方"，该开一张新图，而不是把这张拉大。
 */
export const SITE_LIMIT = 400;

/** 同一片场地上，两个场景的太阳方位差超过这个数就该问一句 */
export const SUN_DRIFT = 30;

/**
 * 同名远景地标在两个场景里的方位差。
 *
 * 比太阳松一点：远景地标的方位本来就是人手拖出来的，拖不了那么准。
 * 但超过 40° 就不是手抖了 —— 那是把同一座山记成了两个方向。
 */
export const FAR_DRIFT = 40;

const ELEV_WORD = { low: '低（早晚斜射）', mid: '中', high: '高（正午顶光）' };

function clampWorld(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-SITE_LIMIT, Math.min(SITE_LIMIT, Number(n.toFixed(1))));
}

/**
 * 把界面传上来的"这个场景在场地的哪儿"规整成可信的形状。
 *
 * 和 normalizeStage 同一个道理：场景的可改字段大多按文本框设计，
 * 一个对象存进去可能变成 "[object Object]" —— 接口回 200、看着像存住了，
 * 读出来是一坨没法用的字符。
 */
export function normalizePlace(place) {
  if (!place || typeof place !== 'object') return null;
  const site = String(place.site ?? '').trim().slice(0, 24);
  if (!site) return null;
  return { site, x: clampWorld(place.x), y: clampWorld(place.y) };
}

/**
 * 场地自身的东西：远景地标 + 太阳。
 *
 * ⚠ 这里**只收远景地标**。近处的门、窗、桌是场景内部的事，
 * 它们的坐标是相对这个场景的原点算的，搬到场地图上没有意义 ——
 * 而且真放上去，一张四百米的图上那个 0.8 米的桌子是一个看不见的点。
 */
export function normalizeSite(site) {
  if (!site || typeof site !== 'object') return { marks: [], sun: null };
  const marks = (Array.isArray(site.marks) ? site.marks : [])
    .filter((m) => m && typeof m === 'object')
    /**
     * ⚠ 没有方位角的一律**丢掉**，不要给它补一个 0。
     *
     * 补 0 的话，一张近处地标（门、窗、桌）被误发到这儿之后，
     * 会变成"正北方向有一扇门"静静躺在场地图上 —— 接口回 200，
     * 图上多一个圆点，而它是凭空捏出来的。宁可少一条，不要多一条假的。
     */
    .filter((m) => Number.isFinite(Number(m.deg)))
    .slice(0, 10)
    .map((m) => ({ name: String(m.name ?? '').trim().slice(0, 12), far: true, deg: previz.norm180(m.deg) }))
    .filter((m) => m.name);
  const rawSun = site.sun && typeof site.sun === 'object' ? site.sun : null;
  const sun = rawSun && Number.isFinite(Number(rawSun.deg))
    ? { deg: previz.norm180(rawSun.deg), elev: ['low', 'mid', 'high'].includes(rawSun.elev) ? rawSun.elev : 'mid' }
    : null;
  return { marks, sun };
}

/** 摆过位置的场景。没摆过的不在任何图上 —— 这是正常状态，不是缺失 */
export function placesOf(project) {
  return (project?.bible?.scenes || [])
    .map((sc) => {
      const place = normalizePlace(sc?.place);
      if (!place) return null;
      return { scene: String(sc.name || ''), ...place, layout: sc.layout || null };
    })
    .filter((x) => x && x.scene);
}

/**
 * 这个项目上有几片场地，每片上面摆了哪几个场景。
 *
 * 按场景在设定集里的顺序排 —— 不按名字排。名字排序会让"第一个场景"
 * 随着改名跳来跳去，而人是按剧本顺序找东西的。
 */
export function sitesOf(project) {
  const byName = new Map();
  for (const p of placesOf(project)) {
    if (!byName.has(p.site)) {
      byName.set(p.site, { name: p.site, places: [], ...normalizeSite(project?.bible?.sites?.[p.site]) });
    }
    byName.get(p.site).places.push(p);
  }
  return [...byName.values()];
}

export function siteOf(project, name) {
  const key = String(name || '').trim();
  if (!key) return null;
  return sitesOf(project).find((s) => s.name === key) || null;
}

/**
 * 从一个场景走到另一个场景：什么方向、多远。
 *
 * 这句话是写给**人**看的，不是塞进提示词的。出图模型不需要知道
 * 大殿离山门外三十米，但排镜头的人需要 —— 因为"他往北走出画"的下一场
 * 如果在南边，那是接不上的，而这件事在两张分开的俯视图上永远看不出来。
 */
export function describeBetween(from, to) {
  if (!from || !to) return null;
  const d = previz.distance(from, to);
  if (d < 0.5) return `${to.scene}和${from.scene}几乎在同一处`;
  const deg = previz.bearing(from, to);
  return `${to.scene}在${from.scene}的${previz.compassOf(deg)}方向约 ${Math.round(d)} 米`;
}

/**
 * 同一片场地上，太阳对不对得上。
 *
 * ── 为什么这条比越轴还要紧 ──
 *
 * 越轴是"这两镜的机位关系不对"，观众说不清哪儿怪但觉得别扭。
 * 太阳不对是"这两场不是同一个下午拍的"—— 观众**说得出来**，
 * 而且一眼就看得出来：影子朝着两个方向。
 *
 * ⚠ 它不该是死规则。剧情本来就可能跨了几小时（进山时清晨、
 * 到大殿已是黄昏），那时候太阳就该不一样。所以这里报的是
 * "要么改，要么这中间确实过了时间"，不是"错了"。
 *
 * ════════ 基准是谁 ════════
 *
 * 场地图上摆过太阳的话，**那个就是基准** —— 它是人明确定下来的
 * "这片地上的光是这样的"。没摆过就退回"拿第一个场景当基准"：
 * 那时候没有权威的一份，只能报"这两个对不上"，而不能说谁对谁错。
 *
 * 这一条不只是措辞好看。没有基准的话，场地图上那个☀就是**纯装饰** ——
 * 拖它没有任何后果，而界面上它看起来像个设置。一个拖了不起作用的控件
 * 比没有这个控件更糟。
 */
export function sunIssues(site) {
  if (!site) return [];
  const fromScenes = site.places
    .map((p) => ({ scene: p.scene, sun: p.layout?.sun || null }))
    .filter((p) => p.sun && Number.isFinite(Number(p.sun.deg)));

  // 场地上定过就以它为准，否则拿第一个场景当基准
  const anchored = Boolean(site.sun && Number.isFinite(Number(site.sun.deg)));
  const base = anchored ? { scene: null, sun: site.sun } : fromScenes[0];
  const rest = anchored ? fromScenes : fromScenes.slice(1);
  if (!base || !rest.length) return [];

  const who = (x) => (x.scene === null ? '场地图上定的光' : `${x.scene}的光`);
  const out = [];
  for (const p of rest) {
    const drift = Math.abs(previz.norm180(p.sun.deg - base.sun.deg));
    if (drift > SUN_DRIFT) {
      out.push({
        kind: 'site-sun-drift',
        site: site.name,
        scenes: [base.scene, p.scene].filter(Boolean),
        what: `同一片「${site.name}」上，${who(base)}从${previz.compassOf(base.sun.deg)}来、`
          + `${p.scene}从${previz.compassOf(p.sun.deg)}来，差了 ${Math.round(drift)}°`,
        why: '一个地方只有一个太阳。除非这中间确实过了几个小时，否则观众会读成"这两场不是同一天拍的"'
      });
    }
    if (p.sun.elev !== base.sun.elev) {
      out.push({
        kind: 'site-sun-elev',
        site: site.name,
        scenes: [base.scene, p.scene].filter(Boolean),
        what: `${who(base)}位高度是${ELEV_WORD[base.sun.elev] || base.sun.elev}、`
          + `${p.scene}是${ELEV_WORD[p.sun.elev] || p.sun.elev}`,
        why: '高度决定影子长短。同一个下午里它可以慢慢变，但不该在相邻两场之间从顶光跳到斜射'
      });
    }
  }
  return out;
}

/**
 * 同一片场地上，同名的远景地标方位对不对得上。
 *
 * 远景地标的定义就是"远到没有视差" —— 机位挪三米它纹丝不动。
 * 那么换个场景（挪三十米）它也该几乎纹丝不动。方位差出四十度，
 * 说明这座山在两个场景里被记成了两个方向，而画面上它会横跨半个屏跑过去。
 */
export function farMarkIssues(site) {
  if (!site) return [];
  const seen = new Map(); // name -> {scene, deg}；scene 为 null 表示"场地图上定的"
  const out = [];
  /**
   * 场地图上摆过的那几座山是**基准**，先填进去。
   *
   * 不这么做的话，场地图上那一排远景地标就是纯装饰 —— 拖它没有任何后果，
   * 而界面上它看起来像个设置。一个拖了不起作用的控件比没有更糟。
   *
   * 有基准之后这条检查也更准：原来是拿"第一个场景"当参照，
   * 那只能说"这两个对不上"；现在说得出**谁摆错了**。
   */
  for (const mk of site.marks || []) {
    if (mk?.name) seen.set(mk.name, { scene: null, deg: previz.norm180(mk.deg) });
  }
  const who = (x) => (x.scene === null ? '场地图上定的是' : `在${x.scene}是`);
  for (const p of site.places) {
    for (const mk of p.layout?.marks || []) {
      if (!mk?.far || !mk.name) continue;
      const prev = seen.get(mk.name);
      if (!prev) {
        seen.set(mk.name, { scene: p.scene, deg: previz.norm180(mk.deg) });
        continue;
      }
      const drift = Math.abs(previz.norm180(previz.norm180(mk.deg) - prev.deg));
      if (drift > FAR_DRIFT) {
        out.push({
          kind: 'site-far-drift',
          site: site.name,
          scenes: [prev.scene, p.scene].filter(Boolean),
          what: `「${mk.name}」${who(prev)}${previz.compassOf(prev.deg)}方向、`
            + `在${p.scene}是${previz.compassOf(previz.norm180(mk.deg))}方向，差了 ${Math.round(drift)}°`,
          why: '远景地标远到没有视差 —— 换个场景它也该在几乎相同的方位。差这么多，画面里它会横着跑过半个屏'
        });
      }
    }
  }
  return out;
}

/**
 * 两个场景摆得一模一样近。
 *
 * 不是错，但基本上是"拖完忘了拖第二个"—— 新场景默认落在原点，
 * 没动过的话都堆在正中间。堆在一起的图看不出任何方向关系，
 * 而这个功能的全部价值就是方向关系。
 */
export function stackedIssues(site) {
  if (!site || site.places.length < 2) return [];
  const out = [];
  for (let i = 0; i < site.places.length; i += 1) {
    for (let j = i + 1; j < site.places.length; j += 1) {
      const a = site.places[i];
      const b = site.places[j];
      if (previz.distance(a, b) < 0.5) {
        out.push({
          kind: 'site-stacked',
          site: site.name,
          scenes: [a.scene, b.scene],
          what: `${a.scene}和${b.scene}摆在同一个点上`,
          why: '两处叠在一起，图上就读不出谁在谁的哪一边 —— 多半是新加的场景还没拖开'
        });
      }
    }
  }
  return out;
}

/**
 * 把场地上定的远景地标和光位，套到某个场景的布局上。
 *
 * ════════ 为什么要有这一步 ════════
 *
 * 只报问题不给出口是没用的 —— 人看到"「山」在山门外是北、在大殿是南"
 * 之后，下一秒就要问"那我该怎么办"。答案是"去每一个场景里把那座山
 * 拖回同一个方位"，而那是重复劳动，重复劳动就会做错、做漏。
 *
 * ⚠ **近处地标一个都不动。**
 *
 * 门、窗、桌是场景内部的东西，有坐标、有视差 —— 它们本来就该每个场景
 * 各不相同。一起覆盖掉的话，这个按钮就从"对齐远景"变成了"把每个场景
 * 的房间布局清空"，而那是灾难性的、不可撤销的。
 *
 * ⚠ 场地上没摆太阳时，**保留场景自己那个**，不要清成 null。
 * "没定基准"和"基准是没有太阳"是两回事，而后者会把每个场景辛苦摆的
 * 光位一次抹掉。
 */
export function alignSceneToSite(layout, siteModel) {
  const near = (layout?.marks || []).filter((m) => m && !m.far);
  const far = (siteModel?.marks || []).map((m) => ({ ...m }));
  const sun = siteModel?.sun ? { ...siteModel.sun } : (layout?.sun || null);
  return { marks: [...near, ...far], sun };
}

/** 这片场地上有没有"套用一下就能解决"的问题 —— 有才值得摆那颗按钮 */
export function alignable(site) {
  if (!site) return false;
  const hasAnchor = Boolean((site.marks || []).length || site.sun);
  if (!hasAnchor) return false;
  return [...sunIssues(site), ...farMarkIssues(site)]
    .some((i) => i.kind === 'site-sun-drift' || i.kind === 'site-sun-elev' || i.kind === 'site-far-drift');
}

/** 这个项目所有场地的问题，一次性列出来 */
export function siteIssues(project) {
  return sitesOf(project).flatMap((s) => [
    ...sunIssues(s),
    ...farMarkIssues(s),
    ...stackedIssues(s)
  ]);
}

/**
 * 一片场地的文字摘要 —— 给面板上那行小字用。
 *
 * 空场地也要有话说。"还没有场景摆上来"比一片空白强得多：
 * 空白让人以为功能坏了，一句话让人知道下一步该干什么。
 */
export function summarize(site) {
  if (!site) return '还没有场地图';
  const n = site.places.length;
  if (!n) return `「${site.name}」上还没有场景`;
  const bits = [`「${site.name}」上有 ${n} 个场景`];
  if (site.sun) bits.push(`光从${previz.compassOf(site.sun.deg)}来`);
  if (site.marks.length) bits.push(`远景 ${site.marks.map((m) => m.name).join('、')}`);
  return bits.join('，');
}

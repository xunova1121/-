/**
 * 成片体检 —— **这片子现在能不能发**，一屏说清楚。
 *
 * ── 补的是哪个洞 ──
 *
 * 检查其实一直都有，但散在四个地方，各说各的：
 *
 *   分镜卡片上   一致性分数（这一镜的人像不像）
 *   分镜体检里   文字层面的毛病（音效写进画面、一镜四件事、台词念不完）
 *   出视频日志里 首帧核对、接缝比对
 *   合成日志里   台词超长、缺片段
 *
 * 每一条单看都有用，合起来却回答不了那个真正要问的问题：
 * **我现在导出去，会不会有明显的错？**
 *
 * 于是实际发生的是：人跑完全流程，看一眼成片觉得还行就发了，
 * 而那几条散落的警告谁也没有回头去翻 —— 它们出现的时机是几十分钟前，
 * 混在几百行日志里。
 *
 * ── 这里只汇总，不重新检查 ──
 *
 * 所有结论都从**已经存在的字段**读出来（consistency、headMatch、tailAlign、
 * 产物路径），加上分镜体检那一份现算的。不重新调模型、不重新跑 FFmpeg ——
 * 体检本身要免费、要快，慢一点人就不会在导出前点它。
 *
 * ── 分档的规矩 ──
 *
 *   blocker  导出去**一定**有人看得出来：缺片段、台词没声音、
 *            标着无缝而实际没接上
 *   warn     质量风险，但未必看得出来：一致性偏低、轻微漂移
 *   note     可以改进，不改也不算错
 *
 * 这个分档必须**真的分得开**。把什么都标成 blocker，人第一次看到十几条红的
 * 就再也不看这一页了 —— 那比没有这一页更糟。
 */

/**
 * 分数怎么来的。
 *
 * ⚠ **永远不要单独显示这个数**。它只是把"有多少问题、多严重"压成一个数
 * 方便排序和一眼判断，它本身没有物理意义 —— 92 和 88 之间没有任何可解释的差别。
 * 真正要看的是下面那张清单：哪几条、为什么、怎么改。
 *
 * 所以 `audit()` 回的是 { score, verdict, items }，而界面必须把 items 摊开。
 * 只印一个分数的界面是在假装精确。
 */
const WEIGHT = { blocker: 12, warn: 4, note: 1 };

const LEVELS = ['blocker', 'warn', 'note'];

function add(items, level, o) {
  items.push({ level, ...o });
}

/**
 * 一致性分数还作数吗。
 *
 * 手改过描述之后那个分数是给**旧描述**打的（studio 里会标 stale）。
 * 拿它当"这一镜没问题"的证据，等于用一个过期的结论放行。
 */
function consistencyOf(shot) {
  const c = shot?.consistency;
  if (!c || c.score === null || c.score === undefined) return null;
  if (c.stale) return { ...c, usable: false };
  return { ...c, usable: true };
}

/**
 * 通体检一遍。**纯函数**：只读 project，不碰盘、不联网。
 *
 * @param lintResults 分镜体检的结果（shotlint.lintShots 的返回）。
 *                    由调用方传进来而不是在这里 import —— 那个模块要读技法卡目录，
 *                    而这个模块想保持"喂进去一个对象就能跑"。
 */
export function audit(project, { lintResults = [], threshold = 75 } = {}) {
  const items = [];
  const shots = (project?.shots || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));

  if (!shots.length) {
    return { score: 0, verdict: 'not-ready', items: [{ level: 'blocker', what: '还没有分镜', fix: '先跑到「分镜」那一步' }], counts: { blocker: 1, warn: 0, note: 0 } };
  }

  // ── 产物齐不齐 ──
  const noImage = shots.filter((s) => !s.imagePath);
  if (noImage.length) {
    add(items, 'blocker', {
      id: 'missing-image',
      what: `${noImage.length} 镜还没有图（第 ${noImage.map((s) => s.index).join('、')} 镜）`,
      why: '没有图就出不了视频，这几镜在成片里是直接缺失的。',
      fix: '跑「镜头图」那一步，或者单独重出这几镜。'
    });
  }
  const noVideo = shots.filter((s) => s.imagePath && !s.videoPath);
  if (noVideo.length) {
    add(items, 'blocker', {
      id: 'missing-video',
      what: `${noVideo.length} 镜有图没视频（第 ${noVideo.map((s) => s.index).join('、')} 镜）`,
      why: '合成时这几镜会被跳过 —— 成片里那一段直接不存在，而素材包看起来是齐的。',
      fix: '跑「视频」那一步，或者单独重出这几镜。'
    });
  }

  /**
   * 有台词却没配音 —— 这一条特别值得单列。
   *
   * 画面在演、嘴在动、**没有声音**。这是所有错里最刺眼的一种，
   * 而它不会让任何一步失败：合成照样成功，成片照样导得出来。
   */
  const silent = shots.filter((s) => String(s.dialogue || '').trim() && !s.audioPath);
  if (silent.length) {
    add(items, 'blocker', {
      id: 'missing-voice',
      what: `${silent.length} 镜有台词但没配音（第 ${silent.map((s) => s.index).join('、')} 镜）`,
      why: '画面在演、嘴在动，而那句话没有声音。合成不会因此失败，成片照样导得出来 —— 所以只能靠这里发现。',
      fix: '跑「配音」那一步。'
    });
  }

  /**
   * 标着「连续动作」而接缝比对说没锁上 —— **界面写着无缝，实际不是**。
   *
   * 这一条算 blocker 不是因为画面坏了，是因为**界面在说谎**：
   * 卡片上挂着"连续动作"，人据此以为这两镜是连的，
   * 直到成片放到那儿才发现跳了一下。
   */
  const brokenSeam = shots.filter((s) => s.link === 'continuous' && s.tailAlign?.verdict === 'missed');
  if (brokenSeam.length) {
    add(items, 'blocker', {
      id: 'seam-missed',
      what: `${brokenSeam.length} 处标着「连续动作」但接缝没锁上（第 ${brokenSeam.map((s) => s.index).join('、')} 镜）`,
      why: '厂商多半没吃末帧参数，只是没报错。成片放到这儿会明显跳一下，而分镜上写着「连续动作」—— 界面和事实不一致。',
      fix: '重出这一镜；或者把这两镜改成硬切，别让界面写着无缝而实际不是。'
    });
  }
  const driftSeam = shots.filter((s) => s.link === 'continuous' && s.tailAlign?.verdict === 'partial');
  if (driftSeam.length) {
    add(items, 'warn', {
      id: 'seam-drift',
      what: `${driftSeam.length} 处接缝有轻微漂移（第 ${driftSeam.map((s) => s.index).join('、')} 镜）`,
      why: '厂商吃了末帧参数但没完全收住，接缝会轻微跳一下。',
      fix: '重出这一镜多半会好；要求不高的话也可以放着。'
    });
  }

  // ── 一致性 ──
  const low = shots.filter((s) => {
    const c = consistencyOf(s);
    return c?.usable && c.score < threshold;
  });
  if (low.length) {
    add(items, 'warn', {
      id: 'consistency-low',
      what: `${low.length} 镜的一致性低于 ${threshold} 分（第 ${low.map((s) => `${s.index}(${s.consistency.score})`).join('、')}）`,
      why: '这几镜里的人和设定图对不上。逐镜看未必看得出来，连起来会觉得"这人怎么变了"。',
      fix: '重出这几镜；老不过的话去设定集把外貌描述写具体（颜色、款式、配饰）。'
    });
  }
  const stale = shots.filter((s) => s.consistency?.stale);
  if (stale.length) {
    add(items, 'warn', {
      id: 'consistency-stale',
      what: `${stale.length} 镜的一致性分数已经过时（第 ${stale.map((s) => s.index).join('、')} 镜）`,
      why: '这些分数是改文案**之前**打的，对不上现在这一版画面 —— 拿它当"没问题"的证据等于用过期结论放行。',
      fix: '重出这几镜，分数会跟着重打。'
    });
  }
  const headBad = shots.filter((s) => s.headMatch?.verdict === 'mismatch');
  if (headBad.length) {
    add(items, 'warn', {
      id: 'head-mismatch',
      what: `${headBad.length} 镜的视频首帧和我们发过去的图对不上（第 ${headBad.map((s) => s.index).join('、')} 镜）`,
      why: '这家多半没吃首帧图，等于这一镜是"文生视频"出来的 —— 人和场景都可能不是你定的那个。',
      fix: '换一家收首帧图的，或者接受这几镜会偏。'
    });
  }

  // ── 分镜体检那一份（文字层面的毛病）──
  const high = [];
  const normal = [];
  for (const r of lintResults) {
    for (const i of r.issues || []) (i.severity === 'high' ? high : normal).push({ ...i, index: r.index });
  }
  if (high.length) {
    add(items, 'warn', {
      id: 'lint-high',
      what: `分镜体检有 ${high.length} 条高危项`,
      why: high.slice(0, 3).map((i) => `第 ${i.index} 镜：${i.what}`).join('；') + (high.length > 3 ? ' 等' : ''),
      fix: '到「分镜」页逐条改。这些是**出图之前**就能改掉的，改完再重出比现在将就便宜。'
    });
  }
  if (normal.length) {
    add(items, 'note', {
      id: 'lint-normal',
      what: `分镜体检有 ${normal.length} 条一般项`,
      why: normal.slice(0, 2).map((i) => `第 ${i.index} 镜：${i.what}`).join('；'),
      fix: '不改也能发，改了更像成片。'
    });
  }

  // ── 设定集 ──
  const bible = project?.bible;
  if (bible) {
    const noSheet = [...(bible.characters || []), ...(bible.scenes || [])].filter((x) => !x.sheetPath);
    if (noSheet.length) {
      add(items, 'warn', {
        id: 'bible-incomplete',
        what: `设定集里有 ${noSheet.length} 条还没出图（${noSheet.slice(0, 4).map((x) => x.name).join('、')}${noSheet.length > 4 ? ' 等' : ''}）`,
        why: '没有设定图的角色和场景，出图时只能靠文字描述压 —— 那是四层一致性手段里最弱的一层。',
        fix: '到「设定集」把这几条出了，再重出用到它们的镜头。'
      });
    }
  }

  const counts = { blocker: 0, warn: 0, note: 0 };
  for (const i of items) counts[i.level] += 1;

  const penalty = LEVELS.reduce((sum, l) => sum + counts[l] * WEIGHT[l], 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const verdict = counts.blocker ? 'not-ready' : counts.warn ? 'fixable' : 'ready';

  // 排序：先按严重程度，同档保持发现顺序（那个顺序本身是有意义的：产物 → 一致性 → 文字）
  items.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
  return { score, verdict, items, counts };
}

export const VERDICT_LABELS = {
  ready: '可以发',
  fixable: '能发，但有几处值得改',
  'not-ready': '先别发'
};

/**
 * 一句话结论。
 *
 * ⚠ 只有分数的那种说法（"质量分 88"）是没有信息量的 ——
 * 人下一秒就要问"哪儿扣的分"。所以这句话永远带上**最要紧的那一条**。
 */
export function headline(report) {
  const label = VERDICT_LABELS[report.verdict];
  if (report.verdict === 'ready') return `${label} —— 没有查出问题（${report.score} 分）`;
  const worst = report.items[0];
  const tail = report.counts.blocker
    ? `${report.counts.blocker} 处会被看出来`
    : `${report.counts.warn} 处质量风险`;
  return `${label}（${report.score} 分，${tail}）：${worst.what}`;
}

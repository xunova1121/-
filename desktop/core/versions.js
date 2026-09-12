/**
 * 产物的历史版本 —— 重出之前，先把上一版留下来。
 *
 * ── 补的是哪个洞 ──
 *
 * 每一次重出写的都是同一个路径（`<镜头id>.png` / `.mp4`），旧的**直接被覆盖**。
 * 于是"重出三次，第二次最好"这种再常见不过的情形没有出路：回不去，只能再赌一次。
 *
 * 而每一版都是真金白银出的。丢掉的不是文件，是已经花掉的钱。
 *
 * ── 为什么按文件算，不按记录算 ──
 *
 * 也可以在 project.json 里记一个版本数组。不这么做，是因为那样有两份真相：
 * 记录说有五版、盘上只剩三个文件（用户清过盘、同步漏了、写到一半崩了），
 * 而界面照着记录画出五个缩略图，点第四个是空的。
 *
 * 直接扫目录就没有这个问题：**盘上有什么就是什么**。代价是每次列版本要读一次
 * 目录，而那是几毫秒的事，一个镜头也就几个文件。
 *
 * ── 留几版 ──
 *
 * 留 5 版。一段 1080p 视频十几 MB，二十镜留满就是一两 G ——
 * 而"我想回到三次之前那一版"实际上很少超过五次。超出的从最旧的删。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 每个产物最多留几个历史版本。超出的从最旧的删 */
export const KEEP = 5;

/** `a/b/c.png` → `{ dir, base: 'c', ext: '.png' }` */
function parts(dest) {
  const ext = path.extname(dest);
  return { dir: path.dirname(dest), base: path.basename(dest, ext), ext };
}

/**
 * 这个产物有哪些历史版本，**新的在前**。
 *
 * 排序按文件的修改时间 —— 时间才是人心里的顺序。
 *
 * ⚠ **时间一样时必须拿版本号兜底**，否则顺序是随机的。
 *
 * 这不是理论上的隐患，是 Windows 上真出过的事：
 *   · `renameSync` **不改 mtime** —— 归档出来的文件带的是它当初被写下的时间
 *   · Windows 的系统时钟粒度约 15 毫秒，而连着重出几版远不到 15 毫秒
 * 两条撞在一起，好几个版本的 mtime **一模一样**。JS 的 sort 对相等的键是
 * 稳定排序，于是最终顺序取决于 `readdirSync` 给的顺序（Windows 上是字母序）
 * —— 也就是**最旧的排在最前面**，正好反了。
 *
 * 后果是"回到上一版"回到的是**最旧那一版**。而这一步是覆盖当前产物的，
 * 人点的时候以为是往回退一格。Linux 上完全看不出来（ext4 的 mtime 精确到纳秒，
 * 天然分得开），CI 在 Windows 上跑才红。
 *
 * 版本号在这里是可靠的第二判据：archive() 取的是"现有最大值 + 1"，
 * 所以号越大一定越新 —— 中间删空了几号也不影响这个结论。
 */
export function list(dest) {
  const { dir, base, ext } = parts(dest);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.v(\\d+)${ext.replace('.', '\\.')}$`);
  return names
    .map((n) => {
      const m = re.exec(n);
      if (!m) return null;
      const full = path.join(dir, n);
      let at = 0;
      try {
        at = fs.statSync(full).mtimeMs;
      } catch {
        return null;
      }
      return { path: full, n: Number(m[1]), at: new Date(at).toISOString(), ms: at };
    })
    .filter(Boolean)
    .sort((a, b) => b.ms - a.ms || b.n - a.n);
}

/**
 * 把现在这个文件挪成历史版本，给新的腾地方。
 *
 * 文件不存在（第一次出）就什么都不做，回 null。
 * 用 rename 而不是 copy：同一个目录里改个名是原子的，不会出现
 * "拷了一半、新文件又写进来了"那种两边都不完整的中间态。
 */
export function archive(dest) {
  if (!fs.existsSync(dest)) return null;
  const { dir, base, ext } = parts(dest);

  /**
   * 版本号取"现有最大值 + 1"，不是"现有个数 + 1"。
   * 按个数算的话，删掉旧版之后新版会撞上一个还在的号，直接覆盖掉它 ——
   * 而那正是这个模块要防的事。
   */
  const existing = list(dest);
  const next = existing.reduce((max, v) => Math.max(max, v.n), 0) + 1;
  const archived = path.join(dir, `${base}.v${next}${ext}`);
  try {
    fs.renameSync(dest, archived);
  } catch {
    return null;
  }

  // 超出上限的从最旧的删。留着不删的话，二十镜各留十几版能占掉几个 G
  const after = list(dest);
  for (const old of after.slice(KEEP)) {
    try {
      fs.rmSync(old.path, { force: true });
    } catch {
      /* 删不掉就算了：占点盘，总好过因为删不掉一个文件把整次重出弄失败 */
    }
  }
  return archived;
}

/**
 * 回到某一版。
 *
 * **当前这一版也要先存起来**再覆盖 —— 不然"我看看上一版长什么样"
 * 这个动作本身就会把现在这版弄丢，而人是不会预期点一下"看看"会删东西的。
 */
export function restore(dest, versionPath) {
  if (!fs.existsSync(versionPath)) throw new Error('这一版的文件已经不在了');
  const keep = archive(dest);
  fs.copyFileSync(versionPath, dest);
  return { restored: versionPath, previous: keep };
}

/** 这个产物连同它的历史版本，一共占多少字节 */
export function bytes(dest) {
  const all = [dest, ...list(dest).map((v) => v.path)];
  return all.reduce((sum, p) => {
    try {
      return sum + fs.statSync(p).size;
    } catch {
      return sum;
    }
  }, 0);
}

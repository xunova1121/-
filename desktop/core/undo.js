/**
 * ══════════ 撤销：把分镜表退回上一步 ══════════
 *
 * ── 补的是哪个洞 ──
 *
 * `versions.js` 早就在管**产物**了：每次重出图之前先把上一版存下来，
 * 理由写在那儿——"丢掉的不是文件，是已经花掉的钱"。
 *
 * 而**文字**（描述、景别、时长、技法、场次）一直是直接盖掉的，一版都不留。
 * 当时的默认前提是"改文字不花钱，所以改错了再改回来就行"。
 *
 * 指令框把这个前提推翻了：现在**一个回车能改掉五十镜的文案**。
 * 说岔一句（想改第 6-12 镜、它理解成了「全部」而你按快了），
 * 整张分镜表就没了，而且没有任何一条路回得去。
 * 一个能一次改五十镜的工具，必须配一条一次退回来的路。
 *
 * ── 为什么和 versions.js 一个路子 ──
 *
 * 那个文件里写着：不在 project.json 里记版本数组，因为那样有**两份真相**——
 * 记录说有五版、盘上只剩三个（清过盘、同步漏了、写到一半崩了），
 * 而界面照着记录画出五个，点第四个是空的。
 *
 * 这里同理：快照就是盘上的文件，**扫目录就是全部事实**。
 * 但比产物多一件事：**每一步得有名字**。
 * Blender 的撤销栈最有用的地方不是能退，是能看见"退的是哪一步"——
 * 一列没有标签的时间戳，人根本不敢按。
 *
 * 名字存在快照文件**内部**（`_undo` 字段），不另开一个索引文件 ——
 * 另开就又变回两份真相了。
 *
 * ── 撤销本身也要能撤销 ──
 *
 * 退回去之前，先把**当前**这份存一张。否则"手滑点了撤销"就成了
 * 一个没法挽回的操作 —— 那正是这个模块要消灭的东西。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 留几步。再多的意义很小，而每张快照是一整份分镜表 */
export const KEEP = 8;

const RE = /^project\.undo-(\d+)\.json$/;

function dirOf(projectDir) {
  return projectDir;
}

/**
 * 有哪几步可以退回去，**新的在前**。
 *
 * 读不出来的快照（写到一半崩了、被手动删了半截）**直接跳过，不报错**：
 * 撤销列表是给人救急用的，一张坏文件不该让整条路不可用。
 */
export function list(projectDir) {
  const dir = dirOf(projectDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => RE.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({
        n: Number(RE.exec(name)[1]),
        file,
        at: json?._undo?.at || null,
        label: json?._undo?.label || '（没记下是哪一步）',
        shots: (json?.shots || []).length
      });
    } catch {
      // 坏文件跳过 —— 见上
    }
  }
  return out.sort((a, b) => b.n - a.n);
}

/**
 * 动手之前先存一张。
 *
 * @param label 这一步**要做什么**，人话。比如"批量改了 7 镜的景别"。
 *              ⚠ 存的是"改之前"的状态，所以标签描述的是**即将发生**的事 ——
 *              界面上写「撤销：批量改了 7 镜的景别」才读得通。
 */
export function snapshot(projectDir, label = '') {
  const dir = dirOf(projectDir);
  const src = path.join(dir, 'project.json');
  if (!fs.existsSync(src)) return null;

  let json;
  try {
    json = JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch {
    // 当前这份都读不出来，就别存一张坏的进去占位置
    return null;
  }
  json._undo = { at: new Date().toISOString(), label: String(label || '').slice(0, 120) };

  const next = (list(dir)[0]?.n || 0) + 1;
  const file = path.join(dir, `project.undo-${next}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8');
  fs.renameSync(tmp, file);

  prune(dir);
  return file;
}

/** 超出 KEEP 的从最旧的删 */
function prune(dir) {
  const all = list(dir);
  for (const old of all.slice(KEEP)) {
    try { fs.unlinkSync(old.file); } catch { /* 删不掉就算了，下次再说 */ }
  }
}

/**
 * 退回某一步。
 *
 * ⚠ 退之前先把**当前**存一张（标签写明是"撤销前"），否则手滑点了撤销
 * 就成了一个没法挽回的操作 —— 而这个模块存在的全部理由就是消灭那种操作。
 */
export function restore(projectDir, n) {
  const dir = dirOf(projectDir);
  const hit = list(dir).find((v) => v.n === Number(n));
  if (!hit) throw new Error(`没有这一步可以退（#${n}）`);

  const json = JSON.parse(fs.readFileSync(hit.file, 'utf8'));
  snapshot(dir, `撤销前的状态（退回到「${hit.label}」之前）`);

  /**
   * `_undo` 是快照自己的元数据，**不能写回正式档**。
   * 写回去的话，下一张快照会把上一张的标签当成自己的，
   * 撤销列表里就会出现一串一模一样的名字。
   */
  delete json._undo;

  const dest = path.join(dir, 'project.json');
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8');
  fs.renameSync(tmp, dest);
  return json;
}

/** 快照占了多少盘（界面上说一句，免得人以为项目莫名其妙变大了） */
export function bytes(projectDir) {
  return list(projectDir).reduce((n, v) => {
    try { return n + fs.statSync(v.file).size; } catch { return n; }
  }, 0);
}

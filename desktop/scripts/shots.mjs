/**
 * 每一镜到底是什么状态 —— **只读，不花钱，不改任何东西**。
 *
 *     node scripts/shots.mjs            # 最近改过的那个项目
 *     node scripts/shots.mjs <项目名>   # 或者项目 id / 名字的一部分
 *
 * ════════ 为什么需要它 ════════
 *
 * 用户报的：「视频13段都生成两次了，PC和移动端还是显示只生成了4段」。
 *
 * 界面上那几镜看起来长得一模一样，都是"有图没视频" —— 可它们分属
 * **三种完全不同的处境，补救动作也完全不同**：
 *
 *   ① 提交成功、片子在厂商那边、我们没取回来（有 task_id）
 *      → 免费捞得回来。重出是第二次付钱。
 *   ② 提交就失败了（没有 task_id）
 *      → 捞不回来，只能重出；但得先知道当初为什么被拒。
 *   ③ 压根没跑到（前面那一镜挂了、或者被叫停了）
 *      → 跑一下就行，什么都没浪费。
 *
 * 分不清这三种，就只能"再全跑一遍" —— 而那正是第二次付钱的由来。
 * 这个命令把三种分开摆出来，并且直接告诉你该按哪个键。
 */
import { list, read } from '../core/store.js';

const want = process.argv[2] || '';
const all = list();
if (!all.length) {
  console.log('这台机器上一个项目都没有。');
  process.exit(0);
}

const hit = want
  ? all.find((p) => p.id === want || (p.title || '').includes(want))
  : all[0]; // list() 已按 updatedAt 倒序
if (!hit) {
  console.log(`没找到项目「${want}」。现有的是：`);
  for (const p of all) console.log(`  ${p.id}  ${p.title}`);
  process.exit(1);
}

const project = read(hit.id);
const shots = (project.shots || []).slice().sort((a, b) => a.index - b.index);
console.log(`\n项目：${project.title}（${project.id}）  共 ${shots.length} 镜\n`);

const owed = [];
const failed = [];
const notRun = [];
const ok = [];

for (const s of shots) {
  if (s.videoPath) ok.push(s);
  else if (s.pendingTask) owed.push(s);
  else if (s.videoError) failed.push(s);
  else notRun.push(s);
}

const pad = (n) => String(n).padStart(2, ' ');
console.log(`✓ 已有视频       ${pad(ok.length)} 镜${ok.length ? `：第 ${ok.map((s) => s.index).join('、')} 镜` : ''}`);
console.log(`$ 钱花了没取回来 ${pad(owed.length)} 镜${owed.length ? `：第 ${owed.map((s) => s.index).join('、')} 镜` : ''}`);
console.log(`✕ 出视频失败了   ${pad(failed.length)} 镜${failed.length ? `：第 ${failed.map((s) => s.index).join('、')} 镜` : ''}`);
console.log(`· 还没跑到       ${pad(notRun.length)} 镜${notRun.length ? `：第 ${notRun.map((s) => s.index).join('、')} 镜` : ''}`);

if (owed.length) {
  console.log('\n─── 钱花了、片子没取回来 ───');
  console.log('这几镜提交是成功的，片子多半还在厂商那边放着。**重出等于第二次付钱。**');
  console.log('捞回来的地方：');
  console.log('  手机 → 流水线页最上面那张黄卡「把这几镜捞回来（不花钱）」');
  console.log('  电脑 → 流水线 → 点开「视频生成」→「重查待认领任务（不花钱）」');
  for (const s of owed) {
    console.log(`  第 ${s.index} 镜  ${s.pendingTask.provider}  ${s.pendingTask.taskId}  ${s.pendingTask.at}`);
  }
}

if (failed.length) {
  console.log('\n─── 出视频失败了（没有任务号，捞不回来）───');
  console.log('这几镜要重出。先看看当初为什么被拒 —— 同样的原因重出十次也还是被拒：');
  for (const s of failed) {
    console.log(`  第 ${s.index} 镜  ${s.videoError.at}`);
    console.log(`      ${s.videoError.message}`);
  }
}

if (!owed.length && !failed.length && notRun.length) {
  console.log('\n这几镜只是还没跑到 —— 直接跑「视频生成」就行，什么都没浪费。');
}

/**
 * ⚠ 老项目上这两栏可能都是空的。
 *
 * "失败原因"是后来才开始存的（在那之前它只作为一个事件发进进度流里，
 * 流一断就没了）。所以更新之前失败的那些镜，这里只会显示"还没跑到"——
 * 不是它们没跑过，是当时没人把原因记下来。重出一次之后就有了。
 */
if (!owed.length && !failed.length && notRun.length && ok.length) {
  console.log('（如果这几镜其实跑过、只是失败了：失败原因是这一版才开始存的，');
  console.log('  更早那些失败没有记录。重出一次，这次的原因就会留下来。）');
}
console.log('');

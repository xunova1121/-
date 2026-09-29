#!/usr/bin/env node
/**
 * 搬家 —— 一条命令把家当打包，另一条命令在新机器上展开。
 *
 *   # 旧机器上
 *   node scripts/migrate.mjs export ~/fd-move.zip
 *
 *   # 传过去（服务器到服务器，别绕道你的笔记本）
 *   scp ~/fd-move.zip root@新IP:~/
 *
 *   # 新机器上
 *   node scripts/migrate.mjs import ~/fd-move.zip
 *
 * ── 为什么给命令行，而不是只做个网页按钮 ──
 *
 * 服务器换服务器时，网页那条路是「服务器 → 你的浏览器 → 你的硬盘 →
 * 再传上去新服务器」，几个 GB 要过两趟你家的宽带。而 scp 是两台机房之间直连，
 * 通常快一个数量级，还不占你的流量。
 *
 * 网页那条也留着（设置里），因为它适合另一种情况：从**电脑版**搬到服务器 ——
 * 那时候东西本来就在你手上。
 *
 * ── 密钥 ──
 *
 * 带密钥就得给一个口令：导出时用它重新加密，导入时用它打开。
 * 那个口令只在你脑子里，不在包里 —— 所以这个包可以放心地过 scp、网盘、U 盘。
 * 不想带就 --no-secrets，到新机器上重配一遍，最省心。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const cmd = args[0];
const file = args[1];
const flag = (name) => args.includes(`--${name}`);

if (!cmd || !file || !['export', 'import'].includes(cmd)) {
  console.log(`用法：
  node scripts/migrate.mjs export <包路径> [--no-media] [--no-secrets]
  node scripts/migrate.mjs import <包路径>

  --no-media    不带图和视频。包会小很多，到新机器上重出一次就有了
  --no-secrets  不带密钥。新机器上自己重配，最省心

数据目录由 FUTUREDREAM_DATA_DIR 决定；Docker 里跑的话在容器内执行：
  docker compose exec app node scripts/migrate.mjs export /data/move.zip`);
  process.exit(cmd ? 1 : 0);
}

const migrate = await import('../core/migrate.js');

/** 口令不能走命令行参数：那会留在 shell 历史和 ps 输出里 */
function askPassphrase(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

if (cmd === 'export') {
  const media = !flag('no-media');
  const want = migrate.survey({ media });

  console.log('\n要搬的东西：');
  console.log(`  项目      ${want.projects} 个`);
  console.log(`  文件      ${want.files} 个，共 ${mb(want.bytes)}`);
  if (want.mediaBytes) {
    console.log(`  其中媒体  ${mb(want.mediaBytes)}${media ? '' : '（这次不带）'}`);
  }
  console.log(`  密钥      ${want.secrets} 把`);

  let passphrase = '';
  if (!flag('no-secrets') && want.secrets) {
    console.log(
      '\n密钥要用一个口令重新加密 —— 它只在你脑子里，不进这个包，\n' +
        '所以包可以放心地过 scp、网盘、U 盘。导入时要填同一个。'
    );
    passphrase = await askPassphrase('设一个口令（直接回车 = 这次不带密钥）：');
  }

  const out = await migrate.exportTo(path.resolve(file), {
    passphrase,
    media,
    onEvent: (e) => console.log(`  ${e.message}`)
  });

  console.log(`\n✓ 打好了：${out.path}（${mb(out.bytes)}，${out.files} 个文件，${out.secrets} 把密钥）`);
  console.log('\n传到新机器（两台机房之间直连，别绕道自己的笔记本）：');
  console.log(`  scp ${out.path} root@新IP:~/`);
  console.log('\n然后在新机器上：');
  console.log(`  node scripts/migrate.mjs import ~/${path.basename(out.path)}`);
  process.exit(0);
}

// ── 导入 ──
if (!fs.existsSync(file)) {
  console.error(`找不到这个包：${file}`);
  process.exit(1);
}

// 先看一眼里面带没带密钥，带了才问口令 —— 不该为一个不需要的东西打断人
const { readZip } = await import('../core/zip.js');
let needPass = false;
try {
  const entry = (await readZip(path.resolve(file))).find((e) => e.name === 'futuredream.json');
  needPass = Boolean(JSON.parse(entry.data.toString('utf8')).secrets);
} catch (err) {
  console.error(`这个包读不开：${err.message}`);
  process.exit(1);
}

const passphrase = needPass ? await askPassphrase('这个包里带着密钥，填导出时设的那个口令：') : '';

try {
  const r = await migrate.importFrom(path.resolve(file), {
    passphrase,
    onEvent: (e) => console.log(`  ${e.message}`)
  });
  console.log(`\n✓ 展开了 ${r.files} 个文件，${r.projects} 个项目，${r.secrets} 把密钥`);
  if (r.renamed.length) {
    // 重名不覆盖：盖掉新机器上这几天的活是不可接受的
    console.log(`\n有 ${r.renamed.length} 个项目和这台机器上已有的重名，已经另存为新项目（标题后面带「（导入）」）：`);
    for (const x of r.renamed.slice(0, 5)) console.log(`  ${x.from} → ${x.to}`);
  }
  if (!r.withMedia) {
    console.log('\n⚠ 这个包不带图和视频 —— 项目和分镜都在，重跑「镜头出图」那一步就有了。');
  }
  console.log('\n重启一下服务让它读到新数据：docker compose restart app');
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}

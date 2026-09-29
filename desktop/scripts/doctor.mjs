/**
 * 体检 —— **在你自己的机器上**，用你自己的密钥，真的跑一遍。
 *
 * ════════ 为什么非要有一个命令行版 ════════
 *
 * 界面里本来就有「路由体检」，但它只在有浏览器的地方点得到。
 * 而最需要体检的两个场合恰恰都没有浏览器：
 *
 *   · 服务器上   —— ssh 进去，`docker compose exec app node scripts/doctor.mjs`
 *   · 出问题时   —— 界面打不开、或者根本不知道该看哪一屏
 *
 * ════════ 它验的是别处验不了的那部分 ════════
 *
 * 自检（selftest）全程打桩，不联外网 —— 它验的是我们的逻辑。
 * 真 FFmpeg 自检（realcheck）验的是合成真跑起来对不对。
 * 这两样我都能替你跑。
 *
 * 但**你的密钥、你的桶、你的网络**我碰不到，也不该碰。
 * 那三样只有在你的机器上才验得了，而它们恰恰是最常出问题的三样：
 *
 *   密钥对不对、模型 ID 存不存在、余额够不够
 *   对象存储的签名、地域、权限
 *   这台机器到厂商的网络通不通（公司网络、跨境）
 *
 * 这个命令就是替你把那三样一次问清楚。
 *
 * ════════ 花不花钱 ════════
 *
 * 默认跑的那几项里，**出图会真的生成一张图，是真计费的**。
 * 别处（界面上的路由体检）默认也是这么跑的，这里保持一致 ——
 * 但开跑前会把这一轮里所有会计费的项列出来，不让它闷声花钱。
 * 出视频默认不跑：那一项贵得多，也慢得多。
 *
 * 这段话不写死"哪几项默认跑"，因为清单在 preflight.CHECKS 里，
 * 会变。写死的注释迟早变成谎话（这一段上一版就是错的）。
 *
 *     node scripts/doctor.mjs              默认几项
 *     node scripts/doctor.mjs --all        全部（含出视频，慢且贵）
 *     node scripts/doctor.mjs ffmpeg oss   只跑点名的（这两项免费）
 *
 * ⚠ 全程不打印任何密钥。报告可以直接贴给别人看。
 */
import process from 'node:process';

const preflight = await import('../core/preflight.js');
const settings = await import('../core/settings.js');
const version = await import('../core/version.js');
const paths = await import('../core/paths.js');
const deploy = await import('../core/deploy.js');

const argv = process.argv.slice(2);
const wantAll = argv.includes('--all');
const named = argv.filter((a) => !a.startsWith('--'));

const ALL = preflight.CHECKS.map((c) => c.id);
const include = named.length ? named : wantAll ? ALL : null;

const bad = (named || []).filter((n) => !ALL.includes(n));
if (bad.length) {
  console.error(`不认识这几项：${bad.join('、')}`);
  console.error(`可选：${ALL.join(' ')}`);
  process.exit(2);
}

/**
 * 输出不是终端时（管道、重定向、CI 日志）一律不发颜色和光标控制码。
 *
 * 这条不是为了好看：这份报告的用途之一就是**贴给别人看**。
 * 带着一串 `\x1b[2K` 和 `[32m` 贴出去，读的人先要在心里过滤一遍噪音，
 * 而那些噪音正好夹在最该看清的那几行里。
 */
const TTY = process.stdout.isTTY;
const paint = (code, text) => (TTY ? `\x1b[${code}m${text}\x1b[0m` : text);

const C = {
  ok: paint(32, '✓'),
  fail: paint(31, '✗'),
  warn: paint(33, '!'),
  skip: paint(90, '–'),
  running: '·'
};

const info = version.info();
console.log(`\n${paint(1, '未来创梦 体检')}  版本 ${info.version}（${info.build}）`);
console.log(`模式：${deploy.SERVER_MODE ? '服务器' : '本机'}    数据目录：${paths.DATA_DIR}`);

const picked = include || preflight.CHECKS.filter((c) => c.defaultOn).map((c) => c.id);
const costly = preflight.CHECKS.filter((c) => picked.includes(c.id) && /高|低$/.test(c.cost) && c.cost !== '极低' && c.cost !== '免费');
if (costly.length) {
  console.log(paint(33, `这一轮包含会计费的项：${costly.map((c) => `${c.label}（${c.cost}）`).join('、')}`));
}
console.log('');

const results = [];
await preflight.run({ include }, (ev) => {
  if (ev.type === 'check' && ev.status === 'running') {
    // 只有真终端才画这个"正在跑"的行。\x1b[2K 是"擦掉整行" ——
    // 别去数字符宽度补空格：中文是双宽，padEnd 数不准
    if (TTY) process.stdout.write(`\x1b[2K  ${C.running} ${labelOf(ev.id)}…\r`);
    return;
  }
  if (ev.type !== 'check') return;
  results.push(ev);

  const glyph = C[ev.status] || '?';
  const who = ev.provider === '本机' ? '本机' : `${ev.providerName}${ev.model ? ` / ${ev.model}` : ''}`;
  process.stdout.write(`${TTY ? '\x1b[2K' : ''}  ${glyph} ${labelOf(ev.id)}  ${who}  ${paint(90, `${ev.ms}ms`)}\n`);
  if (ev.detail) console.log(`      ${ev.detail}`);
  if (ev.message) console.log(`      ${ev.message}`);
  // 只说哪里错了没用，人下一秒就要问"那该怎么办"
  if (ev.hint) console.log(`      ${paint(36, `→ ${ev.hint}`)}`);
});

function labelOf(id) {
  return preflight.CHECKS.find((c) => c.id === id)?.label || id;
}

// ── 手机那一头 ──
console.log(`\n${paint(1, '手机能不能连上')}`);
if (deploy.SERVER_MODE) {
  console.log(`  地址：https://${deploy.PUBLIC_HOST || '（还没配 FD_HOST）'}`);
  console.log(`  ${deploy.PUBLIC_HOST ? C.ok : C.fail} 手机浏览器直接打开这个地址，输访问口令即可`);
  // 口令绝不打印。它和密钥一样，打印出来就等于写进了终端历史和日志
  console.log(`      访问口令在 .env 的 FD_TOKEN 里（这里不打印它）`);
} else {
  const server = await import('../core/server.js');
  const addrs = server.lanAddresses();
  if (!addrs.length) {
    console.log(`  ${C.warn} 这台机器没有局域网地址，手机连不上`);
  } else {
    console.log(`  ${C.ok} 手机和这台电脑连同一个 Wi-Fi，然后打开：`);
    for (const a of addrs) console.log(`      http://${a.address}:${settings.get('lanPort') || 5179}/m`);
    console.log(`      配对码在电脑上「设置 → 手机遥控」里（这里不打印它）`);
  }
}

// ── 结论 ──
const failed = results.filter((r) => r.status === 'fail');
const warned = results.filter((r) => r.status === 'warn');
const skipped = results.filter((r) => r.status === 'skip');

console.log(`\n${'─'.repeat(56)}`);
if (failed.length) {
  console.log(`${paint(31, `${failed.length} 项不通`)}：${failed.map((f) => labelOf(f.id)).join('、')}`);
  console.log('流水线跑到那几步会停下来。上面每一条都写了下一步该做什么。');
} else if (warned.length) {
  console.log(`${paint(33, `能跑，但有 ${warned.length} 处要留意`)}：${warned.map((f) => labelOf(f.id)).join('、')}`);
} else {
  console.log(paint(32, '都通了'));
}
if (skipped.length) {
  // 跳过 ≠ 通过。这两件事必须分开说，否则"跳过"会被读成"没问题"
  console.log(paint(90, `跳过 ${skipped.length} 项（没配就是没配，不算通过）：${skipped.map((f) => labelOf(f.id)).join('、')}`));
}
if (!include) {
  // 照着 CHECKS 现算，别在这儿写死一句话 —— 写死的那句上一版就是错的
  //（说"出图默认没跑"，而出图的 defaultOn 一直是 true，它每次都在跑，还计费）
  const off = preflight.CHECKS.filter((c) => !c.defaultOn).map((c) => c.label);
  if (off.length) {
    console.log(paint(90, `这几项默认没跑：${off.join('、')}。要一起验：node scripts/doctor.mjs --all`));
  }
}
console.log('');

process.exit(failed.length ? 1 : 0);

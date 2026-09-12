/**
 * 创作台打开有多慢 —— 先量，别猜。
 *
 *     node scripts/perfcheck.mjs
 *
 * 量两样：进这一页要发多少条请求、其中**串行等了多少**。
 * 串行是这里的关键：七条各 200ms 的请求，并行是 200ms，串行是 1.4 秒 ——
 * 而在自己机器上跑本地服务时每条只要 1ms，这个差别根本显不出来。
 * 用户是在香港那台服务器上开的，每一跳都真的要走一趟网络。
 *
 * 所以这个脚本给每条 /api 请求人为加一段延迟，把远端的样子模拟出来。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
let chromium;
try {
  const mod = await import(PW);
  chromium = mod.chromium || mod.default?.chromium;
  if (!chromium) throw new Error('没有 chromium');
} catch {
  console.error('没找到 Playwright：npm i -g playwright && npx playwright install chromium');
  process.exit(2);
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-perf-'));
process.env.FUTUREDREAM_DATA_DIR = SANDBOX;
process.env.FUTUREDREAM_NO_OPEN = '1';

// ⚠ 动态 import 不能直接吃绝对路径：Windows 上 C:\... 会被当成协议名，直接崩。
// 必须转成 file:// URL
const mod = (rel) => import(pathToFileURL(path.join(ROOT, '..', rel)).href);
const settings = await mod('core/settings.js');
const store = await mod('core/store.js');
const { listen } = await mod('core/server.js');

settings.patch({ autoCheckOnStart: false });

// 二十镜是个常见规模；镜头越多，页面里那些"每镜一张卡"的开销才显出来
const proj = store.create({ title: '性能量一量', aspectRatio: '16:9', script: '阿澜在码头巡查。' });
store.update(proj.id, (p) => {
  p.bible = {
    style: { anchor: '国风水墨', palette: '', negative: '' },
    characters: [{ name: '阿澜', appearance: '短发', seed: 1, variants: [], sheetPath: '' }],
    scenes: [{ name: '码头', appearance: '晨雾' }],
    props: []
  };
  p.shots = Array.from({ length: 20 }, (_, i) => ({
    id: `s${i + 1}`,
    index: i + 1,
    scene: '码头',
    characters: ['阿澜'],
    description: `第 ${i + 1} 镜的画面描述`,
    camera: '中景',
    duration: 4
  }));
  p.stageStatus = { ...p.stageStatus, bible: 'done', script: 'done' };
  return p;
});

const { url } = await listen(0);
const LATENCY = Number(process.env.FD_LATENCY_MS || 120);

const b = await chromium.launch();
const ctx = await b.newContext();

const calls = [];
await ctx.route('**/api/**', async (route) => {
  const started = Date.now();
  calls.push({ path: new URL(route.request().url()).pathname, at: started });
  // 模拟一跳真网络。本地跑一切都是 1ms，串行的代价根本显不出来
  await new Promise((r) => setTimeout(r, LATENCY));
  return route.continue();
});

/**
 * 模拟**回头用户**：浏览器里存着上次打开的项目。
 * 这才是天天遇到的路径 —— 第一次访问是少数。两种都量，别只挑好看的那个报。
 */
if (process.env.FD_FRESH !== '1') {
  await ctx.addInitScript((id) => localStorage.setItem('fd.projectId', id), proj.id);
}

const page = await ctx.newPage();
console.log(`创作台加载：每条 /api 加 ${LATENCY}ms 延迟（模拟远端服务器）\n`);

const t0 = Date.now();
await page.goto(`${url}#/studio/${proj.id}`);
await page.waitForSelector('.nav-step', { timeout: 30000 });
await page.waitForFunction(() => !document.querySelector('.spin'), null, { timeout: 30000 }).catch(() => {});
const elapsed = Date.now() - t0;

// 把请求按"开始时刻"分组：几乎同时开始的算一批，批数就是串行的深度
const sorted = calls.slice().sort((a, b2) => a.at - b2.at);
const waves = [];
for (const c of sorted) {
  const last = waves[waves.length - 1];
  if (last && c.at - last.at < LATENCY / 2) last.items.push(c.path);
  else waves.push({ at: c.at, items: [c.path] });
}

console.log(`  总耗时       ${elapsed} ms`);
console.log(`  /api 请求数  ${calls.length}`);
console.log(`  串行波次     ${waves.length}   ← 这个数乘以单跳延迟，就是白等的时间`);
for (const [i, w] of waves.entries()) {
  console.log(`    第 ${i + 1} 波：${w.items.join('、')}`);
}
console.log(`\n  理论下限     ${LATENCY} ms（全并行时只等一跳）`);
console.log(`  现在白等了   约 ${(waves.length - 1) * LATENCY} ms`);

await b.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(0);

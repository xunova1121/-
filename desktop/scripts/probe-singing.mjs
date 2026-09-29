#!/usr/bin/env node
/**
 * ══════════ 探路：唱歌的戏怎么出 —— 两条路同时发，放一起比 ══════════
 *
 * 这是一个**探路脚本**，不是产品功能。它不改任何项目数据，
 * 所有产出都写到数据目录下的 probe\sing-<时间>\ 里。
 *
 * ── 同一镜、同一张首帧、同一段歌词，同时发两条 ──
 *
 *   A  照着歌对口型   把**你提供的那首歌**切出这一镜的那几秒，
 *                    连同首帧一起发给万相（input.audio_url），
 *                    让画面里的人跟着这段歌声张嘴、换气、摆动。
 *                    唱的就是那首歌 —— 旋律、嗓音都是原样的。
 *
 *   B  模型自己唱     不给音频，只把歌词写进提示词，让能出声的模型自己唱。
 *                    旋律和嗓音由模型发挥 —— 一定不是你要模仿的那首，
 *                    那正是要确认的代价。
 *
 * 两条互不影响：一条被厂商拒了，另一条照样等到出片。
 *
 * ── 用法（在 desktop 目录下）──
 *
 *   node scripts/probe-singing.mjs
 *       列出所有项目
 *
 *   node scripts/probe-singing.mjs <项目名或id>
 *       列出这个项目里出好图的镜头，和项目里挂着的歌（剪辑台上传的那首）
 *
 *   node scripts/probe-singing.mjs <项目> --shot 5 --from 32.5 --b-model <Seedance 1.5 pro 的 ID>
 *       预览：切出歌的那一段、打印两条会发出去的请求，不发
 *
 *   ... 同上 ... --go
 *       真的发。会**同时**调用两次视频生成，按厂商计费。
 *
 * ── 开关 ──
 *
 *   --shot <镜号>        用哪一镜的首帧（必须已经出了图）
 *   --song <文件>        歌。不填就用这个项目在剪辑台上传的那首
 *   --from <秒>          从歌的第几秒开始切（默认 0）
 *   --seconds 5|10       这一镜多长（默认 5；歌就切这么长）
 *   --lyrics "<歌词>"    这几秒唱的词。不填就用这一镜的台词
 *   --vibe "<曲风>"      只给 B 用：比如"抒情慢歌，温柔女声"
 *   --a-model <ID>       A 用的万相模型（默认 wan2.6-i2v）
 *   --b-via volcengine|dashscope   B 走哪家（默认 volcengine）
 *   --b-model <ID>       B 用的模型。走火山时必填（Seedance 1.5 pro 起，
 *                        ID 带日期后缀，从控制台原样复制 —— 我不猜）；
 *                        走百炼时默认 wan2.6-i2v
 *
 * ── 前提 ──
 *
 * A 那条要把**图和歌都**变成公网地址（百炼只收公网地址）——
 * 设置里要配好「对象存储」或「上传网关」。
 *
 * ⚠ 歌必须是你有权使用的：自己唱的、买了授权的、或用你自己的模型生成的。
 *   脚本不会、也不该替你去网上找歌。拿热门歌的原唱去做要发布的片子，版权风险在你那边。
 *
 * ── 密钥 ──
 *
 * 先从保险箱里取；exe 版的保险箱用普通 node 打不开，那时会让你**当场粘贴**：
 * 不回显、只在这次运行的内存里、不写进任何文件。两家各问一次。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const store = await import('../core/store.js');
const settings = await import('../core/settings.js');
const vault = await import('../core/vault.js');
const catalog = await import('../core/providers/catalog.js');
const providers = await import('../core/providers/index.js');
const ffmpeg = await import('../core/ffmpeg.js');
const studio = await import('../core/pipeline/studio.js');
const { firstMediaUrl } = await import('../core/providers/adapters.js');
const { DATA_DIR } = await import('../core/paths.js');

// ─────────────────────────── 参数 ───────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const VALUED = new Set(['--shot', '--song', '--from', '--seconds', '--lyrics', '--vibe', '--a-model', '--b-via', '--b-model']);
const who = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));

const SHOT = opt('shot');
const FROM = Math.max(0, Number(opt('from')) || 0);
const SECONDS = Number(opt('seconds')) || 5;
const GO = flag('go');
const A_MODEL = opt('a-model') || 'wan2.6-i2v';
const B_VIA = opt('b-via') || 'volcengine';
const B_MODEL = opt('b-model') || (B_VIA === 'dashscope' ? 'wan2.6-i2v' : null);

const say = (...a) => console.log(...a);
const hr = () => say('─'.repeat(60));
const bail = (...lines) => { for (const l of lines) say(l); process.exit(1); };

// ─────────────────────────── 找项目 ───────────────────────────

const all = store.list();
if (!who) {
  say('有这些项目（把名字或 id 接在命令后面）：\n');
  for (const p of all) say(`  ${p.id}  ${p.title || '(无名)'}  ${p.shots} 镜`);
  if (!all.length) say(`  （一个都没有 —— 数据目录是 ${DATA_DIR}）`);
  process.exit(0);
}
const hit = all.find((p) => p.id === who) || all.find((p) => String(p.title || '').includes(who));
if (!hit) bail(`找不到项目「${who}」。不带参数跑一次能列出所有项目。`);
const project = store.read(hit.id);
const shots = (project.shots || []).slice().sort((a, b) => a.index - b.index);
const bible = project.bible || { characters: [], scenes: [], style: {} };
const ff = ffmpeg.locate();

/** 这一镜真正要唱/念的词：去掉括注、说话人前缀、外层引号（和另一个探路脚本同一套规则） */
const spoken = (d) => String(d || '')
  .replace(/[（(][^）)]*[）)]/g, '')
  .replace(/^[^：:「“"]{1,8}[：:]/, '')
  .trim()
  .replace(/^[「“"『]+|[」”"』]+$/g, '')
  .trim();

const songPath = opt('song') || project.edit?.music?.path || null;
const songSeconds = songPath && fs.existsSync(songPath) && ff
  ? await ffmpeg.probeDuration(songPath).catch(() => null)
  : null;

say(`项目：${project.title}（${project.id}）`);
say(songPath
  ? `歌：${path.basename(songPath)}${songSeconds ? `（${songSeconds.toFixed(1)} 秒）` : ''}${opt('song') ? '' : ' —— 剪辑台上传的那首'}`
  : '歌：没有。用 --song 指一个文件，或者先在剪辑台上传一首。');
hr();

if (!SHOT) {
  say('【出好图的镜头】挑一镜（--shot 镜号）。带 ♪ 的是台词里像在唱的\n');
  for (const s of shots.filter((x) => x.imagePath)) {
    const line = spoken(s.dialogue);
    const singing = /唱|♪|歌/.test(`${s.dialogue || ''}${s.description || ''}`);
    say(`  #${s.index}${singing ? ' ♪' : '  '} ${(s.characters || []).join('、') || '(无人)'} · ${String(s.description || '').slice(0, 30)}${line ? ` · 「${line.slice(0, 20)}」` : ''}`);
  }
  if (!shots.some((x) => x.imagePath)) say('  （一镜都还没出图 —— 两条路都要首帧，先出图再来）');
  hr();
  say('下一步：加上 --shot <镜号> --from <歌的第几秒> --b-model <模型ID> 预览要发的两条请求。');
  process.exit(0);
}

// ─────────────────────────── 检查 ───────────────────────────

const shot = shots.find((s) => String(s.index) === String(SHOT));
if (!shot) bail(`没有第 ${SHOT} 镜。`);
if (!shot.imagePath || !fs.existsSync(shot.imagePath)) bail(`第 ${SHOT} 镜还没出图（或图片文件不在了），两条路都要首帧。`);
if (![5, 10].includes(SECONDS)) bail('--seconds 只能是 5 或 10（两家都只收这两档）。');
if (!ff) bail('找不到 FFmpeg，切不了歌。设置 → 本机环境里配好再跑。');
if (!songPath || !fs.existsSync(songPath)) bail('没有歌可用。用 --song 指一个你有权使用的音频文件。');
if (songSeconds && FROM + SECONDS > songSeconds + 0.05) {
  bail(`歌只有 ${songSeconds.toFixed(1)} 秒，从第 ${FROM} 秒切 ${SECONDS} 秒会切到外面去。`);
}
if (!['volcengine', 'dashscope'].includes(B_VIA)) bail('--b-via 要填 volcengine 或 dashscope。');
if (!B_MODEL) {
  bail('B 那条走火山，要用 --b-model 填**能出声**的 Seedance 模型 ID（1.5 pro 或更新），',
    '从火山方舟控制台 → 开通管理 原样复制。ID 带日期后缀，我不猜 —— 猜错了你会白等一轮然后看到 404。',
    '或者 --b-via dashscope，B 就用万相 2.6 自己唱。');
}
for (const [label, id, m] of [['A', 'dashscope', A_MODEL], ['B', B_VIA, B_MODEL]]) {
  if (!catalog.nativeAudioOf(id, m)) {
    say(`⚠ ${label} 用的 ${m} 按名字认不出是能出声的模型 —— 照样发，但它很可能是哑的。`);
  }
}

const lyrics = (opt('lyrics') || spoken(shot.dialogue)).trim();
if (!lyrics) bail('这一镜没有台词，也没给 --lyrics。至少要知道这几秒唱的是什么词。');
const vibe = (opt('vibe') || '').trim();

// ─────────────────────────── 两条提示词 ───────────────────────────

const singer = shot.speaker && shot.speaker !== '旁白' ? shot.speaker : (shot.characters || [])[0] || '画面中的人';
const singerMeta = (bible.characters || []).find((c) => c.name === singer);
const sceneMeta = (bible.scenes || []).find((x) => x.name === shot.scene);
const base = [
  bible.style?.anchor ? `画风：${bible.style.anchor}` : '',
  sceneMeta?.appearance ? `场景：${shot.scene}，${String(sceneMeta.appearance).slice(0, 60)}` : (shot.scene ? `场景：${shot.scene}` : ''),
  singerMeta?.appearance ? `${singer}：${String(singerMeta.appearance).slice(0, 60)}，保持外貌不变` : '',
  `${shot.camera || '中景'}。${shot.description || ''}`
].filter(Boolean);

/**
 * A：歌是现成的，提示词只管"怎么唱"的身体部分。
 * 歌词也写上 —— 模型知道唱的是哪几个字，嘴型更容易对准（尤其是长音和闭口音）。
 */
const promptA = [
  ...base,
  `${singer}正在唱歌，唱的是：「${lyrics}」。`,
  '口型、呼吸和表情跟着传入的歌声走：长音时嘴保持张开，换气时有自然的吸气，',
  '身体随节奏轻轻摆动。是在唱，不是在说话。'
].join('\n');

/**
 * B：没有歌，旋律要模型自己编。
 * ⚠ 明确写"不要伴奏" —— 合成时我们还要不要再垫音乐，得先听清它唱得怎么样。
 */
const promptB = [
  ...base,
  `${singer}开口唱歌，有旋律地唱出来（不是念）：「${lyrics}」。`,
  vibe ? `曲风：${vibe}。` : '',
  '口型和歌声对上。声音只要这段清唱和自然的环境声，不要伴奏，不要背景音乐。'
].filter(Boolean).join('\n');

// ─────────────────────────── 素材 ───────────────────────────

const outDir = path.join(DATA_DIR, 'probe', `sing-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
fs.mkdirSync(outDir, { recursive: true });

// 切歌：-ss 放在 -i 前面（快，且从关键帧之外也准），再转成单声道 mp3 —— 小，上传快
const songCut = path.join(outDir, 'song-cut.mp3');
try {
  await ffmpeg.run(['-y', '-ss', FROM.toFixed(3), '-i', songPath, '-t', String(SECONDS), '-vn', '-ac', '1', '-ar', '44100', '-b:a', '128k', songCut]);
} catch (err) {
  bail(`切歌失败：${err.message.slice(0, 300)}`);
}

say('把首帧和切好的那段歌转成模型能收的地址…');
const isPublic = (u) => /^https?:\/\//i.test(String(u || ''));
const imageRef = await studio.toModelRef(shot.imagePath, {});
const songRef = await studio.toModelRef(songCut, {});
if (!isPublic(imageRef) || !isPublic(songRef)) {
  bail('A 那条要把图和歌都传成公网地址，而现在转出来的不是（多半是没配对象存储）。',
    '去「设置 → 对象存储」或「上传网关」配好再来。');
}
const ratio = project.aspectRatio || settings.get('aspectRatio') || '16:9';

// ─────────────────────────── 两条请求 ───────────────────────────

const dash = catalog.PROVIDERS.find((p) => p.id === 'dashscope');
const dashUrl = providers.interpolate('{{baseUrl}}/api/v1/services/aigc/video-generation/video-synthesis', dash);

/**
 * ⚠ 两条都不写 audio 开关之类的额外字段：百炼对不认识的参数是严格的，
 * 多一个字段整个任务被顶掉，那时候测的就不是唱歌了。
 */
const routes = [
  {
    key: 'A', title: '照着歌对口型', via: 'dashscope', model: A_MODEL, provider: dash,
    url: dashUrl, headers: { 'X-DashScope-Async': 'enable' },
    body: { model: A_MODEL, input: { prompt: promptA, img_url: imageRef, audio_url: songRef }, parameters: { resolution: '720P', duration: SECONDS } }
  }
];
if (B_VIA === 'dashscope') {
  routes.push({
    key: 'B', title: '模型自己唱', via: 'dashscope', model: B_MODEL, provider: dash,
    url: dashUrl, headers: { 'X-DashScope-Async': 'enable' },
    body: { model: B_MODEL, input: { prompt: promptB, img_url: imageRef }, parameters: { resolution: '720P', duration: SECONDS } }
  });
} else {
  const volc = catalog.PROVIDERS.find((p) => p.id === 'volcengine');
  routes.push({
    key: 'B', title: '模型自己唱', via: 'volcengine', model: B_MODEL, provider: volc,
    // ⚠ 走 interpolate，不直接拼 baseUrl —— 后者会无视设置里填的中转站地址
    url: providers.interpolate('{{baseUrl}}/contents/generations/tasks', volc),
    body: {
      model: B_MODEL,
      content: [
        { type: 'text', text: `${promptB} --resolution 720p --dur ${SECONDS} --ratio ${ratio}` },
        { type: 'image_url', image_url: { url: imageRef } }
      ],
      generate_audio: true
    }
  });
}

const shorten = (body) => JSON.parse(JSON.stringify(body, (k, v) =>
  typeof v === 'string' && v.startsWith('data:') ? `${v.slice(0, 40)}…（base64，${v.length} 字符）` : v));
for (const r of routes) {
  const shown = shorten(r.body);
  fs.writeFileSync(path.join(outDir, `request-${r.key}.json`), JSON.stringify({ url: r.url, body: shown }, null, 2));
  say(`\n【${r.key} · ${r.title}】${r.provider.name} / ${r.model} → ${r.url}\n`);
  say(JSON.stringify(shown, null, 2));
}
hr();
say(`第 ${shot.index} 镜 · ${singer} · ${SECONDS} 秒 · 歌从第 ${FROM} 秒起（切好的在 song-cut.mp3，先听一下切得对不对）`);
say(`输出目录：${outDir}`);

if (!GO) {
  say('\n这是预览，一分钱没花。确认没问题后加 --go，两条会同时发。');
  process.exit(0);
}

// ─────────────────────────── 密钥 ───────────────────────────

async function askHidden(q) {
  process.stdout.write(q);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: true });
    rl._writeToOutput = () => {};
    rl.question('', (ans) => { rl.close(); process.stdout.write('\n'); resolve(ans.trim()); });
  });
}
async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()); }));
}

// 两条都走百炼时只问一次
const keys = {};
for (const r of routes) {
  if (keys[r.via] != null) continue;
  const name = r.provider.auth?.secret;
  let k = name ? vault.getSecret(name) : '';
  if (!k) {
    const st = vault.status();
    say(st.locked
      ? `\n保险箱这里打不开 —— exe 版的保险箱只有 exe 自己解得开。`
      : `\n保险箱里没有 ${name}。`);
    k = await askHidden(`把 ${r.provider.name} 的 API Key 粘贴进来（不回显、不保存）：`);
  }
  if (!k) bail(`没有 ${r.provider.name} 的密钥，停在这里。`);
  keys[r.via] = k;
}

const yes = await ask(`\n这会**同时**调用两次视频生成（${routes.map((r) => `${r.key}：${r.model}`).join('，')}），按厂商计费。继续？输入 y：`);
if (yes.toLowerCase() !== 'y') { say('没发。'); process.exit(0); }

// ─────────────────────────── 同时发、同时等 ───────────────────────────

const pick = (obj, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
const state = Object.fromEntries(routes.map((r) => [r.key, '提交中']));
const showState = () => process.stdout.write(`\r  ${routes.map((r) => `${r.key}：${state[r.key]}`).join('   ')}          `);
const save = (r, result) => fs.writeFileSync(path.join(outDir, `result-${r.key}.json`), JSON.stringify(result, null, 2));

/**
 * 一条路从提交到落盘。**永远不抛** —— 失败也是结果，写进 result 里返回，
 * 这样一条被拒不会把另一条正在等的片子一起带走。
 *
 * 自己轮询、自己带鉴权头，不走 sendAsync：后者轮询时回去找保险箱，
 * 而保险箱在这里多半打不开 —— 提交成功、轮询全 401，钱花了片子拿不回。
 */
async function runRoute(r) {
  const auth = { Authorization: `Bearer ${keys[r.via]}` };
  const result = { route: r.key, title: r.title, provider: r.via, model: r.model, seconds: SECONDS };
  const t0 = Date.now();
  let sub;
  try {
    sub = await providers.send({ provider: r.via, method: 'POST', url: r.url, label: `探路·唱歌 ${r.key}`, headers: { ...(r.headers || {}), ...auth }, body: r.body });
  } catch (err) {
    sub = { ok: false, status: 0, json: { error: err.message } };
  }
  result.submit = { status: sub.status, reply: sub.json };
  if (!sub.ok) { state[r.key] = `被拒 HTTP ${sub.status}`; result.rejected = true; save(r, result); return result; }

  const cfg = r.provider.taskPoll;
  const taskId = pick(sub.json, cfg.idPath);
  result.taskId = taskId;
  save(r, result);   // 任务号先落盘：中途断了也能去控制台找回
  const pollUrl = providers.interpolate(cfg.url, r.provider).replace('{taskId}', encodeURIComponent(taskId));
  const ok = cfg.successStates.map((x) => x.toLowerCase());
  const bad = cfg.failureStates.map((x) => x.toLowerCase());

  for (let i = 1; i <= 180; i += 1) {
    await new Promise((res) => setTimeout(res, Number(settings.get('pollIntervalMs')) || 5000));
    let res;
    try {
      res = await providers.send({ provider: r.via, method: 'GET', url: pollUrl, label: `探路·唱歌 ${r.key} 轮询 #${i}`, headers: auth });
    } catch (err) {
      state[r.key] = `查询出错，重试（${err.message.slice(0, 20)}）`; showState();
      continue;
    }
    const st = String(pick(res.json, cfg.statusPath) ?? '').toLowerCase();
    state[r.key] = st || `HTTP ${res.status}`;
    showState();
    if (bad.includes(st)) { result.failed = res.json; save(r, result); return result; }
    if (!ok.includes(st)) continue;

    result.elapsedSec = Math.round((Date.now() - t0) / 1000);
    result.final = res.json;
    const url = firstMediaUrl(res.json, { extensions: ['.mp4', '.mov', '.webm'] });
    if (!url) { state[r.key] = '完成但找不到视频地址'; save(r, result); return result; }
    const file = path.join(outDir, `${r.key}.mp4`);
    try {
      await studio.saveMedia({ url }, file);
      result.video = { file: path.basename(file), ...(await ffmpeg.probeStreams(file)) };
      state[r.key] = '已下载';
    } catch (err) {
      result.downloadError = err.message.slice(0, 300);
      state[r.key] = '下载失败';
    }
    save(r, result);
    return result;
  }
  state[r.key] = '等了 15 分钟还没完';
  result.timedOut = true;
  save(r, result);
  return result;
}

say('');
showState();
const results = await Promise.all(routes.map(runRoute));
say('\n');

// ─────────────────────────── 报告 ───────────────────────────

const line = (x) => {
  if (x.video) return `${x.video.seconds?.toFixed?.(1) ?? '?'} 秒，${x.video.width}x${x.video.height}，**${x.video.hasAudio ? '带音轨' : '没有音轨'}**，生成 ${x.elapsedSec} 秒`;
  if (x.rejected) return `**被厂商拒了**（HTTP ${x.submit.status}）—— 原话在 result-${x.route}.json`;
  if (x.failed) return `**任务失败** —— 原话在 result-${x.route}.json`;
  if (x.timedOut) return `等了 15 分钟没完，任务号 ${x.taskId}（去控制台找）`;
  return x.downloadError ? `下载失败：${x.downloadError}` : '完成了但响应里没有视频地址（原话在 result 里）';
};
const report = [
  `# 探路报告：唱歌的戏 · 第 ${shot.index} 镜 · ${singer}`,
  '',
  `- 歌：${path.basename(songPath)}，第 ${FROM} 秒起 ${SECONDS} 秒`,
  `- 词：「${lyrics}」`,
  ...results.map((x) => `- **${x.route} ${x.title}**（${x.provider} / ${x.model}）：${line(x)}`),
  '',
  '## 看、听的时候留意这几件事',
  '',
  '1. **A 的口型**：长音时嘴是不是一直张着？换气的地方有没有吸气？快的那几个字跟上了吗？',
  '2. **A 的声音**：成片里的音轨还是不是你那段歌（和 song-cut.mp3 对着听）？模型有没有自己改掉、叠上别的声音？',
  '3. **B 唱没唱出来**：是有旋律地唱，还是把词念了一遍？',
  '4. **B 像不像**：它的旋律和嗓音一定不是你要模仿的那首 —— 这正是要确认的代价，听听差多远。',
  '5. **人有没有漂**：两条里的脸、衣服和首帧对得上吗？唱歌时表情幅度大，比说话更容易漂。',
  '',
  '## 文件',
  '',
  '- `A.mp4` / `B.mp4` 两条出来的片子',
  '- `song-cut.mp3` 发给 A 的那段歌',
  '- `request-A.json` / `request-B.json` 发出去的请求（不含密钥）',
  '- `result-A.json` / `result-B.json` 厂商回的原话、任务号、耗时',
  '',
  '把整个文件夹打包发给我（里面没有密钥），我照着结果定下一步：',
  'A 好用就做成产品里的「唱段」；B 好用就只在提示词上补"唱"的写法；都不行就换模型再试。'
].join('\n');
fs.writeFileSync(path.join(outDir, 'report.md'), report);

hr();
say(report);
say(`\n都在这儿：${outDir}`);
process.exit(results.some((x) => x.video) ? 0 : 1);

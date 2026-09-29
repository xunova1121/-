#!/usr/bin/env node
/**
 * ══════════ 探路：新一代视频模型的「原生音频」值不值得接 ══════════
 *
 * 这是一个**探路脚本**，不是产品功能。它不改任何项目数据，
 * 所有产出都写到数据目录下的 probe\<时间>\ 里。
 *
 * ── 要回答的问题 ──
 *
 * 我们整条流水线是按"视频模型是个没声音的、一次只动 3~6 秒的图片动画器"
 * 搭的：配音、音效自己合成，再用 ffmpeg 按时间轴混进去；提示词里甚至写着
 * "画面中的人物不说话，嘴部保持闭合"。
 *
 * 2026 年的模型开始自带声音（对白 + 口型 + 音效一次出）、一次能出一整场戏。
 * 这件事值不值得改流水线，要看**真跑出来的东西**，不是看厂商博客。
 *
 * ── 分两段 ──
 *
 *   免费那段   查你**已经出好**的视频片段：带不带音轨、是哪个模型出的。
 *              再对照你配没配配音，就知道模型自带的声音现在是被丢掉了、
 *              还是原样混进了成片 —— 这件事不花一分钱就能查清。
 *
 *   花钱那段   挑一场戏，把它当成**一整条**发给一个能出声的模型，
 *              台词写进提示词、让人物自己开口。结果和现在流水线出的
 *              这场戏放在同一个文件夹里，你自己看、自己听。
 *              ⚠ 不加 --go 只打印"会发什么"，一分钱都不花。
 *
 * ── 用法（在 desktop 目录下）──
 *
 *   node scripts/probe-native-audio.mjs
 *       列出所有项目
 *
 *   node scripts/probe-native-audio.mjs <项目名或id>
 *       免费体检 + 列出这个项目的每一场戏
 *
 *   node scripts/probe-native-audio.mjs <项目> --scene 3 --via volcengine --model <模型ID>
 *       预览：打印这一场戏会发出去的完整请求，不发
 *
 *   ... 同上 ... --go
 *       真的发。会调用一次视频生成，按厂商计费。
 *
 *   --via dashscope --voice
 *       万相那条路专用：把**我们自己配好的台词音频**一起发过去，
 *       让模型照着这段声音对口型。这是最值得验的一条 ——
 *       它可能同时保住"每个角色一个固定音色"和"口型对得上"。
 *       需要配好对象存储（百炼只收公网地址）。
 *
 * ── 模型 ID 为什么要你自己填 ──
 *
 * 能出声的是 Seedance 1.5 pro 起、万相 2.5 起。而**我们目录里登记的
 * 还是 Seedance 1.0 和万相 2.2**，下拉框里选不到。
 * 新模型的 ID 带日期后缀，我不猜 —— 猜错了你会白等一轮然后看到 404。
 * 去厂商控制台（火山方舟 → 开通管理 / 百炼 → 模型广场）复制原样填进来。
 *
 * ── 密钥 ──
 *
 * 先从保险箱里取。exe 版的保险箱是 Windows DPAPI 加密的，
 * 用普通 node 跑的这个脚本打不开 —— 那时候会让你**当场粘贴一次**：
 * 输入不回显、只在这次运行的内存里、不写进任何文件。
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
const { DATA_DIR } = await import('../core/paths.js');

// ─────────────────────────── 参数 ───────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
// 带值的开关，它们后面那一项是值、不是项目名
const VALUED = new Set(['--scene', '--via', '--model', '--seconds']);
const who = argv.find((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]));

const VIA = opt('via');
const MODEL = opt('model');
const SCENE = opt('scene');
const GO = flag('go');
const VOICE = flag('voice');
const SECONDS = Number(opt('seconds')) || 0;

const SUPPORTED = ['volcengine', 'dashscope'];

const say = (...a) => console.log(...a);
const hr = () => say('─'.repeat(60));

// ─────────────────────────── 找项目 ───────────────────────────

const all = store.list();
if (!who) {
  say('有这些项目（把名字或 id 接在命令后面）：\n');
  for (const p of all) say(`  ${p.id}  ${p.title || '(无名)'}  ${p.shots} 镜`);
  if (!all.length) say('  （一个都没有 —— 数据目录是 ' + DATA_DIR + '）');
  process.exit(0);
}
const hit = all.find((p) => p.id === who) || all.find((p) => String(p.title || '').includes(who));
if (!hit) {
  say(`找不到项目「${who}」。不带参数跑一次能列出所有项目。`);
  process.exit(1);
}
const project = store.read(hit.id);
const shots = (project.shots || []).slice().sort((a, b) => a.index - b.index);

say(`项目：${project.title}（${project.id}）`);
say(`画幅 ${project.aspectRatio || '(跟随设置)'} · ${shots.length} 镜`);
hr();

// ─────────────────────────── 免费那段 ───────────────────────────

/**
 * 你已经出好的那些片段，到底带不带声音。
 *
 * 这件事决定了现在有没有在白花钱、或者成片里有没有"模型自己编的声音"：
 *
 *   合成那一步（core/ffmpeg.js 的 concat）是这么处理片段原声的 ——
 *     配了配音    最后只挂我们混出来的那条音轨，片段自带的声音**被丢掉**
 *     没配配音    直接 -c copy，片段自带的声音**原样进成片**
 *
 * 而我们发给火山的请求里**从来没写过 generate_audio** ——
 * 带不带声音完全由厂商的默认值决定，而那个默认值我们没核实过。
 */
const ff = ffmpeg.locate();
const audit = { byModel: {}, withAudio: 0, total: 0, voiced: 0, missingFiles: 0 };
if (!ff) {
  say('【免费体检】找不到 FFmpeg，查不了音轨。设置 → 本机环境里配好再跑。');
} else {
  for (const s of shots) {
    if (s.audioPath && fs.existsSync(s.audioPath)) audit.voiced += 1;
    if (!s.videoPath) continue;
    if (!fs.existsSync(s.videoPath)) { audit.missingFiles += 1; continue; }
    const info = await ffmpeg.probeStreams(s.videoPath);
    const key = s.videoModelUsed || '（没记下是哪个模型）';
    const g = (audit.byModel[key] ||= { n: 0, audio: 0, shots: [] });
    g.n += 1;
    audit.total += 1;
    if (info?.hasAudio) { g.audio += 1; audit.withAudio += 1; }
    g.shots.push({ index: s.index, hasAudio: Boolean(info?.hasAudio), seconds: info?.seconds, size: info?.width ? `${info.width}x${info.height}` : '' });
  }

  say('【免费体检】已经出好的视频片段带不带声音');
  if (!audit.total) {
    say('  这个项目还没有视频片段，没东西可查。');
  } else {
    for (const [model, g] of Object.entries(audit.byModel)) {
      say(`  ${model}：${g.n} 段，其中 ${g.audio} 段自带音轨`);
    }
    say('');
    if (!audit.withAudio) {
      say('  → 一段都不带声音。模型现在确实是"哑的"，合成时没有东西被丢掉。');
    } else if (audit.voiced) {
      say(`  → ${audit.withAudio} 段自带声音，而你配了配音（${audit.voiced} 条）。`);
      say('    合成时这些片段自带的声音**全部被丢掉**，只留我们混的那条。');
      say('    如果厂商对有声视频加价，这部分钱是白花的 —— 值得在请求里显式关掉，或者反过来用上它。');
    } else {
      say(`  → ${audit.withAudio} 段自带声音，而你没配配音。`);
      say('    合成时这些声音**原样进了成片** —— 那是模型自己编的，');
      say('    而我们的提示词还写着"画面中的人物不说话"。两边在打架。');
    }
    if (audit.missingFiles) say(`  （另有 ${audit.missingFiles} 段记录里有、硬盘上找不到文件）`);
  }
}
hr();

// ─────────────────────────── 一场一场的戏 ───────────────────────────

/**
 * 这一镜真正要念出来的那句。
 *
 * 去掉三样：括注（"（沉默）"是动作提示，不是台词）、说话人前缀（"林晚："）、
 * 外层引号 —— 下面拼提示词时会统一包一层「」，不剥的话就成了「「喂？」」。
 */
const spoken = (d) => String(d || '')
  .replace(/[（(][^）)]*[）)]/g, '')
  .replace(/^[^：:「“"]{1,8}[：:]/, '')
  .trim()
  .replace(/^[「“"『]+|[」”"』]+$/g, '')
  .trim();

const scenes = new Map();
for (const s of shots) {
  const k = Number(s.segment || 1);
  if (!scenes.has(k)) scenes.set(k, []);
  scenes.get(k).push(s);
}
const sceneRows = [...scenes.entries()].map(([k, list]) => ({
  k,
  list,
  seconds: list.reduce((a, s) => a + (Number(s.duration) || 0), 0),
  // ⚠ 用 spoken 数，不用原始字段："（沉默）"不是一句台词
  lines: list.filter((s) => spoken(s.dialogue)).length,
  where: list[0]?.scene || '',
  ready: list.every((s) => s.imagePath)
}));

say('【这个项目的每一场戏】挑一场有台词的来试（--scene 编号）\n');
for (const r of sceneRows) {
  say(`  第 ${r.k} 场  ${r.where || '(未标场景)'}  ${r.list.length} 镜 · ${r.seconds.toFixed(1)}s · ${r.lines} 句台词${r.ready ? '' : ' · ⚠ 有镜还没出图'}`);
}
hr();

if (!SCENE) {
  say('下一步：加上 --scene <编号> --via volcengine|dashscope --model <模型ID> 预览要发的请求。');
  process.exit(0);
}

const row = sceneRows.find((r) => String(r.k) === String(SCENE));
if (!row) { say(`没有第 ${SCENE} 场。`); process.exit(1); }
if (!VIA || !SUPPORTED.includes(VIA)) {
  say(`--via 要填 ${SUPPORTED.join(' 或 ')}。`);
  say('（先只做这两家：它们是我们已经接好、而且官方文档写明了能出声的。');
  say('  可灵 3.0 的"给角色绑定音色"更值得试，但它的请求形状我没法在这边核实，下一轮再加。）');
  process.exit(1);
}
if (!MODEL) {
  say('--model 要填**能出声**的那个模型 ID，从控制台原样复制：');
  say('  火山方舟：Seedance 1.5 pro 或更新（控制台 → 开通管理）');
  say('  百炼：万相 2.5 或更新的图生视频（控制台 → 模型广场）');
  say('我们目录里登记的还是 Seedance 1.0 / 万相 2.2，它们不出声。');
  process.exit(1);
}

// ─────────────────────────── 这场戏的提示词 ───────────────────────────

/**
 * 整场戏写成**一条**多镜头提示词。
 *
 * 和现在流水线最大的两处不同，都是故意的：
 *   ① 一场戏一次发，不是一镜一次 —— 看模型自己能不能把场内的镜头接好
 *   ② 台词写进去、让人物开口 —— 现在的提示词写的是"人物不说话"
 */
const bible = project.bible || { characters: [], scenes: [], style: {} };
const castNames = [...new Set(row.list.flatMap((s) => s.characters || []))];
const castLines = castNames.map((n) => {
  const c = (bible.characters || []).find((x) => x.name === n);
  if (!c) return null;
  if (c.embodied === false) return `${n}：没有实体形象，只有声音（${String(c.appearance || '').slice(0, 40)}）`;
  return `${n}：${String(c.appearance || '').slice(0, 80)}`;
}).filter(Boolean);
const sceneMeta = (bible.scenes || []).find((x) => x.name === row.where);

const shotLines = row.list.map((s, i) => {
  const d = spoken(s.dialogue);
  const who2 = s.speaker || (s.characters || [])[0] || '';
  const talk = d ? `${who2 ? `${who2}说：` : '画外音：'}「${d}」` : '';
  return `镜头${i + 1}（${s.camera || '中景'}，约 ${Number(s.duration || 4).toFixed(0)} 秒）：${s.description || ''}${talk ? `。${talk}` : ''}`;
});

const prompt = [
  bible.style?.anchor ? `画风：${bible.style.anchor}` : '',
  sceneMeta?.appearance ? `场景：${row.where}，${String(sceneMeta.appearance).slice(0, 80)}` : (row.where ? `场景：${row.where}` : ''),
  castLines.length ? `人物：\n${castLines.join('\n')}` : '',
  '分镜：',
  ...shotLines,
  '声音：人物按台词开口说话，口型要对上；保留自然的环境声和动作声；不要背景音乐（背景音乐后期统一加）。'
].filter(Boolean).join('\n');

const wantSeconds = SECONDS || Math.min(10, Math.max(5, Math.round(row.seconds)));
const first = row.list.find((s) => s.imagePath);
if (!first) { say('这一场一张图都还没出，先把图出了再来。'); process.exit(1); }

// ─────────────────────────── 请求体 ───────────────────────────

const provider = catalog.PROVIDERS.find((p) => p.id === VIA);
const ratio = project.aspectRatio || settings.get('aspectRatio') || '16:9';
const outDir = path.join(DATA_DIR, 'probe', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(outDir, { recursive: true });

say(`把这一场的首帧图转成模型能收的引用…`);
const imageRef = await studio.toModelRef(first.imagePath, {});
const isPublic = /^https?:\/\//i.test(String(imageRef || ''));

// 我们自己配好的这场戏的台词，按时间轴摆成一条 —— 对比那一版要用，--voice 也要用
let voiceWav = null;
{
  let t = 0;
  const entries = [];
  for (const s of row.list) {
    if (s.audioPath && fs.existsSync(s.audioPath)) entries.push({ path: s.audioPath, at: t });
    t += Number(s.duration) || 0;
  }
  if (entries.length && ff) {
    voiceWav = path.join(outDir, 'our-voice.wav');
    const args = ['-y'];
    for (const e of entries) args.push('-i', e.path);
    args.push('-filter_complex', ffmpeg.voiceFilterGraph(entries), '-map', '[out]', '-c:a', 'pcm_s16le', voiceWav);
    try { await ffmpeg.run(args); } catch (err) { say(`  拼我们的配音失败：${err.message}`); voiceWav = null; }
  }
}

let spec;
if (VIA === 'volcengine') {
  /**
   * 和产品里的 Seedance 请求**同一个形状**（参数拼在 text 里的 --key value），
   * 只多一个字段：generate_audio。形状越接近已经跑通的那条，
   * 出错时越能确定是新字段的事、不是别的。
   */
  const flags = `--resolution 720p --dur ${wantSeconds} --ratio ${ratio}`;
  spec = {
    // ⚠ 走 interpolate，不直接拼 provider.baseUrl —— 后者会无视你在设置里填的中转站地址
    url: providers.interpolate('{{baseUrl}}/contents/generations/tasks', provider),
    body: {
      model: MODEL,
      content: [
        { type: 'text', text: `${prompt} ${flags}` },
        { type: 'image_url', image_url: { url: imageRef } }
      ],
      generate_audio: true
    }
  };
} else {
  if (!isPublic) {
    say('百炼只收公网地址，而这张图转出来的不是（多半是没配对象存储）。');
    say('去「设置 → 对象存储」配好再来，或者先用 --via volcengine 试。');
    process.exit(1);
  }
  const input = { prompt, img_url: imageRef };
  if (VOICE) {
    if (!voiceWav) { say('--voice 要用这场戏已经配好的台词，而这一场没有配音文件。'); process.exit(1); }
    const audioRef = await studio.toModelRef(voiceWav, {});
    if (!/^https?:\/\//i.test(String(audioRef || ''))) { say('配音传不上公网（对象存储没配好）。'); process.exit(1); }
    input.audio_url = audioRef;
  }
  /**
   * ⚠ 不写 audio 开关。官方文档说 2.5 起**默认就出声**，
   * 而百炼对不认识的参数是严格的（产品代码里记过这个坑）——
   * 多写一个字段，老模型会把整个任务顶掉，那时候测的就不是声音了。
   */
  spec = {
    url: providers.interpolate('{{baseUrl}}/api/v1/services/aigc/video-generation/video-synthesis', provider),
    headers: { 'X-DashScope-Async': 'enable' },
    body: { model: MODEL, input, parameters: { resolution: '720P', duration: wantSeconds } }
  };
}

// 请求体原样存一份（图如果是 base64 就截短 —— 几百 KB 的字符串没人看）
const shown = JSON.parse(JSON.stringify(spec.body, (k, v) =>
  typeof v === 'string' && v.startsWith('data:') ? `${v.slice(0, 40)}…（base64，${v.length} 字符）` : v));
fs.writeFileSync(path.join(outDir, 'request.json'), JSON.stringify({ url: spec.url, body: shown }, null, 2));

say(`【这一场会发出去的请求】→ ${spec.url}\n`);
say(JSON.stringify(shown, null, 2));
hr();
say(`时长：这场戏按分镜是 ${row.seconds.toFixed(1)} 秒，这次按 ${wantSeconds} 秒发（--seconds 可改）。`);
say(`输出目录：${outDir}`);

if (!GO) {
  say('\n这是预览，一分钱没花。确认没问题后加 --go 真的发。');
  process.exit(0);
}

// ─────────────────────────── 真的发 ───────────────────────────

async function askHidden(q) {
  process.stdout.write(q);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: true });
    // 输入不回显：把回显那一步换成什么都不做
    rl._writeToOutput = () => {};
    rl.question('', (ans) => { rl.close(); process.stdout.write('\n'); resolve(ans.trim()); });
  });
}
async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()); }));
}

const secretName = provider.auth?.secret;
let key = secretName ? vault.getSecret(secretName) : '';
if (!key) {
  const st = vault.status();
  say(st.locked
    ? `\n保险箱这里打不开（${st.reason.slice(0, 40)}…）—— exe 版的保险箱只有 exe 自己解得开。`
    : `\n保险箱里没有 ${secretName}。`);
  key = await askHidden(`把 ${provider.name} 的 API Key 粘贴进来（不回显、不保存）：`);
}
if (!key) { say('没有密钥，停在这里。'); process.exit(1); }

const yes = await ask(`\n这会真的调用一次 ${provider.name} / ${MODEL}，按厂商计费（有声视频通常比无声贵）。继续？输入 y：`);
if (yes.toLowerCase() !== 'y') { say('没发。'); process.exit(0); }

const auth = { Authorization: `Bearer ${key}` };
const startedAt = Date.now();
const result = { provider: VIA, model: MODEL, scene: row.k, seconds: wantSeconds, voice: VOICE };

let submitted;
try {
  submitted = await providers.send({
    provider: VIA, method: 'POST', url: spec.url, label: '探路·原生音频',
    headers: { ...(spec.headers || {}), ...auth }, body: spec.body
  });
} catch (err) {
  submitted = { ok: false, status: 0, json: { error: err.message } };
}
result.submit = { status: submitted.status, reply: submitted.json };

if (!submitted.ok) {
  say(`\n厂商拒了（HTTP ${submitted.status}）。原话：`);
  say(JSON.stringify(submitted.json, null, 2).slice(0, 1500));
  say('\n这本身就是探路结果 —— 把 probe 文件夹发给我，我照着原话改。');
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  process.exit(1);
}

/**
 * 自己轮询，不走 sendAsync。
 *
 * sendAsync 轮询时不带鉴权头、回去找保险箱 —— 而保险箱在这里多半是打不开的，
 * 于是提交成功、轮询全是 401，钱花了片子拿不回来。
 */
const cfg = provider.taskPoll;
const pick = (obj, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
const taskId = pick(submitted.json, cfg.idPath);
result.taskId = taskId;
say(`\n任务已提交：${taskId}。开始等…（任务号记在 result.json 里，中途断了也能去控制台找回）`);
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));

const pollUrl = providers.interpolate(cfg.url, provider).replace('{taskId}', encodeURIComponent(taskId));
let done = null;
for (let i = 1; i <= 180; i += 1) {
  await new Promise((r) => setTimeout(r, 5000));
  const res = await providers.send({ provider: VIA, method: 'GET', url: pollUrl, label: `探路·轮询 #${i}`, headers: auth });
  const state = String(pick(res.json, cfg.statusPath) ?? '').toLowerCase();
  process.stdout.write(`\r  第 ${i} 次：${state || res.status}        `);
  if (cfg.successStates.map((x) => x.toLowerCase()).includes(state)) { done = res.json; break; }
  if (cfg.failureStates.map((x) => x.toLowerCase()).includes(state)) {
    say(`\n任务失败（${state}）。原话：`);
    say(JSON.stringify(res.json, null, 2).slice(0, 1500));
    result.failed = res.json;
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    process.exit(1);
  }
}
say('');
result.elapsedSec = Math.round((Date.now() - startedAt) / 1000);
if (!done) { say('等了 15 分钟还没完。任务号在 result.json 里，去控制台看。'); process.exit(1); }
result.final = done;

const url = (await import('../core/providers/adapters.js')).firstMediaUrl(done, { extensions: ['.mp4', '.mov', '.webm'] });
if (!url) { say('完成了，但响应里找不到视频地址。原话在 result.json 里。'); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2)); process.exit(1); }

const nativePath = path.join(outDir, 'native.mp4');
await studio.saveMedia({ url }, nativePath);
const nativeInfo = ff ? await ffmpeg.probeStreams(nativePath) : null;
result.native = { file: 'native.mp4', ...nativeInfo };

// ─────────────────────────── 现在的流水线出的这场戏 ───────────────────────────

/**
 * 同一场戏，现在的做法：各镜片段首尾接起来 + 我们自己的配音。
 * 放在同一个文件夹里，两条挨着听 —— 结论要靠耳朵，不靠我。
 */
const clips = row.list.filter((s) => s.videoPath && fs.existsSync(s.videoPath));
if (ff && clips.length) {
  const cur = path.join(outDir, 'current.mp4');
  const first0 = await ffmpeg.probeStreams(clips[0].videoPath);
  const W = first0?.width || 1280;
  const H = first0?.height || 720;
  const args = ['-y'];
  for (const s of clips) args.push('-i', s.videoPath);
  if (voiceWav) args.push('-i', voiceWav);
  const scaled = clips.map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`);
  const graph = `${scaled.join(';')};${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[v]`;
  args.push('-filter_complex', graph, '-map', '[v]');
  if (voiceWav) args.push('-map', `${clips.length}:a`, '-af', 'apad', '-shortest', '-c:a', 'aac');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', cur);
  try {
    await ffmpeg.run(args);
    result.current = { file: 'current.mp4', ...(await ffmpeg.probeStreams(cur)), clips: clips.length, withOurVoice: Boolean(voiceWav) };
  } catch (err) {
    result.current = { error: err.message.slice(0, 300) };
  }
} else {
  result.current = { note: clips.length ? '找不到 FFmpeg，没拼' : '这一场还没有视频片段，没得比' };
}

// ─────────────────────────── 报告 ───────────────────────────

fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
const report = [
  `# 探路报告：第 ${row.k} 场 · ${VIA} / ${MODEL}`,
  '',
  `- 生成耗时：${result.elapsedSec} 秒`,
  `- 原生音频那一版：${result.native.seconds?.toFixed?.(1) ?? '?'} 秒，${result.native.width}x${result.native.height}，**${result.native.hasAudio ? '带音轨' : '没有音轨'}**`,
  result.current?.file
    ? `- 现在流水线那一版：${result.current.clips} 段拼起来，${result.current.withOurVoice ? '配上我们的配音' : '没有配音'}`
    : `- 现在流水线那一版：${result.current?.note || result.current?.error}`,
  VOICE ? '- 这一次把我们的配音一起发了过去（--voice），看模型能不能照着它对口型' : '',
  '',
  '## 听的时候看这几件事',
  '',
  '1. **口型**：人物张嘴的时候，是不是在说那句台词？',
  '2. **音色**：同一个人的声音，和我们配音里那个角色像不像？（不加 --voice 时一定不像 —— 那正是要确认的代价）',
  '3. **场内衔接**：一整场一次出，镜头之间接得比我们一镜一镜拼的自然吗？',
  '4. **人物一致**：场内换镜头时，脸和衣服有没有漂？',
  '5. **台词有没有被改**：模型有没有自己加词、漏词、念错字？',
  '',
  '## 文件',
  '',
  '- `native.mp4` 原生音频那一版',
  '- `current.mp4` 现在流水线那一版',
  voiceWav ? '- `our-voice.wav` 我们配好的这场戏的台词' : '',
  '- `request.json` 发出去的请求（不含密钥）',
  '- `result.json` 厂商回的原话、任务号、耗时',
  '',
  '把整个文件夹打包发给我（里面没有密钥），我照着结果定下一步。'
].filter((x) => x !== '').join('\n');
fs.writeFileSync(path.join(outDir, 'report.md'), report);

hr();
say(report);
say(`\n都在这儿：${outDir}`);

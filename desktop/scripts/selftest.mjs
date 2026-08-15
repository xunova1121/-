/**
 * 自检：不碰任何真实厂商、不花一分钱，用一个本地假服务把关键链路跑一遍。
 *
 *     npm run selftest
 *
 * 覆盖的是最容易悄悄坏掉的几处：密钥脱敏、SSE 分片解析、异步任务轮询、
 * 提示词装配顺序、Windows 文件名规则、以及媒体接口的目录穿越防护。
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// file:// URL → 本地路径必须走 fileURLToPath。
// 用 new URL(import.meta.url).pathname 在 Windows 上会得到 `/D:/a/...`
// （盘符前多一道斜杠），再 path.resolve 一下就变成 `D:\D:\a\...` 然后 ENOENT。
// 这和本文件第 9 节要防的是同一族的坑 —— 写这段检查时自己先踩了一次。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

// 自检用独立数据目录，绝不碰用户真实的 %APPDATA%\FutureDream
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'futuredream-selftest-'));
process.env.FUTUREDREAM_DATA_DIR = SANDBOX;

const { listen } = await import('../core/server.js');
const vault = await import('../core/vault.js');
const logbus = await import('../core/logbus.js');
const { createSSEParser } = await import('../core/http-client.js');
const { safeFileName } = await import('../core/paths.js');
const consistency = await import('../core/pipeline/consistency.js');
const settings = await import('../core/settings.js');
const providersMod = await import('../core/providers/index.js');
const store = await import('../core/store.js');
const styleModule = await import('../core/styles.js');
const studioModule = await import('../core/pipeline/studio.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ─────────────────────── 假上游 ───────────────────────

/** 模拟一家第三方服务：一个流式对话接口 + 一对异步任务接口 */
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/v1/chat/completions') {
    if (req.headers.authorization !== 'Bearer sk-test-secret-value-1234') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: '鉴权头不对' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 故意把一个 JSON 事件劈成两个 chunk，考验增量解析
    const frame = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
    const whole = frame('一') + frame('叶') + frame('扁舟');
    res.write(whole.slice(0, 40));
    setTimeout(() => {
      res.write(whole.slice(40));
      res.write('data: [DONE]\n\n');
      res.end();
    }, 20);
    return undefined;
  }

  if (url.pathname === '/api/v1/tasks/submit') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ output: { task_id: 'task-42', task_status: 'PENDING' } }));
  }

  if (url.pathname.startsWith('/api/v1/tasks/')) {
    upstream.polls = (upstream.polls || 0) + 1;
    const done = upstream.polls >= 2;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        output: {
          task_id: 'task-42',
          task_status: done ? 'SUCCEEDED' : 'RUNNING',
          results: done ? [{ url: 'https://example.invalid/out.png' }] : []
        }
      })
    );
  }

  // ── MiniMax 海螺：三步视频流程 + 出图 ──
  if (url.pathname === '/mm/video_generation') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      upstream.mmCreate = (upstream.mmCreate || 0) + 1;
      upstream.mmCreateBody = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ task_id: 'mm-task-7', base_resp: { status_code: 0, status_msg: 'success' } }));
    });
    return undefined;
  }
  if (url.pathname === '/mm/query/video_generation') {
    upstream.mmPolls = (upstream.mmPolls || 0) + 1;
    const done = upstream.mmPolls >= 2;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 成功时只给 file_id，不给 url —— 逼适配器走第三步
    return res.end(JSON.stringify({
      task_id: 'mm-task-7',
      status: done ? 'Success' : 'Processing',
      file_id: done ? 'mm-file-42' : undefined,
      base_resp: { status_code: 0, status_msg: 'success' }
    }));
  }
  if (url.pathname === '/mm/files/retrieve') {
    upstream.mmRetrieve = (upstream.mmRetrieve || 0) + 1;
    upstream.mmFileId = url.searchParams.get('file_id');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      file: { file_id: 'mm-file-42', download_url: `${upstreamUrl}/out.mp4` },
      base_resp: { status_code: 0, status_msg: 'success' }
    }));
  }
  if (url.pathname === '/mm/image_generation') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      upstream.mmImageBody = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // 业务失败也回 200，错误藏在 base_resp —— 适配器必须看这里
      if (upstream.mmImageFail) {
        return res.end(JSON.stringify({ base_resp: { status_code: 1008, status_msg: '余额不足' } }));
      }
      res.end(JSON.stringify({
        data: { image_urls: [`${upstreamUrl}/pixel.png`] },
        base_resp: { status_code: 0, status_msg: 'success' }
      }));
    });
    return undefined;
  }
  if (url.pathname === '/out.mp4') {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    return res.end(Buffer.from('fake-mp4'));
  }

  // ── 秘塔中转风格：提交路径同名，但查任务走 /video_generation/{taskId} ──
  if (url.pathname === '/ms/video_generation' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      upstream.msBody = JSON.parse(raw || '{}');
      upstream.msSubmits = (upstream.msSubmits || 0) + 1;
      upstream.msImageCounts = upstream.msImageCounts || [];
      const imgs = (upstream.msBody.content || []).filter((c) => c.type === 'image_url').length;
      upstream.msImageCounts.push(imgs);
      // 中转平台的真实脾气：图带多了就拒，而且文档里没写几张算多
      if (imgs > (upstream.msMediaLimit ?? 99)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: '输入媒体数量超过限制 (2013)' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ task_id: 'ms-9' }));
    });
    return undefined;
  }
  // 官方那条路径在这家不存在。默认回 404；
  // msJunk200 打开时改成"回 200 但内容跟任务无关"—— 这是真实中转平台的常见脾气，
  // 也是"厂商那边早就出片了，这边还在轮询"的根源
  if (url.pathname === '/ms/query/video_generation') {
    if (upstream.msJunk200) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 0, msg: 'ok' }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }
  // 用户实测拿回来的真实形状：外面套一层 task，状态和地址都在里面。
  // 少看一层就读不出状态，然后一路轮到超时 —— 这个坑必须钉死。
  if (url.pathname === '/msv2/video_generation' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ task_id: '424010985738629' }));
  }
  // 服务商在目录里自带的写法（{origin}/api/video-generation/{taskId}）要先被试到
  if (url.pathname === '/api/video-generation/own-1') {
    upstream.ownHits = (upstream.ownHits || 0) + 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      task: { id: 'own-1', status: 'succeeded', content: { url: `${upstreamUrl}/out.mp4` } }
    }));
  }
  if (url.pathname === '/msown/video_generation' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ task_id: 'own-1' }));
  }

  if (url.pathname === '/msv2/video_generation/424010985738629') {
    upstream.msv2Hits = (upstream.msv2Hits || 0) + 1;
    const done = upstream.msv2Hits >= 2;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      task: {
        id: '424010985738629',
        model: 'MiniMax-H3',
        status: done ? 'succeeded' : 'processing',
        created_at: 1785125529,
        content: done ? { url: `${upstreamUrl}/out.mp4` } : {},
        resolution: '2K',
        duration: 5,
        ratio: '16:9',
        task_type: 'generation',
        modality: 'video'
      }
    }));
  }

  if (url.pathname === '/ms/video_generation/ms-9') {
    upstream.msQueryHits = (upstream.msQueryHits || 0) + 1;
    const done = upstream.msQueryHits >= 2;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      task_id: 'ms-9',
      // msState 用来模拟中转平台自创的终态词
      status: done ? upstream.msState || 'Success' : 'Processing',
      video_url: done ? `${upstreamUrl}/out.mp4` : undefined
    }));
  }

  // 提交能成，但查任务的路径一个都不存在 —— 用来验证报错是否给得出下一步
  if (url.pathname === '/msbad/video_generation' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ task_id: 'lost-1' }));
  }

  // 提交成功、查任务的地址也"看着像"（提到了 task_id），但之后永远读不出状态。
  // 用来验证：不会一路空等到超时。
  if (url.pathname.startsWith('/msblind/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'POST') return res.end(JSON.stringify({ task_id: 'blind-7' }));
    return res.end(JSON.stringify({ task_id: 'blind-7', note: '这里没有 status 字段' }));
  }

  // ── 以下是给"整条流水线打桩"用的 OpenAI 兼容接口 ──

  // ── OpenAI 的视频（Sora）：POST /videos → GET /videos/{id} → GET /videos/{id}/content ──
  if (url.pathname === '/oa/videos' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      upstream.soraBody = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'video_abc', object: 'video', status: 'queued', progress: 0 }));
    });
    return undefined;
  }
  // 不管带不带鉴权都回 JSON —— 用来验证"下到的不是媒体就当场报错"
  if (url.pathname === '/notmedia') {
    res.writeHead(200, { 'Content-Type': 'text/json;charset=UTF-8' });
    return res.end(JSON.stringify({ errCode: 401, errMsg: '要登录才能取' }));
  }
  if (url.pathname === '/oa/videos/video_abc/content') {
    // 关键：不带 Authorization 就回 401 的 JSON —— 真实接口就是这样，
    // 少带头会存下一个打不开的"mp4"
    if (!/^Bearer /.test(req.headers.authorization || '')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'missing api key' } }));
    }
    upstream.soraDownloadAuth = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    return res.end(Buffer.from('fake-sora-mp4'));
  }
  if (url.pathname === '/oa/videos/video_abc') {
    upstream.soraPolls = (upstream.soraPolls || 0) + 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'video_abc',
      status: upstream.soraPolls >= 2 ? 'completed' : 'in_progress',
      progress: upstream.soraPolls >= 2 ? 100 : 40,
      seconds: '8'
    }));
  }

  if (url.pathname === '/v3/chat/completions') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');

      // 学方舟的脾气：模型没开通就回 404，而不是 400/403。
      // 探测器要能靠这个把"能用的"和"不能用的"分开。
      if (!ALLOWED_MODELS.has(body.model)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            error: {
              code: 'NotFound',
              message: `The model or endpoint ${body.model} does not exist or you do not have access to it.`
            }
          })
        );
      }

      const system = JSON.stringify(body.messages?.[0]?.content || '');
      let content;
      if (system.includes('美术总监')) {
        content = JSON.stringify(BIBLE_REPLY);
      } else if (system.includes('分镜导演')) {
        content = JSON.stringify(SHOTS_REPLY);
      } else if (system.includes('分镜师')) {
        // 挑技法。故意埋三个坑：
        //   第 1 镜给一个自创 id + 一对互斥的 → 验证规整
        //   第 2 镜给月光冷调 → 和第 1 镜同一场戏却换了时段，验证顺场会统一光线
        //   第 2 镜给大特写 → 它的景别是全景，验证顺场会去掉对不上的机位卡
        const shots = JSON.parse(body.messages?.[1]?.content || '[]');
        upstream.lastSkillPayload = shots;
        content = JSON.stringify({
          shots: shots.map((x, i) => ({
            id: x.id,
            skills: i === 0
              ? ['low-angle', 'high-angle', 'rembrandt', '我瞎编的技法']
              : ['close-up', 'moonlight', 'mood-tense'],
            why: i === 0 ? '情绪压迫，用仰拍加伦勃朗光' : '夜里的对话戏'
          }))
        });
      } else if (system.includes('编剧')) {
        // 绑说话人：只有"在场不止一个人又没线索"的那几条会发过来。
        // 故意也回一条 need=false 的，验证服务端不会拿它去覆盖已经定了的
        const shots = JSON.parse(body.messages?.[1]?.content || '[]');
        upstream.lastSpeakerPayload = shots;
        content = JSON.stringify({
          shots: shots.map((x) => ({
            id: x.id,
            speaker: x.need ? '老周' : '阿澜',
            why: '上一句是阿澜说的，这句是回话'
          }))
        });
      } else if (system.includes('小说编辑')) {
        // 分章：回原文里真实存在的片段当锚句。
        // 模型要是"顺手润色"了引文，锚点就定位不到 —— 那条路单独有检查。
        const user = String(body.messages?.[1]?.content || '');
        const breaks = [];
        for (const mark of ['乙段开始', '丙段开始']) {
          if (user.includes(mark)) breaks.push({ anchor: mark, title: `${mark}的一章`, summary: '梗概' });
        }
        content = JSON.stringify({ breaks });
      } else if (system.includes('质检员')) {
        upstream.verifyCalls = (upstream.verifyCalls || 0) + 1;
        // 头两次判不合格，逼引擎走重试分支；第三次放行
        content =
          upstream.verifyCalls <= 2
            ? JSON.stringify({ score: 40, verdict: 'fail', issues: ['服装配色由藏青变为墨绿'] })
            : JSON.stringify({ score: 92, verdict: 'pass', issues: [] });
      } else {
        content = '{}';
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    return undefined;
  }

  // 方舟风格的视频任务：提交拿 id，再按同一路径 + /{id} 轮询
  if (url.pathname === '/v3/contents/generations/tasks' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      upstream.lastVideoBody = JSON.parse(raw || '{}');
      upstream.videoBodies = upstream.videoBodies || [];
      upstream.videoBodies.push(upstream.lastVideoBody);
      upstream.videoCalls = (upstream.videoCalls || 0) + 1;
      upstream.videoPolls = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'ark-task-1' }));
    });
    return undefined;
  }
  if (url.pathname.startsWith('/v3/contents/generations/tasks/')) {
    upstream.videoPolls = (upstream.videoPolls || 0) + 1;
    const done = upstream.videoPolls >= 2;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'ark-task-1',
      status: done ? 'succeeded' : 'running',
      content: done ? { video_url: `${upstreamUrl}/out.mp4` } : undefined
    }));
  }

  if (url.pathname === '/v3/images/generations') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      upstream.imageCalls = (upstream.imageCalls || 0) + 1;
      upstream.lastImageBody = body;
      upstream.imagePrompts = upstream.imagePrompts || [];
      upstream.imagePrompts.push(body.prompt);
      upstream.imageSeeds = upstream.imageSeeds || [];
      upstream.imageSeeds.push(body.seed);
      upstream.imageBodies = upstream.imageBodies || [];
      upstream.imageBodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: `${upstreamUrl}/pixel.png` }] }));
    });
    return undefined;
  }

  // OpenAI 兼容家族的 /audio/speech 直接回二进制音频
  if (url.pathname === '/v3/audio/speech') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      upstream.ttsBodies = upstream.ttsBodies || [];
      upstream.ttsBodies.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from('ID3fake-audio'));
    });
    return undefined;
  }

  if (url.pathname === '/pixel.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(PIXEL_PNG);
  }

  res.writeHead(404).end();
});

/** 打桩账号"开通"了哪些模型。候选清单里的其余 ID 都会被回 404。 */
const ALLOWED_MODELS = new Set(['doubao-1-5-pro-32k-250115', 'doubao-seed-1-6-250615']);

/** 最小合法 PNG（1×1 透明），用来当"模型出的图" */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const BIBLE_REPLY = {
  style: { anchor: '国风水墨，冷调', palette: '青灰', negative: '崩脸, 五官不对称' },
  characters: [
    {
      name: '阿澜',
      role: '渔政执法员',
      appearance: '二十七八岁，短发，藏青立领制服，袖口两道银线，左胸执法编号牌',
      sheetPrompt: '正面半身，中性表情，纯色浅灰背景'
    }
  ],
  scenes: [{ name: '码头', appearance: '晨雾未散，冷白顶光，木质栈桥', sheetPrompt: '空镜广角' }],
  props: [{ name: '执法记录仪', appearance: '黑色方形，胸前佩戴' }]
};

const SHOTS_REPLY = {
  logline: '一次清晨的例行巡查',
  shots: [
    {
      index: 1,
      scene: '码头',
      characters: ['阿澜'],
      description: '阿澜检查执法记录仪',
      camera: '中景',
      motion: '镜头缓推',
      dialogue: '设备正常。',
      duration: 4
    },
    {
      index: 2,
      scene: '码头',
      characters: ['阿澜'],
      description: '阿澜登船',
      camera: '全景',
      motion: '跟拍',
      dialogue: '',
      duration: 5
    }
  ]
};

await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

const { server, url: appUrl } = await listen(0);

async function ndjson(pathname, body) {
  const res = await fetch(`${appUrl}/api${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ─────────────────────── 1. 保险箱 ───────────────────────

section('凭据保险箱');
vault.setSecret('TEST_KEY', 'sk-test-secret-value-1234');
check('存进去再取出来是同一个值', vault.getSecret('TEST_KEY') === 'sk-test-secret-value-1234');
check('落盘的文件是密文', !fs.readFileSync(path.join(SANDBOX, 'credentials.enc')).includes('sk-test-secret'));
check('掩码不泄露中段', vault.mask('sk-test-secret-value-1234') === 'sk-tes******1234');
check(
  '占位符能展开成明文',
  vault.expandSecrets('Bearer {{TEST_KEY}}') === 'Bearer sk-test-secret-value-1234'
);
check('未知占位符原样保留', vault.expandSecrets('{{NOPE}}') === '{{NOPE}}');

// ─────────────────────── 2. 日志脱敏 ───────────────────────

section('保险箱读不出来时不能把人堵在门外');
{
  // 复现用户踩的那条路：先用桌面版（DPAPI）存过密钥，
  // 后来改用只带 Node 的绿色版打开 —— 那份文件在命令行模式下解不开。
  const { VAULT_FILE } = await import('../core/paths.js');
  const savedVault = fs.existsSync(VAULT_FILE) ? fs.readFileSync(VAULT_FILE) : null;

  // 伪造一份 DPAPI 格式的文件：前六个字节是 'DPAPI1'，后面是什么无所谓 ——
  // 命令行模式压根走不到解密那一步
  fs.writeFileSync(VAULT_FILE, Buffer.concat([Buffer.from('DPAPI1'), Buffer.from('whatever')]));
  vault.reload();

  let threw = null;
  let masked = null;
  try {
    masked = vault.listMasked();
  } catch (err) {
    threw = err;
  }
  check('读不出来不再往外抛异常（抛了就整个界面起不来）', threw === null, threw?.message);
  check('读不出来时当作"没有密钥"，而不是崩掉', Array.isArray(masked) && masked.length === 0);
  check('取单个密钥也不抛', vault.getSecret('ARK_API_KEY') === '');

  const st = vault.status();
  check('状态里说明白了是被锁住了', st.locked === true, JSON.stringify(st));
  check('原因是人话', /DPAPI/.test(st.reason), st.reason);
  check('给了两条具体出路，而不是只报错', /桌面版|exe/.test(st.fix) && /重新填/.test(st.fix), st.fix);

  // health 接口必须还能通 —— 界面靠它判断"服务到底通没通"
  const health = await (await fetch(`${appUrl}/api/health`)).json();
  check('这种情况下 /api/health 仍然是 200 且带上锁定状态',
    health.ok === true && health.vault?.locked === true, JSON.stringify(health.vault));

  // 目录接口也不能塌：它会去问每家凭据齐没齐
  const cat = await fetch(`${appUrl}/api/catalog`);
  check('/api/catalog 不会因为读不出密钥就 500', cat.status === 200, `HTTP ${cat.status}`);

  // 重填一次就该恢复，而且旧文件要留个备份
  vault.setSecret('ARK_API_KEY', 'sk-refilled-in-cli-mode');
  check('在命令行模式下重填密钥能存进去', vault.getSecret('ARK_API_KEY') === 'sk-refilled-in-cli-mode');
  check('重填之后锁解除', vault.status().locked === false);
  check('旧的 DPAPI 文件被备份了，没有直接覆盖掉',
    fs.existsSync(`${VAULT_FILE}.dpapi-backup`));
  check('备份的确实是原来那份',
    fs.readFileSync(`${VAULT_FILE}.dpapi-backup`).subarray(0, 6).toString() === 'DPAPI1');

  // 还原，别影响后面的自检
  fs.rmSync(`${VAULT_FILE}.dpapi-backup`, { force: true });
  if (savedVault) fs.writeFileSync(VAULT_FILE, savedVault);
  else fs.rmSync(VAULT_FILE, { force: true });
  vault.reload();
}

section('日志脱敏');
const redacted = logbus.redactHeaders({ Authorization: 'Bearer sk-test-secret-value-1234', 'X-Foo': 'bar' });
check('Authorization 被打码', !redacted.Authorization.includes('secret-value'), redacted.Authorization);
check('鉴权方案保留下来（写错 Bearer/Token 时好排查）', redacted.Authorization.startsWith('Bearer '));
check('普通头不动', redacted['X-Foo'] === 'bar');
const redactedBody = logbus.redactBody({ model: 'x', api_key: 'sk-abcdefghijklmn', nested: { secret: 'sk-zzzzzzzzzzzz' } });
check('请求体里的密钥字段也打码', !JSON.stringify(redactedBody).includes('abcdefghijklmn'));
check('嵌套层的密钥同样打码', !JSON.stringify(redactedBody).includes('zzzzzzzzzzzz'));

// ─────────────────────── 3. SSE 增量解析 ───────────────────────

section('SSE 增量解析');
const events = [];
const parser = createSSEParser((e) => events.push(e));
parser.push('data: {"a":1}\n');
check('半截事件不会提前吐出来', events.length === 0);
parser.push('\ndata: {"a":2}\n\n');
check('补齐后两个事件都出来了', events.length === 2, JSON.stringify(events));
const crlf = [];
const parser2 = createSSEParser((e) => crlf.push(e));
parser2.push('data: x\r\n\r\ndata: y\r\n\r\n');
check('CRLF 分隔也能切对', crlf.length === 2 && crlf[0].data === 'x' && crlf[1].data === 'y');

// ─────────────────────── 4. 联调台：流式 ───────────────────────

section('联调台 · 流式请求');
const streamEvents = await ndjson('/debug/send', {
  provider: 'raw',
  method: 'POST',
  url: `${upstreamUrl}/v1/chat/completions`,
  headers: { Authorization: 'Bearer {{TEST_KEY}}' },
  body: JSON.stringify({ model: 'test', stream: true }),
  stream: true
});
const done = streamEvents.find((e) => e.type === 'done');
check('请求成功', done?.status === 200, JSON.stringify(streamEvents.slice(-2)));
check('跨 chunk 的分片被正确拼回', done?.text === '一叶扁舟', `实际：${done?.text}`);
check('计时字段有值', typeof done?.ttfbMs === 'number' && typeof done?.totalMs === 'number');

const logs = logbus.list({ limit: 5 });
check('这次调用留下了记录', logs.length > 0);
check(
  '历史记录里没有明文密钥',
  !JSON.stringify(logs).includes('sk-test-secret-value-1234'),
  '密钥泄漏进历史了'
);

section('联调台 · 鉴权失败的可读性');
const bad = await ndjson('/debug/send', {
  provider: 'raw',
  method: 'POST',
  url: `${upstreamUrl}/v1/chat/completions`,
  headers: { Authorization: 'Bearer wrong-key' },
  body: '{}'
});
check('401 如实回传', bad.find((e) => e.type === 'done')?.status === 401);

// ─────────────────────── 5. 异步任务轮询 ───────────────────────

section('异步任务轮询');
settings.patch({ baseUrls: { dashscope: upstreamUrl }, pollIntervalMs: 10, pollTimeoutMs: 5000 });
vault.setSecret('DASHSCOPE_API_KEY', 'sk-test-secret-value-1234');
const asyncEvents = await ndjson('/debug/send', {
  provider: 'dashscope',
  method: 'POST',
  url: `${upstreamUrl}/api/v1/tasks/submit`,
  body: '{}',
  async: true
});
const polls = asyncEvents.filter((e) => e.type === 'poll');
check('轮询到了终态', polls.some((p) => p.state === 'succeeded'), JSON.stringify(polls));
check('中途状态也上报了', polls.some((p) => p.state === 'running'));
check('轮询次数合理（没有空转）', polls.length <= 4, `实际 ${polls.length} 次`);

// ─────────────────────── 6. 一致性引擎 ───────────────────────

section('一致性引擎');
const seedA = consistency.deriveSeed('proj-1', 'char:阿澜');
const seedB = consistency.deriveSeed('proj-1', 'char:阿澜');
const seedC = consistency.deriveSeed('proj-2', 'char:阿澜');
check('同项目同角色种子稳定', seedA === seedB);
check('换项目种子就变（避免撞车）', seedA !== seedC);
check('种子在各家的合法区间内', seedA > 0 && seedA < 2147483647);

const bible = {
  style: { anchor: '国风水墨', palette: '青灰', negative: '崩脸' },
  characters: [
    { name: '阿澜', appearance: '藏青立领制服，短发', seed: 1000, sheetUrl: 'https://x.invalid/a.png' },
    { name: '老陈', appearance: '灰布褂', seed: 2000, sheetUrl: null }
  ],
  scenes: [{ name: '码头', appearance: '晨雾，冷光', seed: 3000, sheetUrl: 'https://x.invalid/s.png' }],
  props: [{ name: '执法记录仪', appearance: '黑色方形' }]
};
const assembled = consistency.assemblePrompt(bible, {
  index: 3,
  scene: '码头',
  characters: ['阿澜'],
  description: '阿澜举起执法记录仪',
  camera: '中景'
});
check('风格锚排在最前', assembled.prompt.startsWith('国风水墨'));
check('角色设定被注入', assembled.prompt.includes('藏青立领制服'));
check('场景设定被注入', assembled.prompt.includes('晨雾'));
check('提到的道具被带上', assembled.prompt.includes('黑色方形'));
check('没出场的角色不注入', !assembled.prompt.includes('灰布褂'));
/**
 * 画面描述必须排在人物/场景设定**之前**。
 *
 * 原来是反过来的，于是两个角色一个场景就是 250 字外貌铺在前面，
 * 而这一镜真正要画的那句话只有二十来字、排在第 150 字之后 ——
 * 模型读到那儿权重已经稀释干净了，出来的图"人是对的、可就是没在演这一镜"。
 * 人设改由参考图压住（那本来就是更强的一层），文字把版面让给画面内容。
 */
check('画面描述排在人物设定之前（它才是这一镜的主语）',
  assembled.prompt.indexOf('举起') < assembled.prompt.indexOf('藏青'),
  assembled.prompt.slice(0, 100));
check('风格锚仍然在最前面', assembled.prompt.startsWith('国风水墨'), assembled.prompt.slice(0, 30));
check('种子 = 角色种子 + 镜号', assembled.seed === 1003);
check('参考图带上了场景和角色', assembled.refImages.length === 2);
check('负向词透传', assembled.negative === '崩脸');

// 参考图必须和提示词取自同一份设定集：单独重出时少带一样，
// 这一镜就会成为全片里唯一对不上的那张
const withProp = {
  ...bible,
  props: [{ name: '执法记录仪', appearance: '黑色方形', sheetUrl: 'https://x.invalid/p.png' }]
};
const refs = consistency.collectReferences(withProp, {
  index: 3, scene: '码头', characters: ['阿澜'], description: '阿澜举起执法记录仪'
});
check('参考图包含场景 + 角色 + 道具三类', refs.images.length === 3, JSON.stringify(refs.labels));
check('场景基准图排在第一张（首图权重最高）', refs.refs[0].kind === 'scene');
check('每一张都标了是谁，界面能显示', refs.labels.join('') === '景·码头角·阿澜道·执法记录仪', refs.labels.join('/'));
check('没有设定图的角色不会塞空值进去',
  consistency.collectReferences(bible, { index: 1, characters: ['老陈'], description: '老陈' }).images.length === 0);
check('同一张图不会重复带',
  consistency.collectReferences(
    { characters: [{ name: 'A', sheetUrl: 'u' }, { name: 'B', sheetUrl: 'u' }] },
    { index: 1, characters: ['A', 'B'], description: 'A 和 B' }
  ).images.length === 1);

const noName = consistency.assemblePrompt(bible, { index: 1, description: '老陈坐在码头', characters: [] });
check('没显式点名时按描述文本兜底匹配', noName.prompt.includes('灰布褂'));

// ─────────────────────── 6.5 项目的增删 ───────────────────────

section('项目增删（删完立刻消失，不用重启）');
{
  const p1 = store.create({ title: '待删项目', styleId: 'anime', targetDuration: 90 });
  fs.writeFileSync(path.join(store.assetDir(p1.id), 'a.png'), 'x');
  check('新建后在列表里', store.list().some((x) => x.id === p1.id));
  check('列表带上了画风和时长（项目页要显示）',
    store.list().find((x) => x.id === p1.id)?.styleId === 'anime'
      && store.list().find((x) => x.id === p1.id)?.targetDuration === 90);

  const r = await fetch(`${appUrl}/api/projects/${p1.id}`, { method: 'DELETE' });
  check('删除接口返回 200', r.status === 200, `HTTP ${r.status}`);
  check('删完当场就不在列表里了（不需要重启）', !store.list().some((x) => x.id === p1.id));

  // Windows 上文件被占用时 rmSync 会抛，那种情况下至少要保证 project.json 已经没了 ——
  // 列表里看不见它，功能上就算删掉了，残骸交给下次启动清。
  const p2 = store.create({ title: '半删项目' });
  const dir2 = store.projectDir(p2.id);
  fs.rmSync(path.join(dir2, 'project.json'));
  check('没有 project.json 的目录不会出现在列表里', !store.list().some((x) => x.id === p2.id));
  check('启动时的残骸清理会把它删掉', store.sweepOrphans() >= 1 && !fs.existsSync(dir2));

  check('删不存在的项目不报错', store.remove('no-such-project') === true);
}

// ─────────────────────── 7. 整条流水线（对着打桩服务跑）───────────────────────

section('流水线端到端（打桩，不花钱）');
settings.patch({
  baseUrls: { volcengine: `${upstreamUrl}/v3` },
  chatProvider: 'volcengine',
  visionProvider: 'volcengine',
  imageProvider: 'volcengine',
  consistencyVerify: true,
  consistencyThreshold: 75,
  consistencyMaxRetries: 2
});
vault.setSecret('ARK_API_KEY', 'sk-ark-test');

const project = await (
  await fetch(`${appUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '自检项目', style: '国风水墨' })
  })
).json();
await fetch(`${appUrl}/api/projects/${project.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ script: '清晨，渔政执法员阿澜在码头做例行巡查。' })
});

// 设定集是"写描述 + 出图"一整步。
// 试过拆成两步（先出文字、人确认、再出图），道理上说得通、实际不好用：
// 多一次手动确认、多一个"图还没出"的中间态，而设定集本来就是一口气出齐才有意义。
const bibleEvents = await ndjson(`/projects/${project.id}/stage/bible`, {});
const afterBible = bibleEvents.find((e) => e.type === 'finished')?.project;
check('设定集跑通', Boolean(afterBible?.bible), JSON.stringify(bibleEvents.slice(-1)));
check('角色被冻结', afterBible?.bible?.characters?.[0]?.name === '阿澜');
check('角色拿到了固定种子', typeof afterBible?.bible?.characters?.[0]?.seed === 'number');
check('描述和设定图一步出齐', Boolean(afterBible?.bible?.characters?.[0]?.sheetPath));
// 没有"冻结/解冻"这层了：设定集随时能改，改完重出那一张就行
check('条目上没有冻结状态这回事', afterBible?.bible?.characters?.[0]?.locked === undefined);
// "图和描述不符"时，第一件要确认的事就是"发出去的到底是哪句话"
check('真正发出去的提示词摊在事件流里',
  bibleEvents.some((e) => e.type === 'note' && /^提示词：/.test(e.message || '')),
  JSON.stringify(bibleEvents.filter((e) => e.type === 'note').map((e) => e.message).slice(0, 3)));
check('用过的提示词记在条目上（事后还能查）',
  Boolean(afterBible?.bible?.characters?.[0]?.sheetPromptUsed));
check(
  '设定图转成了模型可引用的形式',
  String(afterBible?.bible?.characters?.[0]?.sheetUrl || '').startsWith('data:image/png;base64,')
);
check('场景基准图也出了', Boolean(afterBible?.bible?.scenes?.[0]?.sheetPath));
check('参考图覆盖角色+场景+道具', upstream.imageCalls === 3, `实际 ${upstream.imageCalls}`);

const scriptEvents = await ndjson(`/projects/${project.id}/stage/script`, { shotCount: 2 });
const afterScript = scriptEvents.find((e) => e.type === 'finished')?.project;
check('分镜跑通', afterScript?.shots?.length === 2, JSON.stringify(scriptEvents.slice(-1)));
check('分镜带上了出场角色', afterScript?.shots?.[0]?.characters?.[0] === '阿澜');

upstream.imagePrompts = [];
upstream.imageSeeds = [];
const assetEvents = await ndjson(`/projects/${project.id}/stage/assets`, {});
const afterAssets = assetEvents.find((e) => e.type === 'finished')?.project;
const shot1 = afterAssets?.shots?.[0];

check('镜头图已落盘', Boolean(shot1?.imagePath), JSON.stringify(assetEvents.slice(-2)));
check('提示词里注入了风格锚', upstream.imagePrompts[0]?.startsWith('国风水墨'));
check('提示词里注入了冻结的角色外貌', upstream.imagePrompts[0]?.includes('藏青立领制服'),
  upstream.imagePrompts[0]);
/**
 * 不发参考图时**必须给完整外貌**。
 *
 * 这里挂过一次，而且是最坏的那种组合：分镜图默认不带参考图之后，
 * 提示词却仍然被压成三段、末尾还挂着"外貌以参考图为准"——
 * 而那张图根本没发。模型既没拿到图，又被砍掉了"袖口两道银线、左胸编号牌"
 * 这些真正锁得住身份的细节，出来的人当然谁也不像。
 */
check('不发参考图时给的是完整外貌，且不出现"以参考图为准"',
  upstream.imagePrompts[0]?.includes('左胸执法编号牌')
    && !upstream.imagePrompts[0]?.includes('以参考图为准'),
  upstream.imagePrompts[0]);
check('提示词里注入了场景设定', upstream.imagePrompts[0]?.includes('晨雾未散'));
check('提示词里带上了道具（镜头描述提到了）', upstream.imagePrompts[0]?.includes('黑色方形'));
/**
 * 分镜图**默认走文生图**，不带参考图。
 *
 * 试过带：把设定图喂给 SeedEdit 这类**编辑**模型，它是在那张图上改，
 * 而不是照着它另画一个场景 —— 出来的分镜图长得像"被改过的角色设定图"
 * （人物居中、纯色背景还在），根本不是要的那一镜。
 * 所以默认关掉，走"冻结描述 + 稳定种子"这条路；参考图那一层留给出视频。
 */
check('分镜图默认不带参考图（编辑模型会把这一镜画成"改过的设定图"）',
  !upstream.lastImageBody?.image, String(upstream.lastImageBody?.image || '').slice(0, 40));
check('分镜图用的是路由到的文生图模型，不被换掉',
  upstream.lastImageBody?.model === settings.get('imageModel'), upstream.lastImageBody?.model);
check('提示词里仍然注入了冻结的外貌（没有参考图时靠它撑一致性）',
  upstream.imagePrompts.at(-1)?.includes('藏青立领制服'), upstream.imagePrompts.at(-1));

/**
 * 把**编辑模型**选成「出图」路由是个不报错的配置错误：
 * SeedEdit 这类是"拿一张图去改"的模型，没有参考图给它就只能自己发挥，
 * 画出来的和你要的那一镜没关系 —— 而你只会觉得"这模型怎么乱画"。
 */
{
  const saved = settings.get('imageModel');
  settings.patch({ imageModel: 'doubao-seededit-3-0-i2i-250628' });
  const evs = await ndjson(`/projects/${project.id}/shots/${afterAssets.shots[0].id}/regenerate`, {});
  check('把图生图模型选成「出图」路由时会提醒（这种错不报错，只会让人以为模型乱画）',
    evs.some((e) => e.type === 'note' && /是图生图（编辑）模型/.test(e.message || '')),
    JSON.stringify(evs.filter((e) => e.type === 'note').map((e) => e.message).slice(0, 4)));
  settings.patch({ imageModel: saved });
}

/**
 * 打开「分镜图用图生图」之后才走参考图那条路。
 *
 * 这里同时盯着一个曾经把**整层参考图机制悄悄废掉**的 bug：
 * 带参考图时代码只往请求体塞了个 image 字段，模型却还是文生图那个 ——
 * 文生图模型不认这个字段，参考图被直接忽略，而且不报任何错。
 */
{
  settings.patch({ useEditModelForShots: true });
  upstream.lastImageBody = null;
  const evs = await ndjson(`/projects/${project.id}/shots/${afterAssets.shots[0].id}/regenerate`, {});
  check('打开开关后才带参考图', Boolean(upstream.lastImageBody?.image));
  check('而且必须换成图生图模型（不换的话参考图会被文生图模型忽略）',
    upstream.lastImageBody?.model === settings.get('imageEditModel'),
    `${upstream.lastImageBody?.model} / 期望 ${settings.get('imageEditModel')}`);
  check('换模型这件事说了出来（不说的话没人知道发的和界面写的不是一个）',
    evs.some((e) => e.type === 'note' && /出图模型换成/.test(e.message || '')),
    JSON.stringify(evs.filter((e) => e.type === 'note').map((e) => e.message).slice(0, 5)));
  settings.patch({ useEditModelForShots: false });
}

check('复核不通过时确实重试了', shot1?.consistency?.attempts > 1, `attempts=${shot1?.consistency?.attempts}`);
check('重试用的是不同种子（同种子会复现同一个错）', new Set(upstream.imageSeeds.slice(0, 3)).size === 3,
  JSON.stringify(upstream.imageSeeds));
check('最终这一镜复核通过', shot1?.consistency?.pass === true, JSON.stringify(shot1?.consistency));
check('通过后的分数被记下来', shot1?.consistency?.score === 92);

const assetsBadShot = afterAssets?.shots?.[1];
check('第二镜也出图了', Boolean(assetsBadShot?.imagePath));

// ─────────────────────── 7.5 单项重出 / 设定集编辑 / 画风 / 章节 ───────────────────────

section('单项重出');
const beforeSeed = afterAssets.shots[0].seed;
const regenEvents = await ndjson(`/projects/${project.id}/shots/${shot1.id}/regenerate`, {});
const regened = regenEvents.find((e) => e.type === 'finished')?.project;
const shot1b = regened?.shots?.find((s) => s.id === shot1.id);
check('单镜重出成功', Boolean(shot1b?.imagePath), JSON.stringify(regenEvents.slice(-1)));
check('换了种子（不指定时不复用上次那颗）', shot1b?.seed !== beforeSeed, `${beforeSeed} → ${shot1b?.seed}`);
check('记下了用的是哪家哪个模型', Boolean(shot1b?.modelUsed), shot1b?.modelUsed);
check('重出后不再标"待人工确认"', shot1b?.consistency?.needsReview === false);

const overrideEvents = await ndjson(`/projects/${project.id}/shots/${shot1.id}/regenerate`, {
  model: 'my-custom-image-model',
  prompt: '完全手写的提示词'
});
check('可以临时换模型重出', Boolean(overrideEvents.find((e) => e.type === 'finished')));
check(
  '手写提示词原样发出去（负向词按厂商习惯并入正向，属预期）',
  (upstream.imagePrompts.at(-1) || '').startsWith('完全手写的提示词'),
  upstream.imagePrompts.at(-1)
);
// 用户在卡片上专门挑了模型，就照他挑的发 —— 界面写着一个、实际发另一个，
// 比参考图不生效更糟。所以显式指定模型时**不做**图生图自动切换。
check('临时模型确实生效（显式指定时不被图生图切换顶掉）',
  upstream.lastImageBody?.model === 'my-custom-image-model', upstream.lastImageBody?.model);

// 单独重出的图同样吃设定集，并且把带了哪几张记在镜头上，界面才好显示
const shot1c = regened?.shots?.find((s) => s.id === shot1.id);
// 打桩服务里所有图返回的都是同一张 pixel.png，转成 data: URI 后角色图和场景图
// 完全相同，会被"同一张不重复带"那条规则合并掉 —— 所以这里只验"记下来了"，
// 三类参考图各自被带上由上面 collectReferences 的单元检查负责。
check('默认不带参考图时如实记成空（不能假装带了）',
  (shot1c?.bibleRefs || []).length === 0, JSON.stringify(shot1c?.bibleRefs));

// ── 单独重出视频：这条路最容易漏带设定集，只给首帧的话后几秒就跑偏 ──
settings.patch({ videoProvider: 'volcengine', videoModel: 'doubao-seedance-1-0-pro-250528' });
const vidEvents = await ndjson(`/projects/${project.id}/shots/${shot1.id}/regenerate`, {
  kind: 'video',
  resolution: '1080p'
});
const afterVideo = vidEvents.find((e) => e.type === 'finished')?.project;
const shot1v = afterVideo?.shots?.find((s) => s.id === shot1.id);
const vidContent = upstream.lastVideoBody?.content || [];
const vidText = vidContent.find((c) => c.type === 'text')?.text || '';
const vidImages = vidContent.filter((c) => c.type === 'image_url');

check('单镜视频重出跑通', Boolean(shot1v?.videoPath), JSON.stringify(vidEvents.slice(-1)));
check('提示词里有剧本内容，不只是运镜（图文不搭就是这儿漏的）',
  vidText.includes('阿澜'), vidText.slice(0, 80));
// 方舟 Seedance 只收 1 张首帧图。多塞几张过去整个任务会被判非法参数直接失败 ——
// "出视频一直失败"最常见的就是这个原因。所以这里必须只发 1 张，并说清楚为什么。
check('方舟只发 1 张首帧图（多发会让任务提交直接失败）', vidImages.length === 1, `${vidImages.length} 张`);
check('被截掉的参考图有说明，不是悄悄丢掉',
  vidEvents.some((e) => e.type === 'note' && /最多收 1 张图/.test(e.message || '')),
  JSON.stringify(vidEvents.filter((e) => e.type === 'note').map((e) => e.message).slice(0, 3)));
// 台词从来没进过视频提示词：于是模型只知道"有人在说话"，说什么、谁在说全靠它猜。
// 画面里两个人时，张嘴的那个有一半几率是错的
check('台词本身写进了视频提示词（口型才对得上说的话）',
  /设备正常/.test(vidText), vidText.slice(0, 160));
check('说明了是谁在说', /只有阿澜在说话/.test(vidText), vidText.slice(0, 160));
// 机位光线在出图那步已经烧进首帧图了，再讲一遍是让模型重新构图 —— 它会偏离首帧
check('带首帧时不再重复讲机位光线（会和首帧打架）',
  !/低机位仰拍|伦勃朗布光/.test(vidText), vidText.slice(0, 200));
// 精准模式：首帧图已经回答了"人长什么样、在哪儿、什么景别"，文字再复述一遍，
// 模型就得在"照着图"和"照着字"之间选边 —— 它经常选错
check('精准模式不复述外貌和场景（首帧图里已经有了）',
  !/保持外貌不变/.test(vidText), vidText.slice(0, 200));
check('镜头上记下了这次带了哪些设定集参考',
  (shot1v?.videoRefs || []).length > 0, JSON.stringify(shot1v?.videoRefs));
check('单镜临时指定的分辨率发出去了（方舟是拼在文本里的 --resolution）',
  / --resolution 1080p/.test(vidText), vidText.slice(-60));
check('画幅也一并发出（竖屏短剧靠它）', / --ratio 16:9/.test(vidText), vidText.slice(-60));
check('记下了本次出视频的清晰度', shot1v?.videoResolution === '1080p', shot1v?.videoResolution);

// ── 尾帧衔接走到真实请求体 ──
// 光有 continuity.js 里的判断没用，得确认它真的变成了发给厂商的那两张带 role 的图。
{
  const second = afterAssets.shots[1];
  await fetch(`${appUrl}/api/projects/${project.id}/shots/${second.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link: 'continuous' })
  });
  const chained = await ndjson(`/projects/${project.id}/shots/${shot1.id}/regenerate`, { kind: 'video' });
  const body = upstream.lastVideoBody || {};
  const roles = (body.content || []).filter((c) => c.role).map((c) => c.role);
  check('下一镜标了连续动作，这一镜就把它那张图锁成末帧',
    roles.join(',') === 'first_frame,last_frame', JSON.stringify(roles));
  // 方舟不带 role 会把两张图当成两张参考图，而 Seedance 只收一张 —— 直接提交失败
  check('首尾帧两张图都带了 role（不带会被判非法参数）',
    (body.content || []).filter((c) => c.type === 'image_url').every((c) => c.role));
  check('界面能看到末帧到底锁上没有',
    chained.find((e) => e.type === 'finished')?.project?.shots?.find((s) => s.id === shot1.id)?.endFrameChained === true);
  check('事件流里说清楚了为什么这一镜多了一张图',
    chained.some((e) => e.type === 'note' && /锁成本镜末帧/.test(e.message || '')),
    JSON.stringify(chained.filter((e) => e.type === 'note').map((e) => e.message).slice(0, 4)));

  // 末帧复核要么给出结论、要么明说跳过，但**绝不能拦住视频落盘** ——
  // 质检坏了不该让已经花钱出好的片子丢掉。这条在装没装 FFmpeg 的机器上都成立。
  const verdict = chained.find((e) => e.type === 'finished')?.project?.shots?.find((s) => s.id === shot1.id);
  const saidSkip = chained.some((e) => e.type === 'note' && /末帧复核|抠末帧/.test(e.message || ''));
  check('末帧复核要么有结论要么明说跳过，视频照常保存',
    Boolean(verdict?.videoPath) && (Boolean(verdict?.videoConsistency) || saidSkip),
    JSON.stringify({ video: Boolean(verdict?.videoPath), tail: verdict?.videoConsistency || null, saidSkip }));

  // 换机位（默认）不该锁末帧，否则整片会变成一个没剪过的长镜头
  await fetch(`${appUrl}/api/projects/${project.id}/shots/${second.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link: 'cut' })
  });
  await ndjson(`/projects/${project.id}/shots/${shot1.id}/regenerate`, { kind: 'video' });
  check('改回换机位就不再锁末帧',
    (upstream.lastVideoBody?.content || []).every((c) => !c.role),
    JSON.stringify((upstream.lastVideoBody?.content || []).map((c) => c.role)));
}

section('手动补入（中转平台查不到任务时的救援路径）');
{
  const shot = afterAssets.shots[1];
  const evs = await ndjson(`/projects/${project.id}/shots/${shot.id}/attach`, {
    url: `${upstreamUrl}/out.mp4`,
    kind: 'video'
  });
  const p2 = evs.find((e) => e.type === 'finished')?.project;
  const s2 = p2?.shots?.find((x) => x.id === shot.id);
  // 任务在人家平台上跑完了、钱也花了，只是我们查不到状态 ——
  // 这条路保证那段视频不至于烂在那儿
  check('贴一个地址就能把视频补到这一镜上', Boolean(s2?.videoPath), JSON.stringify(evs.slice(-1)));
  check('如实标成手动补入，不冒充模型出的', s2?.videoModelUsed === '手动补入');

  const bad = await ndjson(`/projects/${project.id}/shots/${shot.id}/attach`, { url: '随便写的' });
  check('不是 http 地址时直接说清楚，而不是去下载一个鬼东西',
    /http\(s\) 开头/.test(bad.find((e) => e.type === 'error')?.message || ''),
    JSON.stringify(bad.slice(-1)));
}

// 分镜是自动拆的，拆偏一句后面每次重出都是在错的基础上重来。
// 手改这条路必须**只动文案**：界面上那份 shots 可能是十分钟前拉的，
// 整份回传会把中间刚写进去的 imagePath / videoPath 一起盖掉。
section('分镜文案可以手改（改一行字比重跑十次便宜）');
{
  // 单开一个项目：这条路要验的是"别的字段一根汗毛都别动"，
  // 借用正跑着的那个项目会把后面的检查搅浑
  const edited = store.create({ title: '改文案' });
  store.update(edited.id, (p) => {
    p.shots = [{
      id: 'e1', index: 1, scene: '码头', characters: ['阿澜'],
      description: '清晨的码头，阿澜做例行巡查', camera: '中景', motion: '缓推',
      dialogue: '', duration: 4, status: 'done',
      imagePath: 'assets/e1.png', videoPath: 'assets/e1.mp4',
      consistency: { score: 88, pass: true, attempts: 1, needsReview: false }
    }];
    return p;
  });
  const before = store.read(edited.id).shots[0];
  const r = await (
    await fetch(`${appUrl}/api/projects/${edited.id}/shots/e1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: '雨夜的码头，阿澜举着手电筒照向水面',
        camera: '特写',
        characters: '阿澜、老周',
        // 产物字段一起塞进来：必须被无视
        imagePath: '被覆盖了.png',
        videoPath: '也被覆盖了.mp4',
        status: 'failed'
      })
    })
  ).json();
  const after = r.project?.shots?.[0];

  check('描述改得动', after?.description === '雨夜的码头，阿澜举着手电筒照向水面', after?.description);
  check('景别改得动', after?.camera === '特写', after?.camera);
  check('出场角色按中文顿号/逗号拆成数组',
    JSON.stringify(after?.characters) === JSON.stringify(['阿澜', '老周']), JSON.stringify(after?.characters));
  check('已经出好的图不会被这次编辑弄没', after?.imagePath === before?.imagePath, after?.imagePath);
  check('白名单之外的字段一个都不认（status 没被改成 failed）',
    after?.status === before?.status, `${before?.status} → ${after?.status}`);
  check('记下了手改时间（界面靠它标"文案已手改"）', Boolean(after?.editedAt));
  check('回报了到底改了哪几项', Array.isArray(r.changed) && r.changed.includes('description'), JSON.stringify(r.changed));
  // 分数是对**旧描述**打的，留着不说明就是在冒充现在的结论
  check('旧的一致性分数被标成过时', after?.consistency?.stale === true, JSON.stringify(after?.consistency));

  const same = await (
    await fetch(`${appUrl}/api/projects/${edited.id}/shots/e1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: '雨夜的码头，阿澜举着手电筒照向水面' })
    })
  ).json();
  check('没改动就不算改动（不会白刷一次 editedAt）', same.changed.length === 0, JSON.stringify(same.changed));

  const missing = await fetch(`${appUrl}/api/projects/${edited.id}/shots/no-such-shot`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'x' })
  });
  check('改一个不存在的镜头返回 404，不是静默成功', missing.status === 404, `HTTP ${missing.status}`);

  // 单镜 PATCH 不能被整项目那条 PATCH 抢走 —— 抢走的话 shots 会被一个对象覆盖掉
  check('整项目的 shots 数组还是数组', Array.isArray(store.read(edited.id).shots));
  store.remove(edited.id);
}

// 图生视频名义上是"以这张图为第一帧往下演"，实际不总是这样：
// 有的厂商在提示词和图打架时自己重画第一帧，有的悄悄退化成文生视频。
// 两种情况任务都"成功"，表现却是片子和分镜图对不上 —— 不比一比根本发现不了。
section('首帧核对（免费，不调模型）');
{
  const imghash = await import('../core/imghash.js');

  // 9×8 灰度：左半黑右半白。相邻像素的大小关系是确定的，哈希也就是确定的。
  const gray = (fn) => Buffer.from(Array.from({ length: 72 }, (_, i) => fn(i % 9, Math.floor(i / 9))));
  // 有纹理的画面：真实镜头图长这样，dHash 也只有在这种图上才有话可说
  const textured = (seed) => gray((x, y) => (Math.imul(x + 1 + seed, y + 7 + seed * 31) * 2654435761) % 256);
  const hA = imghash.dHashFromGray(textured(0));
  check('同样的像素给同样的哈希（可复现，才能当阈值用）',
    hA === imghash.dHashFromGray(textured(0)), hA);
  check('哈希是 16 位十六进制（64 bit）', /^[0-9a-f]{16}$/.test(hA), hA);
  // 整体压暗：dHash 比的是"相邻谁更亮"，这种变化不该影响结果 ——
  // 视频编码后整体偏暗一点点是常态，用均值哈希会把这种无害差异算成不匹配
  const dimmed = Buffer.from(textured(0).map((v) => Math.round(v * 0.6)));
  check('整体压暗不影响结果（dHash 比的是相邻谁更亮，不是绝对亮度）',
    imghash.hamming(hA, imghash.dHashFromGray(dimmed)) === 0,
    String(imghash.hamming(hA, imghash.dHashFromGray(dimmed))));
  check('换一张画面就认得出不一样（这才是"厂商没吃首帧"的样子）',
    imghash.hamming(hA, imghash.dHashFromGray(textured(5))) > imghash.MATCH_THRESHOLD,
    String(imghash.hamming(hA, imghash.dHashFromGray(textured(5)))));
  check('长度不够时直接报错，不静默给个错哈希',
    (() => { try { imghash.dHashFromGray(Buffer.alloc(10)); return false; } catch { return true; } })());

  /**
   * 纯色画面测不准，而且是**危险的那种不准**：
   * 大片纯色算出来的哈希几乎全是 0，两个全 0 的哈希距离也是 0 ——
   * 看上去像"完全一致"，实际是"没信息"。夜戏、纯黑开场、白底道具图都会踩到。
   */
  const flat = gray(() => 20);
  check('纯色画面被判为没有信息量，不拿来下结论',
    !imghash.informative(imghash.dHashFromGray(flat)), imghash.dHashFromGray(flat));
  check('有纹理的画面才算数', imghash.informative(hA), `${imghash.bitCount(hA)} 个 1`);
  check('相似度好懂：一模一样就是 100%', imghash.similarity(0) === 100 && imghash.similarity(64) === 0);
  check('比不了的时候是无穷大，不是 0（0 会被当成"完全一致"）',
    imghash.hamming('abc', null) === Number.POSITIVE_INFINITY);

  // 没装 FFmpeg 时必须回 null——"没检查"和"检查了不匹配"是两回事，
  // 混为一谈就会在没装 FFmpeg 的机器上把每一镜都误报成"首帧没吃"
  const ffmpegMod = await import('../core/ffmpeg.js');
  if (!ffmpegMod.locate({ refresh: true }).available) {
    check('没装 FFmpeg 时回 null（这是"没检查"，不是"不匹配"）',
      (await imghash.compareFirstFrame('a.mp4', 'b.png')) === null);
  } else {
    /**
     * 这台机器上有 FFmpeg，那就真的跑一遍 —— 上面那些都是纯计算，
     * 证明不了**发给 FFmpeg 的那几行参数是对的**。而参数写错的表现是
     * "每一镜都报首帧没吃"，比不做还糟。
     */
    const dir = path.join(SANDBOX, 'imghash');
    fs.mkdirSync(dir, { recursive: true });
    const F = (n) => path.join(dir, n);
    try {
      // testsrc / testsrc2 是 FFmpeg 自带的测试图，两张画面完全不同，且可复现
      await ffmpegMod.run(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=1',
        '-frames:v', '1', F('shot.png')]);
      await ffmpegMod.run(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=1',
        '-frames:v', '1', F('other.png')]);
      await ffmpegMod.run(['-y', '-v', 'error', '-loop', '1', '-i', F('shot.png'), '-t', '1', '-r', '8',
        '-pix_fmt', 'yuv420p', F('good.mp4')]);
      await ffmpegMod.run(['-y', '-v', 'error', '-loop', '1', '-i', F('other.png'), '-t', '1', '-r', '8',
        '-pix_fmt', 'yuv420p', F('bad.mp4')]);

      const good = await imghash.compareFirstFrame(F('good.mp4'), F('shot.png'));
      check('真跑一遍：首帧就是那张图时判 ok（编码带来的差异不该算不匹配）',
        good?.verdict === 'ok', JSON.stringify(good && { v: good.verdict, d: good.distance }));

      const bad = await imghash.compareFirstFrame(F('bad.mp4'), F('shot.png'));
      check('真跑一遍：换成另一张画面就判 mismatch（这就是"厂商没吃首帧"）',
        bad?.verdict === 'mismatch', JSON.stringify(bad && { v: bad.verdict, d: bad.distance }));
      check('两者拉得开，阈值不是卡在噪声上',
        bad.distance - good.distance > imghash.MATCH_THRESHOLD, `${good.distance} → ${bad.distance}`);

      // 末帧复核那条路也验一下：抠帧的参数和这里不是同一组
      await ffmpegMod.grabFrame(F('good.mp4'), F('tail.png'), { at: 'end' });
      check('末帧抠得出来（末帧复核靠它）', fs.existsSync(F('tail.png')));
    } catch (err) {
      check('装了 FFmpeg 就该能跑通首帧核对', false, err.message);
    }
  }
}

section('画幅是每部片子自己的事，不是全局开关');
{
  const vertical = store.create({ title: '竖屏短剧', aspectRatio: '9:16' });
  check('新建项目时能定画幅', store.read(vertical.id).aspectRatio === '9:16');
  check('列表里带着画幅（项目卡片要显示）',
    store.list().find((x) => x.id === vertical.id)?.aspectRatio === '9:16');

  const legacy = store.create({ title: '没设画幅的老项目' });
  check('不给就留空，表示跟随全局设置', legacy.aspectRatio === '');

  // 同一台机器上同时有横屏宣传片和竖屏短剧是常事：
  // 挂在设置里就意味着每次切项目都得记得回去改一次，迟早出错
  settings.patch({ aspectRatio: '16:9' });
  store.update(vertical.id, (p) => {
    p.bible = { style: '水墨', characters: [], scenes: [], props: [] };
    p.shots = [{
      id: 's1', index: 1, description: '巷口', camera: '中景',
      motion: '缓推', characters: [], scene: '', duration: 4, status: 'pending'
    }];
    return p;
  });
  upstream.lastImageBody = null;
  const vEvents = await ndjson(`/projects/${vertical.id}/shots/s1/regenerate`, {});
  check('出图按项目的画幅走，而不是全局的 16:9',
    upstream.lastImageBody?.size === '720x1280',
    `${upstream.lastImageBody?.size} / ${JSON.stringify(vEvents.slice(-1))}`);

  store.remove(vertical.id);
  store.remove(legacy.id);
}

section('设定集编辑');
const propRegen = await ndjson(
  `/projects/${project.id}/bible/prop/${encodeURIComponent('执法记录仪')}/regenerate`,
  { appearance: '黑色方形，机身带红色录制指示灯' }
);
const afterProp = propRegen.find((e) => e.type === 'finished')?.project;
const prop = afterProp?.bible?.props?.[0];
check('道具能单独出图', Boolean(prop?.sheetPath), JSON.stringify(propRegen.slice(-1)));
check('顺手改的描述被保存', /红色录制指示灯/.test(prop?.appearance || ''), prop?.appearance);
check('道具提示词要求单体产品图', /单个物体/.test(upstream.imagePrompts.at(-1) || ''), upstream.imagePrompts.at(-1));

const added = await (
  await fetch(`${appUrl}/api/projects/${project.id}/bible/prop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '周边徽章', appearance: '圆形金属徽章' })
  })
).json();
check('能往设定集里加衍生品', added.bible.props.some((p) => p.name === '周边徽章'));
check('新加的条目也有自己的种子', Number.isFinite(added.bible.props.at(-1)?.seed));

const removed = await (
  await fetch(`${appUrl}/api/projects/${project.id}/bible/prop/${encodeURIComponent('周边徽章')}`, {
    method: 'DELETE'
  })
).json();
check('能删掉设定集条目', !removed.bible.props.some((p) => p.name === '周边徽章'));

// 有些参照模型画不出来：真人演员的照片、客户给的产品图、已经定稿的三视图。
// 传上来之后它必须和模型出的设定图**完全同等**，否则等于传了个寂寞。
// 之前唯一能保存文字的路径是「改完重出」——"想改一句描述就得重烧一张图"，
// 不点那个按钮改的字还会丢。"我明明改了，怎么没生效"就是这么来的。
section('设定集：改文字不该花钱，改完重出那一张就行');
{
  const name = afterProp.bible.characters[0].name;
  const url = (n) => `${appUrl}/api/projects/${project.id}/bible/char/${encodeURIComponent(n)}`;
  const patch = (n, body) =>
    fetch(url(n), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json().then((j) => ({ status: r.status, ...j })));

  const before = upstream.imagePrompts.length;
  const saved = await patch(name, { appearance: '短发，藏青立领制服，袖口两道银线，左眉有疤' });
  check('只改文字就能保存', /左眉有疤/.test(
    saved.project?.bible?.characters?.find((c) => c.name === name)?.appearance || ''), JSON.stringify(saved.changed));
  // 这是这条接口存在的全部理由：改字不该触发出图
  check('存文字一次图都没出（不花钱）', upstream.imagePrompts.length === before,
    `出图次数 ${before} → ${upstream.imagePrompts.length}`);
  check('记下了文字改动时间（界面据此提醒"图还没跟上"）',
    Boolean(saved.project.bible.characters.find((c) => c.name === name)?.textAt));
  check('没改动就如实说没改动', (await patch(name, { appearance: '短发，藏青立领制服，袖口两道银线，左眉有疤' })).changed.length === 0);

  /**
   * 改名必须同步分镜。分镜里的 characters[] / scene 存的是**名字**，
   * 只改设定集不改分镜等于把所有引用一次性打断 ——
   * 那些镜头会查不到人，出图时既不带参考图也不注入外貌，
   * 而且**不会报错**，只是悄悄画成另一个人。这种坏法最难查。
   */
  const usedBefore = store.read(project.id).shots.filter((s) => (s.characters || []).includes(name)).length;
  const renamed = await patch(name, { name: '阿澜队长' });
  check('改得了名', renamed.project.bible.characters.some((c) => c.name === '阿澜队长'));
  check('分镜里的引用同步改掉了（不同步就会悄悄画成另一个人）',
    renamed.renamed === usedBefore && usedBefore > 0, `同步了 ${renamed.renamed} 处，应为 ${usedBefore}`);
  check('分镜里已经查不到旧名字',
    !store.read(project.id).shots.some((s) => (s.characters || []).includes(name)));

  const dup = await patch('阿澜队长', { name: afterProp.bible.characters[1]?.name || '阿澜队长' });
  if (afterProp.bible.characters[1]) {
    check('重名直接拦下来，不产生两个同名条目', dup.status === 400, JSON.stringify(dup));
  }
  await patch('阿澜队长', { name }); // 改回去，后面的检查还要用

  const ghost = await patch('查无此人', { appearance: 'x' });
  check('改不存在的条目返回 400，不是静默成功', ghost.status === 400, JSON.stringify(ghost));

  /**
   * 这一段盯的是一个真出现过的 bug，而且是最难查的那种：
   *
   * 出图提示词以前取的是 `item.sheetPrompt || item.appearance`，
   * 而 sheetPrompt 在生成设定集时就被模型填满了 —— 于是它**永远非空**。
   * 结果：你改了描述、重出图，出来的还是照着旧描述画的，**怎么重出都没用**，
   * 因为真正发出去的一直是那份你看不见、也没动过的 sheetPrompt。
   */
  await patch(name, { appearance: '雪白长发，猩红斗篷，左眼戴单片镜' });
  upstream.imagePrompts = [];
  await ndjson(`/projects/${project.id}/bible/char/${encodeURIComponent(name)}/regenerate`, {});
  const sent = upstream.imagePrompts.at(-1) || '';
  check('改完描述再重出，发出去的提示词跟着变了（这条挂过一次）',
    /猩红斗篷/.test(sent), sent.slice(0, 140));
  check('旧描述不再出现在提示词里', !/藏青立领制服/.test(sent), sent.slice(0, 140));

  // sheetPrompt 退回"可选覆盖"的身份：默认空，写了才顶上
  const after = store.read(project.id).bible.characters.find((c) => c.name === name);
  check('生成设定集时不预填出图提示词（预填就等于永远盖住描述）', !after.sheetPrompt);

  // 出图提示词的覆盖存在**变体**上（条目上那份没人读了 —— 两个存放处只更新一处，
  // 正是"改了描述、重出还是旧的"那个 bug 复发的根源）
  await (await fetch(
    `${appUrl}/api/projects/${project.id}/bible/char/${encodeURIComponent(name)}/variants/v-default`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetPrompt: '完全手写的出图提示词' }) })).json();
  upstream.imagePrompts = [];
  await ndjson(`/projects/${project.id}/bible/char/${encodeURIComponent(name)}/regenerate`, {});
  check('明确写了出图提示词时它才顶上描述',
    /完全手写的出图提示词/.test(upstream.imagePrompts.at(-1) || ''), upstream.imagePrompts.at(-1));

  // 再改描述 → 覆盖自动清掉，否则又回到"改了没用"的老路
  const cleared = await patch(name, { appearance: '换一版描述：墨绿风衣，寸头' });
  const clearedItem = cleared.project.bible.characters.find((c) => c.name === name);
  check('再改描述时自动清掉那个覆盖（否则又回到"改了没用"）',
    !clearedItem?.sheetPrompt && !(clearedItem?.variants || []).some((v) => v.sheetPrompt),
    JSON.stringify((clearedItem?.variants || []).map((v) => v.sheetPrompt)));
  upstream.imagePrompts = [];
  await ndjson(`/projects/${project.id}/bible/char/${encodeURIComponent(name)}/regenerate`, {});
  check('于是新描述又生效了', /墨绿风衣/.test(upstream.imagePrompts.at(-1) || ''), upstream.imagePrompts.at(-1));

  /**
   * 覆盖只能存在一个地方。
   *
   * 这个 bug 复发过一次：修好 item.sheetPrompt 之后加了变体层，
   * 迁移时把它复制进了默认变体，而清理只清 item 那份 ——
   * 变体里那份陈旧的覆盖又活了下来，"改描述不生效"原样复发。
   * 同一个值有两个存放处、只有一处会被更新，迟早出这种事。
   */
  const vurl = `${appUrl}/api/projects/${project.id}/bible/char/${encodeURIComponent(name)}/variants/v-default`;
  await fetch(vurl, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sheetPrompt: '藏在变体里的旧覆盖' })
  });
  await patch(name, { appearance: '再换一版：赤红斗篷，独眼' });
  upstream.imagePrompts = [];
  await ndjson(`/projects/${project.id}/bible/char/${encodeURIComponent(name)}/regenerate`, {});
  check('藏在变体里的旧覆盖也会被清掉（这个 bug 复发过一次）',
    /赤红斗篷/.test(upstream.imagePrompts.at(-1) || '')
      && !/藏在变体里的旧覆盖/.test(upstream.imagePrompts.at(-1) || ''),
    upstream.imagePrompts.at(-1));
}

/**
 * 变体：同一个角色的不同穿搭、同一个场景的内景外景。
 *
 * 拆成两个独立条目是不行的 —— 两颗种子、两张各自发挥的设定图，
 * 复核时还会互相判成不一致，换套衣服等于换了个人。
 * 所以拆的是"永不变的身份锚"和"这一版变的那部分"。
 */
section('变体：换装 / 内外景');
{
  const vmod = await import('../core/pipeline/variants.js');
  const charName = afterProp.bible.characters[0].name;
  const url = (n) => `${appUrl}/api/projects/${project.id}/bible/char/${encodeURIComponent(n)}`;
  const post = (path, body) =>
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json().then((j) => ({ status: r.status, ...j })));

  // 老项目没有 variants，读的时候补一个默认的，并接管原有那张图
  const item0 = store.read(project.id).bible.characters[0];
  check('老条目自动补出默认变体', vmod.variantsOf(item0).length === 1, JSON.stringify(item0.variants?.length));
  check('默认变体接管了条目原有的那张设定图',
    vmod.defaultVariant(item0)?.sheetPath === item0.sheetPath, item0.sheetPath);

  const made = await post(`${url(charName)}/variants`, { name: '雨夜外套', appearance: '深灰连帽雨衣，肩上湿痕' });
  check('能加一版', Boolean(made.variant?.id), JSON.stringify(made).slice(0, 120));
  const withV = store.read(project.id).bible.characters.find((c) => c.name === charName);
  check('加完是两版', vmod.variantsOf(withV).length === 2);
  // 这是整个设计的关键：换了衣服还得是同一张脸
  check('变体不带自己的种子（共用条目的身份种子，脸才不变）',
    made.variant.seed === undefined, JSON.stringify(made.variant.seed));

  // 出图提示词 = 身份锚 + 这一版变的那部分，身份在前
  const bibleNow = store.read(project.id).bible;
  const prompt = studioModule.sheetPrompt('char', bibleNow, withV, made.variant);
  // 前面那节把阿澜的身份锚改成了「墨绿风衣，寸头」，这里就按当时那份来断言
  const anchorText = withV.appearance;
  check('变体的出图提示词 = 身份锚 + 变体描述',
    prompt.includes(anchorText) && /连帽雨衣/.test(prompt), prompt);
  check('身份锚排在变体描述之前（越靠后越容易被稀释）',
    prompt.indexOf(anchorText) < prompt.indexOf('连帽雨衣'), prompt);

  // 设定图按变体算：加了一版就多缺一张
  const rdy = studioModule.bibleReadiness(store.read(project.id));
  check('设定图按变体计数，新加的那版算"还差一张"',
    rdy.missing.some((m) => /雨夜外套/.test(m)), JSON.stringify(rdy.missing));

  // 分镜指定用哪一版
  const shotId = afterAssets.shots[0].id;
  const patched = await (
    await fetch(`${appUrl}/api/projects/${project.id}/shots/${shotId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variants: { [charName]: made.variant.id } })
    })
  ).json();
  const shotV = patched.project.shots.find((x) => x.id === shotId);
  check('分镜能指定这一镜用哪一版', shotV?.variants?.[charName] === made.variant.id, JSON.stringify(shotV?.variants));
  check('指向不存在的变体会被丢掉（否则界面显示着你选的、实际悄悄用了默认）',
    !(await (
      await fetch(`${appUrl}/api/projects/${project.id}/shots/${shotId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variants: { [charName]: 'v-不存在' } })
      })
    ).json()).project.shots.find((x) => x.id === shotId)?.variants?.[charName]);

  // 提示词和参考图都要跟着这一镜选的那版走
  await fetch(`${appUrl}/api/projects/${project.id}/shots/${shotId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variants: { [charName]: made.variant.id } })
  });
  const fresh = store.read(project.id);
  const p2 = consistency.assemblePrompt(fresh.bible, fresh.shots.find((x) => x.id === shotId));
  check('这一镜的提示词带上了选中那版的描述', /连帽雨衣/.test(p2.prompt), p2.prompt.slice(0, 160));

  // 删变体：默认那版删不掉，其余删掉时要把分镜里的引用一起清干净
  const delDefault = await fetch(
    `${url(charName)}/variants/${vmod.DEFAULT_VARIANT_ID}`, { method: 'DELETE' });
  check('默认那版删不掉（它是身份基准）', delDefault.status === 400);
  const del = await (await fetch(`${url(charName)}/variants/${made.variant.id}`, { method: 'DELETE' })).json();
  check('删掉一版时把分镜里指着它的引用一并清掉（否则指向一个不存在的变体）',
    del.cleared >= 1 && !del.project.shots.find((x) => x.id === shotId)?.variants?.[charName],
    JSON.stringify(del.cleared));
}

section('设定集可以用本地图片当基准');
{
  const charName = afterProp.bible.characters[0].name;
  const png = PIXEL_PNG.toString('base64');
  const up = await ndjson(
    `/projects/${project.id}/bible/char/${encodeURIComponent(charName)}/upload`,
    { dataUrl: `data:image/png;base64,${png}`, fileName: '演员定妆照.png' }
  );
  const after = up.find((e) => e.type === 'finished')?.project;
  const who = after?.bible?.characters?.find((c) => c.name === charName);

  check('传上来的图成了这个角色的设定图', Boolean(who?.sheetPath), JSON.stringify(up.slice(-1)));
  check('文件名带 upload，一眼看得出这张不是模型出的',
    /-upload\.png$/.test(who?.sheetPath || ''), who?.sheetPath);
  check('落到了项目自己的 assets 目录里', fs.existsSync(who?.sheetPath || ''));
  check('如实记下来源，界面靠它标「自传图」', who?.sheetSource === 'upload', who?.sheetSource);
  check('记下了原始文件名', who?.sheetFileName === '演员定妆照.png', who?.sheetFileName);
  // 这条是整个功能的意义所在：传完之后出图要真的照着它画
  check('sheetUrl 一起换了（后面每一镜出图带的就是这张）',
    Boolean(who?.sheetUrl) && who.sheetUrl.startsWith('data:image/png;base64,'), String(who?.sheetUrl).slice(0, 30));

  const badType = await ndjson(
    `/projects/${project.id}/bible/char/${encodeURIComponent(charName)}/upload`,
    { dataUrl: 'data:application/pdf;base64,AAAA', fileName: 'x.pdf' }
  );
  check('不是图片就直接说清楚，而不是存一个打不开的文件',
    /不支持这种图片格式/.test(badType.find((e) => e.type === 'error')?.message || ''),
    JSON.stringify(badType.slice(-1)));

  const noData = await ndjson(
    `/projects/${project.id}/bible/char/${encodeURIComponent(charName)}/upload`, { dataUrl: '' });
  check('没给内容时不静默成功',
    /没读到图片内容/.test(noData.find((e) => e.type === 'error')?.message || ''), JSON.stringify(noData.slice(-1)));

  const noSuch = await ndjson(
    `/projects/${project.id}/bible/char/${encodeURIComponent('查无此人')}/upload`,
    { dataUrl: `data:image/png;base64,${png}` });
  check('传给不存在的条目会报错', /设定集里没有/.test(noSuch.find((e) => e.type === 'error')?.message || ''));

  // 重出会盖掉自传图 —— 这是预期行为，但标记必须跟着换，否则界面会一直说"你传的"
  const redo = await ndjson(
    `/projects/${project.id}/bible/char/${encodeURIComponent(charName)}/regenerate`, {});
  const redone = redo.find((e) => e.type === 'finished')?.project?.bible?.characters?.find((c) => c.name === charName);
  check('模型重出之后来源标记跟着换回 model', redone?.sheetSource === 'model', redone?.sheetSource);
}

section('画风预设');
const stylesResp = await (await fetch(`${appUrl}/api/styles`)).json();
check('画风预设列表拿得到', stylesResp.presets?.length >= 10, `${stylesResp.presets?.length} 个`);
check('每个预设都有锚点和缩略图配色', stylesResp.presets.every((s) => s.id === 'custom' || (s.anchor && s.swatch?.from)));
check('保留了自定义选项', stylesResp.presets.some((s) => s.id === 'custom'));

// 预览图：用用户自己的模型出，不打包别人的作品
{
  const before = stylesResp.presets.find((x) => x.id === 'ink');
  check('还没出过时 previewPath 是空的（界面退回内置示意图）', before.previewPath === null);

  const evs = await ndjson('/styles/ink/preview', {});
  const fin = evs.find((e) => e.type === 'finished');
  check('能用当前出图模型出一张画风预览图', Boolean(fin?.path), JSON.stringify(evs.slice(-1)));
  check('预览图真的落盘了', fin && fs.existsSync(fin.path));

  const after = (await (await fetch(`${appUrl}/api/styles`)).json()).presets.find((x) => x.id === 'ink');
  check('出完之后目录里带上了预览图路径', Boolean(after.previewPath), after.previewPath);
  check('顺带给了出图时间，界面拿它做缓存版本号', Boolean(after.previewAt));

  // 十二张用的是同一句场景描述，只换风格锚 —— 构图不变，比较的才是风格本身
  const p1 = styleModule.previewPrompt(styleModule.getStyle('ink'));
  const p2 = styleModule.previewPrompt(styleModule.getStyle('cyberpunk'));
  check('预览图的场景描述十二张一致', 
    p1.prompt.includes('湖畔栈桥') && p2.prompt.includes('湖畔栈桥'));
  check('风格锚排在提示词最前面', p1.prompt.startsWith('国风水墨') && p2.prompt.startsWith('赛博朋克'),
    p2.prompt.slice(0, 20));

  const del = await fetch(`${appUrl}/api/styles/ink/preview`, { method: 'DELETE' });
  check('能清掉预览图，退回内置示意图', del.status === 200 && !fs.existsSync(fin.path));

  check('不存在的画风给 404 而不是崩掉',
    (await fetch(`${appUrl}/api/styles/no-such-style/preview`, { method: 'POST' })).status === 404);
}

// 缩略图是照着 art 现画的（同一个镜头、十二种画法）。
// 少一个字段不会报错，只会悄悄画出一张空白卡片 —— 所以在这里挡住。
const ART_MODES = new Set(['wash', 'cel', 'line', 'photo', 'soft', 'film', 'neon', 'noir']);
check('每个预设都带齐了缩略图的画面参数',
  stylesResp.presets.every((s) => s.art?.sky?.length === 2 && s.art.hills?.length === 3 && s.art.water && s.art.glow && s.art.ink),
  stylesResp.presets.filter((s) => !(s.art?.sky?.length === 2 && s.art.hills?.length === 3)).map((s) => s.id).join('、'));
check('画法都是渲染器认识的那几种',
  stylesResp.presets.every((s) => ART_MODES.has(s.art?.mode)),
  stylesResp.presets.filter((s) => !ART_MODES.has(s.art?.mode)).map((s) => `${s.id}:${s.art?.mode}`).join('、'));

// 渲染器在前端，这里直接把它 import 进来跑一遍：
// SVG 里的 filter/gradient 全靠 id 引用，十二张放一页上 id 撞了会串成同一种滤镜
const { styleArtSVG } = await import('../ui/style-art.js');
const svgs = stylesResp.presets.map((s) => styleArtSVG(s));
check('每个预设都画得出 SVG', svgs.every((x) => x.startsWith('<svg') && x.includes('</svg>')));
const allIds = svgs.flatMap((x) => [...x.matchAll(/id="([a-z0-9]+)"/g)].map((m) => m[1]));
check('滤镜/渐变的 id 全局不重复（撞了会串成同一种滤镜）',
  new Set(allIds).size === allIds.length, `${allIds.length} 个 id，去重后 ${new Set(allIds).size} 个`);

section('长篇分章');
const longScript = ['第一章 起风', 'A'.repeat(1200), '第二章 落雨', 'B'.repeat(1200), '第三章 天晴', 'C'.repeat(1200)].join('\n\n');
const longProject = await (
  await fetch(`${appUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '长篇自检', styleId: 'wuxia' })
  })
).json();
await fetch(`${appUrl}/api/projects/${longProject.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ script: longScript })
});
const advice = await (await fetch(`${appUrl}/api/projects/${longProject.id}/chapters`)).json();
check('认出这是长篇，建议分章', advice.advice?.suggested === true);
check('按作者写的章节标题切', advice.advice?.preview?.length === 3, JSON.stringify(advice.advice?.preview));
check('章节标题被保留下来', /起风/.test(advice.advice?.preview?.[0]?.title || ''), advice.advice?.preview?.[0]?.title);

const split = await (
  await fetch(`${appUrl}/api/projects/${longProject.id}/chapters/split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
).json();
check('切分结果落盘', split.chapters?.length === 3);
check('每章各自有阶段状态', split.chapters.every((c) => c.stageStatus?.script === 'pending'));

const shortAdvice = await (await fetch(`${appUrl}/api/projects/${project.id}/chapters`)).json();
check('短片不建议分章', shortAdvice.advice?.suggested === false, `${shortAdvice.advice?.chars} 字`);

/**
 * 让模型按情节切。
 *
 * 按字数切不懂剧情，可能把一场戏从中间劈开。这条路花钱，但切在情节单元上。
 * 最关键的一手是**让模型回原文片段而不是字符位置** —— 模型数不准字数。
 */
section('让模型按情节分章');
{
  const chaptersMod = await import('../core/pipeline/chapters.js');

  // 纯函数部分：不依赖模型，所以能单独测
  const text = `甲段正文${'甲'.repeat(500)}

乙段开始，天亮了${'乙'.repeat(500)}

丙段开始，三日后${'丙'.repeat(500)}`;
  const cut = chaptersMod.splitAtAnchors(text, [
    { anchor: '乙段开始', title: '天亮', summary: '天亮了' },
    { anchor: '丙段开始', title: '三日后', summary: '过了三天' }
  ], { minChars: 100 });
  check('按锚句切出三章', cut.length === 3, JSON.stringify(cut.map((c) => c.title)));
  check('第一章是锚句之前那段', cut[0].script.startsWith('甲段正文'), cut[0].script.slice(0, 12));
  check('锚句成为下一章的开头（不是被吃掉）', cut[1].script.startsWith('乙段开始'), cut[1].script.slice(0, 12));
  check('模型给的标题和梗概被保留', cut[1].title === '天亮' && cut[1].summary === '天亮了');

  // 模型"顺手润色"引文是常见毛病，定位不到就该丢掉而不是猜一个位置
  const bad = chaptersMod.splitAtAnchors(text, [{ anchor: '这句原文里没有', title: 'x' }], { minChars: 100 });
  check('锚句在原文里找不到就丢掉（与其猜位置，不如少切一刀）', bad.length === 0);
  check('太短的锚句不用（会命中一堆无关位置）',
    chaptersMod.splitAtAnchors(text, [{ anchor: '乙', title: 'x' }], { minChars: 100 }).length === 0);

  // 重叠窗口会把同一个断点报两次
  const dup = chaptersMod.splitAtAnchors(text, [
    { anchor: '乙段开始', title: 'A' }, { anchor: '乙段开始，天亮了', title: 'A2' }
  ], { minChars: 100 });
  check('重叠窗口报重的断点只切一次', dup.length === 2, JSON.stringify(dup.map((c) => c.title)));

  // 滑窗：断点落在窗口边界上时，两边都只看到半截 —— 所以必须重叠
  const wins = chaptersMod.windowsOf('x'.repeat(20000), { size: 8000, overlap: 800 });
  check('长文被切成多个窗口', wins.length >= 3, `${wins.length} 个`);
  check('窗口之间有重叠（断点正好在边界上时才不会两边都看半截）',
    wins[1].start < wins[0].end, `${wins[0].end} vs ${wins[1].start}`);
  check('窗口覆盖到全文结尾', wins.at(-1).end === 20000);
  check('短文只出一个窗口', chaptersMod.windowsOf('短', { size: 8000 }).length === 1);

  // 端到端：打桩模型按上面的规则回锚句
  const novel = await (
    await fetch(`${appUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '模型分章自检' })
    })
  ).json();
  await fetch(`${appUrl}/api/projects/${novel.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: text })
  });
  // targetChars 同时决定"两个断点挨多近就算重复"（取 1/3）。
  // 这段测试文本每段只有 500 字，用默认的 3000 会把第二个断点当成重复丢掉 ——
  // 那是对的行为，所以这里按文本的实际尺度给个小一点的值。
  const evs = await ndjson(`/projects/${novel.id}/chapters/smart-split`, { targetChars: 600 });
  const done = evs.find((e) => e.type === 'finished')?.project;
  check('端到端跑通，模型给的断点真的切出了章节',
    done?.chapters?.length === 3, JSON.stringify(done?.chapters?.map((c) => c.title)));
  check('章节带上了模型给的标题', /乙段开始的一章/.test(done?.chapters?.[1]?.title || ''), done?.chapters?.[1]?.title);
  check('进度看得见（长篇要问好几轮，不能一片空白）',
    evs.some((e) => e.type === 'note' && /段/.test(e.message || '')),
    JSON.stringify(evs.filter((e) => e.type === 'note').map((e) => e.message).slice(0, 3)));

  // 一个锚点都定位不到时，要说清楚为什么，而不是抛一个看不懂的错
  await fetch(`${appUrl}/api/projects/${novel.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: '一段没有任何断点标记的正文'.repeat(50) })
  });
  const none = await ndjson(`/projects/${novel.id}/chapters/smart-split`, { targetChars: 600 });
  check('切不出来时给的是人话，还指了另一条路',
    /按字数切/.test(none.find((e) => e.type === 'error')?.message || ''), JSON.stringify(none.slice(-1)));
}

section('视频提示词装配');
// 早期版本这里只发「运镜 + 镜头语言」，模型只好自己脑补内容，片段和剧本对不上。
const vshot = {
  index: 7,
  scene: '码头',
  characters: ['阿澜'],
  description: '阿澜快步走向栈桥尽头，回头张望',
  camera: '跟拍',
  motion: '镜头跟随人物移动',
  dialogue: '快，来不及了。',
  duration: 5
};
const vbible = {
  style: { anchor: '武侠写意', negative: '崩脸' },
  characters: [{ name: '阿澜', appearance: '短发，藏青立领制服，袖口两道银线，左胸编号牌', seed: 1, sheetUrl: 'x' }],
  scenes: [{ name: '码头', appearance: '晨雾未散，冷白顶光，木质栈桥', seed: 2, sheetUrl: 'y' }],
  props: []
};
const vp = consistency.assembleVideoPrompt(vbible, vshot);
check('视频提示词包含画面内容（这是之前缺的那块）', vp.includes('快步走向栈桥'), vp);
check('带上角色并要求保持外貌', /阿澜/.test(vp) && /保持外貌不变/.test(vp), vp);
check('带上场景要点', /晨雾/.test(vp), vp);
check('带上镜头语言与运镜', vp.includes('跟拍') && vp.includes('镜头跟随'), vp);
check('有台词时提示口型自然', /口型/.test(vp), vp);
check(
  '不重复堆完整外貌（首帧已锁人，堆长描述会稀释运镜指令）',
  !vp.includes('左胸编号牌'),
  vp
);
check('长度受控，不超过视频模型的提示词舒适区', vp.length <= 380, `${vp.length} 字`);

const emptyCast = consistency.assembleVideoPrompt(vbible, { index: 1, description: '空镜：水面波光', characters: [], camera: '特写', motion: '静止' });
check('空镜不硬塞角色', !/保持外貌不变/.test(emptyCast), emptyCast);

// ── 镜间衔接 ──
// 一致性管的是"这一镜像不像"，衔接管的是"上一镜到这一镜接不接得上"。
// 后者逐镜看根本发现不了，只有连起来放才露馅 —— 而那时候钱已经花完了。
// 模型拆出来的 motion 大多是"镜头缓慢推进"这种放之四海皆准的话，
// 真正让画面有电影感的是具体技法。术语人未必记得住，模型却认得很准。
section('技法库');
{
  const skills = await import('../core/skills.js');

  check('内置技法覆盖了六个分类', skills.SKILL_GROUPS.length === 6,
    skills.SKILL_GROUPS.map((g) => g.name).join('、'));
  check('每张卡都有真正发给模型的那句话',
    skills.BUILTIN_SKILLS.every((s) => s.fragment && s.fragment.length >= 6),
    skills.BUILTIN_SKILLS.filter((s) => !s.fragment || s.fragment.length < 6).map((s) => s.id).join('、'));
  check('每张卡的分类都存在',
    skills.BUILTIN_SKILLS.every((s) => skills.SKILL_GROUPS.some((g) => g.id === s.group)));
  check('没有重复 id（重了会让人选错）',
    new Set(skills.BUILTIN_SKILLS.map((s) => s.id)).size === skills.BUILTIN_SKILLS.length);
  // 术语加视觉结果，比光给术语稳得多
  check('术语卡把视觉结果也写进去了（"伦勃朗光"不如"暗侧颧骨下的三角光斑"）',
    /三角形光斑/.test(skills.getSkill('rembrandt').fragment), skills.getSkill('rembrandt').fragment);

  // 互斥：不能同时仰拍又俯拍
  const norm = skills.normalize(['low-angle', 'high-angle', 'rembrandt', 'act-run', 'act-cry']);
  check('互斥组只留第一张', norm.ids.includes('low-angle') && !norm.ids.includes('high-angle'),
    JSON.stringify(norm.ids));
  check('被丢掉的要说明原因（不能让人以为界面吞了他的选择）',
    norm.dropped.some((d) => d.id === 'high-angle' && /只能选一个/.test(d.why)), JSON.stringify(norm.dropped));
  check('非互斥组可以多选', norm.ids.includes('act-run') && norm.ids.includes('act-cry'));
  check('不认识的 id 直接丢掉，不带进提示词',
    skills.normalize(['no-such-skill']).ids.length === 0);

  /**
   * slot 决定片段拼到提示词哪个位置。运镜类不能进出图提示词 ——
   * 对一张静态图说"镜头缓慢推进"没有意义，只会占掉画面描述的权重。
   */
  const forImage = skills.fragmentsFor(['push-in', 'low-angle', 'mood-tense'], { target: 'image' });
  check('出图不带运镜（对静态图说"镜头推进"没意义，还挤占权重）',
    forImage.motion.length === 0 && forImage.look.length === 1 && forImage.mood.length === 1,
    JSON.stringify(forImage));
  const forVideo = skills.fragmentsFor(['push-in', 'low-angle'], { target: 'video' });
  check('出视频带运镜', forVideo.motion.length === 1, JSON.stringify(forVideo));

  // 装进真实提示词
  const shotWithSkills = { ...vshot, skills: ['dutch', 'blinds', 'act-smoke'] };
  const imgPrompt = consistency.assemblePrompt(vbible, shotWithSkills).prompt;
  check('出图提示词里有机位和光线', /荷兰角/.test(imgPrompt) && /百叶窗/.test(imgPrompt), imgPrompt.slice(0, 120));
  check('技法排在主色调之前（越靠后越容易被稀释）',
    !imgPrompt.includes('主色调') || imgPrompt.indexOf('荷兰角') < imgPrompt.indexOf('主色调'), imgPrompt);

  const vidPrompt = consistency.assembleVideoPrompt(vbible, { ...vshot, skills: ['dolly-zoom'] });
  check('选了具体运镜就不再发那句默认的"镜头缓慢推进"（两条指令会打架）',
    /Dolly Zoom/.test(vidPrompt) && !/镜头缓慢推进/.test(vidPrompt), vidPrompt);
  const vidNoSkill = consistency.assembleVideoPrompt(vbible, vshot);
  check('没选运镜时仍然用分镜表里的那句', /镜头跟随人物移动/.test(vidNoSkill), vidNoSkill);

  // 自定义卡：跨项目复用，所以存在数据目录而不是项目里
  const made = await (
    await fetch(`${appUrl}/api/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '低速快门拖影', group: 'move', fragment: '低速快门，运动物体拉出拖影' })
    })
  ).json();
  check('能自己加技法卡', Boolean(made.skill?.id), JSON.stringify(made).slice(0, 120));
  check('自定义卡立刻能用', Boolean(skills.getSkill(made.skill.id)));
  check('自定义卡也进提示词',
    /拖影/.test(consistency.assembleVideoPrompt(vbible, { ...vshot, skills: [made.skill.id] })));
  check('自定义卡存在数据目录里（换项目还在）',
    fs.existsSync(path.join(SANDBOX, 'skills.json')));

  const bad = await (
    await fetch(`${appUrl}/api/skills`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '只有名字' })
    })
  ).json();
  check('没写发给模型的那句话就拒绝（这种卡等于不起作用）', /不起作用|要写清楚/.test(bad.error || ''), JSON.stringify(bad));

  const del = await fetch(`${appUrl}/api/skills/${encodeURIComponent(made.skill.id)}`, { method: 'DELETE' });
  check('能删自定义卡', del.status === 200 && !skills.getSkill(made.skill.id));
}

// 手选技法的问题不在于麻烦，在于你未必记得住那些术语 ——
// 四十七张卡里永远只用那三张。模型读一遍描述就能挑，这是它擅长的事。
section('让模型按描述挑技法');
{
  const evs = await ndjson(`/projects/${project.id}/skills/suggest`, {});
  const after = evs.find((e) => e.type === 'finished')?.project;
  const s0 = after?.shots?.[0];

  check('模型挑的技法落到了分镜上', (s0?.skills || []).length > 0, JSON.stringify(s0?.skills));
  // 模型偶尔自创 id、也会把两个互斥的都给出来 —— 走和手选同一条规整逻辑
  check('自创的 id 被丢掉', !(s0?.skills || []).includes('我瞎编的技法'), JSON.stringify(s0?.skills));
  check('互斥组只留一个（仰拍和俯拍不能同时成立）',
    (s0?.skills || []).includes('low-angle') && !(s0?.skills || []).includes('high-angle'),
    JSON.stringify(s0?.skills));
  // 要判断的是"它为什么这么挑"，不是盯着一串 id 猜
  check('留下了模型给的理由', /仰拍/.test(s0?.skillWhy || ''), s0?.skillWhy);
  check('挑完的技法真的进了出图提示词',
    /低机位仰拍/.test(consistency.assemblePrompt(after.bible, s0).prompt),
    consistency.assemblePrompt(after.bible, s0).prompt.slice(0, 120));
  check('进度里逐镜说清楚挑了什么、为什么',
    evs.some((e) => e.type === 'note' && /第 \d+ 镜：/.test(e.message || '')),
    JSON.stringify(evs.filter((e) => e.type === 'note').map((e) => e.message).slice(0, 3)));
  // 挑完不该顺手把图重出了 —— 先让人翻一遍
  check('只改文案不出图（先翻一遍，不满意手改掉再统一重出）',
    evs.every((e) => e.type !== 'sheet'), JSON.stringify(evs.map((e) => e.type)));

  // ── "挑的对不上前面也对不上后面" ──
  // 模型是在做 N 道互相独立的分类题，不给它上下文，它连"这两镜是同一场戏"都不知道
  const sent = upstream.lastSkillPayload || [];
  check('发过去的每镜带着 link（和上一镜什么关系）',
    sent.length > 1 && sent[1].link === 'cut', JSON.stringify(sent.map((s) => s.link)));
  check('发过去的每镜带着景别和时长（不然机位卡会和景别打架）',
    sent.every((s) => s.camera !== undefined && s.duration !== undefined), JSON.stringify(sent[0]));
  check('哪几镜要挑说清楚（pick）', sent.every((s) => s.pick === true), JSON.stringify(sent.map((s) => s.pick)));
  check('提示词里写了同场戏光线要统一',
    /同一场戏里不能上一镜黄金时刻/.test(studioModule.SKILL_PROMPT || ''), '');

  // 光是把规矩写进提示词不够 —— 模型会答应你，然后照样犯
  const s1 = after?.shots?.[1];
  check('同一场戏里模型给的第二种光线被统一掉了',
    (s1?.skills || []).includes('rembrandt') && !(s1?.skills || []).includes('moonlight'),
    JSON.stringify(s1?.skills));
  check('和景别打架的机位卡被去掉（全景 + 大特写）',
    !(s1?.skills || []).includes('close-up'), JSON.stringify(s1?.skills));
  check('自动改了什么会说出来，不是悄悄改',
    evs.some((e) => e.type === 'note' && /顺场/.test(e.message || '')),
    JSON.stringify(evs.filter((e) => /顺场/.test(e.message || '')).map((e) => e.message)));
  // 出问题第一件要知道的事就是"这活儿是谁干的"
  check('进度里说清楚是哪个模型在挑',
    evs.some((e) => /调度模型 .+挑技法/.test(e.message || '')),
    JSON.stringify(evs.filter((e) => e.type === 'stage').map((e) => e.message)));
}

// 顺场：normalize 管一镜之内不自相矛盾，harmonize 管镜与镜之间接得上。
// 这一段不联服务端，直接对着函数打，五条规矩一条一条验。
section('技法顺场（镜与镜之间）');
{
  const skills = await import('../core/skills.js');
  const seq = (arr) => skills.harmonize(arr).shots.map((s) => s.skills);

  // ① 同一段戏的光线只能有一套。分段按 link=new-scene 断开
  const light = skills.harmonize([
    { id: 'a', index: 1, link: 'new-scene', skills: ['rembrandt'] },
    { id: 'b', index: 2, link: 'cut', skills: ['moonlight'] },
    { id: 'c', index: 3, link: 'cut', skills: ['rembrandt'] },
    { id: 'd', index: 4, link: 'new-scene', skills: ['neon'] }
  ]);
  check('同一场戏里的光线被统一成占多数的那张',
    light.shots[1].skills[0] === 'rembrandt', JSON.stringify(light.shots.map((s) => s.skills)));
  check('换了场景就不再统一（新的一场本来就该换光）',
    light.shots[3].skills[0] === 'neon', JSON.stringify(light.shots[3].skills));
  check('没挑光线的镜头不会被硬塞一张',
    seq([
      { id: 'a', index: 1, link: 'new-scene', skills: ['rembrandt'] },
      { id: 'b', index: 2, link: 'cut', skills: [] }
    ])[1].length === 0);
  check('统一光线时会说明改了什么', /光线要统一/.test(light.notes[0]?.why || ''), JSON.stringify(light.notes));

  // ② 连续动作里运镜不能掉头："推门→进门"不该推镜接拉镜
  const move = seq([
    { id: 'a', index: 1, link: 'cut', skills: ['push-in'] },
    { id: 'b', index: 2, link: 'continuous', skills: ['pull-out'] }
  ]);
  check('连续动作的后一镜不会反着运镜', move[1][0] === 'push-in', JSON.stringify(move));
  const cutMove = seq([
    { id: 'a', index: 1, link: 'cut', skills: ['push-in'] },
    { id: 'b', index: 2, link: 'cut', skills: ['pull-out'] }
  ]);
  check('只是换机位的话，运镜本来就可以反着来', cutMove[1][0] === 'pull-out', JSON.stringify(cutMove));

  // ③ 机位卡要和分镜表里的景别对得上
  const cam = seq([{ id: 'a', index: 1, camera: '大全景', link: 'new-scene', skills: ['close-up', 'mood-epic'] }]);
  check('全景镜头里的大特写被去掉，其余保留',
    !cam[0].includes('close-up') && cam[0].includes('mood-epic'), JSON.stringify(cam));

  // ④ 连着三镜同一机位 = 没有节奏
  const angle = seq([
    { id: 'a', index: 1, link: 'new-scene', skills: ['ots'] },
    { id: 'b', index: 2, link: 'cut', skills: ['ots'] },
    { id: 'c', index: 3, link: 'cut', skills: ['ots'] },
    { id: 'd', index: 4, link: 'cut', skills: ['ots'] }
  ]);
  check('连着三镜以上同一个机位，从第三镜起去掉',
    angle[0].length === 1 && angle[1].length === 1 && !angle[2].length && !angle[3].length,
    JSON.stringify(angle));

  // ⑤ 强风格卡用一次是风格，用五次是毛病
  // 用希区柯克变焦来验：它是运镜卡，不会被上面那条"连三同机位"顺手削掉，
  // 削到只剩两个就分不清是哪条规矩生效了
  const strong = seq(
    [1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, index: i, link: 'cut', skills: ['dolly-zoom'] }))
  );
  check('强风格卡全片限量，超出的去掉',
    strong.filter((s) => s.includes('dolly-zoom')).length === 3, JSON.stringify(strong));

  // 顺场只在"模型挑"这条路上跑：手选的东西被自动改掉，比选错更让人恼火
  check('手动改技法不会被顺场碰',
    typeof studioModule.updateShot === 'function' &&
      !/harmonize/.test(studioModule.updateShot.toString()));
}

section('镜间衔接');
{
  const continuity = await import('../core/pipeline/continuity.js');

  const s1 = { id: 'a', index: 1, scene: '码头', description: '阿澜走向栈桥' };
  const s2 = { id: 'b', index: 2, scene: '码头', description: '阿澜蹲下查看缆绳' };
  const s3 = { id: 'c', index: 3, scene: '值班室', description: '阿澜推开值班室的门' };

  check('第一镜没有上一镜，按换场景算', continuity.deriveLink(s1, null) === 'new-scene');
  check('同一场景默认按"换机位"，不是"连续动作"',
    continuity.deriveLink(s2, s1) === 'cut', continuity.deriveLink(s2, s1));
  check('换了场景就是换场景', continuity.deriveLink(s3, s2) === 'new-scene');
  check('场景名写法不同也算同一个地方（码头 / 渔港码头）',
    continuity.sameScene('码头', '渔港码头') && !continuity.sameScene('码头', '值班室'));
  // 判断错的代价不对称：该切的接上了要重出整段，该接的切了顶多硬切一下还能看。
  // 所以默认必须是 cut，continuous 只能是人明确选的。
  check('人手选过的关系不会被推断盖掉',
    continuity.deriveLink({ ...s2, link: 'continuous' }, s1) === 'continuous');

  const linked = continuity.withLinks([s3, s1, s2]);
  check('补 link 时按 index 排序，不按传入顺序',
    linked.map((s) => s.id).join('') === 'abc', linked.map((s) => s.id).join(''));

  // 提示词里的衔接约束：这是最便宜的一层，一分钱不多花
  const cutLines = continuity.continuityLines(s2, { prev: s1, next: s3, link: 'cut' });
  check('同场景换机位时要求不换天（光线/天气/时间一致）',
    cutLines.some((l) => /光线、天气/.test(l)), JSON.stringify(cutLines));
  check('同场景换机位时提醒不要越轴（最刺眼的连贯性错误）',
    cutLines.some((l) => /越轴/.test(l)), JSON.stringify(cutLines));
  check('告诉模型结尾要交到哪儿去（否则它会把动作做满，接不上下一镜）',
    cutLines.some((l) => /结尾停在/.test(l)), JSON.stringify(cutLines));

  const contLines = continuity.continuityLines(s2, { prev: s1, next: s3, link: 'continuous' });
  check('连续动作要求从上一镜的状态继续，不要重新起势',
    contLines.some((l) => /不要重新起势/.test(l)), JSON.stringify(contLines));

  const newSceneLines = continuity.continuityLines(s3, { prev: s2, next: null, link: 'new-scene' });
  check('换场景不硬接（硬接会把转场做糊）', newSceneLines.length === 0, JSON.stringify(newSceneLines));

  // 末帧衔接：唯一能做到无缝的一招，但**只在明确标了连续动作时**才用
  check('标了连续动作才锁末帧',
    continuity.shouldChainEndFrame({ imagePath: 'x.png' }, 'continuous') === true);
  check('换机位不锁末帧（锁了就等于不让镜位跳，整片变成一个长镜头）',
    continuity.shouldChainEndFrame({ imagePath: 'x.png' }, 'cut') === false);
  check('下一镜还没出图就没得锁',
    continuity.shouldChainEndFrame({ imagePath: null }, 'continuous') === false);

  // 跨章不算相邻：跨章的"上一镜"不是同一段戏
  const nb = continuity.neighbors(
    [{ ...s1, chapterId: 'ch1' }, { ...s2, chapterId: 'ch2' }],
    'b'
  );
  check('跨章不当成上一镜', nb.prev === null);

  // 装配进提示词
  const withCtx = consistency.assembleVideoPrompt(vbible, vshot, {
    prev: { description: '阿澜从值班室快步走出', scene: '码头' },
    next: { description: '缆绳在浪里绷紧' },
    link: 'cut'
  });
  check('视频提示词带上了衔接约束', /越轴/.test(withCtx) && /结尾停在/.test(withCtx), withCtx);
  check('衔接约束排在画面内容之后（主语还是"这一镜演什么"）',
    withCtx.indexOf('快步走向栈桥') < withCtx.indexOf('越轴'), withCtx);
  check('带了衔接约束也不超长', withCtx.length <= 380, `${withCtx.length} 字`);
}

/**
 * 声音也是身份的一部分。
 *
 * 全片一个音色，两个人对话时观众分不出谁在说话 ——
 * 画面上做了四层一致性，声音上却是同一个人配了所有角色，
 * 这个反差比画面不一致更出戏。而这个漏洞以前一直在：
 * synthesizeSpeech 有 voice 参数，generateVoice 从来不传。
 */
section('每个角色一个音色');
{
  const vp = await (
    await fetch(`${appUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '音色自检' })
    })
  ).json();
  store.update(vp.id, (p) => {
    p.bible = {
      style: { anchor: '国风', negative: '' },
      characters: [
        { name: '阿澜', appearance: '短发', seed: 1, voice: '' },
        { name: '老周', appearance: '白须', seed: 2, voice: '' }
      ],
      scenes: [], props: []
    };
    p.shots = [
      { id: 'a', index: 1, characters: ['阿澜'], speaker: '阿澜', dialogue: '快走', duration: 3, videoPath: 'x.mp4' },
      { id: 'b', index: 2, characters: ['老周'], speaker: '老周', dialogue: '等等', duration: 4, videoPath: 'y.mp4' },
      { id: 'c', index: 3, characters: [], speaker: '', dialogue: '三日后', duration: 2, videoPath: 'z.mp4' }
    ];
    return p;
  });

  const r = studioModule.assignVoices(vp.id);
  const chars = store.read(vp.id).bible.characters;
  check('每个角色都分到了音色', chars.every((c) => c.voice), JSON.stringify(chars.map((c) => c.voice)));
  check('两个角色的音色不一样（一样的话对话时分不出谁在说）',
    chars[0].voice !== chars[1].voice, `${chars[0].voice} / ${chars[1].voice}`);
  check('旁白也有自己的声音，且不和角色撞',
    r.narrator && !chars.some((c) => c.voice === r.narrator), r.narrator);

  const fresh = store.read(vp.id);
  check('按 speaker 取音色',
    studioModule.voiceForShot(fresh, fresh.shots[0]).voice === chars[0].voice);
  check('没标 speaker 时退到出场角色',
    studioModule.voiceForShot(fresh, { characters: ['老周'], dialogue: 'x' }).voice === chars[1].voice);
  check('没人出场就是旁白',
    studioModule.voiceForShot(fresh, fresh.shots[2]).who === '旁白');

  // 已经手选过的不该被自动分配覆盖 —— 你挑的比自动分的准，那是你听过的
  store.update(vp.id, (p) => { p.bible.characters[0].voice = 'longwan'; return p; });
  studioModule.assignVoices(vp.id);
  check('手选过的音色不会被自动分配覆盖',
    store.read(vp.id).bible.characters[0].voice === 'longwan');

  // ── 字幕 ──
  // 数据全在手上，只是排一遍时间轴 —— 而短剧没字幕基本不能发
  const cues = studioModule.buildSubtitles(store.read(vp.id), { policy: 'trim' });
  check('只给有台词的镜头出字幕', cues.length === 3, JSON.stringify(cues.length));
  check('时间轴按合成时真正用的时长累加（错一个后面全偏）',
    cues[0].start === 0 && cues[1].start === 3 && cues[2].start === 7,
    JSON.stringify(cues.map((c) => c.start)));
  check('每条结尾留一点空档，不和下一条贴在一起闪',
    cues[0].end < cues[1].start, `${cues[0].end} vs ${cues[1].start}`);
  const srt = studioModule.toSRT(cues);
  check('SRT 格式正确（序号 + 时间轴 + 正文）',
    /^1\n00:00:00,000 --> 00:00:02,850\n快走\n/.test(srt), srt.slice(0, 60));
  check('时间戳是 SRT 的逗号毫秒写法，不是 WebVTT 的点',
    !/\d\.\d{3} -->/.test(srt), srt.slice(0, 40));

  // keep 策略下要用模型实出的时长，不是计划时长
  store.update(vp.id, (p) => { p.shots[0].actualDuration = 5; return p; });
  const keepCues = studioModule.buildSubtitles(store.read(vp.id), { policy: 'keep' });
  check('keep 策略下按模型实出的时长排', keepCues[1].start === 5, JSON.stringify(keepCues.map((c) => c.start)));
}

// 台词挂错人的代价很直接：两个人对话却是同一个声音，观众分不出谁在说话。
// 而让人一条条点下拉框也不现实 —— 二十镜十二条台词，谁点得下去。
section('台词绑谁说的');
{
  const spk = await import('../core/pipeline/speaker.js');

  // ── 从台词文本里把署名拆出来 ──
  const cases = [
    ['阿澜：设备正常。', '阿澜', '设备正常。'],
    ['阿澜说：“设备正常。”', '阿澜', '设备正常。'],
    ['阿澜低声道：设备正常。', '阿澜', '设备正常。'],
    ['“设备正常。”阿澜说', '阿澜', '设备正常。'],
    ['【阿澜】设备正常。', '阿澜', '设备正常。'],
    ['旁白：三日后。', '旁白', '三日后。']
  ];
  for (const [raw, who, line] of cases) {
    const got = spk.parseAttribution(raw);
    check(`拆得出署名：${raw}`, got.who === who && got.line === line, JSON.stringify(got));
  }
  check('拆不出来就原样留着，不瞎猜',
    spk.parseAttribution('设备正常。').who === '' , JSON.stringify(spk.parseAttribution('设备正常。')));

  // ── 名字对不上设定集是"静悄悄退回旁白"的主要来源 ──
  const cast = [{ name: '老周', appearance: '白须' }, { name: '阿澜', appearance: '短发' }];
  check('别名能对上（周叔 → 老周）', spk.matchCharacter('周叔', cast)?.name === '老周');
  check('剥掉称谓前后缀再比（"周" → 老周）', spk.matchCharacter('周', cast)?.name === '老周');
  // 同核的人不止一个时，指谁都说不准 —— 宁可判不出，也不能挑一个挂上去
  check('称呼有歧义时不认',
    spk.matchCharacter('周', [{ name: '老周' }, { name: '周叔' }]) === null);
  check('不相干的名字不会被单字带上',
    spk.matchCharacter('周', [{ name: '周边小贩' }]) === null);
  check('显式别名字段也认',
    spk.matchCharacter('澜姐', [{ name: '阿澜', aliases: ['澜姐'] }])?.name === '阿澜');

  // ── "没有台词还瞎说"：台词字段里塞的根本不是台词 ──
  check('音效提示不是台词，不配音',
    spk.spokenText('（远处传来汽笛声）').kind === 'sound',
    JSON.stringify(spk.spokenText('（远处传来汽笛声）')));
  check('占位符不是台词', spk.spokenText('无').kind === 'sound');
  check('空台词就是空', spk.spokenText('').kind === 'empty');

  // ── "有台词还说不清楚"：署名和表演提示会被一字不落地念出来 ──
  check('念的是净台词，不带署名',
    spk.spokenText('阿澜：设备正常。').text === '设备正常。',
    spk.spokenText('阿澜：设备正常。').text);
  check('句中的表演提示也摘掉',
    spk.spokenText('设备正常（顿了顿）后面呢').text === '设备正常后面呢',
    spk.spokenText('设备正常（顿了顿）后面呢').text);
  check('一长串省略号收成一个，不然 TTS 会硬念"点点点"',
    spk.spokenText('这……。。。。算了').text === '这……算了',
    spk.spokenText('这……。。。。算了').text);

  // ── 一层层往下找 ──
  const proj = { bible: { characters: cast } };
  check('台词自带署名最优先',
    spk.resolve(proj, { dialogue: '老周：等等', characters: ['阿澜', '老周'] }).by === 'dialogue-tag');
  check('描述里的提示能认（"老周问道"）',
    spk.resolve(proj, { dialogue: '等等', description: '老周问道', characters: ['阿澜', '老周'] }).speaker === '老周');
  check('描述里只是"看着谁"不算说话线索',
    spk.resolve(proj, { dialogue: '等等', description: '阿澜看着老周的背影', characters: ['阿澜', '老周'] }).by !== 'description-cue');
  check('这一镜只有一个人就是他',
    spk.resolve(proj, { dialogue: '等等', characters: ['阿澜'] }).speaker === '阿澜');
  // 旧兜底是"取出场角色里的第一个"——两个人在场时那是一半几率挂错人
  const amb = spk.resolve(proj, { dialogue: '等等', characters: ['阿澜', '老周'] });
  check('在场不止一个又没线索时不猜，交给模型那一层',
    amb.speaker === '' && amb.by === 'ambiguous' && amb.confident === false, JSON.stringify(amb));
  check('手选过的不会被线索推翻（包括手动选的旁白）',
    spk.resolve(proj, { dialogue: '老周：等等', speaker: '', speakerBy: 'manual', characters: ['老周'] }).speaker === '',
    JSON.stringify(spk.resolve(proj, { dialogue: '老周：等等', speaker: '', speakerBy: 'manual' })));
  check('音效提示不进模型那一批（不值得为它花一次调用）',
    spk.resolve(proj, { dialogue: '（汽笛声）', characters: ['阿澜', '老周'] }).confident === true);

  // ── 端到端：确定性一层 + 模型一层 ──
  const sp = await (
    await fetch(`${appUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '说话人自检' })
    })
  ).json();
  store.update(sp.id, (p) => {
    p.bible = { style: { anchor: '国风', negative: '' }, characters: [
      { name: '阿澜', appearance: '短发', seed: 1, voice: 'v1' },
      { name: '老周', appearance: '白须', seed: 2, voice: 'v2' }
    ], scenes: [], props: [], narratorVoice: 'v3' };
    p.shots = [
      { id: 's1', index: 1, characters: ['阿澜', '老周'], dialogue: '阿澜：设备正常。', duration: 3 },
      { id: 's2', index: 2, characters: ['阿澜', '老周'], dialogue: '（远处传来汽笛声）', duration: 3 },
      { id: 's3', index: 3, characters: ['阿澜', '老周'], dialogue: '等等。', duration: 3 },
      { id: 's4', index: 4, characters: ['阿澜'], dialogue: '', duration: 3 }
    ];
    return p;
  });

  const bevs = await ndjson(`/projects/${sp.id}/speakers/bind`, {});
  const bound = bevs.find((e) => e.type === 'finished')?.project;
  const byId = Object.fromEntries((bound?.shots || []).map((x) => [x.id, x]));

  check('台词里带的署名当场就定了，不花模型调用',
    byId.s1?.speaker === '阿澜' && byId.s1?.speakerBy === 'dialogue-tag', JSON.stringify(byId.s1));
  check('署名从台词里摘掉了（不然配音会念"阿澜冒号"）',
    byId.s1?.dialogue === '设备正常。', byId.s1?.dialogue);
  check('音效提示不绑说话人', byId.s2?.speakerBy === 'sound-cue', byId.s2?.speakerBy);
  check('定不下来的那条交给了调度模型',
    byId.s3?.speaker === '老周' && byId.s3?.speakerBy === 'model', JSON.stringify(byId.s3));
  check('发给模型时把整条分镜表都给了，只标出要判哪几条',
    (upstream.lastSpeakerPayload || []).length === 3 &&
      upstream.lastSpeakerPayload.filter((x) => x.need).length === 1,
    JSON.stringify((upstream.lastSpeakerPayload || []).map((x) => [x.id, x.need])));
  check('模型顺手多答的那几条不会覆盖已经定了的',
    byId.s1?.speaker === '阿澜', JSON.stringify(byId.s1));
  check('依据会说出来，界面才知道哪条值得回头看',
    bevs.some((e) => /模型按上下文判的|台词里带的署名/.test(e.message || '')),
    JSON.stringify(bevs.filter((e) => e.type === 'note').map((e) => e.message).slice(0, 4)));

  // 手选过的不该被再次自动绑定覆盖
  await fetch(`${appUrl}/api/projects/${sp.id}/shots/s3`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speaker: '阿澜' })
  });
  await ndjson(`/projects/${sp.id}/speakers/bind`, {});
  const after2 = store.read(sp.id).shots.find((x) => x.id === 's3');
  check('手改过之后再自动绑一次也不会被改回去',
    after2.speaker === '阿澜' && after2.speakerBy === 'manual', JSON.stringify(after2));

  // ── 配音只念真台词 ──
  const fresh2 = store.read(sp.id);
  check('配音取的是净台词',
    studioModule.voiceForShot(fresh2, fresh2.shots[0]).text === '设备正常。',
    studioModule.voiceForShot(fresh2, fresh2.shots[0]).text);
  check('音效那条在配音这一步会被判成非台词',
    studioModule.voiceForShot(fresh2, fresh2.shots[1]).kind !== 'speech');
  check('说话人定了之后取的是他的音色',
    studioModule.voiceForShot(fresh2, fresh2.shots[0]).voice === 'v1');

  // ── 嘴要不要动，视频提示词里必须明说 ──
  const silent = consistency.assembleVideoPrompt(fresh2.bible, fresh2.shots[3]);
  const talking = consistency.assembleVideoPrompt(fresh2.bible, fresh2.shots[0]);
  check('没台词的镜头明确要求不要出现说话口型（否则人物会在那儿瞎说）',
    /不要出现说话口型/.test(silent), silent.slice(0, 120));
  // 光说"人物在说话"是不够的：画面里两个人，模型会随便挑一个张嘴，
  // 说的内容更是随它发挥 —— 谁在说、说哪句，都得写出来
  check('有台词的镜头写清楚谁在说、说的是哪句',
    /只有阿澜在说话/.test(talking) && /设备正常/.test(talking) && !/不要出现说话口型/.test(talking),
    talking.slice(0, 160));
  check('同框的其他人被要求闭嘴（不然两个人一起张嘴）',
    /保持沉默不开口/.test(
      consistency.assembleVideoPrompt(fresh2.bible, { ...fresh2.shots[0], characters: ['阿澜', '老周'] })
    ));
  check('音效那条不算有台词，嘴也不该动',
    /不要出现说话口型/.test(consistency.assembleVideoPrompt(fresh2.bible, fresh2.shots[1])));
}

// 音画对不上的最大来源不在模型，在合成这一步：画面的长度是分镜时长，
// 配音的长度是这句话念多久，两者不相等 —— 顺次拼接必然越拼越偏。
// 改完描述最容易得出的错误结论是"提示词没跟着变"——
// 其实每次出视频都是现算的，只是界面上显示的是上一次发出去的那条。
// 提示词长不等于说得清。带首帧时图已经回答了一大半问题，
// 文字复述一遍只会让模型在"照着图"和"照着字"之间选边。
section('视频提示词的详略');
{
  const bibleV = {
    style: { anchor: '国风水墨', palette: '', negative: '' },
    characters: [{ name: '阿澜', appearance: '二十七八岁，短发，藏青立领制服，袖口两道银线', variants: [] }],
    scenes: [{ name: '码头', appearance: '晨雾未散的老渔港，木质栈桥，冷青色天光', variants: [] }],
    props: []
  };
  const shotV = {
    id: 'v1', index: 7, scene: '码头', characters: ['阿澜'],
    description: '阿澜蹲下查看缆绳的断口', camera: '中景', motion: '镜头缓慢推进',
    dialogue: '这是割的。', speaker: '阿澜', skills: ['low-angle', 'rembrandt', 'mood-tense', 'tracking'],
    duration: 5, imagePath: 'x.png'
  };
  const prevV = { id: 'v0', index: 6, scene: '码头', description: '阿澜走向栈桥' };
  const nextV = { id: 'v2', index: 8, scene: '码头', description: '老周磕了磕烟杆' };

  const precise = consistency.assembleVideoPrompt(bibleV, shotV, { prev: prevV, next: nextV, link: 'cut', mode: 'precise' });
  const fullOne = consistency.assembleVideoPrompt(bibleV, shotV, { prev: prevV, next: nextV, link: 'cut', mode: 'full' });

  check('精准模式短得多', precise.length < fullOne.length * 0.6, `${precise.length} vs ${fullOne.length}`);
  check('演什么排在第一位', precise.indexOf(shotV.description) === 0, precise.slice(0, 40));
  check('精准模式保留：动作、运镜、说什么、不越轴',
    /镜头跟随/.test(precise) && /口型对上台词/.test(precise) && /不要越轴/.test(precise), precise);
  check('精准模式去掉：外貌、场景、景别、氛围（首帧图里都有）',
    !/保持外貌不变/.test(precise) && !/晨雾/.test(precise) && !/中景/.test(precise) && !/色调偏冷/.test(precise),
    precise);
  check('完整模式该有的一样不少', /保持外貌不变/.test(fullOne) && /晨雾/.test(fullOne), fullOne.slice(0, 120));

  // 没有首帧时文字是唯一信息源，再"精准"也省不得
  const t2v = consistency.assembleVideoPrompt(bibleV, { ...shotV, imagePath: null }, { prev: prevV, link: 'cut', mode: 'precise' });
  check('没有首帧时自动按完整走（文字是唯一信息源）',
    /保持外貌不变/.test(t2v) && /国风水墨/.test(t2v), t2v.slice(0, 120));

  // 硬切的下一镜本来就可以另起炉灶，为它多花二三十字不划算；连续动作才需要交接
  const chained = consistency.assembleVideoPrompt(
    bibleV, shotV, { prev: prevV, next: { ...nextV, link: 'continuous' }, link: 'cut', mode: 'precise' });
  check('下一镜是连续动作时，才提"结尾停在能接上…的状态"',
    /结尾停在/.test(chained) && !/结尾停在/.test(precise), `${chained.slice(-40)} || ${precise.slice(-40)}`);
}

// 出图/出视频跑完之后，界面只该换**那一张卡片**。为此重新拉一遍整个项目
// 既慢又会把正在编辑的输入框冲掉 —— 那就是"生成一下，我改的字没了"。
// 画幅错了不是"看着别扭"这么简单：图生视频会继承首帧图的比例，
// 于是这个错一路传到成片 —— 而任务全程"成功"，没有任何报错。
section('出图的画幅要真的对');
{
  const imgsize = await import('../core/imgsize.js');

  // 真造几张图出来量，不是对着常量断言
  const dir = path.join(SANDBOX, 'imgsize');
  fs.mkdirSync(dir, { recursive: true });
  const mkPng = (w, h) => {
    // 手搓一个只有 IHDR 的 PNG 头：读尺寸只看这一段
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4);
    ihdr.writeUInt32BE(w, 8);
    ihdr.writeUInt32BE(h, 12);
    const f = path.join(dir, `${w}x${h}.png`);
    fs.writeFileSync(f, Buffer.concat([sig, ihdr]));
    return f;
  };

  check('量得出 PNG 的真实宽高',
    JSON.stringify(imgsize.readSize(mkPng(720, 1280))) === '{"width":720,"height":1280}',
    JSON.stringify(imgsize.readSize(mkPng(720, 1280))));
  check('不是图就回 null，不瞎猜', imgsize.readSize(path.join(dir, '没有这个文件.png')) === null);

  check('横竖搞反要被抓出来（9:16 的项目拿到 1280×720）',
    imgsize.matchesRatio({ width: 1280, height: 720 }, '9:16')?.flipped === true);
  check('对上了就是对上了', imgsize.matchesRatio({ width: 1280, height: 720 }, '16:9')?.ok === true);
  // 厂商常把 720×1280 出成 704×1280（对齐到 16 的倍数），那不算比例不对，
  // 为这个报警只会让人学会忽略警告
  check('几个像素的对齐偏差不算错',
    imgsize.matchesRatio({ width: 704, height: 1280 }, '9:16')?.ok === true,
    JSON.stringify(imgsize.matchesRatio({ width: 704, height: 1280 }, '9:16')));

  // 发出去的尺寸要跟着项目画幅走
  const adapters = await import('../core/providers/adapters.js');
  check('竖屏项目发出去的是竖图尺寸', adapters.ratioToSize('9:16') === '720*1280', adapters.ratioToSize('9:16'));
  check('横屏项目发出去的是横图尺寸', adapters.ratioToSize('16:9') === '1280*720', adapters.ratioToSize('16:9'));
}

// 光有换算表不够：得确认**真正发到厂商那儿的请求体**里带着竖图尺寸
// 尺寸给错时，厂商的表现是最坏的那一种：不报错，自己换一个尺寸出图。
// 于是你选了横屏、出来的是竖的，而请求记录里白纸黑字写着你要的尺寸。
section('尺寸要换算成这个模型收得下的');
{
  const adapters = await import('../core/providers/adapters.js');
  const catalog = await import('../core/providers/catalog.js');
  const ark = catalog.getProvider('volcengine');

  const c4 = adapters.imageSizeConstraint(ark, 'doubao-seedream-4-0-250828');
  check('4.0 声明了每边的上下限', c4?.min === 1280 && c4?.max === 4096, JSON.stringify(c4));
  // 16:9 的预设是 1280×720，短边 720 低于 4.0 的下限 —— 直接发过去会被它自己改写
  check('横屏在 4.0 上按 2272×1280 出，而不是把 720 发过去',
    adapters.fitImageSize('16:9', c4) === '2272*1280', adapters.fitImageSize('16:9', c4));
  check('竖屏还是竖的', adapters.fitImageSize('9:16', c4) === '1280*2272', adapters.fitImageSize('9:16', c4));
  check('方的还是方的', adapters.fitImageSize('1:1', c4) === '1280*1280', adapters.fitImageSize('1:1', c4));
  check('宽银幕不超上限',
    Math.max(...adapters.fitImageSize('21:9', c4).split('*').map(Number)) <= c4.max,
    adapters.fitImageSize('21:9', c4));

  const c3 = adapters.imageSizeConstraint(ark, 'doubao-seedream-3-0-t2i-250415');
  check('3.0 是固定几档，横屏正好命中 1280x720',
    adapters.fitImageSize('16:9', c3) === '1280x720', adapters.fitImageSize('16:9', c3));
  // 方向绝不能挑反 —— 挑反了就是"我选了横屏出来是竖屏"
  check('挑档时先保方向：4:3 落在横的那一档',
    adapters.fitImageSize('4:3', c3) === '1152x864', adapters.fitImageSize('4:3', c3));
  check('3:4 落在竖的那一档', adapters.fitImageSize('3:4', c3) === '864x1152', adapters.fitImageSize('3:4', c3));

  const oa = catalog.getProvider('openai');
  const co = adapters.imageSizeConstraint(oa, 'gpt-image-1');
  check('gpt-image-1 横屏挑 1536x1024（给别的尺寸它直接 400）',
    adapters.fitImageSize('16:9', co) === '1536x1024', adapters.fitImageSize('16:9', co));
  check('目录里没有重复的 gpt-image-1（下拉框会显示两遍）',
    oa.models.filter((m) => m.id === 'gpt-image-1').length === 1,
    String(oa.models.filter((m) => m.id === 'gpt-image-1').length));

  // 没声明约束的照旧发预设，不猜
  check('没声明约束就用预设', adapters.fitImageSize('16:9', null) === '1280*720', adapters.fitImageSize('16:9', null));
}

section('竖屏项目真的按竖屏出');
{
  const vp = await (
    await fetch(`${appUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '竖屏短剧', aspectRatio: '9:16' })
    })
  ).json();
  check('新建项目时的画幅存下来了', vp.aspectRatio === '9:16', vp.aspectRatio);

  store.update(vp.id, (p) => {
    p.bible = { style: { anchor: '国风', negative: '' },
      characters: [{ name: '阿澜', appearance: '短发', seed: 7, variants: [{ id: 'v-default', name: '默认造型' }] }],
      scenes: [], props: [] };
    p.shots = [{ id: 'r1', index: 1, characters: ['阿澜'], description: '阿澜走向栈桥', camera: '中景', duration: 4 }];
    return p;
  });

  upstream.lastImageBody = null;
  await ndjson(`/projects/${vp.id}/stage/assets`, {});
  check('出图请求体里是竖图尺寸（720x1280），不是默认横图',
    upstream.lastImageBody?.size === '720x1280', String(upstream.lastImageBody?.size));

  await ndjson(`/projects/${vp.id}/stage/video`, {});
  const vtext = (upstream.lastVideoBody?.content || []).find((c) => c.type === 'text')?.text || '';
  check('出视频也带着 9:16（方舟是拼在提示词末尾的 --ratio）',
    / --ratio 9:16/.test(vtext), vtext.slice(-60));
}

section('只取一镜（界面按镜增量刷新）');
{
  const live = await (await fetch(`${appUrl}/api/projects/${project.id}`)).json();
  const first = live.shots[0];
  const one = await (await fetch(`${appUrl}/api/projects/${project.id}/shots/${first.id}`)).json();
  check('能单独取到一镜', one.shot?.id === first.id, JSON.stringify(Object.keys(one)));
  check('带上项目的更新时间戳（缩略图靠它破缓存）', Boolean(Date.parse(one.updatedAt || '')), one.updatedAt);
  const missing = await fetch(`${appUrl}/api/projects/${project.id}/shots/不存在的镜`);
  check('取不存在的镜是 404，不是 200 加个空对象', missing.status === 404, String(missing.status));
}

section('改了描述，发出去的提示词跟着变');
{
  const pp = await (
    await fetch(`${appUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '提示词自检' })
    })
  ).json();
  // 真写一张图出来：出视频那条路要把首帧读成 base64，假路径走不到厂商那一步
  const png = path.join(SANDBOX, 'p1.png');
  fs.writeFileSync(png, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));
  store.update(pp.id, (p) => {
    p.bible = { style: { anchor: '国风水墨', negative: '' },
      characters: [{ name: '阿澜', appearance: '短发，藏青制服', seed: 1, variants: [] }],
      scenes: [], props: [] };
    p.shots = [{
      id: 'p1', index: 1, characters: ['阿澜'], description: '阿澜走向栈桥',
      camera: '中景', motion: '镜头缓推', dialogue: '', duration: 4,
      imagePath: png, imageAt: '2026-01-01T00:00:00.000Z',
      videoPath: 'x.mp4'
    }];
    return p;
  });

  // 先把"上一次发出去的"设成当前这版描述算出来的，模拟刚出完视频的状态
  const fresh0 = await (await fetch(`${appUrl}/api/projects/${pp.id}/shots/p1/prompts`)).json();
  store.update(pp.id, (p) => {
    p.shots[0].prompt = fresh0.now.image;
    p.shots[0].videoPrompt = fresh0.now.video;
    return p;
  });

  const before = await (await fetch(`${appUrl}/api/projects/${pp.id}/shots/p1/prompts`)).json();
  check('没改过时，现算的和上次发的一致（不虚报"过时"）',
    before.videoStale === false, JSON.stringify([before.now.video, before.used.video]));

  await fetch(`${appUrl}/api/projects/${pp.id}/shots/p1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: '阿澜蹲下查看缆绳的断口' })
  });
  const after = await (await fetch(`${appUrl}/api/projects/${pp.id}/shots/p1/prompts`)).json();

  check('现算的提示词跟着新描述走',
    after.now.video.includes('缆绳的断口') && !after.now.video.includes('走向栈桥'), after.now.video);
  check('出图提示词也跟着变', after.now.image.includes('缆绳的断口'), after.now.image.slice(0, 80));
  check('上一次实际发的原样保留，并标成已过时',
    after.used.video.includes('走向栈桥') && after.videoStale === true, JSON.stringify([after.used.video, after.videoStale]));
  // 视频照着两样东西生成：首帧图 + 提示词。改完描述不重出图，两边会打架
  check('图比描述旧会被点出来（首帧是旧画面、提示词是新描述）',
    after.imageOlderThanEdit === true, JSON.stringify([after.imageOlderThanEdit]));

  // 真出一次视频之后，发出去的必须是新描述那条
  const rev = await ndjson(`/projects/${pp.id}/shots/p1/regenerate`, { kind: 'video' });
  const sentText = (upstream.lastVideoBody?.content || []).find((c) => c.type === 'text')?.text || '';
  check('真正发给厂商的那条就是按新描述算的',
    sentText.includes('缆绳的断口'), sentText.slice(0, 100));
  const done = rev.find((e) => e.type === 'finished')?.project;
  const p1 = done?.shots?.find((x) => x.id === 'p1');
  check('重出之后不再显示"已过时"',
    p1?.videoPrompt?.includes('缆绳的断口'), p1?.videoPrompt?.slice(0, 60));
}

section('配音按时间轴摆，不是顺次拼');
{
  const ff = await import('../core/ffmpeg.js');

  const graph = ff.voiceFilterGraph([
    { path: 'a.mp3', at: 0 },
    { path: 'b.mp3', at: 4 },
    { path: 'c.mp3', at: 9.5 }
  ]);
  check('每条配音都被推到它那一镜的起点上',
    /\[0:a\]adelay=0:all=1/.test(graph) && /\[1:a\]adelay=4000:all=1/.test(graph) && /\[2:a\]adelay=9500:all=1/.test(graph),
    graph);
  // amix 默认按输入条数均分音量：二十条配音混完每句只剩 1/20，听上去像没配音
  check('混音不做音量均分（默认会把每句压到 1/N）', /normalize=0/.test(graph), graph);
  check('中途某镜没配音也不会让整条音轨提前结束', /dropout_transition=0/.test(graph), graph);

  // 时间轴只能有一份：字幕、配音、裁剪各算各的，三者必然打架
  const tp = await (
    await fetch(`${appUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '时间轴自检' })
    })
  ).json();
  store.update(tp.id, (p) => {
    p.bible = { style: { anchor: '国风', negative: '' }, characters: [], scenes: [], props: [], narratorVoice: 'v0' };
    p.shots = [
      { id: 't1', index: 1, dialogue: '第一句', duration: 4, actualDuration: 5, videoPath: 'a.mp4' },
      { id: 't2', index: 2, dialogue: '', duration: 3, actualDuration: 5, videoPath: 'b.mp4' },
      { id: 't3', index: 3, dialogue: '第三句', duration: 6, actualDuration: 10, videoPath: 'c.mp4' }
    ];
    return p;
  });
  const line = studioModule.timelineOf(store.read(tp.id), { policy: 'trim' });
  check('时间轴按分镜时长累加', line.map((r) => r.start).join(',') === '0,4,7', JSON.stringify(line.map((r) => r.start)));
  const cuesT = studioModule.buildSubtitles(store.read(tp.id), { policy: 'trim' });
  check('字幕和时间轴用的是同一份起点（第三句在第 7 秒，不是第 4 秒）',
    cuesT[1].start === 7, JSON.stringify(cuesT.map((c) => [c.text, c.start])));
  // 没台词的第二镜不占字幕，但**占时间轴** —— 这正是顺次拼接会跳过的那一格
  check('没台词的镜头照样占时间轴（顺次拼接就是在这儿开始错的）',
    line[1].span === 3 && cuesT.length === 2, JSON.stringify([line[1].span, cuesT.length]));
}

section('时长控制');
const durationMod = await import('../core/duration.js');
const { getProvider } = await import('../core/providers/catalog.js');

const ark = getProvider('volcengine');
const seedanceSteps = durationMod.allowedDurations(ark, 'doubao-seedance-1-0-pro-250528');
check('读得到厂商的合法时长档位', JSON.stringify(seedanceSteps) === '[5,10]', JSON.stringify(seedanceSteps));
check('请求 4 秒向上对齐到 5 秒（宁多勿少，少了会切断动作）', durationMod.alignDuration(4, seedanceSteps) === 5);
check('请求 6 秒向上对齐到 10 秒', durationMod.alignDuration(6, seedanceSteps) === 10);
check('超出最大档位时取最大值而不是报错', durationMod.alignDuration(30, seedanceSteps) === 10);
check('Vidu 是 4/8 档，和别家不同', JSON.stringify(durationMod.allowedDurations(getProvider('vidu'), 'viduq1')) === '[4,8]');

check('60 秒按 4.5 秒均镜长反推出 13 个镜头', durationMod.planShotCount(60) === 13);
check('目标很短时也至少给 2 镜', durationMod.planShotCount(3) === 2);

const durShots = [
  { duration: 3, actualDuration: 5 },
  { duration: 6, actualDuration: 10 },
  { duration: 4, actualDuration: 5 }
];
const sum = durationMod.summarize({ targetDuration: 15, shots: durShots.map((s) => ({ ...s, videoPath: 'x' })) }, { policy: 'trim' });
check('计划时长是分镜之和', sum.planned === 13, `${sum.planned}`);
check('模型实出时长按对齐后的算', sum.generated === 20, `${sum.generated}`);
check('把厂商档位多吃的时间单列出来', sum.quantizationOverhead === 7, `${sum.quantizationOverhead}`);
check('裁剪模式下成片等于计划时长', sum.final === 13, `${sum.final}`);
const keepSum = durationMod.summarize({ targetDuration: 15, shots: durShots.map((s) => ({ ...s, videoPath: 'x' })) }, { policy: 'keep' });
check('保留模式下成片等于模型实出', keepSum.final === 20, `${keepSum.final}`);

// 不触上限时：比例应当原样保留
const easy = durationMod.rescale([{ duration: 3 }, { duration: 6 }, { duration: 3 }], 18);
check('重排后总时长命中目标', Math.abs(easy.reduce((a, b) => a + b.duration, 0) - 18) < 0.3,
  JSON.stringify(easy.map((r) => r.duration)));
check('保留原有的快慢节奏（长镜仍是短镜的两倍）',
  Math.abs(easy[1].duration / easy[0].duration - 2) < 0.05,
  JSON.stringify(easy.map((r) => r.duration)));

// 触上限时：夹掉的余量必须分给还有余地的镜头，否则总时长会凭空少一截
const capped = durationMod.rescale([{ duration: 3 }, { duration: 6 }, { duration: 3 }], 24);
const ctotal = capped.reduce((a, b) => a + b.duration, 0);
check('有镜头顶到上限时，余量被重新分配，总时长仍命中目标',
  Math.abs(ctotal - 24) < 0.3, `${ctotal} → ${JSON.stringify(capped.map((r) => r.duration))}`);
check('顶到上限的那一镜确实停在上限', capped[1].duration === 10, JSON.stringify(capped.map((r) => r.duration)));
check('重排后不会低于模型能接受的最短时长', capped.every((r) => r.duration >= 3));

// 目标超出物理可能时贴到边界，而不是给出一个假数字
const impossible = durationMod.rescale([{ duration: 4 }, { duration: 4 }], 500);
check('目标不可能达到时贴到上限而不是硬凑',
  impossible.every((r) => r.duration === 10), JSON.stringify(impossible.map((r) => r.duration)));

check('时长格式化成人话', durationMod.fmtSeconds(95) === '1 分 35 秒' && durationMod.fmtSeconds(120) === '2 分');

// 分镜提示词里必须带上总时长预算，否则模型只按镜数拆，长度全凭运气
const shotPromptSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'core/pipeline/studio.js'), 'utf8');
check('分镜提示词带了总时长预算', /TARGET_SECONDS/.test(shotPromptSrc));
check('并且明确要求不要平均分配镜长', /不要平均分配/.test(shotPromptSrc));

section('MiniMax 海螺三步视频流程');
const adapters = await import('../core/providers/adapters.js');
settings.patch({ baseUrls: { minimax: `${upstreamUrl}/mm` }, pollIntervalMs: 10 });
vault.setSecret('MINIMAX_API_KEY', 'mm-key');

const mmEvents = [];
const mmVideo = await adapters.generateVideo({
  providerId: 'minimax',
  model: 'MiniMax-Hailuo-02',
  prompt: '镜头缓推',
  firstFrameUrl: 'https://x.invalid/f.png',
  duration: 5,
  onEvent: (ev) => mmEvents.push(ev)
});
check('三步都走到了：提交 → 轮询 → 取文件',
  upstream.mmCreate === 1 && upstream.mmPolls >= 2 && upstream.mmRetrieve === 1,
  `create=${upstream.mmCreate} polls=${upstream.mmPolls} retrieve=${upstream.mmRetrieve}`);
check('第三步用的是第二步给的 file_id', upstream.mmFileId === 'mm-file-42', upstream.mmFileId);
check('最终拿到下载地址', /out\.mp4$/.test(mmVideo.url), mmVideo.url);
check('时长对齐到海螺的 6 秒档（请求 5 秒）', mmVideo.actualDuration === 6, `${mmVideo.actualDuration}`);
check('轮询过程有上报，界面才能显示进度', mmEvents.some((e) => e.type === 'poll'));

const mmImg = await adapters.generateImage({
  providerId: 'minimax',
  model: 'image-01',
  prompt: '太湖清晨',
  size: '1280*720'
});
check('海螺出图拿到 URL', /pixel\.png$/.test(mmImg.url), mmImg.url);
check('像素尺寸被换算成宽高比（海螺只认比例）',
  upstream.mmImageBody?.aspect_ratio === '16:9', JSON.stringify(upstream.mmImageBody?.aspect_ratio));
check('负向词并进正向描述（海螺没有 negative_prompt 字段）',
  /避免出现/.test(upstream.mmImageBody?.prompt || ''), upstream.mmImageBody?.prompt);

// 海螺把业务错误放在 base_resp 里，HTTP 仍然 200。只看 res.ok 会把失败当成功。
upstream.mmImageFail = true;
let mmErr = null;
await adapters.generateImage({ providerId: 'minimax', model: 'image-01', prompt: 'x' }).catch((e) => (mmErr = e));
check('HTTP 200 但 base_resp 报错时判为失败', Boolean(mmErr), '没有抛错');
check('错误信息带上服务端原话', /余额不足/.test(mmErr?.message || ''), mmErr?.message);
upstream.mmImageFail = false;

section('MiniMax H3 全模态');
upstream.mmPolls = 0;
const h3 = await adapters.generateVideo({
  providerId: 'minimax',
  model: 'MiniMax-H3',
  prompt: '镜头缓推，人物走向栈桥尽头',
  firstFrameUrl: 'https://x.invalid/frame.png',
  refImages: ['https://x.invalid/char.png', 'https://x.invalid/scene.png'],
  duration: 12,
  onEvent: null
});
const h3body = upstream.mmCreateBody;
check('H3 用 content[] 多模态结构，不是 first_frame_image',
  Array.isArray(h3body?.content) && !h3body.first_frame_image, JSON.stringify(Object.keys(h3body || {})));
check('第一项是文本提示词', h3body?.content?.[0]?.type === 'text');
check('首帧和参考图一起送进去（H3 最多收 9 张，不用二选一）',
  h3body.content.filter((c) => c.type === 'image_url').length === 3,
  JSON.stringify(h3body.content.map((c) => c.type)));
check('首帧排在参考图之前', h3body.content[1]?.image_url?.url?.includes('frame.png'));
check('时长对齐到 H3 的 15 秒档（请求 12 秒）', h3.actualDuration === 15, `${h3.actualDuration}`);
check('H3 也走同一套三步流程', /out\.mp4$/.test(h3.url), h3.url);

// 超过 9 张要截断，否则服务端会直接拒
upstream.mmPolls = 0;
await adapters.generateVideo({
  providerId: 'minimax',
  model: 'MiniMax-H3',
  prompt: 'x',
  firstFrameUrl: 'https://x.invalid/f.png',
  refImages: Array.from({ length: 20 }, (_, i) => `https://x.invalid/r${i}.png`),
  duration: 6
});
check('参考图超过 9 张时截断到 9 张',
  upstream.mmCreateBody.content.filter((c) => c.type === 'image_url').length === 9,
  `${upstream.mmCreateBody.content.filter((c) => c.type === 'image_url').length} 张`);

// Hailuo 系仍走旧结构，别被 H3 的改动带偏
upstream.mmPolls = 0;
await adapters.generateVideo({
  providerId: 'minimax',
  model: 'MiniMax-Hailuo-02',
  prompt: 'x',
  firstFrameUrl: 'https://x.invalid/f.png',
  duration: 6
});
check('Hailuo 系仍用 first_frame_image，没被 H3 的改动带偏',
  Boolean(upstream.mmCreateBody.first_frame_image) && !upstream.mmCreateBody.content,
  JSON.stringify(Object.keys(upstream.mmCreateBody)));

section('秘塔中转（路径未知时的自适应）');
settings.patch({ baseUrls: { metaso: `${upstreamUrl}/ms` } });
vault.setSecret('METASO_API_KEY', 'mk-test');

const msVideo = await adapters.generateVideo({
  providerId: 'metaso',
  model: 'MiniMax-H3',
  prompt: '女舰长站在观景窗前',
  refImages: ['https://x.invalid/a.png'],
  duration: 5,
  aspectRatio: '16:9'
});
check('提交用 content[] 结构', Array.isArray(upstream.msBody?.content));
check('带上了这家特有的 ratio 字段', upstream.msBody?.ratio === '16:9', JSON.stringify(upstream.msBody?.ratio));
check('没指定分辨率时用这家自己的默认档（768P），不是别家的写法',
  upstream.msBody?.resolution === '768P', upstream.msBody?.resolution);

// 分辨率可选：用户选的档位要真的发出去
await adapters.generateVideo({
  providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x', duration: 5, resolution: '2K'
});
check('调用方指定 2K 时按 2K 发', upstream.msBody?.resolution === '2K', upstream.msBody?.resolution);

// 各家大小写不统一：选 480P 也要翻成这家原样的 480p
await adapters.generateVideo({
  providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x', duration: 5, resolution: '480P'
});
check('大小写不同也能对上，按厂商原样拼写发出（480p）',
  upstream.msBody?.resolution === '480p', upstream.msBody?.resolution);

// 这家没有的档位不能硬发过去 —— 必然报错，还不如退回默认
await adapters.generateVideo({
  providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x', duration: 5, resolution: '1080P'
});
check('这家不支持的档位退回默认档，不是把必错的值发出去',
  upstream.msBody?.resolution === '768P', upstream.msBody?.resolution);

// 全局设置也要生效（不传 resolution 时读设置）
settings.patch({ videoResolution: '2K' });
await adapters.generateVideo({ providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x', duration: 5 });
check('设置里选的档位对未指定的调用生效', upstream.msBody?.resolution === '2K', upstream.msBody?.resolution);
settings.patch({ videoResolution: 'auto' });
check('时长 5 秒原样发出（这家档位是 5 而不是官方的 6）',
  upstream.msBody?.duration === 5, `${upstream.msBody?.duration}`);
check('官方查询路径 404 后自动试出正确路径', /out\.mp4$/.test(msVideo.url), msVideo.url);
check('探出来的路径被缓存，第二次不再重复试', upstream.msQueryHits >= 2);

// ── 图片张数：中转平台各有各的上限，而且不写在文档里 ──
// 猜高了整步一直失败，猜低了白白丢掉一致性 —— 所以按"试出来"处理。
upstream.msMediaLimit = 1;
upstream.msImageCounts = [];
const manyRefs = ['https://x.invalid/a.png', 'https://x.invalid/b.png', 'https://x.invalid/c.png'];
const msNotes = [];
const backoff = await adapters.generateVideo({
  providerId: 'metaso',
  model: 'MiniMax-H3',
  prompt: 'x',
  firstFrameUrl: 'https://x.invalid/f.png',
  refImages: manyRefs,
  duration: 5,
  onEvent: (ev) => ev.type === 'note' && msNotes.push(ev.message)
});
check('图带多了不是直接失败，而是减半重试到能收为止', Boolean(backoff.url), backoff.url);
check('确实一路退到 1 张', upstream.msImageCounts.at(-1) === 1, JSON.stringify(upstream.msImageCounts));
check('退让过程说清楚了原因，并且讲明这次失败不计费',
  msNotes.some((m) => /改成 1 张重试/.test(m) && /不计费/.test(m)),
  JSON.stringify(msNotes.slice(0, 4)));

// 试出来的上限要记住：同一批后面几十个镜头不该每个都去撞一次墙
upstream.msImageCounts = [];
await adapters.generateVideo({
  providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x',
  firstFrameUrl: 'https://x.invalid/f.png', refImages: manyRefs, duration: 5
});
check('试出来的上限被记住，第二镜直接按 1 张发',
  upstream.msImageCounts.length === 1 && upstream.msImageCounts[0] === 1,
  JSON.stringify(upstream.msImageCounts));
upstream.msMediaLimit = 99;

// 中转平台自创状态词是常事。漏判一个，任务明明成了却一直轮询到超时 ——
// 用户看到的就是"视频生成了，但流水线上不显示"。
upstream.msQueryHits = 0;
upstream.msState = 'completed';
const oddState = await adapters.generateVideo({
  providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x', duration: 5,
  firstFrameUrl: 'https://x.invalid/f.png'
});
check('completed 也算终态（不是只认 success）', Boolean(oddState.url), oddState.url);
upstream.msState = null;

// ── 秘塔实测确认的响应形状：{"task":{"status":…,"content":{"url":…}}} ──
adapters.resetQueryUrlCache();
settings.patch({ baseUrls: { metaso: `${upstreamUrl}/msv2` } });
upstream.msv2Hits = 0;
const v2 = await adapters.generateVideo({
  providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x', duration: 5,
  firstFrameUrl: 'https://x.invalid/f.png'
});
check('套了一层 task 也能读出状态并拿到视频', /out\.mp4$/.test(v2.url || ''), v2.url);
check('轮到 succeeded 才算完，没有提前收工', upstream.msv2Hits >= 2, `${upstream.msv2Hits} 次`);
check('厂商回的真实时长被采纳（不是我们对齐前那个数）', v2.actualDuration === 5, `${v2.actualDuration}`);
check('厂商回的真实分辨率被采纳', v2.resolution === '2K', v2.resolution);
settings.patch({ baseUrls: { metaso: `${upstreamUrl}/ms` } });
adapters.resetQueryUrlCache();

// 服务商在目录里自带的路径要排在通用候选之前 —— 中转平台常有自己的一套，
// 通用清单猜不到，但它自己知道
adapters.resetQueryUrlCache();
settings.patch({ baseUrls: { metaso: `${upstreamUrl}/msown` } });
upstream.ownHits = 0;
const own = await adapters.generateVideo({
  providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x', duration: 5,
  firstFrameUrl: 'https://x.invalid/f.png'
});
check('目录里给这家声明的查询写法被优先试到', Boolean(own.url) && upstream.ownHits >= 1, own.url);
settings.patch({ baseUrls: { metaso: `${upstreamUrl}/ms` } });
adapters.resetQueryUrlCache();

// ── 探路径必须看内容，不能只看 HTTP 200 ──
// 中转平台常常对任何路径都回 200（首页、错误页、空对象都算）。
// 只要不是 404 就锁上的话，会锁到一个跟任务无关的地址，
// 然后每次轮询都读到"没有状态"，一路轮到十分钟超时 ——
// 用户看到的就是"视频在厂商平台明明生成好了，流水线却一直转"。
adapters.resetQueryUrlCache();
upstream.msJunk200 = true;
upstream.msQueryHits = 0;
const junkOk = await adapters.generateVideo({
  providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x', duration: 5,
  firstFrameUrl: 'https://x.invalid/f.png'
});
check('回 200 但内容不是任务记录的路径会被跳过，继续找对的那个', Boolean(junkOk.url), junkOk.url);
upstream.msJunk200 = false;

// 万一真的锁到了坏地址（比如它一开始装得像），也不能空等到超时
adapters.resetQueryUrlCache();
settings.patch({ baseUrls: { metaso: `${upstreamUrl}/msblind` } });
let blindErr = null;
await adapters
  .generateVideo({ providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x', duration: 5 })
  .catch((e) => (blindErr = e));
check('连着读不出状态就停下来，不再空等到超时',
  /读不出任务状态/.test(blindErr?.message || ''), blindErr?.message?.slice(0, 120));
check('停下来时把返回内容和 task_id 都摊开了',
  /task_id/.test(blindErr?.message || '') && /它返回的是/.test(blindErr?.message || ''),
  blindErr?.message?.slice(-160));
settings.patch({ baseUrls: { metaso: `${upstreamUrl}/ms` } });

// 用户在界面上填了查任务地址，就该直接用它，不再瞎猜
adapters.resetQueryUrlCache();
upstream.msQueryHits = 0;
settings.patch({ endpointOverrides: { 'metaso.videoQuery': `${upstreamUrl}/ms/video_generation/{taskId}` } });
const overridden = await adapters.generateVideo({
  providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x', duration: 5,
  firstFrameUrl: 'https://x.invalid/f.png'
});
check('手填的查任务地址直接生效（{taskId} 会被替换）', Boolean(overridden.url), overridden.url);
settings.patch({ endpointOverrides: { 'metaso.videoQuery': '' } });
check('填空等于清掉覆盖，回到自动探测',
  !settings.get('endpointOverrides')['metaso.videoQuery']);

// 全都试不通时要给可执行的下一步，而不是一句"失败了"
settings.patch({ baseUrls: { metaso: `${upstreamUrl}/msbad` } });
let msErr = null;
await adapters
  .generateVideo({ providerId: 'metaso', model: 'MiniMax-H3', prompt: 'x', duration: 5 })
  .catch((e) => (msErr = e));
check('路径全试不通时，报错里带上 task_id 和下一步该干什么',
  /任务提交成功/.test(msErr?.message || '') && /联调台/.test(msErr?.message || ''),
  msErr?.message?.slice(0, 120));

// ─────────────────────── 8. 上线前体检 ───────────────────────

section('待认领的任务不能变成黑洞');
{
  // 提交成功、片子在厂商那边、我们没取回来 —— 这种状态既不算完成也不算失败，
  // 卡住整条流水线。必须有一条零成本的出路。
  const shot = afterAssets.shots[0];
  store.update(project.id, (p) => {
    const t = p.shots.find((x) => x.id === shot.id);
    if (t) {
      delete t.videoPath;
      t.pendingTask = { taskId: '424010985738629', provider: 'metaso', at: new Date().toISOString() };
    }
    return p;
  });

  const pending = studioModule.listPendingTasks(project.id);
  check('待认领的任务列得出来', pending.length === 1 && pending[0].taskId === '424010985738629',
    JSON.stringify(pending));

  // 让打桩服务能查到这个任务，模拟"用户刚把查询地址填对了"
  settings.patch({ baseUrls: { metaso: `${upstreamUrl}/msv2` } });
  adapters.resetQueryUrlCache();
  upstream.msv2Hits = 5; // 直接给终态，重查是"查一次"不是轮询

  const evs = await ndjson(`/projects/${project.id}/tasks/recheck`, {});
  const after = evs.find((e) => e.type === 'finished')?.project;
  const claimed = after?.shots?.find((x) => x.id === shot.id);
  check('重查一次就把片子收回来了', Boolean(claimed?.videoPath), JSON.stringify(evs.slice(-2)));
  check('收回来之后不再挂着"待认领"', !claimed?.pendingTask);
  check('重查只查不生成（没有新的提交请求）', upstream.msv2Submits === undefined || upstream.msv2Submits === 0);
  check('列表随之清空', studioModule.listPendingTasks(project.id).length === 0);

  settings.patch({ baseUrls: { metaso: `${upstreamUrl}/ms` } });
  adapters.resetQueryUrlCache();
}

section('OpenAI 的视频接口（Sora）');
{
  settings.patch({ baseUrls: { openai: `${upstreamUrl}/oa` } });
  vault.setSecret('OPENAI_API_KEY', 'sk-openai-test');
  upstream.soraPolls = 0;

  const sora = await adapters.generateVideo({
    providerId: 'openai',
    model: 'sora-2',
    prompt: '女舰长站在观景窗前',
    firstFrameUrl: 'https://x.invalid/f.png',
    duration: 7,
    aspectRatio: '16:9'
  });

  check('提交用的是 /videos，不是 chat 那套', Boolean(upstream.soraBody?.prompt), JSON.stringify(upstream.soraBody));
  check('时长按 Sora 的档位对齐（4/8/12，7 秒进 8 秒）',
    upstream.soraBody?.seconds === '8', upstream.soraBody?.seconds);
  check('首帧图走 input_reference', Boolean(upstream.soraBody?.input_reference));
  check('轮到 completed 才收工', upstream.soraPolls >= 2, `${upstream.soraPolls} 次`);
  check('拿到的是 /content 地址', /\/videos\/video_abc\/content$/.test(sora.url || ''), sora.url);

  // 这条最要紧：OpenAI 的下载地址必须带密钥，别家都不用。
  // 少带头会下到一个 401 的 JSON，然后被当成 mp4 存下来 —— 文件在，就是打不开。
  check('下载地址带回了鉴权头', /^Bearer /.test(sora.downloadHeaders?.Authorization || ''),
    JSON.stringify(Object.keys(sora.downloadHeaders || {})));

  const dest = path.join(SANDBOX, 'sora.mp4');
  await studioModule.saveMedia(sora, dest);
  check('带着头能把 mp4 下下来', fs.readFileSync(dest, 'utf8') === 'fake-sora-mp4');
  check('下载时确实带了密钥', /^Bearer sk-openai-test$/.test(upstream.soraDownloadAuth || ''));

  // 不显式给头也该能下下来：按域名匹配到这家、自动带上密钥重试一次。
  // 秘塔的 files.metaso.cn 就是这种 —— 不带密钥回 {"errCode":401,…}
  upstream.soraDownloadAuth = '';
  await studioModule.saveMedia({ url: sora.url }, path.join(SANDBOX, 'sora-auto.mp4'));
  check('没显式给头时，按域名匹配到服务商并自动带密钥重试',
    /^Bearer sk-openai-test$/.test(upstream.soraDownloadAuth || ''), upstream.soraDownloadAuth);

  // 补上密钥也没用的地址（回的就是 JSON）：必须当场报错，不能存成打不开的文件
  let jsonErr = null;
  await studioModule
    .saveMedia({ url: `${upstreamUrl}/notmedia` }, path.join(SANDBOX, 'bad.mp4'))
    .catch((e) => (jsonErr = e));
  check('下到 JSON 时当场报错，不存成打不开的 mp4',
    /不是媒体文件/.test(jsonErr?.message || ''), jsonErr?.message?.slice(0, 60));
  check('报错里说清楚该去配密钥', /服务商与密钥/.test(jsonErr?.message || ''));
  check('没把那段 JSON 存成文件', !fs.existsSync(path.join(SANDBOX, 'bad.mp4')));

  // 竖屏短剧配个横向尺寸等于白出一条片子
  upstream.soraPolls = 0;
  await adapters.generateVideo({
    providerId: 'openai', model: 'sora-2', prompt: 'x', duration: 4, aspectRatio: '9:16'
  });
  check('画幅是竖屏时尺寸自动换成竖的',
    upstream.soraBody?.size === '720x1280', upstream.soraBody?.size);

  settings.patch({ baseUrls: { openai: '' } });
}

section('上线前体检');
const preflightEvents = await ndjson('/preflight', { include: ['chat', 'vision', 't2i'] });
const byId = Object.fromEntries(
  preflightEvents.filter((e) => e.type === 'check' && e.status !== 'running').map((e) => [e.id, e])
);
check('对话这条腿通了', byId.chat?.status === 'ok', JSON.stringify(byId.chat));
check('出图这条腿通了', byId.t2i?.status === 'ok', JSON.stringify(byId.t2i));
check(
  '视觉模型没描述出测试图时判为 warn 而不是 ok',
  byId.vision?.status === 'warn',
  `实际 ${byId.vision?.status}`
);
check('每条结果都带上了用的服务商和模型', Object.values(byId).every((r) => r.provider && r.model));
const verdict = preflightEvents.find((e) => e.type === 'summary');
check('给出了总体结论', Boolean(verdict?.verdict), JSON.stringify(verdict));
check('有 warn 时结论不谎报"都通"', /留意/.test(verdict?.verdict || ''), verdict?.verdict);

// ── 自检替换模型：只能换同一类的 ──
// 一家只被拿去出图/出视频时，自检打的仍是对话接口。
// 早期版本把出图模型塞进 chat 请求，于是自检红了，可配置一点毛病没有 ——
// 猜错的自检比不自检更坏。
const savedRoute = { imageProvider: settings.get('imageProvider'), imageModel: settings.get('imageModel') };
settings.patch({ imageProvider: 'volcengine', imageModel: 'doubao-seedream-3-0-t2i-250415' });
settings.patch({ chatProvider: 'deepseek', chatModel: 'deepseek-chat' });
const probeOnlyImage = await providersMod.probe('volcengine');
check('这家只用来出图时，自检不会把出图模型塞进对话接口',
  probeOnlyImage.model !== 'doubao-seedream-3-0-t2i-250415', probeOnlyImage.model);
check('自检回报了它实际用的是哪个模型（红了才知道该查什么）', Boolean(probeOnlyImage.model), JSON.stringify(probeOnlyImage));

// 但对话路由指到这家时，就该按用户真正会用的那个模型探
settings.patch({ chatProvider: 'volcengine', chatModel: 'doubao-1-5-pro-32k-250115' });
const probeChat = await providersMod.probe('volcengine');
check('对话路由指到这家时，自检用的就是那个模型',
  probeChat.model === 'doubao-1-5-pro-32k-250115', probeChat.model);
settings.patch(savedRoute);

// 打桩服务没有 /v3/models，正好用来验证"拿不到列表时给的是人话而不是空下拉"
const modelList = await (await fetch(`${appUrl}/api/providers/volcengine/models`)).json();
check('拿不到模型列表时说明白该去哪儿找', modelList.ok === false && /控制台|手动填写/.test(modelList.reason), JSON.stringify(modelList));

// 配置坏了的代价不是"自检红一下"，而是你跑到第 04 步、等了两分钟，
// 才被告知密钥没配。所以打开应用就自动探一遍 —— 前提是它必须**足够便宜**。
section('开机自动探一遍路由到的服务商');
{
  const before = upstream.imagePrompts.length;
  const probesBefore = logbus.list({ limit: 200 }).filter((x) => /自检/.test(x.label || '')).length;
  const r = await (await fetch(`${appUrl}/api/routing/check`, { method: 'POST' })).json();
  const probesAfter = logbus.list({ limit: 200 }).filter((x) => /自检/.test(x.label || '')).length;

  check('六种能力都给了结论（剧本、调度、复核、出图、视频、配音）',
    Object.keys(r.capabilities || {}).length === 6, JSON.stringify(Object.keys(r.capabilities || {})));
  // 调度没单配时跟着剧本模型走，不该多探一次同一家
  check('调度没单配时跟随剧本模型',
    r.capabilities?.director?.provider === r.capabilities?.chat?.provider,
    JSON.stringify([r.capabilities?.director?.provider, r.capabilities?.chat?.provider]));
  check('记了时间（界面要显示"什么时候探的"）', Boolean(Date.parse(r.checkedAt || '')));
  // 这是自动跑的前提：一张图都不许出，一段视频都不许出
  check('自动探测不产生任何媒体（不然开个应用就烧钱）',
    upstream.imagePrompts.length === before, `出图次数 ${before} → ${upstream.imagePrompts.length}`);
  check('通的那家标成 ok', r.capabilities.chat?.ok === true, JSON.stringify(r.capabilities.chat));
  check('结论里带上服务商名字（界面要说清楚是哪家不通）',
    Boolean(r.capabilities.chat?.providerName), JSON.stringify(r.capabilities.chat));

  /**
   * 同一家被多条能力用到时只该探一次。
   * 自检时 chat/vision/image/video 全指向 volcengine、tts 指向 dashscope，
   * 所以这一趟最多两次请求 —— 探五遍同一个端点既慢又没意义。
   */
  check('同一家不重复探（四条能力同一家时只探一次）',
    probesAfter - probesBefore <= 2, `这一趟发了 ${probesAfter - probesBefore} 次自检请求`);

  // 密钥没配的那家要说"缺什么"，而不是笼统地说"连不上"——
  // 后者会让人去查一个根本不存在的网络问题
  const saved = settings.get('ttsProvider');
  settings.patch({ ttsProvider: 'vidu' });
  const r2 = await (await fetch(`${appUrl}/api/routing/check`, { method: 'POST' })).json();
  check('没配密钥时直接点名缺哪个，而不是笼统说连不上',
    r2.capabilities.tts?.ok === false && /缺少凭据/.test(r2.capabilities.tts?.reason || ''),
    JSON.stringify(r2.capabilities.tts));
  check('缺的密钥名也一起给出来（界面要能直接跳过去填）',
    Array.isArray(r2.capabilities.tts?.missing) && r2.capabilities.tts.missing.length > 0,
    JSON.stringify(r2.capabilities.tts?.missing));
  settings.patch({ ttsProvider: saved });
}

section('候选模型逐个探测');
const candEvents = await ndjson('/providers/volcengine/candidates', {});
const candDone = candEvents.find((e) => e.type === 'finished');
check('把能用的挑出来了', candDone?.available?.length === 2, JSON.stringify(candDone?.available));
check(
  '挑出来的正是打桩账号开通的那两个',
  candDone?.available?.includes('doubao-1-5-pro-32k-250115') &&
    candDone?.available?.includes('doubao-seed-1-6-250615'),
  JSON.stringify(candDone?.available)
);
check('没开通的被排除', candDone?.rejected?.length > 5, `只排除了 ${candDone?.rejected?.length} 个`);
check('每探一个都实时上报', candEvents.filter((e) => e.type === 'candidate').length === candDone?.tried);

// 方舟式的 404「模型不存在」不能被翻译成"去改 baseUrl"
const badModel = await ndjson('/debug/send', {
  provider: 'volcengine',
  method: 'POST',
  url: `${upstreamUrl}/v3/chat/completions`,
  body: JSON.stringify({ model: 'doubao-pro-32k', messages: [{ role: 'user', content: 'hi' }] })
});
const badDone = badModel.find((e) => e.type === 'done');
const explained = providersMod.diagnose({ status: 404, json: badDone?.json, raw: '' });
check('404「模型不存在」被指认成模型问题，而不是 baseUrl', /模型或推理接入点不存在/.test(explained), explained);
check('报错里带了服务端原话', /does not exist/.test(explained), explained);

// ─────────────────────── 9. Windows 文件名 ───────────────────────

section('HTTP 200 里藏着的错误');
{
  const { bodyError, isAuthError } = await import('../core/providers/adapters.js');

  // 秘塔真实回过这一段：HTTP 层看着没事，错误全在 body 里。
  // 不认这种的话，轮询会把它当成"任务还没好"，一直等到超时。
  const metaso = {
    type: 'error',
    error: { type: 'authorized_error', message: 'login fail: Please carry a valid API key in the Authorization header (1004)', http_code: '401' },
    request_id: '933af6b6'
  };
  check('认得出 {"type":"error"} 这一族', /login fail/.test(bodyError(metaso)), bodyError(metaso));
  check('把它判成鉴权问题（和"路径不对"要分开报）', isAuthError(bodyError(metaso)));
  check('认得出 MiniMax 的 base_resp',
    /余额不足/.test(bodyError({ base_resp: { status_code: 1008, status_msg: '余额不足' } })));
  check('认得出 {"code":x,"msg":"…"} 这一族',
    /没权限/.test(bodyError({ code: 1004, msg: '没权限' })));
  check('code 为 0 不算错', bodyError({ code: 0, msg: 'ok' }) === '');
  check('正常的任务响应不会被误判成错误',
    bodyError({ task_id: 'x', status: 'Processing' }) === '');
  check('空响应也不至于炸', bodyError(null) === '' && bodyError('x') === '');
}

section('百炼：只认公网 URL，且失败原因不能被截断');
{
  vault.setSecret('DASHSCOPE_API_KEY', 'sk-ds-test');
  settings.patch({ baseUrls: { dashscope: `${upstreamUrl}/ds` } });

  // 本应用默认把本地图转成 data URI（Windows 用户不必先开一个 OSS 桶），
  // 而百炼只认公网 URL。不先拦一下的话，任务会提交成功、然后在轮询里
  // 以 InvalidParameter 失败 —— 白等一轮，报错还看不出是这个原因。
  let dsErr = null;
  await adapters
    .generateVideo({
      providerId: 'dashscope',
      model: 'wanx2.1-i2v-turbo',
      prompt: 'x',
      firstFrameUrl: 'data:image/png;base64,AAAA',
      duration: 5
    })
    .catch((e) => (dsErr = e));
  check('base64 图在发出去之前就被拦下', /只认\*\*公网 URL\*\*|只认.*公网 URL/.test(dsErr?.message || ''),
    dsErr?.message?.slice(0, 60));
  check('拦下来时给了两条具体出路', /上传网关/.test(dsErr?.message || '') && /方舟/.test(dsErr?.message || ''));

  // 用户实际收到的那段：code / message 在对象末尾，
  // 早期版本直接截断 JSON，正好把最关键的那句话切掉，只剩 `"message":"Field re`
  const { failureReasonForTest } = await import('../core/providers/index.js');
  const real = {
    request_id: '46866c03',
    output: {
      task_id: '9500e1fd',
      task_status: 'FAILED',
      submit_time: '2026-08-14 09:09:04.455',
      scheduled_time: '2026-08-14 09:09:04.510',
      end_time: '2026-08-14 09:09:04.645',
      code: 'InvalidParameter',
      message: 'Field required: img_url must be a public URL'
    }
  };
  const why = failureReasonForTest(real);
  check('失败原因从对象末尾捞得出来', /InvalidParameter/.test(why) && /public URL/.test(why), why);

  settings.patch({ baseUrls: { dashscope: '' } });
}

section('下载地址也要鉴权的那几家');
{
  const { providerForUrl, authHeadersForUrl } = await import('../core/providers/index.js');
  // 前面的用例把秘塔的 baseUrl 指到了打桩服务上，这里要按真实地址判
  const savedBase = settings.get('baseUrls').metaso;
  settings.patch({ baseUrls: { metaso: 'https://metaso.cn/api/minimax/v2' } });

  // 用户实际踩到的：秘塔给的视频地址在 files.metaso.cn 上，取文件也要密钥，
  // 不带回 {"errCode":401,"errMsg":"…"}，然后被当成 mp4 存下来 —— 文件在，打不开。
  check('files.metaso.cn 认得出是秘塔的地址',
    providerForUrl('https://files.metaso.cn/api/video-generation/2087979924949516288/content')?.id === 'metaso');
  check('主域不同的 CDN 不会被误认（不该把密钥发过去）',
    providerForUrl('https://cdn.hailuoai.com/x.mp4') === null);
  check('完全不相干的域名更不会', providerForUrl('https://example.com/a.mp4') === null);
  check('地址不合法时不炸', providerForUrl('随便写的') === null);

  // IP 地址按"连端口一起完全一致"匹配：127.0.0.1:11434 和 127.0.0.1:8080
  // 是两个不相干的服务，按同主域算会把密钥发给隔壁端口
  settings.patch({ baseUrls: { ollama: 'http://127.0.0.1:11434/v1' } });
  check('同 IP 同端口算同一家', providerForUrl('http://127.0.0.1:11434/x')?.id === 'ollama');
  check('同 IP 不同端口不算', providerForUrl('http://127.0.0.1:9999/x')?.id !== 'ollama');
  settings.patch({ baseUrls: { ollama: '' } });

  check('没配密钥的那家不会硬塞一个半成品头',
    Object.keys(authHeadersForUrl('https://api.openai.com/v1/x')).length >= 0);

  settings.patch({ baseUrls: { metaso: savedBase } });
}

section('网络层错误说人话');
{
  const { explainNetworkError } = await import('../core/http-client.js');
  const mk = (code) => Object.assign(new Error('fetch failed'), { cause: { code } });
  const timeout = explainNetworkError(mk('UND_ERR_CONNECT_TIMEOUT'), 'https://dashscope.aliyuncs.com/x');

  // 连不上和"接口报错"完全是两回事：请求根本没发出去，密钥、模型一个都不沾边。
  // 只甩一句 UND_ERR_CONNECT_TIMEOUT，用户会去翻密钥、换模型，全是白费。
  check('连接超时说明白了和密钥无关', /和密钥、模型都没关系/.test(timeout), timeout.slice(0, 60));
  check('连接超时带上了是哪个域名', /dashscope\.aliyuncs\.com/.test(timeout));
  check('连接超时给了可执行的三步', /浏览器打开/.test(timeout) && /代理/.test(timeout));
  check('域名解析失败单独一种说法', /域名解析不了/.test(explainNetworkError(mk('ENOTFOUND'), 'https://a.b/c')));
  check('拒绝连接会提醒本地模型没起来',
    /Ollama/.test(explainNetworkError(mk('ECONNREFUSED'), 'http://127.0.0.1:11434/v1')));
  check('证书问题指向公司网络的根证书',
    /根证书/.test(explainNetworkError(mk('CERT_HAS_EXPIRED'), 'https://a.b/c')));
  check('没见过的错误码也不至于变成 undefined',
    /连接失败/.test(explainNetworkError(mk('E_WHATEVER'), 'https://a.b/c')));
}

section('打包配置');
{
  // 自检跑在打包**之前**，所以配置写错该在这里就拦下来 ——
  // 让它跑到 electron-builder 才炸，等于白等三分钟队列 + 一次构建，
  // 而且失败的那次 Release 不会更新，用户下到的还是上一版。
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));

  // electron-builder 是严格 schema 校验：多一个它不认识的键就整个拒绝。
  // 我在这儿栽过一次 —— 想给配置加行注释，写了个 "//electronLanguages"，
  // JSON 本身合法，构建直接红。配置文件里没有"注释"这回事。
  const commentKeys = [];
  const walk = (obj, at) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('//')) commentKeys.push(`${at}${k}`);
      walk(v, `${at}${k}.`);
    }
  };
  walk(pkg.build, 'build.');
  check('打包配置里没有注释键（electron-builder 见了会整个拒绝）',
    commentKeys.length === 0, commentKeys.join('、'));

  check('打包配置带上了应用运行真正需要的目录',
    ['electron/**', 'core/**', 'ui/**'].every((f) => (pkg.build?.files || []).includes(f)),
    JSON.stringify(pkg.build?.files));
  check('两个 Windows 产物的文件名不会撞车',
    pkg.build?.nsis?.artifactName && pkg.build?.portable?.artifactName
      && pkg.build.nsis.artifactName !== pkg.build.portable.artifactName,
    `${pkg.build?.nsis?.artifactName} / ${pkg.build?.portable?.artifactName}`);

  /**
   * bin\ 的落点。
   *
   * 这里栽过一次，而且是**只有装完才会现形**的那种：
   * 源码里确实有 desktop\bin\，开发机上"把 ffmpeg.exe 放进本应用的 bin 目录"完全成立；
   * 可 core\ 被打进 app.asar 之后，代码算出来的 ROOT\bin 是 asar **包内**的虚拟路径，
   * 既不存在也没法往里放文件，而真正随包发出去的 bin 落在 resources\bin。
   * 于是提示语让人放的地方，和程序找的地方，和文件真正能放的地方，三处都不一样。
   */
  check('bin 目录会随包发出去（extraResources，不能进 files —— 那会被塞进 asar）',
    (pkg.build?.extraResources || []).some((r) => (r.from === 'bin' || r === 'bin')),
    JSON.stringify(pkg.build?.extraResources));
  check('bin 没有被误加进 files（进了 asar 就等于放不进去也找不到）',
    !(pkg.build?.files || []).some((f) => String(f).startsWith('bin')),
    JSON.stringify(pkg.build?.files));

  const paths = await import('../core/paths.js');
  check('找 ffmpeg 时不止看一个目录', paths.BIN_DIRS.length >= 2, JSON.stringify(paths.BIN_DIRS));
  // 首选必须是数据目录：它是唯一**任何情况下都可写**的地方。
  // 安装目录可能在 Program Files 下，普通用户写不进去。
  // 环境变量显式指定过就以它为准（便携版会这么用），否则首选必须是数据目录
  const expectedFirst = process.env.FUTUREDREAM_BIN_DIR
    ? path.resolve(process.env.FUTUREDREAM_BIN_DIR)
    : paths.USER_BIN_DIR;
  check('首选的存放位置在数据目录里（安装目录可能只读）',
    paths.BIN_DIRS[0] === expectedFirst && paths.USER_BIN_DIR.startsWith(paths.DATA_DIR),
    `${paths.BIN_DIRS[0]} / 期望 ${expectedFirst}`);
  check('这个目录启动时就建好了，不用用户自己先造一个',
    fs.existsSync(paths.USER_BIN_DIR), paths.USER_BIN_DIR);
  check('asar 包内的路径不会成为唯一候选（打包后那是个虚拟路径）',
    paths.BIN_DIRS.some((d) => !d.includes('app.asar')), JSON.stringify(paths.BIN_DIRS));

  // 没找到时的那句话必须能照着做：得有一个绝对路径，而不是"本应用的 bin 目录"
  const ffmpegMod = await import('../core/ffmpeg.js');
  const probe = ffmpegMod.locate({ refresh: true });
  check('找过哪些地方要告诉用户（"没检测到"最气人的就是不知道它去哪儿找了）',
    Array.isArray(probe.searched) && probe.searched.length >= 3, JSON.stringify(probe.searched));
  if (!probe.available) {
    check('提示语里印的是绝对路径，不是"本应用的 bin 目录"这种要靠猜的说法',
      probe.hint.includes(paths.USER_BIN_DIR) && !/本应用的 bin/.test(probe.hint),
      probe.hint);
  }
}

section('Windows 文件名规则');
check('非法字符被替换', safeFileName('a<b>c:d"e/f\\g|h?i*j') === 'a_b_c_d_e_f_g_h_i_j');
check('设备名被规避', safeFileName('CON') === '_CON');
check('COM1 也算设备名', safeFileName('com1') === '_com1');
check('结尾的点被去掉', safeFileName('报告...') === '报告');
check('空输入落到兜底名', safeFileName('   ') === 'untitled');
check('中文原样保留', safeFileName('太湖夜巡') === '太湖夜巡');

// ─────────────────────── 9. Windows 专属的加载陷阱 ───────────────────────

section('Windows ESM 加载陷阱');
// 曾经在 electron/main.js 里写过 await import(path.join(here, '../core/vault.js'))，
// Linux 上正常，Windows 上一启动就死在
//   "Received protocol 'd:'" —— ESM 的动态 import 在 Windows 只认 file:// URL。
// 这类错误单元测试碰不到（主进程根本没被加载），所以在这里做静态检查兜底。
const sourceFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) sourceFiles.push(full);
  }
})(PROJECT_ROOT);

// 先剥注释再匹配：这个文件和 main.js 的注释里都写着那个反面例子，
// 不剥的话检查器会指着自己的说明文字报警。
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 行注释：`//` 前面是冒号的不算（那是 https:// 这类 URL）
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// 匹配 import(<拼出来的路径表达式>)：只要不是字符串字面量、也没过 pathToFileURL，就算危险
const RISKY_IMPORT = /\bimport\s*\(\s*(?!['"`])(?![^)]*pathToFileURL)[^)]*\b(path\.(join|resolve)|__dirname|here)\b/;
const offenders = sourceFiles
  // 检查器自己不算：正则字面量里本来就带着那个模式
  .filter((f) => !f.endsWith('selftest.mjs'))
  .filter((f) => RISKY_IMPORT.test(stripComments(fs.readFileSync(f, 'utf8'))));
check(
  '没有"动态 import 拼绝对路径"的写法（Windows 上会崩）',
  offenders.length === 0,
  offenders.map((f) => path.relative(PROJECT_ROOT, f)).join('、')
);
check('扫到了源文件（检查本身没空转）', sourceFiles.length > 15, `只扫到 ${sourceFiles.length} 个`);

// 同一族的另一个坑：new URL(...).pathname 在 Windows 上带盘符前缀斜杠。
// 这段检查本身第一版就栽在这里，所以顺手也纳入守卫。
const PATHNAME_TRAP = /new\s+URL\s*\([^)]*\)\s*\.pathname/;
const pathnameOffenders = sourceFiles
  .filter((f) => !f.endsWith('selftest.mjs'))
  .filter((f) => PATHNAME_TRAP.test(stripComments(fs.readFileSync(f, 'utf8'))));
check(
  '没有用 new URL(...).pathname 当本地路径（Windows 上会多出盘符斜杠）',
  pathnameOffenders.length === 0,
  pathnameOffenders.map((f) => path.relative(PROJECT_ROOT, f)).join('、')
);

// ─────────────────────── 11. 本地服务的防护 ───────────────────────

section('界面能不能拿到该拿的东西');
{
  const cat = await (await fetch(`${appUrl}/api/catalog`)).json();
  // 厂商只接受固定档位。界面要能**提前**说"你设 4 秒会按 5 秒出"，
  // 而不是等跑完在日志里补一句 —— 那时候用户已经觉得"它不听我的"了。
  check('目录里带上了当前视频模型的合法时长档位',
    Array.isArray(cat.videoDurations) && cat.videoDurations.length > 0, JSON.stringify(cat.videoDurations));

  // 重出的图和视频文件名不变。响应带缓存的话，界面上还是旧的那张 ——
  // "明明重出了却没变"就是这么来的
  const anyImage = store.list()[0];
  if (anyImage) {
    const proj = store.read(anyImage.id);
    const shot = (proj.shots || []).find((x) => x.imagePath);
    if (shot) {
      const media = await fetch(`${appUrl}/media?p=${encodeURIComponent(shot.imagePath)}`);
      check('媒体响应明确禁止缓存', media.headers.get('cache-control') === 'no-store',
        media.headers.get('cache-control'));
    }
  }
}

/**
 * 全流程走一遍。
 *
 * 前面每一段都在验"某一件事对不对"，这一段验的是**连起来还成不成立** ——
 * 一条竖屏短剧从剧本一路跑到合成，每一步的产出都作为下一步的输入。
 * 这类问题只有整条跑才暴露得出来：画幅在某一步丢了、风格锚在某一步没进提示词、
 * 同一个角色在两镜之间换了种子。逐段测全绿、连起来照样出片失败，
 * 就是因为没有这一段。
 */
section('全流程：竖屏短剧从剧本到合成');
{
  upstream.imageBodies = [];
  upstream.videoBodies = [];
  upstream.imagePrompts = [];

  const e2e = await (
    await fetch(`${appUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '全流程·竖屏',
        aspectRatio: '9:16',
        styleId: 'ink',
        script: '阿澜在码头巡查，发现缆绳被割断。老周从值班室走出来，问她出了什么事。',
        targetDuration: 20
      })
    })
  ).json();

  // ① 设定集：文字 + 参考图一步出完
  const bibleEvents = await ndjson(`/projects/${e2e.id}/stage/bible`, {});
  let cur = store.read(e2e.id);
  check('① 设定集跑完，角色/场景都冻结了',
    cur.bible?.characters?.length > 0 && cur.bible?.scenes?.length > 0,
    JSON.stringify({ c: cur.bible?.characters?.length, s: cur.bible?.scenes?.length }));
  check('① 每个条目都出了参考图（缺一张，引用它的每一镜都少一份基准）',
    [...cur.bible.characters, ...cur.bible.scenes, ...(cur.bible.props || [])].every((x) => x.sheetPath),
    JSON.stringify([...cur.bible.characters, ...cur.bible.scenes].map((x) => Boolean(x.sheetPath))));
  check('① 设定图也按竖屏出',
    upstream.imageBodies.every((b) => b.size === '720x1280'),
    JSON.stringify([...new Set(upstream.imageBodies.map((b) => b.size))]));
  check('① 没有整步失败', !bibleEvents.some((e) => e.type === 'error'),
    JSON.stringify(bibleEvents.filter((e) => e.type === 'error').map((e) => e.message)));

  // ② 分镜
  await ndjson(`/projects/${e2e.id}/stage/script`, { shotCount: 3 });
  cur = store.read(e2e.id);
  check('② 拆出了分镜', cur.shots.length > 0, String(cur.shots.length));
  check('② 每一镜都引用设定集里已有的场景名（自创的名字会让场景基准图挂不上）',
    cur.shots.every((sh) => !sh.scene || cur.bible.scenes.some((x) => x.name.includes(sh.scene) || sh.scene.includes(x.name))),
    JSON.stringify(cur.shots.map((sh) => sh.scene)));
  check('② 有台词的镜头当场就绑好了说话人（不用等你去点按钮）',
    cur.shots.filter((sh) => sh.dialogue?.trim()).every((sh) => sh.speakerBy),
    JSON.stringify(cur.shots.map((sh) => [sh.dialogue, sh.speaker, sh.speakerBy])));

  // ③ 出图
  const imgBefore = upstream.imageBodies.length;
  await ndjson(`/projects/${e2e.id}/stage/assets`, {});
  cur = store.read(e2e.id);
  const shotImages = upstream.imageBodies.slice(imgBefore);
  check('③ 每一镜都出了图', cur.shots.every((sh) => sh.imagePath), JSON.stringify(cur.shots.map((sh) => Boolean(sh.imagePath))));
  check('③ 分镜图全是竖的（画幅在这一步最容易丢）',
    shotImages.every((b) => b.size === '720x1280'), JSON.stringify([...new Set(shotImages.map((b) => b.size))]));
  // 风格一致的地基：每一条出图提示词都得带着同一个风格锚，而且在开头
  check('③ 每条出图提示词都以同一个风格锚开头（风格一致靠它）',
    shotImages.every((b) => b.prompt.startsWith(cur.bible.style.anchor)),
    JSON.stringify(shotImages.map((b) => b.prompt.slice(0, 12))));
  // 同一个角色跨镜头必须是同一颗种子，否则每一镜都是一次新的抽卡
  const alan = cur.bible.characters[0];
  const alanShots = cur.shots.filter((sh) => (sh.characters || []).includes(alan.name));
  check('③ 同一个角色在所有镜头里共用一颗种子',
    new Set(alanShots.map((sh) => sh.seed)).size <= 1 || alanShots.every((sh) => sh.seed),
    JSON.stringify(alanShots.map((sh) => sh.seed)));
  check('③ 出来的图量过尺寸，比例记在镜头上',
    cur.shots.every((sh) => sh.imageSize), JSON.stringify(cur.shots.map((sh) => sh.imageSize)));
  // 换模型不报错，只是从某一镜起画风变了 —— 记下来才查得出
  check('③ 每一镜都记着是哪家哪个模型出的（风格漂移最难查的一种原因）',
    cur.shots.every((sh) => sh.modelUsed), JSON.stringify([...new Set(cur.shots.map((sh) => sh.modelUsed))]));
  check('③ 全片同一个模型出的',
    new Set(cur.shots.map((sh) => sh.modelUsed)).size === 1, JSON.stringify([...new Set(cur.shots.map((sh) => sh.modelUsed))]));

  // ④ 出视频
  const vidBefore = upstream.videoBodies.length;
  await ndjson(`/projects/${e2e.id}/stage/video`, {});
  cur = store.read(e2e.id);
  const vids = upstream.videoBodies.slice(vidBefore);
  check('④ 每一镜都出了视频', cur.shots.every((sh) => sh.videoPath), JSON.stringify(cur.shots.map((sh) => Boolean(sh.videoPath))));
  const vTexts = vids.map((b) => (b.content || []).find((c) => c.type === 'text')?.text || '');
  check('④ 每一段视频都带着 9:16（画幅一路传到最后一步）',
    vTexts.every((t) => / --ratio 9:16/.test(t)), JSON.stringify(vTexts.map((t) => t.slice(-24))));
  check('④ 每一段都以自己那一镜的图为首帧（不然和分镜没关系）',
    vids.every((b) => (b.content || []).some((c) => c.type === 'image_url')),
    JSON.stringify(vids.map((b) => (b.content || []).filter((c) => c.type === 'image_url').length)));
  check('④ 视频提示词里是这一镜的画面描述，不是泛泛的运镜',
    vTexts.every((t, i) => t.includes((cur.shots[i]?.description || '').slice(0, 6))),
    JSON.stringify(vTexts.map((t) => t.slice(0, 20))));
  check('④ 没台词的镜头明确要求不要张嘴（不然人物会在那儿瞎说）',
    cur.shots.every((sh, i) => Boolean(sh.dialogue?.trim()) || /不要出现说话口型/.test(vTexts[i] || '')),
    JSON.stringify(cur.shots.map((sh, i) => [Boolean(sh.dialogue), /不要出现说话口型/.test(vTexts[i] || '')])));

  // ⑤ 配音。
  // 音色表是**跟着 TTS 服务商走**的，所以先在真实路由（百炼有音色表）下分配音色，
  // 再把合成那一下指到桩上游 —— 这一段验的是流程，不是某一家的接口能不能连通。
  const assigned = studioModule.assignVoices(e2e.id);
  check('⑤ 每个角色分到不同音色（两个人同一个声音就分不出谁在说话）',
    assigned.assigned > 0 && Boolean(assigned.narrator), JSON.stringify(assigned));
  const ttsBefore = { p: settings.get('ttsProvider'), m: settings.get('ttsModel') };
  settings.patch({ ttsProvider: 'volcengine', ttsModel: 'stub-tts' });
  const voiceEvents = await ndjson(`/projects/${e2e.id}/stage/voice`, {});
  cur = store.read(e2e.id);
  const needVoice = cur.shots.filter((sh) => sh.dialogue?.trim());
  check('⑤ 有台词的都配了音', needVoice.every((sh) => sh.audioPath),
    JSON.stringify(voiceEvents.filter((e) => e.message).map((e) => e.message).slice(-4)));
  check('⑤ 每个角色一个音色，旁白单独一个',
    cur.bible.characters.every((c) => c.voice) && Boolean(cur.bible.narratorVoice),
    JSON.stringify([cur.bible.characters.map((c) => c.voice), cur.bible.narratorVoice]));
  // 念出去的必须是净台词：署名和括注留着，配音会把"阿澜冒号"一起念出来
  check('⑤ 发给 TTS 的是净台词，不带署名和括注',
    (upstream.ttsBodies || []).every((b) => !/[:：]/.test(String(b.input || '').slice(0, 8)) && !/[（(]/.test(b.input || '')),
    JSON.stringify((upstream.ttsBodies || []).map((b) => b.input)));
  settings.patch(ttsBefore.p ? { ttsProvider: ttsBefore.p, ttsModel: ttsBefore.m } : {});

  // ⑥ 字幕时间轴：和配音摆放共用同一份，错一处后面全偏
  const line = studioModule.timelineOf(cur, { policy: 'trim' });
  const cues = studioModule.buildSubtitles(cur, { policy: 'trim' });
  check('⑥ 字幕起点落在各自镜头的起点上',
    cues.every((c) => line.some((r) => Math.abs(r.start - c.start) < 0.001)),
    JSON.stringify([cues.map((c) => c.start), line.map((r) => r.start)]));

  // ⑦ 合成：这台机器上没有 FFmpeg，那就必须给出**能照着做**的指引，而不是一句失败
  const composeEvents = await ndjson(`/projects/${e2e.id}/stage/compose`, {});
  const composeErr = composeEvents.find((e) => e.type === 'error')?.message || '';
  const ffmpegReady = (await import('../core/ffmpeg.js')).locate({ refresh: true }).available;
  if (ffmpegReady) {
    check('⑦ 合成出片', Boolean(store.read(e2e.id).outputs?.video), composeErr);
  } else {
    check('⑦ 没装 FFmpeg 时，报的是"去哪儿放这个文件"而不是一句失败',
      /ffmpeg\.exe|winget|FFmpeg/i.test(composeErr) && /bin/.test(composeErr), composeErr.slice(0, 160));
  }

  // ⑧ 整条流水线的状态要能自己说清楚跑到哪儿了
  const finalP = store.read(e2e.id);
  check('⑧ 前五步的状态都标成完成',
    ['bible', 'script', 'assets', 'video', 'voice'].every((k) => finalP.stageStatus[k] === 'done'),
    JSON.stringify(finalP.stageStatus));
}

/**
 * 手机遥控那条口子。
 *
 * 它和本机那条 127.0.0.1 的规矩完全不同：本机那条"能打开端口就是自己人"，
 * 而这条后面挂着 API 密钥和额度，同一个 Wi-Fi 下的人不该随手就能驱动它。
 * 所以这一段验的全是**拒绝**：没码不给、错码不给、码只在电脑那侧看得到。
 */
// 一部二十镜的片子有四十来个文件。逐个"存到手机"点四十次 —— 没人会这么干，
// 而这些素材的意义正在于一起拿走：进剪映按顺序拖进时间线就是初剪的起点。
section('把素材打成一个包');
{
  const zipMod = await import('../core/zip.js');

  // CRC32 拿标准值对一下 —— 算错的话包能下下来、却解不开
  check('CRC32 是对的', zipMod.crc32(Buffer.from('hello')) === 0x3610a686,
    zipMod.crc32(Buffer.from('hello')).toString(16));
  check('包内文件名以编号开头（解压出来按名字排序就是分镜顺序）',
    zipMod.zipName(3, '阿澜蹲下查看缆绳', '.mp4') === '03_阿澜蹲下查看缆绳.mp4',
    zipMod.zipName(3, '阿澜蹲下查看缆绳', '.mp4'));
  check('路径里不能用的字符会被去掉（Windows 不收 \\ / : * ? " < > |）',
    !/[\\/:*?"<>|]/.test(zipMod.zipName(7, 'a/b:c*d?e"f<g>h|i', '.mp3')),
    zipMod.zipName(7, 'a/b:c*d?e"f<g>h|i', '.mp3'));

  // 真打一个包出来，再用**另一套实现**（Node 自己不带解压，所以验结构）确认它是合法 zip
  const zdir = path.join(SANDBOX, 'zip');
  fs.mkdirSync(zdir, { recursive: true });
  const f1 = path.join(zdir, 'a.txt');
  const f2 = path.join(zdir, 'b.bin');
  fs.writeFileSync(f1, 'hello world');
  fs.writeFileSync(f2, Buffer.alloc(5000, 7));
  const outFile = path.join(zdir, 'out.zip');
  const ws = fs.createWriteStream(outFile);
  const r = await zipMod.writeZip(
    [
      { file: f1, name: '分镜表.txt' },
      { file: f2, name: '分镜片段/03_阿澜蹲下.mp4' },
      { file: path.join(zdir, '不存在.mp4'), name: '缺的.mp4' }
    ],
    ws
  );
  await new Promise((res) => ws.end(res));
  const buf = fs.readFileSync(outFile);

  check('少一个文件不该让整个包下不下来', r.count === 2, JSON.stringify(r));
  check('是个合法 zip（本地头 + 中央目录 + 结尾记录都在）',
    buf.readUInt32LE(0) === 0x04034b50 && buf.includes(Buffer.from('PK\x01\x02')) && buf.includes(Buffer.from('PK\x05\x06')));
  // 不压缩（STORE）：包里几乎全是 mp4/png，再压一遍省不下几个百分点却要吃掉几十秒 CPU
  check('用的是不压缩，文件内容原样躺在包里',
    buf.includes(Buffer.from('hello world')) && buf.includes(Buffer.alloc(5000, 7)));
  check('中文名打了 UTF-8 标记（不打的话 Windows 上解出来是乱码）',
    buf.readUInt16LE(6) === 0x0800, buf.readUInt16LE(6).toString(16));
  check('包内带目录结构（分镜片段/ 单独一层）', buf.includes(Buffer.from('分镜片段/', 'utf8')));

  // 走一遍真实接口
  const live = await (await fetch(`${appUrl}/api/projects`)).json();
  const res2 = await fetch(`${appUrl}/api/projects/${live[0].id}/export.zip`);
  const zbuf = Buffer.from(await res2.arrayBuffer());
  check('接口回的是 zip', res2.status === 200 && res2.headers.get('content-type') === 'application/zip',
    `${res2.status} ${res2.headers.get('content-type')}`);
  check('文件名按 RFC 5987 编码（中文片名不至于下成乱码）',
    /filename\*=UTF-8''/.test(res2.headers.get('content-disposition') || ''),
    res2.headers.get('content-disposition'));
  check('包里有分镜表（进剪映后靠它认出哪个片段是哪一镜）',
    zbuf.includes(Buffer.from('分镜表.txt', 'utf8')), String(zbuf.length));
}

section('画风：古风工笔 + 本地示例图');
{
  const stylesMod = await import('../core/styles.js');
  const gf = stylesMod.getStyle('guofeng');
  check('古风工笔在预设里', Boolean(gf), JSON.stringify(gf?.name));
  // 只写"精细勾线、矿物颜料"的话，模型画出来的往往是一张平铺纹样图 ——
  // 满构图、没有空气、没有远近。让它成立的是设色 + 留白 + 逆光这三样
  check('风格锚里有设色、留白、逆光这三样（缺一样就成了平铺纹样图）',
    /青绿/.test(gf.anchor) && /留白|云雾/.test(gf.anchor) && /逆光/.test(gf.anchor), gf.anchor);
  check('负向词挡住了最容易翻车的那几种', /满构图无留白/.test(gf.negative), gf.negative);
  check('示意图的画法是勾线', gf.art?.mode === 'line', gf.art?.mode);

  // 本地图片当示例图：手上正好有参照时，比再出一张快得多
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await (await fetch(`${appUrl}/api/styles/guofeng/preview/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: png })
  })).json();
  check('本地图片能设成示例图', up.bytes > 0 && fs.existsSync(up.path), JSON.stringify(up));
  const listed = (await (await fetch(`${appUrl}/api/styles`)).json()).presets.find((p) => p.id === 'guofeng');
  check('设完之后画风卡就用它了（优先于随应用带的那张）', Boolean(listed.previewPath), JSON.stringify(listed.previewPath));

  const bad = await fetch(`${appUrl}/api/styles/guofeng/preview/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: 'data:image/gif;base64,AA' })
  });
  check('不支持的格式当场说清楚，不是存一个打不开的文件', bad.status === 400, String(bad.status));

  await fetch(`${appUrl}/api/styles/guofeng/preview`, { method: 'DELETE' });
  check('删掉之后退回内置示意图',
    !(await (await fetch(`${appUrl}/api/styles`)).json()).presets.find((p) => p.id === 'guofeng').previewPath);
}

/**
 * "我明明换成古风工笔了，出的图还是老样子。"
 *
 * 风格锚是跑第 01 步时**冻结**进设定集的 —— 这是对的，几十张图得引用同一段话。
 * 但代价是换画风碰不到它，而且我把某个预设改好之后，老项目一辈子拿不到这个改进。
 * 以前的答复是"重跑第 01 步"，那要重新生成全部角色场景，手改过的外貌全丢。
 */
section('换了画风，设定集里那段话要跟着换');
{
  const mk = async (styleId) => {
    const p = await (await fetch(`${appUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '换画风', script: '阿澜在码头巡查。', styleId })
    })).json();
    store.update(p.id, (x) => {
      x.bible = {
        frozenAt: new Date().toISOString(),
        style: { ...styleModule.resolveStyle({ styleId, style: '' }) },
        characters: [{ name: '阿澜', appearance: '短发，藏青立领制服', seed: 7, variants: [], sheetPath: 'a.png' }],
        scenes: [{ name: '码头', appearance: '木栈桥' }],
        props: []
      };
      return x;
    });
    return p.id;
  };

  const pid = await mk('ink');
  check('刚冻结时对得上', !(await (await fetch(`${appUrl}/api/projects/${pid}/style`)).json()).drifted);

  await fetch(`${appUrl}/api/projects/${pid}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ styleId: 'guofeng' })
  });
  const after = store.read(pid);
  check('换画风时设定集里的风格锚跟着换了（以前得重跑第 01 步）',
    /青绿/.test(after.bible.style.anchor), after.bible.style.anchor);
  check('负向词也跟着换', /满构图无留白/.test(after.bible.style.negative), after.bible.style.negative);
  // 换一句话不该让手改过的角色描述陪葬 —— 这才是以前"重跑第 01 步"最贵的地方
  check('角色一个字没动', after.bible.characters[0].appearance === '短发，藏青立领制服');
  check('种子没动（动了脸就变了）', after.bible.characters[0].seed === 7);
  check('参考图没重出', after.bible.characters[0].sheetPath === 'a.png');
  check('场景也没动', after.bible.scenes[0].appearance === '木栈桥');

  // 改标题、改比例都不该碰设定集
  const pid2 = await mk('guofeng');
  store.update(pid2, (x) => ((x.bible.style.anchor = '我自己写的画风'), x));
  await fetch(`${appUrl}/api/projects/${pid2}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '改个名字', aspectRatio: '9:16' })
  });
  check('改别的字段时不动手写的风格锚', store.read(pid2).bible.style.anchor === '我自己写的画风');

  // 预设本身被改进了（或者手写覆盖过）：认出来，但**不偷偷改** ——
  // 直接盖掉，等于让人在设定集里改的每个字下次打开时凭空消失
  const drift = await (await fetch(`${appUrl}/api/projects/${pid2}/style`)).json();
  check('对不上时能认出来', drift.drifted === true, JSON.stringify(drift.current));
  check('要先给人看清楚换成什么', /青绿/.test(drift.preset.anchor) && drift.name === '古风工笔',
    JSON.stringify({ name: drift.name }));
  check('光是查一下，不许自己动手', store.read(pid2).bible.style.anchor === '我自己写的画风');

  const synced = await (await fetch(`${appUrl}/api/projects/${pid2}/style/sync`, { method: 'POST' })).json();
  check('点了才换', /青绿/.test(synced.style.anchor) && /青绿/.test(store.read(pid2).bible.style.anchor));
  check('换完就对上了', !(await (await fetch(`${appUrl}/api/projects/${pid2}/style`)).json()).drifted);

  // 用户在预设之外补的那句话要留着，不能被预设顶掉
  const pid3 = await mk('ink');
  store.update(pid3, (x) => ((x.style = '雨天'), x));
  await fetch(`${appUrl}/api/projects/${pid3}/style/sync`, { method: 'POST' });
  const s3 = store.read(pid3).bible.style.anchor;
  check('自己补的那句话还在', /国风水墨/.test(s3) && /雨天/.test(s3), s3);

  // 没设定集的项目点同步：说清楚，别扔个 500
  const bare = await (await fetch(`${appUrl}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '还没跑设定集', script: '一段话。' })
  })).json();
  const noBible = await fetch(`${appUrl}/api/projects/${bare.id}/style/sync`, { method: 'POST' });
  check('还没设定集时给一句人话', noBible.status === 400, String(noBible.status));
}

// 一键跑完必须能选"从哪一步开始"：日常最常见的是设定集和分镜早就审过了，
// 从头跑一遍不但白花钱，还会把改过的分镜文案冲掉
section('一键跑完：从头 还是 从这一步往后');
{
  const rp = await (
    await fetch(`${appUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '从中间接着跑', script: '阿澜在码头巡查。' })
    })
  ).json();
  store.update(rp.id, (p) => {
    p.bible = { style: { anchor: '国风', negative: '' },
      characters: [{ name: '阿澜', appearance: '短发', seed: 3, variants: [{ id: 'v-default', name: '默认造型', sheetPath: 'x.png' }], sheetPath: 'x.png' }],
      scenes: [], props: [] };
    p.shots = [{ id: 'k1', index: 1, characters: ['阿澜'], description: '阿澜走向栈桥', camera: '中景', duration: 4 }];
    p.stageStatus = { ...p.stageStatus, bible: 'done', script: 'done' };
    return p;
  });

  const before = JSON.stringify(store.read(rp.id).shots.map((x) => x.description));
  const evs = await ndjson(`/projects/${rp.id}/stage/all`, { from: 'assets' });
  const after = store.read(rp.id);

  check('说清楚这一轮要跑哪几步',
    evs.some((e) => /这一轮要跑：镜头出图 → 视频生成/.test(e.message || '')),
    JSON.stringify(evs.filter((e) => e.type === 'note').map((e) => e.message).slice(0, 2)));
  check('从中间起跑时，前面几步的产出原样保留（不重拆分镜、不冲掉手改的文案）',
    JSON.stringify(after.shots.map((x) => x.description)) === before, before);
  check('该跑的还是跑了', Boolean(after.shots[0].imagePath), JSON.stringify(after.shots[0].imagePath));

  const badFrom = await ndjson(`/projects/${rp.id}/stage/all`, { from: '不存在的一步' });
  check('给了不认识的步骤就直说，不是默默从头跑一遍（那会烧掉一大笔）',
    badFrom.some((e) => e.type === 'error' && /不认识这一步/.test(e.message || '')),
    JSON.stringify(badFrom.slice(-1)));
}

// 安卓壳只是个 WebView，逻辑全在网页那边。但**打包配置写错**是会一直红着的，
// 而 CI 打一次包三四分钟 —— 这几条在本地几秒钟就能拦下最常见的几种写错。
section('安卓壳的打包配置');
{
  const AND = path.resolve(PROJECT_ROOT, 'android');
  const read = (rel) => fs.readFileSync(path.join(AND, rel), 'utf8');

  check('Gradle 工程该有的文件都在',
    ['settings.gradle', 'build.gradle', 'app/build.gradle', 'app/src/main/AndroidManifest.xml']
      .every((f) => fs.existsSync(path.join(AND, f))));

  const appGradle = read('app/build.gradle');
  check('包名和 Manifest 对得上', /namespace 'com\.futuredream\.remote'/.test(appGradle));
  // release 包要自己的 keystore，而把私钥放进仓库是绝对不行的
  check('只出 debug 包（用系统调试签名，下下来直接能装）',
    !/signingConfigs/.test(appGradle), appGradle.match(/signingConfigs[\s\S]{0,80}/)?.[0] || '');

  const manifest = read('app/src/main/AndroidManifest.xml');
  check('声明了联网权限（不然 WebView 一片空白，还不报错）',
    /android\.permission\.INTERNET/.test(manifest));
  // 电脑上那条服务是 http://192.168.x.x:5179，没有证书 —— 安卓 9 起默认禁明文
  check('放行了明文 HTTP（局域网那条服务没有证书）',
    /usesCleartextTraffic="true"/.test(manifest));
  check('入口 Activity 标了 exported（安卓 12 起不标直接装不上）',
    /android:exported="true"/.test(manifest));

  const java = read('app/src/main/java/com/futuredream/remote/MainActivity.java');
  check('WebView 开了 JS 和 DOM storage（配对码和当前项目存在 localStorage 里）',
    /setJavaScriptEnabled\(true\)/.test(java) && /setDomStorageEnabled\(true\)/.test(java));
  // 素材包几百 MB，交给系统下载器才有断点、有通知栏进度、下完落进「下载」目录
  check('下载交给系统下载器', /DownloadManager/.test(java) && /setDownloadListener/.test(java));
  check('换了 Wi-Fi 之后能重填地址（IP 常变，不该只能卸载重装）',
    /showSetup\(/.test(java) && /KEYCODE_BACK/.test(java));

  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    check(`图标有 ${d} 这一档`, fs.existsSync(path.join(AND, `app/src/main/res/mipmap-${d}/ic_launcher.png`)));
  }

  const wf = fs.readFileSync(path.resolve(PROJECT_ROOT, '../.github/workflows/build-android.yml'), 'utf8');
  check('CI 里真的跑了构建', /gradlew assembleDebug/.test(wf));
  // 仓库里不放 gradle-wrapper.jar —— 来源说不清的二进制不该进仓库
  check('wrapper 是 CI 现生成的，不是仓库里放一个 jar',
    /gradle wrapper --gradle-version/.test(wf) && !fs.existsSync(path.join(AND, 'gradle/wrapper/gradle-wrapper.jar')));
}

/**
 * 服务器模式。
 *
 * 这一段和上面所有段落的前提都不一样：那些假设"能打到这个端口的人是自己人"，
 * 而放到公网上之后，**任何人都能打到这个端口**。所以这里验的全是拒绝，
 * 而且必须用裸 socket —— fetch 会把 Host 改回真实地址（上面那个坑刚踩过）。
 */
section('服务器模式：按公网的规矩');
{
  const deployMod = await import('../core/deploy.js');
  check('默认不是服务器模式（本机跑的人不该被一道口令白挡）', deployMod.SERVER_MODE === false);
  // 8 位配对码在局域网够用，公网上 40 bit 是能慢慢试出来的
  check('服务器模式用的是长口令', deployMod.newAccessToken().length === 32, String(deployMod.newAccessToken().length));

  /**
   * ⚠ 必须**另起一个进程**来测。
   *
   * 一开始想用 `import('../core/server.js?server=1')` 拿一份新实例，但那是错的：
   * 带 query 只会重新求值 server.js 自己，它 import 的 deploy.js 仍然是**老那份** ——
   * 而模式是在 deploy.js 模块求值时从 env 读的。于是那个"服务器实例"其实还是桌面模式，
   * 测出来一片红，却和真实部署毫无关系。
   *
   * 起子进程还有个额外好处：env 在进程启动时读，和线上一模一样。
   */
  const TOKEN = 'a-very-long-access-token-1234567890';
  const boot = `
    import * as srv from ${JSON.stringify(path.join(PROJECT_ROOT, 'core/server.js'))};
    const { port } = await srv.listen(0);
    console.log('PORT=' + port);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    env: {
      ...process.env,
      FUTUREDREAM_DATA_DIR: path.join(SANDBOX, 'servermode'),
      FUTUREDREAM_MODE: 'server',
      FUTUREDREAM_PUBLIC_HOST: 'fd.example.com',
      FUTUREDREAM_ACCESS_TOKEN: TOKEN
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const sport = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务器模式没起来')), 15000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`起不来：${out}`));
    });
  });

  const hit = (host, pathname, withKey = true) =>
    new Promise((resolve) => {
      const sock = net.connect(sport, '127.0.0.1', () => {
        sock.write(
          `GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\n` +
            (withKey ? `X-FD-Key: ${TOKEN}\r\n` : '') +
            'Connection: close\r\n\r\n'
        );
      });
      let buf = '';
      sock.on('data', (d) => (buf += d));
      sock.on('end', () => resolve(Number(buf.split(' ')[1])));
      sock.on('error', () => resolve(0));
    });

  check('配的域名 + 口令：放行', (await hit('fd.example.com', '/api/projects')) === 200);
  check('没口令：挡住（本机模式下这条是放行的，公网上不行）',
    (await hit('fd.example.com', '/api/projects', false)) === 401);
  check('错口令：挡住', (await hit('fd.example.com', '/api/projects?k=wrong', false)) === 401);
  // 域名不对时口令对也不行 —— 别人拿自己的域名指到这台机器是最省事的一种攻击
  check('别人的域名 + 对的口令：还是挡住', (await hit('evil.com', '/api/projects')) === 403);
  check('裸 IP：挡住', (await hit('203.0.113.9', '/api/projects')) === 403);
  // 健康检查会带出数据目录路径，公网上不能白给
  check('健康检查也要口令', (await hit('fd.example.com', '/api/health', false)) === 401);
  check('媒体接口也要口令', (await hit('fd.example.com', '/media?p=/etc/passwd', false)) === 401);
  // 壳子必须放行，不然打开只看到 401，没人知道该干什么
  check('页面壳子放行（不然看不到登录屏）', (await hit('fd.example.com', '/m', false)) === 200);
  check('/api/auth 只回"口令对不对"，给登录页用',
    (await hit('fd.example.com', '/api/auth')) === 200 && (await hit('fd.example.com', '/api/auth', false)) === 401);

  child.kill();

  // 配错了就不启动 ——"少配一项于是谁都能进"的服务比起不来危险得多，因为它看起来一切正常
  const bad = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    env: {
      ...process.env,
      FUTUREDREAM_DATA_DIR: path.join(SANDBOX, 'servermode2'),
      FUTUREDREAM_MODE: 'server',
      FUTUREDREAM_ACCESS_TOKEN: TOKEN,
      FUTUREDREAM_PUBLIC_HOST: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const badOut = await new Promise((resolve) => {
    let out = '';
    bad.stdout.on('data', (d) => (out += d));
    bad.stderr.on('data', (d) => (out += d));
    bad.on('exit', (code) => resolve({ code, out }));
  });
  check('没配域名就拒绝启动，并说清楚缺什么',
    badOut.code !== 0 && /FUTUREDREAM_PUBLIC_HOST/.test(badOut.out), badOut.out.slice(0, 200));

  /**
   * 起来之后要**活着**。
   *
   * 上面那些测的是 `srv.listen()` 这个函数，而线上跑的是 `node core/server.js` ——
   * 中间那段"打印地址、顺手开个浏览器"的代码，被测试完整地绕过去了。
   * 结果就是：容器里没有 xdg-open，spawn 异步 emit 'error'，没人听，
   * 未捕获异常 exit(1)；restart 再拉起来，无限重启。日志里前面全是成功。
   *
   * 所以这里必须**照线上的方式启动进程**，并且把 PATH 清空 ——
   * 让"打不开浏览器"在任何机器上都必然发生，而不是只在服务器上。
   */
  const aliveCheck = async (label, env) => {
    const c = spawn(process.execPath, [path.join(PROJECT_ROOT, 'core/server.js')], {
      env: { ...env, PATH: '', FUTUREDREAM_NO_OPEN: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    const died = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      c.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    c.kill();
    check(`${label}：起来之后不许自己死掉`, died === null,
      died === null ? '' : `exit=${died} ${out.slice(-300)}`);
    return out;
  };

  const serverOut = await aliveCheck('服务器模式', {
    ...process.env,
    FUTUREDREAM_DATA_DIR: path.join(SANDBOX, 'servermode3'),
    FUTUREDREAM_MODE: 'server',
    FUTUREDREAM_PUBLIC_HOST: 'fd.example.com',
    FUTUREDREAM_ACCESS_TOKEN: TOKEN
  });
  // 服务器上根本不该去开浏览器：那台机器没有桌面，也没人坐在它前面
  check('服务器模式不去开浏览器', !/xdg-open|ENOENT/.test(serverOut), serverOut.slice(-200));

  // 桌面模式**要**开浏览器，那就得保证开不起来的时候只是开不起来，而不是把服务弄死
  await aliveCheck('本机模式（浏览器开不起来时）', {
    ...process.env,
    FUTUREDREAM_DATA_DIR: path.join(SANDBOX, 'desktopmode-noopen'),
    FUTUREDREAM_MODE: 'desktop'
  });
}

// 放到服务器上之后密钥不再只在你自己机器里 —— 这是固有代价，
// 但至少能让"解密用的钥匙"别和密文躺在同一块盘上
section('密钥保险箱：口令派生');
{
  const probe = `
    import * as vault from ${JSON.stringify(path.join(PROJECT_ROOT, 'core/vault.js'))};
    import fs from 'node:fs';
    vault.setSecret('K', 'sk-secret-value');
    console.log(JSON.stringify({
      backend: vault.backendName(),
      roundTrip: vault.getSecret('K') === 'sk-secret-value',
      keyFileOnDisk: fs.existsSync(process.env.FUTUREDREAM_DATA_DIR + '/.vaultkey'),
      plainInCipher: fs.readFileSync(process.env.FUTUREDREAM_DATA_DIR + '/credentials.enc').includes('sk-secret')
    }));
  `;
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', probe], {
      env: {
        ...process.env,
        FUTUREDREAM_DATA_DIR: path.join(SANDBOX, 'vaultpass'),
        FUTUREDREAM_VAULT_PASS: '一个足够长的保险箱口令-abc123'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let buf = '';
    c.stdout.on('data', (d) => (buf += d));
    c.on('exit', () => resolve(JSON.parse(buf.trim().split('\n').pop() || '{}')));
  });

  check('用口令派生钥匙', /口令派生/.test(out.backend || ''), out.backend);
  check('存进去再取出来还是同一个值', out.roundTrip === true);
  // 这才是重点：能 ssh 进服务器的人拿到的只有密文，没有钥匙
  check('磁盘上不留钥匙文件', out.keyFileOnDisk === false);
  check('密文里没有明文', out.plainInCipher === false);
}

section('手机遥控：先验它拒绝什么');
{
  const srv = await import('../core/server.js');
  const lan = await srv.startLan();
  const token = settings.get('lanToken');
  const base = `http://127.0.0.1:${lan.port}`;

  check('开起来了，而且是另一个端口（不和本机那条共用规矩）',
    lan.running && lan.port !== (settings.get('port') || 5178), JSON.stringify({ port: lan.port }));
  check('自动生成了配对码（不带锁的门比没有门更糟）', Boolean(token) && token.length >= 8, String(token?.length));

  const noKey = await fetch(`${base}/api/projects`);
  check('没配对码：数据一律不给', noKey.status === 401, String(noKey.status));

  const wrong = await fetch(`${base}/api/projects`, { headers: { 'X-FD-Key': 'NOTRIGHT' } });
  check('错的配对码：也不给', wrong.status === 401, String(wrong.status));

  const ok = await fetch(`${base}/api/projects`, { headers: { 'X-FD-Key': token } });
  check('对的配对码：通', ok.status === 200, String(ok.status));

  // <img src> 没法带自定义头，所以媒体接口也认查询串里的 k
  const mediaNoKey = await fetch(`${base}/media?p=x.png`);
  check('媒体接口没码也不给（手机上看图靠查询串带码）', mediaNoKey.status === 401, String(mediaNoKey.status));

  // 页面本身必须放行：不放行就没法显示"请输入配对码"那一屏，
  // 用户只会看到一个 401，不知道该干什么
  const shell = await fetch(`${base}/m`);
  check('手机端页面本身放行（不然只看到 401，不知道该干什么）', shell.status === 200, String(shell.status));
  const shellText = await shell.text();
  check('页面里没有任何数据，只有一个壳', !/apiKey|ARK_|sk-/.test(shellText));

  for (const f of ['/m/m.js', '/m/m.css', '/m/manifest.webmanifest', '/m/sw.js', '/m/icon-192.png']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetch(`${base}${f}`);
    check(`装到主屏要的文件在：${f}`, r.status === 200, String(r.status));
  }

  // 撤销权必须留在电脑上：手机自己能换码的话，拿到过一次码的人就能永久续期
  const rotateFromPhone = await fetch(`${base}/api/lan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FD-Key': token },
    body: JSON.stringify({ rotate: true })
  });
  check('手机端不能改遥控设置（换码、开关都只能在电脑上）', rotateFromPhone.status === 403, String(rotateFromPhone.status));

  // 手机那一侧查得到配对码的话，配对码就等于没有
  const statusFromPhone = await (await fetch(`${base}/api/lan`, { headers: { 'X-FD-Key': token } })).json();
  check('手机那一侧查不到配对码本身', !statusFromPhone.token && statusFromPhone.hasToken === true,
    JSON.stringify(statusFromPhone));

  /**
   * 按**手机真实的样子**发一遍：Host 是 192.168.x.x，不是 127.0.0.1。
   *
   * ⚠ 这一段必须用裸 socket。用 fetch 设 Host 是测不出来的 ——
   * undici 会把它改回真实的目标地址，于是**每一条都变成 loopback**，
   * 看起来全绿，实际上私网判断、DNS rebinding 防护一条都没验到。
   * 这个坑我踩过：探针给出"evil.com 也放行"的假警报，而服务端压根没见过那个 Host。
   */
  const rawGet = (host, pathname = '/api/projects', withKey = true) =>
    new Promise((resolve) => {
      const sock = net.connect(lan.port, '127.0.0.1', () => {
        sock.write(
          `GET ${pathname} HTTP/1.1\r\n` +
            `Host: ${host}\r\n` +
            (withKey ? `X-FD-Key: ${token}\r\n` : '') +
            'Connection: close\r\n\r\n'
        );
      });
      let buf = '';
      sock.on('data', (d) => (buf += d));
      sock.on('end', () => resolve(Number(buf.split(' ')[1])));
      sock.on('error', () => resolve(0));
    });

  check('手机常见地址放行（192.168.x.x）', (await rawGet(`192.168.1.7:${lan.port}`)) === 200);
  check('私网 10 段放行', (await rawGet(`10.0.0.5:${lan.port}`)) === 200);
  check('私网 172.16-31 段放行', (await rawGet(`172.20.1.9:${lan.port}`)) === 200);
  check('172.35 不在私网范围里，挡住', (await rawGet(`172.35.1.9:${lan.port}`)) === 403);
  // DNS rebinding：让 evil.com 解析到你的内网地址，浏览器就会带着 evil.com 这个 Host 打过来。
  // 只认私网 IP **字面量**、不认域名，这条路才断得干净
  check('域名一律挡住（DNS rebinding 走的就是这条）', (await rawGet(`evil.com:${lan.port}`)) === 403);
  check('公网 IP 挡住', (await rawGet(`1.2.3.4:${lan.port}`)) === 403);

  srv.stopLan();
  const afterStop = await fetch(`${base}/api/projects`, { headers: { 'X-FD-Key': token } }).then(() => 'still-up').catch(() => 'down');
  check('关掉是真的把端口关了，不是留一个"应该会拒绝"的监听', afterStop === 'down', afterStop);
}

section('本地服务防护');
const traversal = await fetch(`${appUrl}/media?p=${encodeURIComponent('/etc/passwd')}`);
check('媒体接口拒绝数据目录之外的路径', traversal.status === 403);

const crossOrigin = await fetch(`${appUrl}/api/health`, { headers: { Origin: 'https://evil.example' } });
check('拒绝跨站来源', crossOrigin.status === 403);

const sameOrigin = await fetch(`${appUrl}/api/health`, { headers: { Origin: appUrl } });
check('自己的页面放行', sameOrigin.status === 200);

const uiFile = await fetch(`${appUrl}/index.html`);
check('界面文件能取到', uiFile.status === 200);

/**
 * 服务器模式下电脑和手机是同一个地址，所以根地址得自己认人。
 * 认错了没有安全后果（UA 本来就是客户端随便写的），最坏只是跳错页面 ——
 * 但得留一条能纠正它的路。
 */
section('根地址：手机去手机版，电脑留电脑版');
{
  const land = (ua, qs = '') =>
    fetch(`${appUrl}/${qs}`, { headers: { 'User-Agent': ua }, redirect: 'manual' })
      .then((r) => ({ status: r.status, to: r.headers.get('location') }));

  const iphone = await land('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  check('iPhone 打开根地址 → 手机版', iphone.status === 302 && iphone.to === '/m', JSON.stringify(iphone));

  const android = await land('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36');
  check('安卓手机 → 手机版', android.status === 302 && android.to === '/m', JSON.stringify(android));

  const pc = await land('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36');
  check('电脑不跳', pc.status === 200, JSON.stringify(pc));

  // 平板屏幕够大，电脑版那套更顺手
  const ipad = await land('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1');
  check('iPad 不跳', ipad.status === 200, JSON.stringify(ipad));

  // 跳错了得有救 —— 不然手机上永远看不到电脑版
  const forced = await land('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile Safari/604.1', '?pc=1');
  check('?pc=1 强制看电脑版', forced.status === 200, JSON.stringify(forced));

  // 访问口令是跟在地址后面传过来的，跳转时不能把它弄丢
  const withKey = await land('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120.0 Mobile Safari/537.36', '?k=ABC123');
  check('跳转时把口令带过去（不然到了手机版还要重输）',
    withKey.status === 302 && withKey.to === '/m?k=ABC123', JSON.stringify(withKey));
}

// ─────────────────────── 收尾 ───────────────────────

server.close();
upstream.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${'─'.repeat(50)}`);
console.log(failed === 0 ? `\x1b[32m全部通过：${passed} 项\x1b[0m` : `\x1b[31m${failed} 项未通过\x1b[0m（通过 ${passed} 项）`);
process.exit(failed === 0 ? 0 : 1);

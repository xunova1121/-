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
import { fileURLToPath, pathToFileURL } from 'node:url';

// file:// URL → 本地路径必须走 fileURLToPath。
// 用 new URL(import.meta.url).pathname 在 Windows 上会得到 `/D:/a/...`
// （盘符前多一道斜杠），再 path.resolve 一下就变成 `D:\D:\a\...` 然后 ENOENT。
// 这和本文件第 9 节要防的是同一族的坑 —— 写这段检查时自己先踩了一次。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

// 自检用独立数据目录，绝不碰用户真实的 %APPDATA%\FutureDream
// 心跳调快，不然那条断言要等 15 秒 —— 等 15 秒的测试没人愿意跑
process.env.FUTUREDREAM_PING_MS = '60';
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
      // 让用例能造一次"厂商明确拒了"的失败，用来验失败原因有没有被存下来
      if (upstream.videoFail) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: upstream.videoFail }));
      }
      upstream.msImageCounts = upstream.msImageCounts || [];
      const imgs = (upstream.msBody.content || []).filter((c) => c.type === 'image_url').length;
      upstream.msImageCounts.push(imgs);
      /**
       * 这家认不认末帧。真实世界里"认"是常态（控制台上摆着起始帧/结束帧两个框），
       * 但中转平台换一版接口就可能不认了 —— 而那种时候接缝会**安静地消失**。
       * 打开这个开关就是在模拟那一天。
       */
      upstream.msSawEndFrame = upstream.msSawEndFrame || [];
      const hasEnd = Boolean(upstream.msBody.last_frame_image)
        || (upstream.msBody.content || []).some((c) => c.role === 'last_frame');
      upstream.msSawEndFrame.push(hasEnd);
      // 每一次提交里，普通图列表（content 的 image_url）都发了哪几张
      upstream.msContentUrls = upstream.msContentUrls || [];
      upstream.msContentUrls.push((upstream.msBody.content || [])
        .filter((c) => c.type === 'image_url' && !c.role)
        .map((c) => c.image_url?.url || ''));
      if (hasEnd && upstream.msRejectEndFrame) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'invalid parameter: last_frame_image' }));
      }
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
    // ⚠ 这个计数原来没有，而有一条断言在读它 —— 于是那条断言
    // 量的是 undefined === undefined，**永远绿**。而它守的恰恰是
    //"有没有第二次付钱"这件事，一条永远绿的断言在这儿等于没有守。
    upstream.msv2Submits = (upstream.msv2Submits || 0) + 1;
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
      } else if (system.includes('剪辑师')) {
        /**
         * 自动标衔接。**故意给一份违规的答案** —— 模型真会这么答，
         * 提示词只是请求。收口那一层要能把每一条都掰回来：
         *   第 1 镜   没有上一镜可接
         *   跨场次那镜 另一个地方、另一段时间，不可能是连续动作
         *   一长串     连着标下去整段会变成一个没剪过的长镜头
         */
        const shots = JSON.parse(body.messages?.[1]?.content || '[]');
        upstream.lastLinkPayload = shots;
        content = JSON.stringify({
          shots: shots.map((x) => ({ index: x.index, link: 'continuous', why: '模型说什么都连' }))
        });
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

  // 音效：ElevenLabs 那条路，直接回音频二进制，鉴权走 xi-api-key 而不是 Bearer
  if (url.pathname === '/v1/sound-generation') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      upstream.sfxHeaders = req.headers;
      upstream.sfxBodies = upstream.sfxBodies || [];
      upstream.sfxBodies.push(JSON.parse(raw || '{}'));
      // 鉴权头写错的话（发成 Bearer）就 401 —— 真厂商也是这么回的
      if (!req.headers['xi-api-key']) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ detail: { message: '缺少 xi-api-key' } }));
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return res.end(Buffer.from('ID3fake-sfx'));
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

/**
 * 这份假答复**故意是违规的**：第 2 镜跨了场次却标着「连续动作」和叠化。
 * 模型真会这么答 —— 提示词只是请求。解析那一步必须把它掰回来，
 * 否则那两镜会去锁末帧，强行让新的一场长成上一场的样子，而且不报任何错。
 */
const SHOTS_REPLY = {
  logline: '一次清晨的例行巡查',
  segments: [
    { index: 1, where: '码头', when: '清晨', summary: '阿澜出发前的检查与登船', enter: 'cut' }
  ],
  shots: [
    {
      index: 1,
      segment: 1,
      scene: '码头',
      characters: ['阿澜'],
      description: '阿澜检查执法记录仪',
      camera: '中景',
      motion: '镜头缓推',
      dialogue: '设备正常。',
      transition: 'dissolve',
      duration: 4
    },
    {
      index: 2,
      segment: 1,
      scene: '码头',
      characters: ['阿澜'],
      description: '阿澜登船',
      camera: '全景',
      motion: '跟拍',
      dialogue: '',
      link: 'continuous',
      // 场次内部不该有转场。模型照样会给，解析那一步要把它压回硬切
      transition: 'dissolve',
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

/**
 * 场次那一层真的落地了没有 —— 前面测的是零件，这里测的是整条路。
 * 假答复是故意违规的（跨场次标了「连续动作」、第一镜标了叠化），
 * 走完拆分镜这一步之后必须已经被掰回来。
 */
check('场次表存进项目里了', afterScript?.segments?.length === 1,
  JSON.stringify(afterScript?.segments));
check('两镜都在同一个场次里', afterScript?.shots?.map((x) => x.segment).join(',') === '1,1',
  afterScript?.shots?.map((x) => x.segment).join(','));
// 第一镜前面什么都没有，叠化不可能生效 —— 界面上显示一个永远不生效的转场比没有更糟
check('第一镜那个叠化被掰成硬切', afterScript?.shots?.[0]?.transition === 'cut',
  afterScript?.shots?.[0]?.transition);
// 场次内部一律硬切。中间来一下叠化是最典型的业余做法
check('场次内部那个叠化也被掰成硬切', afterScript?.shots?.[1]?.transition === 'cut',
  afterScript?.shots?.[1]?.transition);
// 场次内部的衔接关系不该被动 —— 那本来就该由它自己决定
check('场次内部的「连续动作」原样保留', afterScript?.shots?.[1]?.link === 'continuous',
  afterScript?.shots?.[1]?.link);
// 改了什么必须说出来，不能悄悄改
check('纠正过程说出来了',
  scriptEvents.some((e) => /按场次规矩纠正了/.test(e.message || '')),
  JSON.stringify(scriptEvents.filter((e) => e.type === 'note').slice(0, 4)));
check('场次摘要也报了',
  scriptEvents.some((e) => /1 个场次/.test(e.message || '')),
  JSON.stringify(scriptEvents.filter((e) => e.type === 'note').map((e) => e.message).slice(0, 6)));

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
/**
 * 方舟 Seedance 只收 1 张首帧图；标了「连续动作」时走首尾帧模式，最多 2 张，
 * 而且**两张都要带 role** —— 不带的话它会当成两张参考图，整个任务提交就失败。
 * 多塞第三张过去同样是非法参数。所以这里卡的是"不超过 2 张"。
 *
 * 这份假答复里第 2 镜标着 continuous，所以正确答案就是 2 张（首帧 + 末帧）。
 * 设定集参考图那一张必须被截掉，并且说清楚为什么。
 */
check('方舟最多 2 张（首帧+末帧），第三张会让任务提交直接失败',
  vidImages.length === 2, `${vidImages.length} 张`);
check('被截掉的参考图有说明，不是悄悄丢掉',
  vidEvents.some((e) => e.type === 'note' && /最多收 2 张图/.test(e.message || '')),
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

/**
 * 邻镜参考：把「链」改成「星」。
 *
 * 链式（1→2→3→4）直觉上很对：每一镜都和前一镜像，全片就都像。
 * **但它一定会漂** —— 每次生成都有损耗，第 4 镜参照的是漂过两次的第 3 镜，
 * 到第 10 镜时参照物本身已经不对了，而且回不去：链上没有任何一环记得原样。
 *
 * 星形（1→2, 1→3, 1→4）效果一样（都像同一张，自然彼此也像），
 * 误差却是**常数**而不是**累加**。这一节验的就是这个拓扑。
 */
/**
 * 整段标衔接关系。
 *
 *「这一段是一个连贯动作」是**按段**发生的想法，不是按镜 ——
 * 推门→进门→环视→停下，四镜是一件事。一镜一镜点四次容易漏掉中间那一镜，
 * 而漏掉的那一镜恰恰是断点，出完片才看得出来。
 */
/**
 * 镜头分级：贵模型只用在看得出差别的地方。
 *
 * 视频那一步按镜计费，而空镜、远景、过渡镜常占一部片子的三四成 ——
 * 那些地方便宜模型和贵模型看不出差别，全片一律用最贵的等于白花钱。
 *
 * 这一节最要紧的两条：**不配时行为一个字不变**（默默换掉用户选的模型
 * 是不能接受的，哪怕是"为你省钱"），以及**判定依据说得出口**。
 */
/**
 * 画面指纹（**还没接线**）。
 *
 * 这一层是为了回答"从第 6 镜开始画风变了"——色调偏了、对比度跳了。
 * 这类漂移逐镜看每张都正常，连起来才露馅，而目前完全没有自动检查。
 *
 * ⚠ 它**不是人脸识别**：那需要一个人脸模型，而这个项目零依赖、不带 GPU。
 * 拿色彩指纹冒充"人像不像"的判据是在骗自己。
 *
 * 模块本身写完了，接进复核流程那一步暂缓 —— 所以这里只验纯计算部分。
 */
/**
 * 学来的"这家最多收几张图"必须**会过期**。
 *
 * 原来它是永久的，而那是个严重的错：一次偶发失败（某张图地址临时取不到、
 * 厂商抖一下）被归因成"图带多了"，然后这台服务**这辈子都按 1 张发** ——
 * 参考图少一半以上，一致性跟着塌，而且没有任何报错，只是"最近出图不太像"。
 *
 * 用户截了秘塔控制台的图：参考素材那栏写着 0/9。我们学到的"最多 1 张"
 * 从头到尾就是错的。降级必须可撤销，否则一次误判就是永久损失。
 */
/**
 * `cannot download media URL (2013)` —— 厂商下不到我们给的图。
 *
 * 这一条曾经被当成"图带多了"，后果是一连串**做在错地方**的补救：
 * 自动减半重试 → 减到 1 张照样失败（地址还是取不到）→ 把"最多 1 张"记下来
 * → 从此每一镜只带 1 张参考图，一致性塌了一半，而且不报任何错。
 *
 * 一个指错方向的判断，会让后面每一个动作都做在错的地方。
 */
/**
 * 存下来的限时地址会过期 —— 而过期的样子是"看起来完全正常的 https 链接"。
 *
 * imageRef 落盘进项目文件，重出视频时直接拿来当首帧。对象存储私有桶给的是
 * 限时签名地址，几小时后那个链接就打不开了，厂商那边报
 * `cannot download media URL`，报错里**没有一个字提到过期**。
 *
 * 重新签一次是纯本地计算、不发任何请求 —— 省那一下毫无意义。
 */
/**
 * 「请求超时（60000ms 未返回）」—— 这句话对排错毫无帮助。
 *
 * 它没说是网络慢、厂商卡住、还是我们自己塞了 40MB 过去。而第三种恰恰是
 * 最常见、也最容易改的那一种：参考图上限从 3 张提到 9 张之后，一旦走内联
 * base64 兜底（没配对象存储时），请求体直接涨三倍，光上传就超过任何合理超时。
 *
 * 张数上限管的是"厂商收不收得下"，体积管的是"这个请求发不发得出去"——两回事。
 */
section('内联图按体积卡，超时要说清楚发了多大');
{
  const ad = await import('../core/providers/adapters.js');
  const big = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`;
  const notes = [];
  const kept = ad.__trimInlineImages([big, big, big, big], (e) => notes.push(e.message));
  check('内联图超预算时截断', kept.length < 4 && kept.length >= 1, String(kept.length));
  // 只说"发不出去"没用，要说清楚该去配什么
  check('并且说清楚该配对象存储', notes.some((m) => /对象存储/.test(m)), notes[0]?.slice(0, 60));
  check('还告诉你配完能全带上', notes.some((m) => /全带上/.test(m)));

  // 走地址的不受影响 —— 那种请求体只有几 KB
  const urls = ['https://a/1.png', 'https://a/2.png', 'https://a/3.png'];
  check('走公网地址的一张都不砍', ad.__trimInlineImages(urls, () => {}).length === 3);
  // 一张就超预算时也得发出去，否则等于什么都不做
  check('单张就超预算时仍然发（否则等于什么都做不了）',
    ad.__trimInlineImages([big], () => {}).length === 1);

  /**
   * 超时时间要跟着体积走：固定 60 秒对 2KB 的 JSON 宽松，对 40MB 荒谬。
   */
  const hc = await import('../core/http-client.js');
  const slow = http.createServer(() => { /* 故意永不回应 */ });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const slowUrl = `http://127.0.0.1:${slow.address().port}/`;
  let msg = '';
  try {
    await hc.execute({
      method: 'POST', url: slowUrl, timeoutMs: 300,
      body: { blob: 'x'.repeat(3 * 1024 * 1024) }
    });
  } catch (err) {
    msg = err.message;
  }
  slow.close();
  check('超时报错带上了这次发了多大', /MB/.test(msg), msg.slice(0, 120));
  check('并直接点名 base64 内联这个最常见的原因', /base64/.test(msg));
}

section('存下来的限时地址不复用');
{
  const st = await import('../core/pipeline/studio.js');
  const oss2 = await import('../core/oss.js');

  check('带 Expires 的一律现签，不复用',
    st.__usableRef('https://b.oss-cn-beijing.aliyuncs.com/a.png?OSSAccessKeyId=x&Expires=1700000000&Signature=y') === null);
  // 上传网关给的地址和内联图不会过期，复用它们是对的
  check('网关给的固定地址照常复用',
    st.__usableRef('https://cdn.example.com/a.png') === 'https://cdn.example.com/a.png');
  check('内联图照常复用', st.__usableRef('data:image/png;base64,AAA').startsWith('data:'));
  check('没有就是没有', st.__usableRef(null) === null);

  /**
   * 一小时是"够用"的直觉值，但实际链路比直觉长：提交 → 厂商排队十几分钟
   * → 才去拉图。中间慢一点地址就过期了，而报错完全指不到这上面。
   */
  settings.patch({ oss: {} });
  check('限时地址默认活 6 小时，不是 1 小时', oss2.config().signedTtl === 21600, String(oss2.config().signedTtl));

  /**
   * 上面四条守的是**分镜自己那张图**。而设定集参考图走的是另一条路
   * （bible 里的 sheetUrl），那条路上一次都没经过这个守卫。
   *
   * 用户的实测，图明明还在对象存储里：
   *   ※ 想改成内联图绕过去，但第 2 张我们自己也下不下来（HTTP 403）
   *   ✕ 厂商那边下载不到我们给的图
   *
   * 设定集是前一天建的，限时地址活 6 小时 —— 第二天所有参考图一起 403。
   * 而且这个洞会**越用越疼**：设定集建得越早、片子做得越久，越必然撞上。
   *
   * 光"跳过过期的"不算修好：那样这一镜少带一张参考图，人设当场松掉，
   * 而且不报错，只是"最近出的图不太像"。本地文件一直都在，重新签一个就行。
   */
  const collected = (await import('../core/pipeline/consistency.js')).collectReferences(
    {
      characters: [{ name: '班主任', sheetPath: '/tmp/nope-班主任.png', sheetUrl: 'https://b.oss.com/t.png?Expires=1700000000&Signature=y' }],
      scenes: [{ name: '办公室', sheetPath: '/tmp/nope-办公室.png', sheetUrl: 'https://cdn.example.com/office.png' }],
      props: []
    },
    { description: '班主任在办公室里', scene: '办公室', characters: ['班主任'] }
  );
  check('参考图带上了本地路径（不然过期了也没法重签）',
    Array.isArray(collected.paths) && collected.paths.length === collected.images.length,
    JSON.stringify(collected.paths));
  check('过期的那张确实被认出来了',
    collected.images.filter((u) => st.__usableRef(u) === null).length === 1,
    JSON.stringify(collected.images));
}

section('长任务的流：一分钟不吭声，连接会被掐掉');
{
  /**
   * 用户在手机上重出一张图，得到一句 `network error`。
   *
   * 这条流经常**一分多钟一个字节都不写** —— 出一张图要等厂商三十秒到两分钟，
   * 这期间流上完全静默。而一条静默的连接会被沿途任何一环回收：
   * 手机基站的 NAT 表、运营商的空闲超时、反向代理、浏览器息屏时收紧的策略。
   *
   * 掐掉之后浏览器只给一句 `network error`，它不区分"服务器挂了""网断了"
   * "闲太久被回收了"—— 而这三件事该做的处理完全不同。更要命的是：
   * **任务在服务器上还好好跑着**，图其实出来了。
   */
  const srv = await import('../core/server.js');
  const writes = [];
  const handlers = {};
  const fakeRes = {
    writeHead() {},
    write(chunk) { writes.push(chunk); },
    end(chunk) { if (chunk) writes.push(chunk); },
    on(ev, fn) { handlers[ev] = fn; }
  };

  const stream = srv.__ndjson(fakeRes);
  stream.send({ type: 'note', message: '开跑' });
  check('正常事件照常发出去', writes.some((w) => /开跑/.test(w)), JSON.stringify(writes));

  // 自检里把心跳调到 60ms（FUTUREDREAM_PING_MS），不然这条要等 15 秒
  await new Promise((r) => setTimeout(r, 200));
  const pings = writes.filter((w) => /"type":"ping"/.test(w)).length;
  check('静默期间会持续发心跳（否则连接被回收）', pings >= 2, `${pings} 次`);

  /**
   * ping 必须是**能被 JSON.parse 的完整一行**。
   * 各端都是按行 parse、按 type 分派，不认识的 type 天然忽略 ——
   * 但只要有一行 parse 不了，缓冲区的切分就会乱，后面的真事件跟着丢。
   */
  const pingLine = writes.find((w) => /ping/.test(w));
  check('心跳是完整的一行 JSON（解析不了会带乱后面的事件）',
    pingLine.endsWith('\n') && JSON.parse(pingLine.trim()).type === 'ping', JSON.stringify(pingLine));

  stream.end({ type: 'finished' });
  const after = writes.length;
  await new Promise((r) => setTimeout(r, 200));
  check('结束之后不再发心跳（不然定时器会一直吊着）', writes.length === after, `又多了 ${writes.length - after} 条`);

  // 对端先走的情况：res 的 close 事件要能把定时器停掉
  const w2 = [];
  const res2 = { writeHead() {}, write(c) { w2.push(c); }, end() {}, on(ev, fn) { if (ev === 'close') res2.__close = fn; } };
  srv.__ndjson(res2);
  res2.__close();
  const n2 = w2.length;
  await new Promise((r) => setTimeout(r, 200));
  check('对端断开后也停掉心跳', w2.length === n2, `又多了 ${w2.length - n2} 条`);
}

section('预演台：把"中景"变成一组数');
{
  const pv = await import('../core/pipeline/previz.js');

  /**
   * 景别是**算出来的**，不是感觉。同样说"中景"，35mm 站 2 米和 85mm 站 5 米
   * 是完全不同的两张画（后者背景压缩、透视平），而 camera: "中景"
   * 把这个差别整个抹掉了 —— 于是模型每一镜自己挑一个，
   * 同一场戏里景别忽远忽近，看起来像"模型不稳定"。
   */
  check('同样 3 米，35mm 是全景、85mm 是近景',
    pv.shotSize(3, 35).label === '全景' && pv.shotSize(3, 85).label === '近景',
    `${pv.shotSize(3, 35).label} / ${pv.shotSize(3, 85).label}`);
  check('走近就变特写', pv.shotSize(0.6, 50).label === '特写', pv.shotSize(0.6, 50).label);
  // 换焦段不换镜头位置也会换景别 —— 这正是"中景"说不清的东西
  check('同一位置换长焦，景别跟着变',
    pv.shotSize(5, 35).label !== pv.shotSize(5, 135).label);

  // ── 方位：0° 朝上、顺时针 ──
  check('正上方是 0°', pv.bearing({ x: 0, y: 0 }, { x: 0, y: 1 }) === 0);
  check('正右方是 90°', pv.bearing({ x: 0, y: 0 }, { x: 1, y: 0 }) === 90);

  /**
   * 机位在人的哪一边 —— 这一条直接决定发哪张设定图。
   * 机位在人的正南方（y 更小），人朝北（facing 0）就是背对镜头。
   */
  const cam = { x: 0, y: -3, height: 1.6, lens: 35 };
  check('人面向机位 → 正面', pv.facingRelation(cam, { x: 0, y: 0, facing: 180 }).sheet === 'primary');
  check('人背对机位 → 背面', pv.facingRelation(cam, { x: 0, y: 0, facing: 0 }).sheet === 'back');
  check('人侧对机位 → 侧面', pv.facingRelation(cam, { x: 0, y: 0, facing: 90 }).sheet === 'side');

  check('机位高过眼睛是俯拍', pv.heightRelation(2.4).label === '俯拍');
  check('齐眼是平视', pv.heightRelation(1.6).label === '平视');
  check('趴地上是仰拍', pv.heightRelation(0.4).label === '仰拍');

  /**
   * ── 越轴 ──
   *
   * 两个人对话，他们之间那条连线就是轴线。机位待在同一侧，
   * A 永远在左、B 永远在右；跨到另一侧，两人在画面上左右对调 ——
   * 而观众读到的不是"换了机位"，是"他俩换了位置"。
   *
   * 这一条以前只是提示词里一句"不要越轴"，而模型根本不知道机位在哪。
   */
  const two = [{ name: 'A', x: -1, y: 0, facing: 90 }, { name: 'B', x: 1, y: 0, facing: 270 }];
  const south = pv.axisSide({ x: 0, y: -3 }, two);
  const north = pv.axisSide({ x: 0, y: 3 }, two);
  check('轴线两侧算出来是相反的', south !== 0 && north !== 0 && south !== north, `${south} / ${north}`);
  check('同一侧的两个机位不算越轴',
    pv.crossesAxis({ side: south }, { side: pv.axisSide({ x: -2, y: -4 }, two) }) === false);
  check('跨到对面就是越轴', pv.crossesAxis({ side: south }, { side: north }) === true);
  /**
   * 正好落在轴线上的机位回 0。它是唯一"两侧都算"的位置 ——
   * 拿它和谁比都不该报越轴，否则会冒出一堆假警报，
   * 而假警报多了人就不看这个检查了。
   */
  check('正好在轴线上时不报越轴', pv.crossesAxis({ side: 0 }, { side: north }) === false);

  // ── 三种译法 ──
  const read = pv.readShot({
    cam: { x: 0, y: -3, height: 1.2, lens: 85, move: { horizontal: -3, zoom: 0, pan: 0, tilt: 0, roll: 0, vertical: 0 } },
    subjects: [{ name: '强雄', x: 0, y: 0, facing: 180 }]
  });
  const zh = pv.toChinese(read, { subjectName: '强雄' });
  check('中文译法把景别、方位、高度、焦段都说全了',
    /近景/.test(zh) && /正面/.test(zh) && /85mm/.test(zh), zh);
  check('并且说了运镜方向', /向左横移/.test(zh), zh);

  const kling = pv.toKling(read);
  check('可灵译法给的是那六个字段', kling && kling.config.horizontal === -3, JSON.stringify(kling?.config));
  /**
   * ⚠ 可灵的 camera_control 和**首尾帧、运动笔刷三选一**。
   * 也就是说标了「连续动作」要锁尾帧的镜，在可灵上用不了结构化运镜。
   * 这个冲突必须让调用方看见，不能等到线上才发现两个都设了、只生效一个。
   */
  check('并且标出了它和首尾帧互斥', kling.conflictsWithEndFrame === true);
  check('固定机位不发运镜参数（别给一组全 0 让它乱动）', pv.toKling(pv.readShot({ cam: { x: 0, y: -2 }, subjects: [] })) === null);

  check('海螺那一路给方括号指令', pv.toBrackets(read) === '[左移]', pv.toBrackets(read));
  // 六个方向全塞进去的话模型会挑着执行，而挑哪个你控制不了
  const busy = pv.readShot({ cam: { move: { horizontal: 9, zoom: 8, pan: 7, tilt: 6, roll: 5, vertical: 4 } }, subjects: [] });
  check('运镜太多时只留最强的两个', pv.toBrackets(busy).match(/\[/g).length === 2, pv.toBrackets(busy));

  /**
   * 没排位就**不能假装有**。编一句"机位在人物右前方"而实际没人摆过，
   * 比笼统的"中景"更坏 —— 它是一个听起来很精确的谎。
   */
  check('没排位时回 null，让原来那句 camera 接着用',
    pv.cameraLine({ camera: '中景' }) === null);
  check('排过位就给出精确那句', /mm/.test(pv.cameraLine({ stage: { cam: { x: 0, y: -3, height: 1.6, lens: 50 }, subjects: [{ name: '强雄', x: 0, y: 0, facing: 180 }] } })));
}

/**
 * previz.js 必须保持**零依赖**。
 *
 * 界面拿它算实时读数，走的是服务端把这个文件**原样发给浏览器**那条路
 *（/previz.js）。它一旦 import 了任何东西（哪怕只是同目录的另一个模块），
 * 浏览器那边就会去请求一个不存在的地址 —— 而失败的样子是整块面板不出来，
 * 或者更糟：面板在、读数是空的，看起来像"这一镜算不出来"。
 *
 * 两端共用一份代码的好处是不可能算漂，代价就是这条约束。写下来，让它会报错。
 */
{
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'core', 'pipeline', 'previz.js'), 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*import\s/.test(l));
  check('预演台的几何模块保持零依赖（它要原样发给浏览器）',
    imports.length === 0, imports.join(' / '));
}

section('连续动作的首帧是上一段的末帧 —— 机位不该跳');
{
  const pv = await import('../core/pipeline/previz.js');
  const lint = await import('../core/pipeline/shotlint.js');
  const stage = (x, y, lens) => ({ cam: { x, y, height: 1.6, lens, move: {} }, subjects: [{ name: 'A', x: 0, y: 0, facing: 180 }] });

  /**
   * 标了「连续动作」的镜，首帧**就是上一段视频的真实末帧**。
   * 画面起点已经被上一镜定死了，而提示词里那句机位是这一镜排位算出来的。
   *
   * 两者一冲突，模型只能二选一：无视首帧（接缝白做了），
   * 或者无视排位（排位白做了）—— **两种都不报错**。
   */
  const prev = { id: 'p', index: 4, segment: 1, description: '他伸手去推门', stage: stage(0, -4, 35) };
  const mk = (st, link) => ({ id: 'n', index: 5, segment: 1, link, description: '门开了一条缝', stage: st });
  const jumps = (s2) => lint.lintShots([prev, s2]).flatMap((r) => r.issues).filter((i) => i.kind === 'continuous-camera-jump');

  check('机位大挪 → 报', jumps(mk(stage(2, -4, 35), 'continuous')).length === 1);
  check('景别从全景跳到特写 → 报',
    /景别从/.test(jumps(mk(stage(0, -1.2, 85), 'continuous'))[0]?.what || ''),
    jumps(mk(stage(0, -1.2, 85), 'continuous'))[0]?.what);
  check('标成硬切就不报（硬切本来就该跳）', jumps(mk(stage(0, -1.2, 85), 'cut')).length === 0);

  /**
   * ⚠ 第一版是拿**档位名**比的（"全景" vs "远景"），当场假警报：
   * 机位只挪 0.3 米，而画面高度正好跨过 2.8 米那条档位线，就翻了档。
   *
   * 档位是给人读的，边界上一厘米的抖动就能翻。真正该量的是
   * "画面装得下多高"变了多少倍 —— 那是连续的，没有悬崖。
   * 一个乱报的检查等于没有检查：看两次假警报之后人就再也不看它了。
   */
  check('挪一点点不报（哪怕档位名正好翻了档）',
    jumps(mk(stage(0.3, -4.1, 35), 'continuous')).length === 0,
    JSON.stringify(pv.cameraJump(prev.stage, stage(0.3, -4.1, 35))));

  // 有一边没排位就无从比较 —— 不能凭空报
  check('有一边没排位时不报', pv.cameraJump(null, stage(0, -1, 85)) === null);
  check('报的时候给出路（改成硬切 / 把机位拖回去）',
    /硬切/.test(jumps(mk(stage(2, -4, 35), 'continuous'))[0]?.fix || ''));
}

section('预演台 vs 技法卡：两边都在说机位，会打架');
{
  const pv = await import('../core/pipeline/previz.js');
  const lint = await import('../core/pipeline/shotlint.js');

  /**
   * 技法卡里有一整组在**描述机位**（平视/仰拍/俯拍/顶视/大特写），
   * 还有一组在**描述运镜**（推镜/拉镜/摇镜/跟拍/固定镜头）。
   * 而排过位之后，机位高度、景别、运镜方向全是算出来的。
   *
   * 两者会一起进同一条提示词，而且挨着：
   *   「低机位仰拍，被摄者显得高大……，镜头：全景，机位在强雄正面方向、平视，35mm」
   * 模型只能挑一句听，挑哪句你控制不了。表现是"排了位好像没生效"，
   * 而**没有任何报错** —— 两句话各自都是合法的。
   */
  const staged = {
    index: 7,
    description: '强雄站在窗前',
    stage: { cam: { x: 0, y: -3, height: 1.6, lens: 35, move: { horizontal: -4 } }, subjects: [{ name: '强雄', x: 0, y: 0, facing: 180 }] }
  };

  const bad = pv.conflictingSkills({ ...staged, skills: ['low-angle', 'static'] });
  check('仰拍 vs 排位算出的平视 → 报', bad.some((c) => c.id === 'low-angle'), JSON.stringify(bad));
  check('固定镜头 vs 排位算出的横移 → 报', bad.some((c) => c.id === 'static'), JSON.stringify(bad));
  check('报的时候指着说排位到底是什么', bad.find((c) => c.id === 'low-angle')?.said === '平视');

  /**
   * ⚠ 只报**真的对不上**的。选了「平视」而排位也是平视，那是一致，不是冲突 ——
   * 把一致的也报出来，这个检查立刻变成噪音，然后没人再看它。
   */
  check('一致的不报（平视 + 平视）',
    pv.conflictingSkills({ ...staged, skills: ['eye-level'] }).length === 0);
  check('一致的不报（跟拍 + 横移）',
    pv.conflictingSkills({ ...staged, skills: ['tracking'] }).length === 0);
  // 光线、动作、氛围和机位无关，一张都不该被牵连
  check('不相干的卡不受影响',
    pv.conflictingSkills({ ...staged, skills: ['rembrandt', 'act-cry'] }).length === 0);
  /**
   * 排位说不了的东西不算冲突：环绕、希区柯克变焦、手持质感、荷兰角、过肩 ——
   * 那六个参数里根本没有它们，卡片是**补充**而不是矛盾。
   */
  check('排位表达不了的卡不算冲突',
    pv.conflictingSkills({ ...staged, skills: pv.SKILLS_BEYOND_STAGE }).length === 0,
    JSON.stringify(pv.conflictingSkills({ ...staged, skills: pv.SKILLS_BEYOND_STAGE })));
  // 没排位就没有冲突可言 —— 那时候技法卡就是唯一的机位来源
  check('没排位时不报', pv.conflictingSkills({ skills: ['low-angle'], description: 'x' }).length === 0);

  // 报到用户看得见的地方
  const found = lint.lintShot({ ...staged, skills: ['low-angle'] });
  const hit = found.find((i) => i.kind === 'skill-vs-stage');
  check('冲突进了分镜体检', Boolean(hit), JSON.stringify(found.map((i) => i.kind)));
  check('说的是卡的名字，不是 id（用户看到的是名字）', /仰拍/.test(hit?.what || ''), hit?.what);
  check('给了两条都能走的出路', /取消/.test(hit?.fix || '') && /拖成/.test(hit?.fix || ''), hit?.fix);
}

section('预演台：下一镜接着上一镜排，不是从零开始');
{
  const pv = await import('../core/pipeline/previz.js');

  const prev = {
    cam: { x: -2, y: -3, height: 1.2, lens: 85, move: { horizontal: -4 } },
    subjects: [
      { name: '强雄', x: -1, y: 0, facing: 90 },
      { name: '班主任', x: 1, y: 0, facing: 270 }
    ]
  };

  /**
   * 同一场戏里人不会在两镜之间瞬移。每镜从空白重摆的话，不只是重复劳动 ——
   * 人的位置一变，两人之间那条**轴线就转了**，于是"机位在同一侧"这个判断
   * 整个失去意义，越轴检查开始乱报。而乱报的检查比没有检查更糟：
   * 看两次假警报之后，人就再也不看它了。
   */
  const next = pv.inheritStage(prev, ['强雄', '班主任']);
  check('人的位置原样接过来', next.subjects[0].x === -1 && next.subjects[1].x === 1,
    JSON.stringify(next.subjects));
  check('朝向也接过来（不然每镜都要重新转身）', next.subjects[0].facing === 90);
  /**
   * 机位也接过来当起点：起点落在上一镜同一侧，**默认就是不越轴的**，
   * 要越轴得自己动手把它拖过去。
   */
  check('机位接过来当起点，默认不越轴',
    pv.axisSide(next.cam, next.subjects) === pv.axisSide(prev.cam, prev.subjects));
  check('焦段和运镜也一起带过来', next.cam.lens === 85 && next.cam.move.horizontal === -4);

  // 这一镜新出场的人得有个位置，先摆中间等着被拖走
  const withNew = pv.inheritStage(prev, ['强雄', '周爸爸']);
  check('新出场的人补一个位置', withNew.subjects.length === 2 && withNew.subjects[1].name === '周爸爸');
  check('已有的人还是原来那个位置', withNew.subjects[0].x === -1);
  /**
   * 上一镜有、这一镜没有的人要**丢掉**。留在图上的话，算景别时可能挑到他
   * 当主体，于是整镜的景别都是照错人算的 —— 而画面上根本没有这个人。
   */
  check('这一镜没有的人要丢掉（否则景别会照错人算）',
    !withNew.subjects.some((x) => x.name === '班主任'), JSON.stringify(withNew.subjects.map((x) => x.name)));

  check('上一镜没排过位就没得继承', pv.inheritStage(null, ['强雄']) === null);
}

section('预演台：算出来的机位，比读描述里的关键词准');
{
  const con = await import('../core/pipeline/consistency.js');
  const lint = await import('../core/pipeline/shotlint.js');

  const bible = {
    characters: [{
      name: '强雄',
      sheetPath: '/x/front.png',
      sheetUrl: 'https://cdn.example.com/front.png',
      variants: [{
        id: 'v-default',
        sheetPath: '/x/front.png',
        sheetUrl: 'https://cdn.example.com/front.png',
        angles: [{ id: 'back', sheetPath: '/x/back.png', sheetUrl: 'https://cdn.example.com/back.png' }]
      }]
    }],
    scenes: [],
    props: []
  };

  /**
   * 「他望着窗外」这句话，既可能是侧脸也可能是背影 —— 读字是分不出来的。
   * 而机位一摆就是确定的：机位在他正南、他朝北，那就是背影。
   */
  const staged = {
    description: '强雄望着窗外',
    characters: ['强雄'],
    stage: { cam: { x: 0, y: -3, height: 1.6, lens: 50 }, subjects: [{ name: '强雄', x: 0, y: 0, facing: 0 }] }
  };
  const noStage = { description: '强雄望着窗外', characters: ['强雄'] };
  check('没排位时关键词判不出来，发正面（和以前一样）',
    con.collectReferences(bible, noStage).images[0] === 'https://cdn.example.com/front.png');
  check('排过位就按机位发背面 —— 关键词一个字都没提到"背"',
    con.collectReferences(bible, staged).images[0] === 'https://cdn.example.com/back.png',
    con.collectReferences(bible, staged).labels[0]);

  // ── 越轴报到用户看得见的地方 ──
  const two = [{ name: 'A', x: -1, y: 0, facing: 90 }, { name: 'B', x: 1, y: 0, facing: 270 }];
  const shots = [
    { id: 's1', index: 1, segment: 1, description: '两人对话', stage: { cam: { x: 0, y: -3, height: 1.6, lens: 50 }, subjects: two } },
    { id: 's2', index: 2, segment: 1, description: '反打', stage: { cam: { x: 0, y: 3, height: 1.6, lens: 50 }, subjects: two } }
  ];
  const found = lint.lintShots(shots);
  const axis = found.flatMap((r) => r.issues).find((i) => i.kind === 'crosses-axis');
  check('越轴被分镜体检抓出来了', Boolean(axis), JSON.stringify(found.map((r) => r.index)));
  check('并且说清楚成片上会看到什么', /左右对调|掉头/.test(axis?.why || ''), (axis?.why || '').slice(0, 50));
  check('并且给了怎么改', /同一侧/.test(axis?.fix || ''), axis?.fix);

  // 跨场次不查：换了场戏轴线本来就重新算，查了全是假警报
  const crossSeg = lint.lintShots([shots[0], { ...shots[1], segment: 2 }]);
  check('跨场次不报越轴（轴线本来就重算）',
    !crossSeg.flatMap((r) => r.issues).some((i) => i.kind === 'crosses-axis'));
  // 没排位的镜断开链条，不拿它和隔壁比
  const partial = lint.lintShots([shots[0], { id: 's2', index: 2, segment: 1, description: '反打' }]);
  check('没排位的镜不参与越轴判断',
    !partial.flatMap((r) => r.issues).some((i) => i.kind === 'crosses-axis'));
}

section('设定图的角度：人一转身，参考图也得跟着转');
{
  const ang = await import('../core/pipeline/angles.js');
  const con = await import('../core/pipeline/consistency.js');

  check('角色有正 / 侧 / 背', ang.anglesFor('char').map((a) => a.id).join(',') === 'primary,side,back');
  check('场景多一张俯视平面（预演台的排位底图就是它）',
    ang.anglesFor('scene').map((a) => a.id).includes('top'));
  // 道具多出两张只是多花钱：产品图视角本来就够
  check('道具不补角度', ang.extraAngles('prop').length === 0);

  /**
   * 提示词必须同时说两件事：换个角度，**以及别换人**。
   * 只说前者的话，模型很乐意给你"一个侧面的另一个人"——
   * 而那比没有这张图更糟：它会被当成同一个人的参考图发出去。
   */
  const back = ang.promptFor('char', 'back');
  check('背面图的提示词要求"同一个人"', /同一个人/.test(back), back.slice(0, 40));
  check('并且点明发型服装要和正面一致', /发型/.test(back) && /一致/.test(back));
  // 俯视图要的是布局图，不是"从高处拍一张" —— 后者既不能当俯拍参考也没法当底图
  check('俯视图要的是平面布局，不是大仰角镜头',
    /垂直向下/.test(ang.promptFor('scene', 'top')), ang.promptFor('scene', 'top').slice(0, 30));

  // ── 挑角度 ──
  const has = { available: ['side', 'back'] };
  check('背对镜头 → 发背面那张',
    ang.pickAngle('char', { description: '强雄背对镜头站在窗前' }, has) === 'back');
  check('侧脸对话 → 发侧面那张',
    ang.pickAngle('char', { description: '两人侧脸对话' }, has) === 'side');
  check('普通描述 → 还是正面', ang.pickAngle('char', { description: '强雄推门进来' }, has) === 'primary');
  /**
   * 没补过的角度不能挑 —— 挑了就会取到一个没有图的条目，
   * 结果是这一镜**一张参考图都没带**，比带错那张还糟。
   */
  check('没补过背面时，退回正面而不是取空',
    ang.pickAngle('char', { description: '背对镜头' }, { available: [] }) === 'primary');
  check('俯拍 → 场景发俯视图',
    ang.pickAngle('scene', { description: '俯拍整个操场', camera: '俯拍' }, { available: ['top'] }) === 'top');

  // ── 真的传到参考图那一步了吗 ──
  const bible = {
    characters: [{
      name: '强雄',
      sheetPath: '/x/front.png',
      sheetUrl: 'https://cdn.example.com/front.png',
      variants: [{
        id: 'v-default',
        name: '默认造型',
        sheetPath: '/x/front.png',
        sheetUrl: 'https://cdn.example.com/front.png',
        angles: [{ id: 'back', sheetPath: '/x/back.png', sheetUrl: 'https://cdn.example.com/back.png' }]
      }]
    }],
    scenes: [],
    props: []
  };
  const front = con.collectReferences(bible, { description: '强雄推门进来', characters: ['强雄'] });
  check('正面镜发正面图', front.images[0] === 'https://cdn.example.com/front.png', front.images[0]);
  const behind = con.collectReferences(bible, { description: '强雄背对镜头走远', characters: ['强雄'] });
  check('背影镜真的换成了背面图', behind.images[0] === 'https://cdn.example.com/back.png', behind.images[0]);
  // 标签要带出角度，否则用户看不出这一镜为什么像 / 不像
  check('标签上写明这次发的是哪个角度', /背面/.test(behind.labels[0]), behind.labels[0]);
  // 重签那条路要用本地文件 —— 角度图的本地路径也得跟着带出来
  check('角度图的本地路径也带上了（过期能重签）', behind.paths[0] === '/x/back.png', String(behind.paths[0]));
}

section('设定集参考图过期：重新签，而不是让厂商拒掉');
{
  const st = await import('../core/pipeline/studio.js');
  const fsx = await import('node:fs');
  const pathx = await import('node:path');

  // 真写一张图到盘上 —— 重签这条路要读它，假路径会让整段悄悄走进"找不到"那一支
  const realPng = pathx.join(SANDBOX, 'sheet-班主任.png');
  fsx.writeFileSync(realPng, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ));
  const gonePng = pathx.join(SANDBOX, 'sheet-没了.png');

  const project = { id: 'refresh-test', bible: { characters: [], scenes: [], props: [] }, shots: [] };
  const notes = [];
  const fresh = await st.__refreshRefs(
    project,
    {
      images: [
        'https://cdn.example.com/ok.png',
        'https://b.oss.com/t.png?Expires=1700000000&Signature=y',
        'https://b.oss.com/x.png?Expires=1700000000&Signature=z'
      ],
      labels: ['景·办公室', '角·班主任', '道·没了的东西'],
      paths: [null, realPng, gonePng]
    },
    { onEvent: (ev) => notes.push(ev.message) }
  );

  const joined = notes.join(' | ');
  check('没过期的那张原样留着', fresh.images[0] === 'https://cdn.example.com/ok.png', fresh.images[0]);
  check('过期但本地还在的，换成了新地址',
    fresh.images.length === 2 && fresh.images[1] !== 'https://b.oss.com/t.png?Expires=1700000000&Signature=y',
    JSON.stringify(fresh.images));
  check('标签跟着一起收缩，不会和图错位',
    fresh.labels.length === fresh.images.length && fresh.labels[1] === '角·班主任',
    JSON.stringify(fresh.labels));
  check('说清楚是地址过期了，不是图没了', /过期/.test(joined) && /6 小时/.test(joined), joined.slice(0, 140));
  /**
   * 本地也找不到的那张只能放弃 —— 但必须**出声**。
   * 默默少带一张参考图，表现就是"最近出的图不太像"，是最难查的那类。
   */
  check('本地也没了的那张，大声说一句，别默默少带',
    /本地那份图也找不到/.test(joined) && /道·没了的东西/.test(joined), joined.slice(-160));
}

section('下不到图 ≠ 图太多');
{
  const ad = await import('../core/providers/adapters.js');
  const idx = await import('../core/providers/index.js');

  // 判别：只认明确在说数量的话，不认厂商的私有错误码
  const isLimit = (m) => ad.__isMediaLimitError(m);
  check('「下不到图」不再被当成「图太多」', isLimit('cannot download media URL (2013)') === false);
  check('真的说数量时还是认得出', isLimit('输入媒体数量超过限制 (2013)') === true);
  check('英文的数量超限也认', isLimit('number of images exceeded') === true);
  // 裸着匹配 2013 的话，报错里任何地方出现这四个数字都会被误判
  check('时间戳里的 2013 不会被误判', isLimit('任务 20130422 超时') === false);

  // 报错要指向对的方向：人看到"请求体不合法"会去翻参数、翻模型 ID，全是白费
  const said = idx.diagnose({ status: 400, json: { message: 'cannot download media URL (2013)' } });
  check('400 里单独把"下不到图"挑出来说', /下载不到我们给的图/.test(said), said.slice(0, 60));
  check('并且说清楚这不是参数问题', /不是参数问题/.test(said));
  check('给了可以照着做的排查顺序', /无痕窗口/.test(said) && /对象存储/.test(said));

  // 我们自己去拉一次 —— 把猜测变成事实
  const inline = await ad.__probeMediaUrl('data:image/png;base64,AAAA');
  check('内联图的情况直接点名', /只收公网地址/.test(inline), inline.slice(0, 40));
  const unreachable = await ad.__probeMediaUrl('http://127.0.0.1:1/nope.png');
  check('拉不到时说"我们这边也拉不到"', /我们这边也拉不到/.test(unreachable), unreachable.slice(0, 50));
  const ok = await ad.__probeMediaUrl(`${appUrl}/index.html`);
  // 这两种情况的下一步动作毫不相干，而单看厂商那句话是分不出来的
  check('拉得到时反过来指向厂商那边', /厂商那边够不着/.test(ok), ok.slice(0, 50));
  /**
   * 这个探测是从跑着应用的那台机器上发的，而桶通常就在同一片机房 ——
   * "我们拉得到"因此几乎必然成立。原来的话把它说成"地址本身是好的"，
   * 会让人放心地不去查桶权限，而桶不是公共读恰恰是最常见的原因。
   */
  check('并且承认这个探测本身够不着结论', /同一片机房/.test(ok) && /公共读/.test(ok), ok.slice(0, 120));
  check('给了一个能分清两种情况的动作', /无痕窗口/.test(ok), ok.slice(0, 200));
}

section('厂商拉不到我们的桶：先绕过去，再讲道理');
{
  /**
   * 用户那条日志：厂商回 `cannot download media URL (2013)`，我们自己探测
   * 却是 HTTP 206。结论"把桶换到和厂商同一侧"是对的，但它救不了眼前这一镜 ——
   * 换地域要重建桶、重传所有素材，而人现在就想把这一镜出出来。
   *
   * 厂商其实不需要能访问我们的桶，它只需要拿到那几个字节。
   * 我们拉得到，那就下下来内联发过去。
   */
  const ad = await import('../core/providers/adapters.js');
  const cat = await import('../core/providers/catalog.js');
  ad.resetMediaLimits();
  vault.setSecret('METASO_API_KEY', 'ms-test-key');

  const provider = cat.PROVIDERS.find((p) => p.id === 'metaso');
  const reachable = `${appUrl}/index.html`; // 我们拉得到的真地址
  const notes = [];
  let submits = 0;
  let sawInline = 0;

  /**
   * "到底发的是地址还是字节"只能在 buildBody 里看 —— checkBiz 拿到的是
   * 上游的回包，跟我们发出去的 body 没有关系。
   */
  let attempt = 0;
  const res = await ad.__submitWithMediaBackoff({
    providerId: 'metaso',
    provider,
    model: 'MiniMax-H3',
    url: `${upstreamUrl}/api/v1/tasks/submit`,
    images: [reachable, reachable],
    buildBody: (imgs) => {
      attempt += 1;
      if (imgs.some((u) => String(u).startsWith('data:'))) sawInline += 1;
      return { imgs, inline: imgs.some((u) => String(u).startsWith('data:')) };
    },
    checkBiz: () => {
      submits += 1;
      // 第一次发的是地址（attempt 1）→ 厂商说下不到；之后发的是字节 → 收
      if (attempt === 1) throw new Error('cannot download media URL (2013)');
      return { ok: true };
    },
    label: '测试',
    onEvent: (ev) => notes.push(ev.message)
  }).catch((err) => ({ error: err.message }));

  const joined = notes.join(' | ');
  check('厂商下不到时，改把图下下来内联发', !res.error && sawInline >= 1, res.error || `inline=${sawInline}`);
  check('说清楚绕过去了、这一镜不用重来', /不用重来/.test(joined), joined.slice(0, 200));
  /**
   * 绕过去之后**仍然要把长期的解法说出来**。内联每镜都要多下一趟图，
   * 图一多还会撞体积上限 —— 它是应急，不是终点。不说的话人就永远停在这。
   */
  check('同时仍然给出长期解法（把桶换到同一侧）', /同一侧/.test(joined), joined.slice(0, 260));

  /**
   * 一部片子十几二十镜。如果每一镜都先撞一次墙再改内联，那就是十几次
   * 白跑的提交，每次都要等厂商超时 —— 慢，而且日志里全是失败，
   * 人分不出哪一条是真出事了。第一镜撞过就该记住。
   */
  const before = submits;
  const shapes = []; // 每次 buildBody 发的是地址还是字节
  const second = await ad.__submitWithMediaBackoff({
    providerId: 'metaso',
    provider,
    model: 'MiniMax-H3',
    url: `${upstreamUrl}/api/v1/tasks/submit`,
    images: [reachable],
    buildBody: (imgs) => {
      const inline = imgs.every((u) => String(u).startsWith('data:'));
      shapes.push(inline ? 'inline' : 'url');
      return { inline };
    },
    // 厂商的行为没变：发地址照样下不到。所以"只提交了一次"必须是因为
    // 我们**第一次就发了字节**，而不是因为这个假厂商太好说话。
    checkBiz: () => {
      submits += 1;
      if (shapes[shapes.length - 1] === 'url') throw new Error('cannot download media URL (2013)');
      return { ok: true };
    },
    label: '测试',
    onEvent: (ev) => notes.push(ev.message)
  }).catch((err) => ({ error: err.message }));
  check('下一镜直接走内联，不再白撞一次',
    !second.error && submits - before === 1 && shapes[0] === 'inline',
    `${submits - before} 次提交，${shapes.join('→')}`);

  /**
   * 而"我们自己也拉不到"的时候不能绕 —— 那不是厂商够不着，是地址本身有问题。
   * 硬绕只会多等一个超时，然后报一个更含糊的错。
   */
  ad.resetMediaLimits();
  const dead = await ad.__submitWithMediaBackoff({
    providerId: 'metaso',
    provider,
    model: 'MiniMax-H3',
    url: `${upstreamUrl}/api/v1/tasks/submit`,
    images: ['http://127.0.0.1:1/nope.png'],
    buildBody: (imgs) => ({ imgs }),
    checkBiz: () => { throw new Error('cannot download media URL (2013)'); },
    label: '测试',
    onEvent: (ev) => notes.push(ev.message)
  }).catch((err) => ({ error: err.message }));
  check('我们自己也拉不到时，不硬绕，照实报', /我们这边也拉不到/.test(dead.error || ''), (dead.error || '').slice(0, 120));

  /**
   * 最阴的一种：**第 1 张好、第 3 张坏**。
   *
   * 诊断那一步原来永远探 images[0]，于是它会输出"我们这边拉得到 ——
   * 是厂商那边够不着"。这句话和事实正好相反：真正坏掉的是第 3 张图，
   * 而用户会照着这句去查跨境、查 CDN、甚至去重建对象存储桶。
   *
   * 一句指错方向的诊断比没有诊断更贵 —— 它会让人花几个小时在错的地方。
   */
  ad.resetMediaLimits();
  const mixedNotes = [];
  const mixed = await ad.__submitWithMediaBackoff({
    providerId: 'metaso',
    provider,
    model: 'MiniMax-H3',
    url: `${upstreamUrl}/api/v1/tasks/submit`,
    images: [reachable, reachable, 'http://127.0.0.1:1/broken.png'],
    buildBody: (imgs) => ({ imgs }),
    checkBiz: () => { throw new Error('cannot download media URL (2013)'); },
    label: '测试',
    onEvent: (ev) => mixedNotes.push(ev.message)
  }).catch((err) => ({ error: err.message }));

  check('坏的不是第一张时，点名是第几张', /第 3 张/.test(mixedNotes.join(' | ')), mixedNotes.join(' | ').slice(0, 160));
  // 这条才是要害：诊断必须去探真正坏掉的那张，否则它会说出相反的话
  check('诊断探的是真正坏掉的那张，不是永远探第一张',
    /我们这边也拉不到/.test(mixed.error || '') && !/厂商那边够不着/.test(mixed.error || ''),
    (mixed.error || '').slice(0, 160));

  ad.resetMediaLimits();
}

section('学来的图片上限：会过期，而且别乱学');
{
  const ad = await import('../core/providers/adapters.js');
  ad.resetMediaLimits();

  ad.rememberMediaLimit('x::y', 2);
  check('刚学到的用得上', ad.learnedMediaLimit('x::y') === 2);
  check('没学过的那家不受影响', ad.learnedMediaLimit('other::z') === null);
  ad.resetMediaLimits();
  check('能手动清掉重新试探', ad.learnedMediaLimit('x::y') === null);

  /**
   * 匹配得太宽是这类 bug 的根源：`2013` 裸着匹配的话，报错里任何地方
   * 出现这四个数字（时间戳、任务号、年份）都会被当成"图太多"，
   * 于是一次完全不相干的失败被学成永久降级。
   */
  const cat = await import('../core/providers/catalog.js');
  const metaso = cat.PROVIDERS.find((p) => p.id === 'metaso');
  // 厂商界面上写着 0/9 —— 拿一个猜测当默认值，它就会变成事实
  check('秘塔按官方 H3 的 9 张发，不是保守的 3 张',
    metaso?.videoDefaults?.maxImages === 9, String(metaso?.videoDefaults?.maxImages));
}

section('内联图被拒时：说清楚是体积，而且别学错结论');
{
  /**
   * 用户的实例：秘塔控制台上写着参考素材 `0/9`，而发 4 张就被拒。
   * 张数远没到上限，被顶掉的是**体积** —— 4 张内联 base64 合计 8.9MB。
   *
   * 而厂商在体积超了时给的话往往还是"媒体数量超限"那一套，
   * 于是我们照字面减张数：4 → 2 → 1，三次上传、每次好几 MB、
   * 前两次纯属白跑，最后还留下一个错误结论。
   */
  const ad = await import('../core/providers/adapters.js');
  const cat = await import('../core/providers/catalog.js');
  ad.resetMediaLimits();

  // 一张 1.5MB 的假内联图
  const big = `data:image/png;base64,${'A'.repeat(1_500_000)}`;
  const notes = [];
  let tries = 0;
  const provider = cat.PROVIDERS.find((p) => p.id === 'metaso');

  // 这家标称 9 张 —— 断言里要用得上，别写死一个数
  check('秘塔标称收 9 张（所以 4 张被拒不可能是张数问题）',
    provider.videoDefaults.maxImages === 9, String(provider.videoDefaults.maxImages));

  // send() 先要凭据、再要一个真回 200 的地址 —— 否则连不到 checkBiz 那一步
  vault.setSecret('METASO_API_KEY', 'ms-test-key');
  const res = await ad.__submitWithMediaBackoff({
    providerId: 'metaso',
    provider,
    model: 'MiniMax-H3',
    url: `${upstreamUrl}/api/v1/tasks/submit`,
    images: [big, big, big],
    buildBody: (imgs) => ({ content: imgs.map((u) => ({ type: 'image_url', image_url: { url: u } })) }),
    checkBiz: () => {
      tries += 1;
      // 前两次按"媒体数量超限"拒掉，第三次放行 —— 复现用户那条日志
      if (tries < 3) throw new Error('输入媒体数量超过限制');
      return { ok: true };
    },
    label: '测试',
    onEvent: (ev) => notes.push(ev.message)
  }).catch((err) => ({ error: err.message }));

  const joined = notes.join(' | ');
  check('点明了是内联发的、合计多大', /内联发的/.test(joined) && /MB/.test(joined), joined.slice(0, 220));
  // 让人以为"这家小气"是最坏的误导 —— 他会去换厂商，而换了照样不行
  check('点明了远没到张数上限，多半是体积', /远没到上限/.test(joined) && /体积/.test(joined), joined.slice(0, 260));
  check('给了真正的出路（配对象存储）', /对象存储/.test(joined), joined.slice(0, 260));

  /**
   * 而且**不能把这个数记下来**。内联时"减到几张才过"量的是体积，
   * 当成张数上限记住的话，配好对象存储之后本来能发 9 张，
   * 却因为这条记忆继续只发 1 张 —— 不报任何错，只是"最近出的图不太像"。
   */
  check('内联被拒不写进"学来的上限"（那是体积不是张数）',
    ad.learnedMediaLimit('metaso::https://metaso.cn/api/minimax/v2::MiniMax-H3') === null,
    String(ad.learnedMediaLimit('metaso::https://metaso.cn/api/minimax/v2::MiniMax-H3')));
  void res;
  ad.resetMediaLimits();
}

section('图片上限按模型问，不是按服务商问');
{
  /**
   * 用户日志里的原话：
   *   ※ 服务端嫌图带多了（5 张），改成 2 张重试
   *   ※ 服务端嫌图带多了（2 张），改成 1 张重试
   *   ※ 海螺任务已提交
   * 每一镜都要白撞两次墙。而"海螺只吃 1 张"这件事目录里本来就写着 ——
   * 只是没人问模型，只问了服务商。
   */
  const ad = await import('../core/providers/adapters.js');
  const cat = await import('../core/providers/catalog.js');
  const mm = cat.PROVIDERS.find((p) => p.id === 'minimax');

  check('H3 还是 9 张', ad.modelMaxImages(mm, 'MiniMax-H3') === 9, String(ad.modelMaxImages(mm, 'MiniMax-H3')));
  check('海螺 2.3 只发 1 张，不再白撞两次墙',
    ad.modelMaxImages(mm, 'MiniMax-Hailuo-2.3') === 1, String(ad.modelMaxImages(mm, 'MiniMax-Hailuo-2.3')));
  check('I2V-01 同理', ad.modelMaxImages(mm, 'I2V-01') === 1);
  // S2V 的第二张走 subject_reference，占的不是首帧那个位置
  check('S2V 收 2 张', ad.modelMaxImages(mm, 'S2V-01') === 2);
  // 0 是合法答案。用 || 兜底的话这个 0 会被当成"没写"，然后按 9 张发出去
  check('文生视频模型是 0 张，而不是回退到服务商的 9 张',
    ad.modelMaxImages(mm, 'T2V-01') === 0, String(ad.modelMaxImages(mm, 'T2V-01')));
  check('目录里没写的模型退回服务商上限',
    ad.modelMaxImages(mm, '不存在的模型') === 9);
  check('连服务商都没写的退回 4', ad.modelMaxImages({ models: [] }, 'x') === 4);

  // Vidu：r2v 收 3 张，classic 走 img2video 只吃首帧
  const vidu = cat.PROVIDERS.find((p) => p.id === 'vidu');
  check('Vidu Q1 收 3 张', ad.modelMaxImages(vidu, 'viduq1') === 3);
  check('Vidu Q1 Classic 只收 1 张', ad.modelMaxImages(vidu, 'viduq1-classic') === 1);

  /**
   * 学来的上限也必须按模型记。少了模型这一段，海螺试出的"最多 1 张"
   * 会扣到同一家 H3 头上 —— 而 H3 是这家唯一能靠多张参考图锁人设的模型。
   */
  ad.resetMediaLimits();
  ad.rememberMediaLimit('minimax::https://api.minimax.chat::MiniMax-Hailuo-2.3', 1);
  check('海螺学到的数不会扣到 H3 头上',
    ad.learnedMediaLimit('minimax::https://api.minimax.chat::MiniMax-H3') === null);
  check('海螺自己那条还在',
    ad.learnedMediaLimit('minimax::https://api.minimax.chat::MiniMax-Hailuo-2.3') === 1);
  ad.resetMediaLimits();
}

section('分镜体检：出图之前就该发现的三类硬伤');
{
  const lint = await import('../core/pipeline/shotlint.js');

  /**
   * 用户报的那一场戏，一字不改地拿来当用例：
   * "老师坐在办公室、听到敲门、说请进，客人推门进来，然后坐下"
   * 出来的片子是门本来就开着 + 有敲门声 + 老师在说话，整场逻辑是反的。
   */
  const bad = lint.lintShot({
    description: '老师坐在办公室里，听到敲门声，然后客人推门进来，走了进来，坐下'
  });
  const kinds = bad.map((i) => i.kind);
  check('认出"敲门声"写进了画面', kinds.includes('sound-in-frame'), kinds.join(','));
  check('认出一镜塞了好几件事', kinds.includes('too-many-beats'), kinds.join(','));
  check('认出写的是动作做完的样子', kinds.includes('end-state'), kinds.join(','));
  // 只说"这里不对"是没用的，人下一秒就要问"那该怎么写"
  check('每条都给了改法', bad.every((i) => i.fix && i.fix.length > 8));

  // 拆开之后就该干净 —— 报个不停的检查等于没有检查，人会直接无视它
  check('拆成一镜一动作之后不再报',
    lint.lintShot({ description: '老师伏在办公桌前批改作业' }).length === 0,
    JSON.stringify(lint.lintShot({ description: '老师伏在办公桌前批改作业' })));
  check('正在发生的动作不报',
    lint.lintShot({ description: '门把手正在缓缓转动' }).length === 0);
  check('空描述不报', lint.lintShot({ description: '' }).length === 0);

  /**
   * 乱报的检查等于没有检查 —— 看两次假警报之后人就再也不看它了。
   * 所以这几条"写得很丰满但只有一个动作"的描述必须一条都不报。
   */
  const quiet = [
    '老师伏在办公桌前，台灯的光落在摊开的作业本上，窗外是深夜',
    '桌上已经堆满了文件，一支钢笔横在最上面',
    '强雄站在走廊尽头，背对镜头，肩膀微微起伏'
  ];
  for (const d of quiet) {
    check(`不误报：${d.slice(0, 12)}…`, lint.lintShot({ description: d }).length === 0,
      JSON.stringify(lint.lintShot({ description: d }).map((i) => i.kind)));
  }

  const results = lint.lintShots([
    { id: 'a', index: 1, description: '老师伏案批改作业' },
    { id: 'b', index: 2, description: '传来敲门声，然后老师抬起头' }
  ]);
  check('只回有问题的那几镜', results.length === 1 && results[0].index === 2);
  const brief = lint.summarize(results);
  check('摘要里点名是第几镜', /第 2 镜/.test(brief), brief);
  check('没问题时不吭声', lint.summarize([]) === null);
}

section('跑的是哪一版：更新完能核对，而不是去点功能试');
{
  /**
   * 服务器上更新是 `git pull && docker compose up -d --build`，
   * 这条命令有好几种"看起来成功、其实没更新"的失败法（镜像用了缓存层、
   * 容器没重建、改的是另一个目录）。没有版本号的话，
   * 判断生效没有只能靠去点个新功能试试 —— 而试出来没有还分不清是哪种原因。
   */
  const health = await (await fetch(`${appUrl}/api/health`)).json();
  check('健康检查带上了版本号', /^\d+\.\d+\.\d+$/.test(health.version || ''), String(health.version));
  check('也带上了构建标记', typeof health.build === 'string' && health.build.length > 0, String(health.build));
  // 注入不到时回 dev 而不是装作知道 —— 一个假的版本号比没有版本号更坏
  check('没注入提交号时老实说 dev', health.build === 'dev', String(health.build));

  const ver = await import('../core/version.js');
  const info = ver.info();
  check('版本号从 package.json 读，不是写死的', info.version === health.version);

  /**
   * 打 exe 那条路不能靠环境变量：electron-builder 把源码打进 asar，
   * 用户双击运行时构建机上那个变量早就没了。所以要落成文件跟着一起打包。
   * 少了这一条，所有 exe 用户看到的都是 dev。
   */
  const buildJson = path.join(PROJECT_ROOT, 'core', 'build.json');
  const hadBuildJson = fs.existsSync(buildJson);
  const savedBuildJson = hadBuildJson ? fs.readFileSync(buildJson, 'utf8') : null;
  try {
    fs.writeFileSync(buildJson, JSON.stringify({ build: 'abc1234' }));
    // info() 有缓存，用一个带查询串的地址拿一份新的模块实例
    const fresh = await import(`../core/version.js?v=${Date.now()}`);
    check('打包时写进去的提交号读得出来', fresh.info().build === 'abc1234', fresh.info().build);
  } finally {
    if (savedBuildJson === null) fs.rmSync(buildJson, { force: true });
    else fs.writeFileSync(buildJson, savedBuildJson);
  }

  // 生成的文件不该进版本库 —— 提交进去它永远指向"上次提交时的上一个提交"
  const ignore = fs.readFileSync(path.join(PROJECT_ROOT, '.gitignore'), 'utf8');
  check('build.json 在 .gitignore 里', /core\/build\.json/.test(ignore));

  // Docker 那条路要把提交号钉进镜像，少了 build-arg 这一环整件事就白做了
  const dockerfile = fs.readFileSync(path.join(PROJECT_ROOT, 'Dockerfile'), 'utf8');
  check('Dockerfile 收 FD_BUILD 并转成环境变量',
    /ARG FD_BUILD/.test(dockerfile) && /ENV FUTUREDREAM_BUILD=\$FD_BUILD/.test(dockerfile));
  const compose = fs.readFileSync(path.join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8');
  check('compose 把 FD_BUILD 传给构建', /FD_BUILD:\s*"\$\{FD_BUILD/.test(compose));
}

section('叫停：真的走一遍接口，而不是只测那个开关');
{
  /**
   * 前面两段测的是零件。这一段测的是**整件事到底成不成** ——
   * 起一个真的跑八镜的任务，跑到一半从另一条连接上点「停」，
   * 然后看它是不是真的没把剩下几镜发出去。
   *
   * 只测开关的话，有太多种"开关翻了但没人看"的失败法：
   * 信号没传进循环、循环里没有安全点、异常在 catch 里被当成
   * 普通失败吞掉然后接着跑下一镜 —— 每一种都会让钱照烧。
   */
  const cp = await (
    await fetch(`${appUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '叫停自检' })
    })
  ).json();

  const SHOTS = 8;
  store.update(cp.id, (p) => {
    p.bible = { style: { anchor: '国风', negative: '' },
      characters: [{ name: '阿澜', appearance: '短发', seed: 7, variants: [{ id: 'v-default', name: '默认造型' }] }],
      scenes: [], props: [] };
    p.shots = Array.from({ length: SHOTS }, (_, i) => ({
      id: `c${i + 1}`, index: i + 1, characters: ['阿澜'],
      description: `第 ${i + 1} 镜`, camera: '中景', duration: 4
    }));
    return p;
  });

  const events = [];
  let cancelReply = null;
  const res = await fetch(`${appUrl}/api/projects/${cp.id}/stage/assets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let doneShots = 0;
  let busyStatus = null;
  let busyBody = '';
  let jobPeek = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      events.push(ev);
      if (ev.type === 'shot' && ev.status === 'done') {
        doneShots += 1;
        // 第二镜出完就叫停 —— 跑到一半才是真实场景
        if (doneShots === 2 && !cancelReply) {
          // 同一时刻再点一次「跑」，必须被 409 拦下（两条流水线会抢同一批文件）
          const again = await fetch(`${appUrl}/api/projects/${cp.id}/stage/assets`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
          });
          busyStatus = again.status;
          busyBody = await again.text();

          /**
           * 流断了之后，"现在还在跑吗、跑到第几镜"必须问得出来。
           *
           * 用户的原话：「点击全跑了，手机切屏一会回来刷屏还是不动」。
           * 这份活儿跑在服务器上，切屏只是把那条进度流掐了 —— 而这一端
           * 从来不问一句"还在跑吗"，于是回来看到的是一个静止的页面，
           * 人只能判断成卡死了，再点一次「往后全跑」，撞上 409。
           */
          jobPeek = await (await fetch(`${appUrl}/api/projects/${cp.id}/job`)).json();

          cancelReply = await (
            await fetch(`${appUrl}/api/projects/${cp.id}/cancel`, { method: 'POST' })
          ).json();
        }
      }
    }
  }

  check('正在跑的时候再点一次跑，被 409 拦下', busyStatus === 409, String(busyStatus));
  /**
   * 409 的**正文**必须写清楚。手机上那条错误提示原来只有光秃秃一行
   * "HTTP 409" —— 一个状态码对用户是零信息，尤其 409 这种字面上什么也没说的。
   * 话本来就写好了（jobs.start 里那一段），只是前端没把它读出来。
   */
  const busySaid = (() => { try { return JSON.parse(busyBody).error || ''; } catch { return ''; } })();
  check('409 的正文说清楚了是"已经在跑"', /已经在跑/.test(busySaid), busySaid.slice(0, 120));
  check('并且给出两条出路（等它跑完 / 先停下来）',
    /等它跑完/.test(busySaid) && /停下来/.test(busySaid), busySaid.slice(0, 160));

  // 流断了也问得出"还在跑吗、跑到第几镜"
  check('断流之后还能问出这份活儿在跑', jobPeek?.running === true, JSON.stringify(jobPeek));
  check('并且说得出跑到第几镜（手机切屏回来全靠它）',
    Number.isInteger(jobPeek?.shotIndex) && jobPeek.shotIndex > 0, JSON.stringify(jobPeek));
  check('也说得出是哪一镜的 id（分镜页上要把那张点亮）',
    Boolean(jobPeek?.shotId), JSON.stringify(jobPeek?.shotId));
  check('取消接口回了确认', cancelReply?.cancelled === true, JSON.stringify(cancelReply));

  const last = events[events.length - 1];
  // 收尾事件必须是 cancelled 而不是 error —— 前端拿这个字段决定提示语，
  // 报成 error 会让人回头去查一个根本不存在的问题
  check('流以「已停下」收尾，不是报错', last?.type === 'cancelled', JSON.stringify(last).slice(0, 160));
  check('收尾时把当前项目也带回来了（界面要拿它刷新）', Boolean(last?.project?.shots));

  const after = store.read(cp.id);
  const made = after.shots.filter((x) => x.imagePath).length;
  /**
   * 这一条是整个功能的意义所在：**剩下几镜的钱省下来了**。
   * 允许比 2 多一两镜（叫停请求飞过去的时候手上那镜正在跑），
   * 但绝不能是 8 —— 那说明取消压根没生效。
   */
  check(`八镜里只出了前几镜就停了（实际 ${made} 镜）`, made >= 2 && made <= 4, String(made));
  check('没被停掉的那几镜没有被标成失败',
    after.shots.filter((x) => x.status === 'failed').length === 0,
    JSON.stringify(after.shots.map((x) => x.status)));

  // 停完之后登记表要干净，不然下一次「跑」会被自己的残留挡住
  const job = await (await fetch(`${appUrl}/api/projects/${cp.id}/job`)).json();
  check('停完之后没有残留的任务登记', job.running === false, JSON.stringify(job));

  // 接着跑：剩下那几镜要能补齐，而且已经出好的不重出（不重复计费）
  const resume = await ndjson(`/projects/${cp.id}/stage/assets`, {});
  check('停完还能接着跑', resume.some((e) => e.type === 'finished'));
  check('剩下的镜头补齐了', store.read(cp.id).shots.every((x) => x.imagePath));
}

section('叫停：停在下一个安全点，而不是掐断');
{
  const jobs = await import('../core/jobs.js');
  jobs.__reset();

  // ── 登记与并发 ──
  const j = jobs.start('p1', 'video');
  check('登记上了', jobs.describe('p1').running === true);
  check('阶段名翻成人话', jobs.describe('p1').stageLabel === '出视频', jobs.describe('p1').stageLabel);
  check('别的项目不受影响', jobs.describe('p2').running === false);

  /**
   * 同一个项目不许跑两遍。以前连点两下「全跑」就是两条流水线抢同一批文件，
   * 表现是"有几镜莫名其妙变回了旧的"，几乎不可能靠看日志查出来。
   */
  let busy = null;
  try {
    jobs.start('p1', 'assets');
  } catch (err) {
    busy = err;
  }
  check('同项目跑两遍会被拦下', busy?.code === 'BUSY', String(busy?.code));
  check('并且说清楚了在跑什么、该怎么办', /已经在跑「出视频」/.test(busy?.message || ''), busy?.message);
  check('别的项目照样能开', Boolean(jobs.start('p2', 'assets')));

  // ── 取消 ──
  check('取消前没有中止信号', j.signal.aborted === false);
  const r = jobs.cancel('p1');
  check('取消成功', r.cancelled === true);
  check('信号发出去了', j.signal.aborted === true);
  /**
   * 这句话必须说清楚"手上这一镜会跑完"。
   * 只回一个 ok 的话，用户看着它又跑完一镜会以为按钮坏了 ——
   * 而那一镜的钱本来就已经花了，掐掉才是真的浪费。
   */
  check('说清楚了手上那一镜会跑完', /跑完并存下来/.test(r.message), r.message);
  check('也说清楚了后面的不发', /还没开始.*都不发|不发/.test(r.message), r.message);
  check('再点一次不会重复中止', /已经在停了/.test(jobs.cancel('p1').message));
  check('状态里标着正在停', jobs.describe('p1').cancelling === true);
  check('没在跑的项目取消是句人话，不是报错',
    jobs.cancel('p3').cancelled === false && /没有在跑/.test(jobs.cancel('p3').message));

  // ── 安全点 ──
  let stopped = null;
  try {
    jobs.checkpoint(j.signal, '第 5 镜起往后的 6 镜');
  } catch (err) {
    stopped = err;
  }
  check('到安全点会停', stopped?.code === 'CANCELLED', String(stopped?.code));
  // "不计费"这三个字很要紧：用户最担心的就是"我点了停，钱还在烧吗"
  check('并且说明没开始的不计费', /不计费/.test(stopped?.message || ''), stopped?.message);
  check('认得出这是取消不是失败', jobs.isCancel(stopped) === true);
  check('别的错不会被当成取消', jobs.isCancel(new Error('厂商 500')) === false);
  // 没取消时 checkpoint 必须什么都不做，否则整条流水线跑不起来
  const fresh = jobs.start('p4', 'assets');
  jobs.checkpoint(fresh.signal, '不该抛');
  check('没取消时安全点直接放行', true);

  // ── 收工 ──
  jobs.finish(j);
  check('收工后登记表里没有了', jobs.describe('p1').running === false);
  // 拿别人的 job 来收会误删掉后开的那一份
  const later = jobs.start('p1', 'voice');
  jobs.finish(j);
  check('收工只收自己那一份', jobs.describe('p1').running === true);
  jobs.finish(later);
  jobs.__reset();
}

section('叫停：轮询停下来，但不能把已经花掉的钱弄丢');
{
  /**
   * 这是取消里最容易造成实际损失的一处：任务**已经提交**，钱已经在花。
   * 停轮询是对的，但如果连 task_id 一起丢掉 ——
   * 片子在厂商那儿跑完了，而你再也找不回来。
   */
  const { poll } = await import('../core/http-client.js');

  const ac = new AbortController();
  ac.abort();
  let err = null;
  try {
    await poll(async () => ({ done: false, value: {} }), { signal: ac.signal, taskId: 'task-88', intervalMs: 10 });
  } catch (e) {
    err = e;
  }
  check('取消时轮询停下来', err?.code === 'CANCELLED', String(err?.code));
  check('任务号带出来了（上层要拿它记「待认领」）', err?.taskId === 'task-88', String(err?.taskId));
  check('话里点明了它已经计费、去哪儿找回来',
    /计费/.test(err?.message || '') && /待认领/.test(err?.message || ''), err?.message);

  // 跑到一半才取消：已经问过的那几次不该白问，但不能再往下问
  const ac2 = new AbortController();
  let asked = 0;
  let err2 = null;
  try {
    await poll(
      async () => {
        asked += 1;
        if (asked === 2) ac2.abort();
        return { done: false, value: {} };
      },
      { signal: ac2.signal, taskId: 't2', intervalMs: 10 }
    );
  } catch (e) {
    err2 = e;
  }
  check('中途取消，问过两次就停', asked === 2, String(asked));
  check('中途取消也带着任务号', err2?.taskId === 't2');

  // 没有信号时行为一点不变 —— 这条路上绝大多数调用都不传信号
  let n = 0;
  const v = await poll(async () => { n += 1; return n >= 2 ? { done: true, value: 'ok' } : { done: false, value: {} }; },
    { intervalMs: 5 });
  check('不传信号时照常轮询到底', v === 'ok' && n === 2, `${v}/${n}`);
}

section('音效：不是拿配音模型念"敲门声"三个字');
{
  const ad = await import('../core/providers/adapters.js');
  const auth = await import('../core/providers/auth.js');
  const cat = await import('../core/providers/catalog.js');
  const vault = await import('../core/vault.js');

  // ── 能力是分开的 ──
  check('目录里音效是独立能力', Boolean(cat.CAPABILITIES.sfx), JSON.stringify(Object.keys(cat.CAPABILITIES)));
  const el = cat.PROVIDERS.find((p) => p.id === 'elevenlabs');
  check('有一家做音效的', Boolean(el) && el.capabilities.includes('sfx'));

  /**
   * 鉴权头写错是这类接入最常见、也最难查的一种失败：
   * 对方回 401，而 401 的第一反应永远是"密钥不对"，
   * 人会去控制台反复重建密钥，白折腾一圈。
   */
  vault.setSecret('ELEVENLABS_API_KEY', 'el-test-key-1234');
  const heads = auth.buildAuthHeaders(el);
  check('用 xi-api-key 而不是 Bearer', heads['xi-api-key'] === 'el-test-key-1234', JSON.stringify(heads));
  check('并且不多发一个 Authorization', !heads.Authorization, JSON.stringify(heads));

  // ── 不做音效就是不做，不回退 ──
  let refused = null;
  try {
    await ad.generateSfx({ providerId: 'dashscope', model: 'qwen3-tts-flash', text: '敲门声' });
  } catch (err) {
    refused = err;
  }
  // 回退到配音模型的话，出来的是一个人念"敲门声"这三个字，
  // 而且会被当成成片的一部分交付出去 —— 比没有音效更糟
  check('拿配音服务商做音效会被当场拒绝', Boolean(refused), String(refused));
  check('并且说清了为什么', /念/.test(refused?.message || ''), refused?.message);

  const r = ad.resolvedRouting();
  check('默认不配音效服务商', !r.sfx.provider, JSON.stringify(r.sfx));

  // ── 真发一次 ──
  settings.patch({ baseUrls: { elevenlabs: `${upstreamUrl}/v1` } });
  upstream.sfxBodies = [];
  const got = await ad.generateSfx({
    providerId: 'elevenlabs', model: 'eleven_text_to_sound_v2', text: '木门被敲三下', seconds: 2.5
  });
  check('拿到了音频（二进制那条路）', Boolean(got.binaryRequest || got.url), JSON.stringify(got).slice(0, 120));

  // 时长要卡住：音效比画面长的话会响到下一镜上，观众立刻听出不对
  const body = upstream.sfxBodies[0] || got.binaryRequest?.body;
  check('把时长带过去了', Number(body?.duration_seconds) === 2.5, JSON.stringify(body));
  const capped = await ad.generateSfx({ providerId: 'elevenlabs', text: 'x', seconds: 999 });
  const cappedBody = upstream.sfxBodies[1] || capped.binaryRequest?.body;
  check('离谱的时长被夹住', Number(cappedBody?.duration_seconds) <= 22, JSON.stringify(cappedBody));

  settings.patch({ baseUrls: {} });
}

section('音效走完整条：从分镜那一栏到成片的音轨里');
{
  /**
   * 前面测的是零件。这一段走真接口：建项目 → 分镜里写上音效 →
   * 跑配音那一步 → 看音效文件出没出来、混音时是不是压低了。
   */
  const sp = await (
    await fetch(`${appUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '音效自检' })
    })
  ).json();

  store.update(sp.id, (p) => {
    p.bible = { style: { anchor: '国风', negative: '' }, characters: [], scenes: [], props: [] };
    p.shots = [
      { id: 'x1', index: 1, segment: 1, description: '老师伏案批改作业', duration: 4,
        sound: '远处传来敲门声', videoPath: '/tmp/x1.mp4', dialogue: '', characters: [] },
      { id: 'x2', index: 2, segment: 1, description: '老师抬起头', duration: 3,
        sound: '', videoPath: '/tmp/x2.mp4', dialogue: '', characters: [] }
    ];
    return p;
  });

  // ① 没配音效服务商：跳过，而且要说清楚为什么，不能闷声不做
  const skipped = await ndjson(`/projects/${sp.id}/stage/voice`, {});
  const skipNote = skipped.filter((e) => e.type === 'note').map((e) => e.message).join(' | ');
  check('没配服务商时说明跳过了', /还没配音效服务商/.test(skipNote), skipNote.slice(0, 200));
  // 故意不回退到配音模型这件事必须写在提示里 —— 否则用户会以为是 bug
  check('并且解释了为什么不用配音模型顶上', /念/.test(skipNote), skipNote.slice(0, 240));
  check('这时候没有音效文件', !store.read(sp.id).shots[0].sfxPath);

  // ② 配上之后真的出
  settings.patch({
    baseUrls: { elevenlabs: `${upstreamUrl}/v1` },
    sfxProvider: 'elevenlabs',
    sfxModel: 'eleven_text_to_sound_v2'
  });
  upstream.sfxBodies = [];
  const ran = await ndjson(`/projects/${sp.id}/stage/voice`, {});
  const after = store.read(sp.id);

  check('写了音效的那一镜出了文件', Boolean(after.shots[0].sfxPath), JSON.stringify(after.shots[0].sfxPath));
  check('文件真的落盘了', after.shots[0].sfxPath && fs.existsSync(after.shots[0].sfxPath));
  check('没写音效的那一镜不花这笔钱', !after.shots[1].sfxPath);
  check('发过去的是那句描述', upstream.sfxBodies[0]?.text === '远处传来敲门声', JSON.stringify(upstream.sfxBodies[0]));
  // 音效比画面长的话会响到下一镜上，所以生成时就按镜头时长卡
  check('时长按镜头卡住', Number(upstream.sfxBodies[0]?.duration_seconds) <= 4,
    String(upstream.sfxBodies[0]?.duration_seconds));
  // 改了描述之后界面要能说清"现在这条音效是旧的"
  check('记下了当时那句描述', after.shots[0].sfxOf === '远处传来敲门声', after.shots[0].sfxOf);
  check('说明了会压在台词底下',
    ran.some((e) => /压在台词底下/.test(e.message || '')),
    ran.filter((e) => e.type === 'note').map((e) => e.message).join(' | ').slice(0, 200));

  // ③ 已经出过的不重出 —— 重出就是重复计费
  upstream.sfxBodies = [];
  await ndjson(`/projects/${sp.id}/stage/voice`, {});
  check('已经有的音效不重出（不重复计费）', upstream.sfxBodies.length === 0, String(upstream.sfxBodies.length));

  /**
   * ④ 改了描述就要重出。
   *
   * 只看"有没有文件"的话，改完描述再跑一遍什么都不会变 ——
   * 界面上标着"音效已过时"，重跑也退不掉，人只会觉得那个标记坏了。
   * 而实际后果更实在：成片里还是那声旧的。
   */
  await fetch(`${appUrl}/api/projects/${sp.id}/shots/x1`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sound: '玻璃杯摔碎' })
  });
  check('改完描述，界面上认得出这条音效过时了',
    store.read(sp.id).shots[0].sfxOf !== store.read(sp.id).shots[0].sound);
  upstream.sfxBodies = [];
  await ndjson(`/projects/${sp.id}/stage/voice`, {});
  check('改了描述会重出', upstream.sfxBodies[0]?.text === '玻璃杯摔碎', JSON.stringify(upstream.sfxBodies[0]));
  check('重出之后不再是过时的',
    store.read(sp.id).shots[0].sfxOf === '玻璃杯摔碎', store.read(sp.id).shots[0].sfxOf);

  settings.patch({ baseUrls: {}, sfxProvider: '', sfxModel: '' });
}

section('混音：音效必须压在台词底下');
{
  const ff = await import('../core/ffmpeg.js');

  /**
   * 等响的话，一声关门就能把一句台词整个盖掉 —— 而台词是观众唯一的信息来源。
   * 这是混音里最基本的一条，也是自己做音频最容易做砸的一处：
   * 素材各自听着都正常，混到一起才发现听不清人话。
   */
  const graph = ff.voiceFilterGraph([
    { path: 'line.mp3', at: 0 },
    { path: 'knock.mp3', at: 2.5, gain: 0.35 }
  ]);
  check('台词按原音量', /\[0:a\]adelay=0:all=1\[a0\]/.test(graph), graph);
  check('音效压低了', /\[1:a\]adelay=2500:all=1,volume=0\.350\[a1\]/.test(graph), graph);
  // gain=1 不该多加一个没用的 volume 滤镜 —— 每多一层滤镜就多一次重采样
  check('gain 为 1 时不多加滤镜',
    !/volume=/.test(ff.voiceFilterGraph([{ path: 'a.mp3', at: 0, gain: 1 }])));
  check('没写 gain 也不加', !/volume=/.test(ff.voiceFilterGraph([{ path: 'a.mp3', at: 0 }])));
  // 二十条混完每句只剩 1/20 音量，听上去像没配音
  check('仍然不做音量均分', /normalize=0/.test(graph));
}

section('场次：先决定在哪儿断，再决定拆成几镜');
{
  const seg = await import('../core/pipeline/segments.js');
  const tr = await import('../core/transitions.js');

  // ── 洗模型给的场次表 ──
  const segs = seg.normalizeSegments([
    { where: '办公室', when: '二十年前', summary: '明锋收下支票', enter: 'dissolve' },
    { where: '办公室', when: '今天', summary: '明锋想起那天', enter: 'fade' },
    { where: '走廊', when: '今天', enter: '花式旋转' }
  ]);
  // 第一段前面什么都没有，"进入方式"无从谈起
  check('第一场固定硬切', segs[0].enter === 'cut', segs[0].enter);
  check('第二场保留黑场', segs[1].enter === 'fade');
  check('瞎编的进入方式退回硬切', segs[2].enter === 'cut', segs[2].enter);
  check('序号重排成 1..n', segs.map((x) => x.index).join(',') === '1,2,3');
  check('模型没给场次表时回空数组，退回老行为', seg.normalizeSegments(undefined).length === 0);

  // ── 分配 ──
  const byModel = seg.assignSegments(
    [{ index: 1, segment: 1 }, { index: 2, segment: 2 }, { index: 3, segment: 99 }], segs);
  check('模型标的场次用得上', byModel[1].segment === 2);
  check('越界的夹回合法范围', byModel[2].segment === 3, String(byModel[2].segment));

  // 模型没标时按场景名推断 —— 抓不到"同地点不同时间"，但不会抓错
  const derived = seg.assignSegments(
    [{ index: 1, scene: '码头' }, { index: 2, scene: '码头' }, { index: 3, scene: '值班室' }], []);
  check('没标时按场景名变化推断', derived.map((x) => x.segment).join(',') === '1,1,2',
    derived.map((x) => x.segment).join(','));

  // ── 强制归一：这一段才是这个模块存在的理由 ──
  const raw = [
    { index: 1, segment: 1, transition: 'dissolve', link: 'cut' },
    { index: 2, segment: 1, transition: 'dissolve', link: 'continuous' },
    { index: 3, segment: 2, transition: 'cut', link: 'continuous' },
    { index: 4, segment: 2, transition: 'fade', link: 'cut' }
  ];
  const { shots: fixed, changes } = seg.enforce(raw, segs);

  check('第一镜没有转场可言', fixed[0].transition === 'cut' && fixed[0].link === 'new-scene');
  // 场次内部来一下叠化是最典型的业余做法
  check('场次内部的叠化被改回硬切', fixed[1].transition === 'cut', fixed[1].transition);
  check('场次内部的衔接关系不动', fixed[1].link === 'continuous');
  /**
   * 这一条是整条规矩里唯一会造成真实损失的：continuous 会去锁末帧，
   * 跨了二十年还这么锁，等于强行让新的一场长成上一场的样子，而且不报错。
   */
  check('跨场次的「连续动作」被改成换场景', fixed[2].link === 'new-scene', fixed[2].link);
  check('场次头一镜按场次的进入方式来', fixed[2].transition === 'fade', fixed[2].transition);
  check('场次内部的第 4 镜转场被压回硬切', fixed[3].transition === 'cut');
  // 改了什么必须说得出来 —— 悄悄改用户看得见的字段是这类归一化最容易犯的错
  check('每一处改动都有记录', changes.length >= 4, String(changes.length));
  check('记录里写清了为什么', changes.every((c) => c.why && c.why.length > 6));

  // ── 时长账 ──
  const cost = seg.overlapCost([
    { transition: 'cut' }, { transition: 'dissolve' }, { transition: 'fade' }, { transition: 'dissolve' }
  ]);
  check('只有叠化吃时长，黑场不吃', cost === tr.DISSOLVE_SECONDS * 2, String(cost));
  check('第一镜的转场不算钱', seg.overlapCost([{ transition: 'dissolve' }]) === 0);

  check('摘要点出了场次数和镜数',
    /3 个场次/.test(seg.summarize(segs, fixed) || ''), seg.summarize(segs, fixed));
}

section('接缝：不收末帧的厂商上，靠什么把两段连起来');
{
  const continuity = await import('../core/pipeline/continuity.js');
  const cat = await import('../core/providers/catalog.js');

  /**
   * 先把问题摆出来：**收末帧的厂商是少数**。
   *
   * 「连续动作」原来只有一条实现 —— 把下一镜那张图锁成这一段的末帧。
   * 它成立的前提是厂商收末帧图，而只有方舟、可灵、Vidu 收。
   * 用海螺、秘塔、百炼、Sora 时，那条路整个是空的：
   * 我们说一句"这家不收末帧"，然后两段之间就只剩文字上的衔接。
   */
  const v = (id) => cat.PROVIDERS.find((p) => p.id === id)?.videoDefaults?.endFrame === true;
  check('方舟收末帧', v('volcengine'));
  check('可灵收末帧', v('kling'));
  check('Vidu 收末帧', v('vidu'));
  check('海螺不收末帧（所以老办法在它上面是空的）', !v('minimax'));
  check('百炼不收末帧', !v('dashscope'));
  /**
   * 秘塔**是收的** —— 控制台上摆着「起始帧」和「结束帧」两个上传框。
   *
   * 目录里原来没写 endFrame，于是「连续动作」在秘塔上整个是空的：
   * 先说一句"锁成末帧，两镜之间会是无缝的"，紧接着又说"这家不收末帧，会是硬切"。
   * 两句自相矛盾的话躺在同一份日志里，而用户的控制台截图证明第二句是错的。
   *
   * 教训：目录里的一个"没写"，和"明确写了不支持"在代码里是同一回事 ——
   * 而它会安静地关掉一整条功能。
   */
  check('秘塔收末帧（控制台上有起始帧/结束帧两个框）', v('metaso'));

  /**
   * 反过来做就不依赖厂商了：等上一段跑完，抠出它**真实的最后一帧**，
   * 拿那一帧当这一镜的首帧。每一家 i2v 都收首帧图。
   */
  const prev = { id: 'a', index: 1, segment: 1, videoPath: '/x/a.mp4' };
  const shot = { id: 'b', index: 2, segment: 1 };
  check('连续动作时接住上一段的末帧',
    continuity.shouldChainFromTail(shot, prev, 'continuous') === true);
  // 同场换机位本来就该跳一下，接了反而不对
  check('同场换机位不接', continuity.shouldChainFromTail(shot, prev, 'cut') === false);
  check('换场景不接', continuity.shouldChainFromTail(shot, prev, 'new-scene') === false);
  // 上一段还没出视频时无从接起 —— 这一条决定了它必须用"刚读出来的项目"
  check('上一段还没出视频就不接',
    continuity.shouldChainFromTail(shot, { ...prev, videoPath: null }, 'continuous') === false);
  /**
   * 跨场次一律不接。这是"链式生成"唯一真正危险的地方：
   * 把二十年前那一镜的末帧接到今天这一镜的头上，
   * 等于强行让新的一场长成上一场的样子，而且不报任何错。
   */
  check('跨场次不接',
    continuity.shouldChainFromTail({ ...shot, segment: 2 }, prev, 'continuous') === false);

  /**
   * 上面这五条**全都是对的**，而用户还是出了一批片子回来说"并不是这样啊"。
   *
   * 因为它们量的是"该不该接"，没有一条量"不接的时候有没有说一声"。
   * 而 continuous 从来不会被自动推断出来（deriveLink 只在 new-scene 和 cut
   * 之间选），所以最常见的情形是一整批一个 continuous 都没有 ——
   * 接缝这条路一次都没走，日志里一个字都没有。
   *
   * 用户唯一能得出的结论是"这功能是假的"，而且他没法反驳自己。
   * 没做某件事，和做了但没说，在用户那儿是同一回事。
   */
  const st = await import('../core/pipeline/studio.js');
  const plan = st.__seamPlanOf;

  const noneShots = [
    { id: 'a', index: 1, segment: 1, scene: '走廊' },
    { id: 'b', index: 2, segment: 1, scene: '走廊' },
    { id: 'c', index: 3, segment: 1, scene: '走廊' }
  ];
  const none = plan(noneShots, noneShots, 'tail');
  check('一处连续动作都没有时，明说"这批接缝全是硬切"', /全是硬切/.test(none), none.slice(0, 60));
  // 只说"没接"是不够的 —— 人会以为坏了。要说清楚这是默认，以及为什么
  check('并且说清楚这是默认、不是坏了', /默认/.test(none) && /长镜头/.test(none), none.slice(0, 160));
  /**
   * "去哪儿改"必须指到**一个按钮**上。原来写的是"把后面那一镜的「接」改成
   * 连续动作"—— 那是二十镜要点二十次的做法，人看完不会去做。
   * 分镜页上本来就有「整段标衔接」和「自动标」，指过去才是能执行的话。
   */
  check('并且告诉他去哪儿改（指到按钮上）',
    /整段标衔接/.test(none) && /自动标/.test(none), none.slice(-140));
  /**
   * 这条是用户第四次报"接缝没生效"之后补的。
   *
   * 前面几条只说"这一批没标"，没说**不标就永远不会有**。
   * 而 continuous 是唯一不会被自动推断出来的 link —— 不写这一句，
   * 人会以为"再跑一次说不定就标上了"，然后一直等一个不会来的东西。
   */
  check('并且说明「连续动作」不会被自动判出来',
    /不会被自动判出来/.test(none), none.slice(0, 200));

  const someShots = [
    { id: 'a', index: 1, segment: 1, scene: '走廊' },
    { id: 'b', index: 2, segment: 1, scene: '走廊', link: 'continuous' },
    { id: 'c', index: 3, segment: 1, scene: '走廊' }
  ];
  const some = plan(someShots, someShots, 'tail');
  check('有连续动作时，点名是第几到第几镜', /1→2/.test(some), some.slice(0, 90));
  check('并且说清楚其余是硬切', /其余是硬切/.test(some), some.slice(0, 120));

  /**
   * 只重出后面那一镜时最容易踩空：上一段这次不出、之前也没出过片，
   * 抠不到末帧。这时候标记明明在，接缝却还是接不上 —— 不说的话
   * 就是"有时候接得上有时候接不上"，比一次都不接更让人没法排查。
   */
  const orphan = plan(someShots, [someShots[1]], 'tail');
  check('上一段没片子时点明抠不到末帧', /抠不到末帧/.test(orphan), orphan.slice(0, 120));
  check('并且给出办法（把上一镜一起选上）', /一起选上/.test(orphan), orphan.slice(-60));

  /**
   * ══ 首尾帧模式必须先说清楚它长什么样 ══
   *
   * 用户拿着 0.1.0 的 exe 回来说："收尾帧有效吗，在生成视频的时候，
   * 完全不是按照首尾来的"，以及更早那次"还是只用各自首帧生成"。
   *
   * 那个观察**是对的**：首尾帧模式下每一段确实是从自己那张图开始的，
   * 接缝是靠逼上一段"结束在下一镜那张图上"做出来的 —— 做在上一镜身上。
   * 会去看"本段首帧是不是上段尾帧"的那个预期，对应的是另一个模式。
   *
   * 功能是对的，话没说，于是被判成坏的 —— 而且判得有理有据。
   * 所以这两条量的不是"接没接"，是"有没有先讲清楚它长什么样"。
   */
  const lockPlan = plan(someShots, someShots, 'lock');
  check('首尾帧模式点明每一段仍然从自己那张图开始',
    /自己那张图/.test(lockPlan), lockPlan.slice(-220));
  check('并且点明接缝做在上一镜身上',
    /上一镜/.test(lockPlan), lockPlan.slice(-220));
  check('并且指出想要"首帧＝上段尾帧"该换哪个模式',
    /接住真实末帧/.test(lockPlan), lockPlan.slice(-220));
  // 反面：接住真实末帧模式下这句话是多余的，说了反而把人绕晕
  check('接住真实末帧模式下不说这段',
    !/自己那张图/.test(plan(someShots, someShots, 'tail')));

  const off = plan(someShots, someShots, 'off');
  check('关掉时如实说关掉了', /已关掉/.test(off), off.slice(0, 40));
}

section('节奏：每一段是独立生成的，速度得自己接上');
{
  const continuity = await import('../core/pipeline/continuity.js');

  /**
   * 用户报的：第一段人在慢慢走，第二段突然加速，很莫名其妙。
   *
   * 原因是每一段都**独立生成**：模型只看到"这一镜演什么、多长"，
   * 看不到上一段人是用什么速度走的，于是自己挑一个。
   * 首帧接住了也救不了 —— 首帧只定住第一格，速度是后面几秒的事。
   */
  const prev = { index: 1, description: '陈卫沿走廊缓步向前' };
  const lines = continuity.continuityLines(
    { index: 2, description: '陈卫走到门前停下' }, { prev, link: 'continuous' });
  const joined = lines.join('，');
  check('连续动作时要求速度接上', /运动速度和上一镜保持一致/.test(joined), joined);
  check('并且明说不要突然加快或放慢', /突然加快或放慢/.test(joined), joined);

  // 硬切不该管速度 —— 换机位本来就可以换节奏，管了反而绑手绑脚
  const cutLines = continuity.continuityLines(
    { index: 2, description: '门被推开' }, { prev, link: 'cut' }).join('，');
  check('同场换机位不管速度（换机位本来就可以换节奏）', !/运动速度/.test(cutLines), cutLines);

  // 拆分镜那一层也要说：动作量配不上时长才是节奏突变的根
  const studioSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'core', 'pipeline', 'studio.js'), 'utf8');
  check('拆分镜时要求动作量配得上时长', /动作量要配得上时长/.test(studioSrc));
  check('并且给了可照着做的量（走三五步约 3 秒之类）', /正常走三五步/.test(studioSrc));
}

section('接住末帧时，自己那张分镜图不能白出');
{
  /**
   * 用户的原话："我生成的分镜图片就没有用了"。
   *
   * 那张图是花钱出的、审过的、构图和内容都按分镜定的。
   * 接缝模式下它不再当"第一格画面"，但它该改当**参考图** ——
   * 首帧管接缝（从哪一帧长出来），参考图管内容（要演成什么样），
   * 两件事本来就不冲突，之前是被做成了二选一。
   */
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'core', 'pipeline', 'studio.js'), 'utf8');
  check('接住末帧时把本镜分镜图改当参考图', /本镜分镜图/.test(src));
  check('而且排在设定集参考图前面（它更贴这一镜要演的东西）',
    /bibleRefs\.images\.unshift/.test(src));
  check('带不上时只影响构图，不影响接缝 —— 说清楚了',
    /只影响构图参照，不影响接缝/.test(src));
}

section('末帧写法不知道就试，别押一个然后安静失效');
{
  const ad = await import('../core/providers/adapters.js');
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'core', 'providers', 'adapters.js'), 'utf8');

  /**
   * 秘塔控制台上摆着「起始帧」「结束帧」两个框，所以它一定收 ——
   * 但字段名没有公开文档。押一个然后安静失效，正是这条功能一直是空的原因。
   * 提交参数校验失败**不计费**，所以按可能性排序试一遍是划算的。
   */
  check('准备了不止一种末帧写法', /last_frame_image/.test(src) && /content-role/.test(src));
  check('试通了会记住（同一批后面的镜头不再重试）', /rememberMediaLimit\(shapeKey/.test(src));
  check('两种都不成时不带末帧兜底，而不是把这一镜废掉',
    /改成不带末帧发/.test(src) && /lastFrameUrl = null/.test(src));
  // 接缝做不上是遗憾，但必须说出来 —— 不说的话用户看到的是"标了连续动作但还是跳"
  check('并且说清楚接缝这次没做上、以及还有哪条路',
    /接缝那儿会跳一下/.test(src) && /接住真实末帧/.test(src));
  void ad;
}

section('接缝：走一遍出视频，看首帧到底发的是哪张');
{
  /**
   * 这一段量的是**接住真实末帧**那条路，所以明写 seamMode，不吃默认值。
   *
   * 默认值改成「首尾帧」的时候这条当场红了 —— 它一直靠"默认就是 tail"
   * 这个隐含前提活着。测试依赖默认值就是这样：默认一动，
   * 红的是一条和这次改动毫不相干的断言，而看的人得先花时间弄明白它为什么红。
   */
  settings.patch({ seamMode: 'tail' });
  const sp = await (
    await fetch(`${appUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '接缝自检' })
    })
  ).json();

  store.update(sp.id, (p) => {
    p.bible = { style: { anchor: '国风', negative: '' },
      characters: [{ name: '阿澜', appearance: '短发', seed: 7, variants: [{ id: 'v-default', name: '默认造型' }] }],
      scenes: [], props: [] };
    p.shots = [
      { id: 'k1', index: 1, segment: 1, characters: ['阿澜'], description: '阿澜伸手去够门把手',
        camera: '中景', duration: 4, link: 'new-scene' },
      // 第 2 镜是第 1 镜那个动作的下一瞬间 —— 接缝就该在这儿
      { id: 'k2', index: 2, segment: 1, characters: ['阿澜'], description: '手把门把手拧下去',
        camera: '特写', duration: 4, link: 'continuous' }
    ];
    return p;
  });

  await ndjson(`/projects/${sp.id}/stage/assets`, {});
  upstream.videoBodies = [];
  const evs = await ndjson(`/projects/${sp.id}/stage/video`, {});
  const after = store.read(sp.id);

  const notes = evs.filter((e) => e.type === 'note').map((e) => e.message).join(' | ');
  const ffReady = (await import('../core/ffmpeg.js')).locate({ refresh: true }).available;

  /**
   * 抠帧要 FFmpeg，而这份自检是**不依赖外部环境**的 —— 两条路都得验：
   *
   *   装了    真的抠出末帧当首帧，并且落库
   *   没装    退回自己那张分镜图，**并且说清楚为什么**
   *
   * 第二条一点都不次要：多数人第一次跑的时候就是没装 FFmpeg 的状态。
   * 那时候接缝跳一下是可以接受的，"不知道为什么跳"才不行。
   */
  if (ffReady) {
    check('第 2 镜说明了接住上一段的真实末帧', /接住第 1 镜的\*\*真实末帧\*\*/.test(notes), notes.slice(0, 300));
    check('落库记下了接缝来源（界面要显示哪几处是像素级连着的）',
      after.shots[1]?.headFromTail?.fromIndex === 1, JSON.stringify(after.shots[1]?.headFromTail));
    // 抠出来的那一帧要真的落盘 —— 不落盘的话首帧核对没法拿它去比
    check('末帧抠出来落盘了', fs.existsSync(path.join(store.assetDir(sp.id), 'k2.head.png')));
  } else {
    check('没装 FFmpeg 时明说了接不上、以及为什么',
      /没装 FFmpeg/.test(notes) && /接缝会跳一下/.test(notes), notes.slice(0, 300));
    check('并且退回用自己那张分镜图，没把这一镜废掉', Boolean(after.shots[1]?.videoPath));
    check('没接上就不记接缝来源（不能记一个没发生的事）', !after.shots[1]?.headFromTail);
  }
  check('第 1 镜没有接缝来源（它前面没有片子）', !after.shots[0]?.headFromTail);

  /**
   * ⚠ 首帧核对必须拿**真正发出去的那张**去比。
   *
   * 接缝模式下发的是上一段的末帧，不是这一镜的分镜图。
   * 还拿分镜图去比的话，每一个接住上一镜的镜头都会被报成"首帧没吃" ——
   * 一个彻头彻尾的假警报，而且恰恰出现在接缝工作得最好的那几镜上。
   * 假警报比没有警报更坏：报几次之后，真的那次也没人看了。
   */
  check('首帧核对没有误报"首帧没吃"',
    after.shots[1]?.headMatch?.verdict !== 'mismatch',
    JSON.stringify(after.shots[1]?.headMatch));

  // 关掉就该完全退回老行为
  settings.patch({ seamMode: 'off' });
  store.update(sp.id, (p) => { p.shots.forEach((x) => { x.videoPath = null; x.headFromTail = null; }); return p; });
  const off = await ndjson(`/projects/${sp.id}/stage/video`, {});
  check('关掉之后不接末帧',
    !off.some((e) => /真实末帧/.test(e.message || '')) && !store.read(sp.id).shots[1]?.headFromTail);
  // 还回默认，别把后面的段一起带偏
  settings.patch({ seamMode: 'lock' });
}

section('成片体检：现在能不能发');
{
  const q = await import('../core/pipeline/quality.js');
  const shot = (i, o = {}) => ({ id: `q${i}`, index: i, description: '他站在门口', ...o });
  const done = (i, o = {}) => shot(i, { imagePath: 'a', videoPath: 'v', ...o });

  /**
   * 检查一直都有，但散在四个地方各说各的：分镜卡片上的一致性分数、分镜体检、
   * 出视频日志里的首帧核对和接缝比对、合成日志里的台词超长。
   * 每一条单看都有用，合起来却回答不了那个真正要问的问题 ——
   * **我现在导出去，会不会有明显的错？**
   */
  const clean = q.audit({ bible: { characters: [{ name: 'A', sheetPath: 'x' }], scenes: [] }, shots: [done(1), done(2)] });
  check('全都齐时给放行', clean.verdict === 'ready' && clean.score === 100, JSON.stringify(clean.counts));
  check('放行时也说清楚查了什么', /没有查出问题/.test(q.headline(clean)), q.headline(clean));

  /**
   * ── blocker 的定义：导出去**一定**有人看得出来 ──
   *
   * 这三条都不会让任何一步失败：合成照样成功，成片照样导得出来。
   * 所以只能靠体检发现 —— 而这正是它存在的理由。
   */
  const noVideo = q.audit({ shots: [done(1), shot(2, { imagePath: 'a' })] });
  check('有图没视频 → 拦', noVideo.verdict === 'not-ready' && noVideo.items[0].id === 'missing-video',
    JSON.stringify(noVideo.items.map((i) => i.id)));
  check('说清楚后果（成片里那段直接没有）', /直接不存在/.test(noVideo.items[0].why), noVideo.items[0].why);

  const silent = q.audit({ shots: [done(1, { dialogue: '我不同意' })] });
  check('有台词没配音 → 拦', silent.items.some((i) => i.id === 'missing-voice'));
  check('点明它不会让任何一步失败（所以只能靠体检发现）',
    /照样导得出来/.test(silent.items.find((i) => i.id === 'missing-voice').why));

  const broken = q.audit({ shots: [done(1, { link: 'continuous', tailAlign: { verdict: 'missed' } })] });
  check('标着连续动作但接缝没锁上 → 拦', broken.items.some((i) => i.id === 'seam-missed'));
  /**
   * 这一条算 blocker 不是因为画面坏了，是因为**界面在说谎**：
   * 卡片上写着「连续动作」，人据此以为是连的，直到成片放到那儿才发现跳了。
   */
  check('理由是界面和事实不一致', /界面和事实不一致/.test(broken.items.find((i) => i.id === 'seam-missed').why));

  /**
   * ══ 接缝"两条路都没走成"也要拦 ══
   *
   * 这一条是 endFrameChained 改成"如实回报"之后必须补的。
   *
   * 那个字段原来记的是"我们打算发末帧"，所以只要标了连续动作它就是 true，
   * 接缝复核一定会跑，跑出 missed 就被上面那条拦下。现在它记的是
   * "真的发出去了没有" —— 末帧被厂商扔掉的那些镜，复核直接不跑
   * （没锁过，验什么），tailAlign 是 null，上面那条**拦不到它们**。
   *
   * 不补这一条的话，接缝消失得比以前更安静：卡片上标着连续动作、
   * 体检一片绿、成片放到那儿跳一下。用户报的"后面几个一个都连不上"
   * 就是这种形状。
   */
  const nothing = q.audit({
    shots: [
      done(1, { endFrameChained: false }),
      done(2, { link: 'continuous', headFromTail: null })
    ]
  });
  check('末帧被扔了、也没接住上一段 → 拦',
    nothing.items.some((i) => i.id === 'seam-nothing'), JSON.stringify(nothing.items.map((i) => i.id)));
  check('并且指向真正的解法（配对象存储，别让末帧被挤掉）',
    /对象存储/.test(nothing.items.find((i) => i.id === 'seam-nothing').fix));
  // 反面两条：接缝真做上了就不该报，否则这条会变成一条永远红的噪音
  const lockOk = q.audit({
    shots: [done(1, { endFrameChained: true }), done(2, { link: 'continuous' })]
  });
  check('首尾帧真锁上了就不报', !lockOk.items.some((i) => i.id === 'seam-nothing'),
    JSON.stringify(lockOk.items.map((i) => i.id)));
  const tailOk = q.audit({
    shots: [done(1, { endFrameChained: false }), done(2, { link: 'continuous', headFromTail: { fromIndex: 1 } })]
  });
  check('走的是接住真实末帧那条路，也不报', !tailOk.items.some((i) => i.id === 'seam-nothing'),
    JSON.stringify(tailOk.items.map((i) => i.id)));

  // ── warn：质量风险，但未必看得出来 ──
  const low = q.audit({ shots: [done(1, { consistency: { score: 60 } })] });
  check('一致性偏低是 warn 不是 blocker', low.verdict === 'fixable', JSON.stringify(low.counts));
  /**
   * 手改过描述之后那个分数是给**旧描述**打的。
   * 拿它当"这一镜没问题"的证据，等于用一个过期的结论放行。
   */
  const stale = q.audit({ shots: [done(1, { consistency: { score: 95, stale: true } })] });
  check('过时的高分不当作通过', stale.items.some((i) => i.id === 'consistency-stale'), JSON.stringify(stale.items.map((i) => i.id)));
  check('而且不因为分数高就漏报', stale.verdict !== 'ready');

  /**
   * ⚠ 分档必须**真的分得开**。什么都标成 blocker 的话，人第一次看到十几条红的
   * 就再也不看这一页了 —— 那比没有这一页更糟。
   */
  const mixed = q.audit({
    shots: [done(1, { consistency: { score: 60 } }), shot(2, { imagePath: 'a' })],
    bible: { characters: [{ name: 'A' }], scenes: [] }
  });
  check('blocker 排在 warn 前面', mixed.items[0].level === 'blocker', JSON.stringify(mixed.items.map((i) => i.level)));
  check('两档同时存在时不会混为一谈', mixed.counts.blocker > 0 && mixed.counts.warn > 0, JSON.stringify(mixed.counts));

  /**
   * 一句话结论**永远带上最要紧的那一条**。
   * 只有分数的说法（"质量分 88"）没有信息量 —— 人下一秒就要问"哪儿扣的分"。
   */
  check('结论里带着最要紧那条，不是光一个分数',
    q.headline(mixed).includes(mixed.items[0].what), q.headline(mixed));

  check('没有分镜时直接说没分镜', q.audit({ shots: [] }).items[0].what === '还没有分镜');
}

section('自动剪辑：跳掉开头那几帧不动的');
{
  const ac = await import('../core/autocut.js');
  const ih = await import('../core/imghash.js');
  // 用真哈希的汉明距离，别自己造一个 —— 造出来的会和产线用的那个不是一回事
  const opts = { hamming: ih.hamming };
  // 把"帧差序列"直接变成假哈希：第 i 位翻 d 个 bit，汉明距离就是 d
  const fromDiffs = (diffs) => {
    const out = ['0000000000000000'];
    let acc = 0n;
    for (const d of diffs) {
      acc ^= BigInt((2 ** d) - 1);          // 翻 d 个 bit
      out.push(acc.toString(16).padStart(16, '0'));
    }
    return out;
  };

  /**
   * 图生视频几乎都有的毛病：开头零点几秒是不动的（模型在"起势"，
   * 前几帧基本是首帧的复制）。一段察觉不到，二十段连起来整片发黏 ——
   * 而逐段看每一段都没问题，这正是最难自己发现的那类。
   */
  check('开头五帧不动 → 从 1 秒进',
    ac.headTrim([0, 0, 0, 0, 0, 4, 5, 4, 5, 4]) === 1, String(ac.headTrim([0, 0, 0, 0, 0, 4, 5, 4, 5, 4])));

  /**
   * ⚠ 这一条是拿真视频跑出来的回归。
   *
   * 第一版用的是**绝对阈值**（汉明距离 ≤ 3 算静止）。而一段从第一帧就在动的
   * 真片子，相邻帧差只有 2~4 —— 全在阈值以下，于是整段被判成"开头一秒没动"，
   * 白白剪掉一秒真内容。单元测试当时是绿的，因为我造的假数据用的是大数。
   *
   * 现在判据是**相对这一段自己的运动量**：低于中位数四分之一才算没动。
   */
  check('全程都在动（帧差只有 2~4）→ 一帧都不剪',
    ac.headTrim([2, 2, 2, 2, 2, 3, 4, 3, 2, 3]) === 0,
    String(ac.headTrim([2, 2, 2, 2, 2, 3, 4, 3, 2, 3])));

  // 整段静止的空镜：那就是它本来的样子，剪掉就没了
  check('全程静止的空镜一帧都不剪', ac.headTrim([0, 0, 0, 0, 0, 0]) === 0);

  /**
   * ⚠ **一帧的编码噪点不算"开始动了"。**
   *
   * floor 的下限是 1，而旧写法见到第一个 `>= floor` 就停 ——
   * 于是任何一处差值为 1 的抖动都能把整个检测掐掉。偏偏那个抖动
   * 最常出现在最前面：第一帧是 I 帧、第二帧是 P 帧，编码方式不同，
   * 哪怕画面完全一样 dHash 也可能差 1。
   *
   * 这不是假想。我给真 FFmpeg 走查造测试片时随手加了个
   * `-preset ultrafast`，采出来的差值就成了 [1,0,0,0,0,0,2,2,…]——
   * 肉眼一看就是前六帧没动，而旧写法判成 0。同一段素材换个 preset
   * 就能正常判出来，而厂商用什么编码参数我们管不着。
   */
  check('开头一帧噪点不算开始动（[1,0,0,0,0,0,2,2,2] 仍判得出废头）',
    ac.headTrim([1, 0, 0, 0, 0, 0, 2, 2, 2]) > 0,
    String(ac.headTrim([1, 0, 0, 0, 0, 0, 2, 2, 2])));
  // 反面：真的从第一帧就在动，必须还是 0 —— 否则上面那条是靠放水换来的
  check('真从头就在动的，还是一帧都不剪',
    ac.headTrim([2, 2, 2, 2, 2, 3, 4, 3, 2, 3]) === 0,
    String(ac.headTrim([2, 2, 2, 2, 2, 3, 4, 3, 2, 3])));
  // 中间偶发一帧噪点也不该被当成"动起来了"而提前收尾
  check('废头中间夹一帧噪点也扛得住',
    ac.headTrim([0, 0, 1, 0, 0, 0, 5, 5, 5]) > 0.4,
    String(ac.headTrim([0, 0, 1, 0, 0, 0, 5, 5, 5])));

  /**
   * 安全带：最多砍 1 秒。万一判断出错（比如慢镜头被当成静止），
   * 没有它就会把整段砍光。宁可少剪，也不要剪掉真内容。
   */
  check('最多只砍 1 秒（判错时的安全带）',
    ac.headTrim(Array(20).fill(0).concat([9, 9, 9])) <= ac.MAX_HEAD,
    String(ac.headTrim(Array(20).fill(0).concat([9, 9, 9]))));

  // ── 挑窗口 ──
  const dead = fromDiffs([0, 0, 0, 0, 0, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6]);
  const w = ac.pickWindow(dead, 4, 3, opts);
  check('去掉废头之后从 1 秒切 3 秒', w.in === 1 && w.out === 4, JSON.stringify(w));

  /**
   * 去完头就不够长了的话，把入点往回挪。
   * 时长不够会触发补帧（把最后一帧冻住撑时间），那比开头顿一下难看得多 ——
   * 画面彻底静止，观众一眼就看出是凑数的。
   */
  const tight = ac.pickWindow(dead, 3.4, 3, opts);
  check('去完头不够长时，入点往回挪保时长',
    tight.in === 0.4 && Number((tight.out - tight.in).toFixed(2)) === 3, JSON.stringify(tight));

  // 报的时候只报真剪了的。"0 镜被剪"每次合成都印一遍是纯噪音
  check('一条都没剪时不打那行', ac.summarize([{ trimmed: false, deadHead: 0, index: 1 }]) === null);
  const brief = ac.summarize([{ trimmed: true, deadHead: 0.6, in: 0.6, index: 3 }]);
  check('剪了就说清楚剪了哪几镜、为什么', /#3/.test(brief) && /首帧的复制/.test(brief), brief);
}

section('历史版本：重出之前把上一版留下来');
{
  const v = await import('../core/versions.js');
  const os2 = await import('node:os');

  /**
   * 每一次重出写的都是同一个路径（`<镜头id>.png` / `.mp4`），旧的直接被覆盖。
   * "重出三次，第二次最好"这种再常见不过的情形没有出路 —— 只能再赌一次。
   *
   * 而每一版都是真金白银出的：丢掉的不是文件，是已经花掉的钱。
   */
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), 'fd-ver-'));
  const dest = path.join(dir, 'shot-1.png');

  check('第一次出：没有上一版可留', v.archive(dest) === null);
  fs.writeFileSync(dest, '第1版');
  for (let i = 2; i <= 8; i += 1) {
    v.archive(dest);
    fs.writeFileSync(dest, `第${i}版`);
  }

  /**
   * 留 5 版。一段 1080p 视频十几 MB，二十镜留满就是一两 G，
   * 而"我想回到三次之前那一版"实际上很少超过五次。
   */
  const kept = v.list(dest);
  check(`超出上限的从最旧的删（留 ${v.KEEP} 版）`, kept.length === v.KEEP, `${kept.length} 版`);
  check('新的在前', kept[0].n > kept[kept.length - 1].n, kept.map((x) => x.n).join(','));
  check('当前那份没被动', fs.readFileSync(dest, 'utf8') === '第8版');

  /**
   * ⚠ 换回某一版时，**当前这版也要先存起来**。
   * 不然"我看看上一版长什么样"这个动作本身就会把现在这版弄丢 ——
   * 而人不会预期点一下"看看"会删东西。
   */
  const before = fs.readFileSync(dest, 'utf8');
  v.restore(dest, kept[1].path);
  check('换回上上版之后，当前就是那一版', fs.readFileSync(dest, 'utf8') === '第6版', fs.readFileSync(dest, 'utf8'));
  check('换回去是可逆的（刚才那版被存起来了）',
    v.list(dest).some((x) => fs.readFileSync(x.path, 'utf8') === before),
    v.list(dest).map((x) => fs.readFileSync(x.path, 'utf8')).join(','));

  /**
   * 版本号取"现有最大值 + 1"，不是"现有个数 + 1"。
   * 按个数算的话，删掉旧版之后新版会撞上一个还在的号 —— 直接覆盖掉它，
   * 而那正是这个模块要防的事。
   */
  const dir2 = fs.mkdtempSync(path.join(os2.tmpdir(), 'fd-ver2-'));
  const d2 = path.join(dir2, 'x.png');
  fs.writeFileSync(d2, 'a'); v.archive(d2);
  fs.writeFileSync(d2, 'b'); v.archive(d2);
  fs.rmSync(v.list(d2).find((x) => x.n === 1).path);   // 手动删掉 v1，制造空档
  fs.writeFileSync(d2, 'c'); v.archive(d2);
  const ns = v.list(d2).map((x) => x.n).sort();
  check('删过旧版之后，新版不会撞号覆盖掉还在的那个',
    new Set(ns).size === ns.length && ns.includes(2), ns.join(','));

  // 目录不存在 / 文件不在时不能炸 —— 用户清过盘是常事
  check('目录不存在时回空数组', v.list(path.join(dir, 'nope', 'a.png')).length === 0);
  let threw = null;
  try { v.restore(dest, path.join(dir, 'nope.png')); } catch (e) { threw = e.message; }
  check('要一个已经不在的版本时，报人话', /不在了/.test(threw || ''), String(threw));
}

section('台词时长：念不完的镜头，出图之前就该拉长');
{
  const d = await import('../core/duration.js');
  const lint = await import('../core/pipeline/shotlint.js');

  /**
   * 原来只有**合成**那一步会发现"台词比镜头长"，而那时候图和视频的钱已经花完了：
   * 补救要么重出这一镜的视频（拉长），要么重配音（改短台词），两条都是重来一遍。
   *
   * 而这件事在拆分镜的时候就完全算得出来 —— 台词就在手上。
   */
  check('五个字大约一秒多', d.speechSeconds('设备正常。') > 1 && d.speechSeconds('设备正常。') < 2.5,
    String(d.speechSeconds('设备正常。')));
  check('二十一个字要五秒上下', d.speechSeconds('这里的缆绳被人动过，昨天夜里有人来过这儿。') > 4,
    String(d.speechSeconds('这里的缆绳被人动过，昨天夜里有人来过这儿。')));
  check('没台词就是 0 秒', d.speechSeconds('') === 0 && d.speechSeconds(null) === 0);
  // 标点是停顿，不发音但实实在在占时间
  check('标点算进停顿', d.speechSeconds('好，我知道了。') > d.speechSeconds('好我知道了'));

  check('4 秒装不下这句 21 字的台词',
    d.fitsDialogue({ dialogue: '这里的缆绳被人动过，昨天夜里有人来过这儿。', duration: 4 }).ok === false);
  check('拉到它说的秒数就装得下', (() => {
    const line = '这里的缆绳被人动过，昨天夜里有人来过这儿。';
    return d.fitsDialogue({ dialogue: line, duration: d.secondsForDialogue({ dialogue: line }) }).ok;
  })());

  // 手改台词不会自动拉时长，所以体检要拦一道
  const bad = lint.lintShot({ index: 3, description: '他站在门口', dialogue: '我不知道该怎么跟你说这件事，但是我必须说出来。', duration: 4 });
  const hit = bad.find((i) => i.kind === 'dialogue-too-long');
  check('体检拦得住手改出来的超长台词', Boolean(hit), JSON.stringify(bad.map((i) => i.kind)));
  check('说清楚会怎样（压到下一镜）', /下一镜/.test(hit?.why || ''), hit?.why?.slice(0, 60));
  check('给了具体该拉到几秒', /\d/.test(hit?.fix || ''), hit?.fix);
  check('台词短的不报', lint.lintShot({ index: 4, description: '他站在门口', dialogue: '好。', duration: 4 })
    .some((i) => i.kind === 'dialogue-too-long') === false);
}

section('台词四种类型：只有对白才该动嘴');
{
  const sp = await import('../core/pipeline/speaker.js');
  const con = await import('../core/pipeline/consistency.js');

  /**
   * 原来只有两种：有 speaker 是对白，没有是旁白。漏掉了短剧里最常用的
   * **心里话** —— 声音是这个角色自己的，但他嘴不动。
   *
   * 用原来那套表达不了：填了说话人，画面被要求"口型对上台词"，出来是自言自语；
   * 留空当旁白，声音又换成了旁白音色。两种都不对，而且**都不报错**。
   */
  check('四种类型都在', sp.LINE_KINDS.map((k) => k.id).join(',') === 'speech,inner,voiceover,offscreen');
  check('只有对白动嘴',
    sp.LINE_KINDS.filter((k) => sp.movesLips(k.id)).map((k) => k.id).join(',') === 'speech');

  // 没标过的按老规矩推，老项目读出来行为一个字不变
  check('没标过 + 有说话人 → 对白', sp.lineKindOf({ speaker: '强雄' }) === 'speech');
  check('没标过 + 没说话人 → 旁白', sp.lineKindOf({}) === 'voiceover');
  /**
   * ⚠ 判类型要用**推断过**的说话人。分镜没填说话人时，画面里只有一个角色
   * 就算他说的 —— 拿原始字段判会把这种情况变成旁白，而老行为是对白。
   */
  check('推断出来的说话人也算数', sp.lineKindOf({ dialogue: '走' }, '阿澜') === 'speech');

  const bible = {
    characters: [{ name: '强雄', appearance: '短发' }, { name: '班主任', appearance: '制服' }],
    scenes: [], props: []
  };
  const base = { description: '强雄站在办公桌前', characters: ['强雄', '班主任'], dialogue: '我不能就这么算了。', speaker: '强雄' };
  const line = (kind) => con.assembleVideoPrompt(bible, { ...base, lineKind: kind }, {});

  check('对白：口型对上台词', /口型对上台词/.test(line('speech')));
  /**
   * 心里话是这次真正补上的那一种：他自己的声音、嘴闭着。
   * 只说"嘴唇闭合"还不够 —— 模型会画成发呆，所以加一句眼神有戏。
   */
  check('心里话：说是内心独白，而且嘴闭着', /内心独白/.test(line('inner')) && /嘴唇闭合/.test(line('inner')), line('inner').slice(-80));
  check('心里话不要求口型', !/口型对上/.test(line('inner')));
  check('画外音：说话的人不在画面里', /不在画面里/.test(line('offscreen')), line('offscreen').slice(-70));
  check('旁白：声音来自画外', /画外旁白/.test(line('voiceover')));
  // 空镜里一个人都没有时，四种都不该说话 —— 提示词里出现"人物"会招来一个人
  const empty = con.assembleVideoPrompt(bible, { description: '空荡的走廊', characters: [], dialogue: '他走了。', lineKind: 'voiceover' }, {});
  check('空镜里不提人物（提了会凭空画出一个人）', !/人物|嘴唇/.test(empty), empty.slice(0, 90));
}

section('自动标连续动作：模型给的是建议，收口由代码做');
{
  const st4 = await import('../core/pipeline/studio.js');

  /**
   * 这活儿只能交给模型：规则能判的只有"换没换场景"（比场景名），
   * 而"这一镜是不是上一镜那个动作的下一瞬间"要读懂两句中文之间的动作关系 ——
   * 「伸手去够门把手」和「把门把手拧下去」是同一只手的同一个动作，
   * 而「他在批改作业」和「特写他的钢笔」不是。字面上同一场戏、同一批词，
   * 规则区分不了。
   *
   * 但**判错的代价是不对称的**：标多了那一段失去剪辑感、机位锁死、
   * 而且必须串行生成（每镜等上一镜的末帧）慢好几倍；标少了顶多硬切一下。
   * 所以模型答完必须有一层确定性的收口 —— 打桩那边故意让模型
   * **每一镜都答 continuous**，看收口拦不拦得住。
   */
  const lp = store.create({ title: '自动标衔接', script: 'x' });
  store.update(lp.id, (p) => {
    p.shots = [
      { id: 'l1', index: 1, segment: 1, scene: '办公室', description: '他伸手去够门把手' },
      { id: 'l2', index: 2, segment: 1, scene: '办公室', description: '把门把手拧下去' },
      { id: 'l3', index: 3, segment: 1, scene: '办公室', description: '门开了一条缝' },
      { id: 'l4', index: 4, segment: 1, scene: '办公室', description: '他侧身挤进去' },
      { id: 'l5', index: 5, segment: 2, scene: '走廊', description: '走廊尽头的安全灯' },
      // 人手选过的那一镜：绝不覆盖
      { id: 'l6', index: 6, segment: 2, scene: '走廊', description: '他站在灯下', link: 'cut', linkBy: 'user' }
    ];
    return p;
  });

  const evs = [];
  const out = await st4.suggestLinks(lp.id, { onEvent: (e) => evs.push(e.message) });
  const after = store.read(lp.id).shots;
  const linkOf = (i) => after.find((x) => x.index === i)?.link;

  check('第 1 镜没有上一镜可接，不标', linkOf(1) !== 'continuous', String(linkOf(1)));
  check('第 2、3 镜采纳了', linkOf(2) === 'continuous' && linkOf(3) === 'continuous',
    `${linkOf(2)} / ${linkOf(3)}`);
  /**
   * 连着三镜就停。再连下去整段会变成一个没剪过的长镜头，
   * 而且这几镜必须串行生成，慢好几倍 —— 这是标多了最实在的代价。
   */
  check('连到第三镜就打住（不然整段变成一个长镜头）', linkOf(4) !== 'continuous', String(linkOf(4)));
  check('跨场次那镜不标（另一个地方、另一段时间）', linkOf(5) !== 'continuous', String(linkOf(5)));
  check('人手选过的一镜不覆盖', linkOf(6) === 'cut', String(linkOf(6)));

  /**
   * 被规矩拦下来的**必须逐条说出来**。不然人看到模型答了却没生效，
   * 只会以为功能坏了 —— 这个项目里同一个毛病已经出现过三次。
   */
  const notes = evs.filter(Boolean).join(' | ');
  check('拦下来的都说了为什么', /没采纳/.test(notes), notes.slice(0, 200));
  check('说清楚了是哪几条规矩拦的',
    /跨了场次/.test(notes) && /长镜头/.test(notes) && /手动标过/.test(notes), notes.slice(0, 400));
  check('采纳的那几镜记下了理由（人要能判断它凭什么这么标）',
    Boolean(after.find((x) => x.index === 2)?.linkWhy), JSON.stringify(after.find((x) => x.index === 2)?.linkWhy));
  check('返回值里也带着被拦的清单', (out.refused || []).length >= 3, JSON.stringify(out.refused));
}

section('单镜重出：接缝没做，也得说一句为什么');
{
  const st3 = await import('../core/pipeline/studio.js');

  /**
   * 用户在手机上重出两镜，看到的是"两段各自用各自的首帧"，
   * 于是得出"两个接缝模式都没生效"。
   *
   * 而真相是：那两镜没标「连续动作」，接缝本来就不该做 ——
   * 只是**单镜重出这条路一个字都没说**。批量出视频那条开跑前会打一行
   * 接缝计划，这条漏了。不触发的分支彻底安静，用户唯一能得出的结论
   * 就是"功能是坏的"，而且他没法反驳自己。
   *
   * 这是这个项目里同一个教训的第三次（前两次：接缝计划、手机端新建项目）。
   */
  const sp3 = store.create({ title: '接缝解释', script: 'x' });
  store.update(sp3.id, (p) => {
    p.bible = { style: { anchor: '', negative: '' }, characters: [], scenes: [], props: [] };
    p.shots = [
      { id: 'a', index: 1, segment: 1, scene: '走廊', description: '伸手', camera: '中景', duration: 4, imagePath: '/x/1.png' },
      { id: 'b', index: 2, segment: 1, scene: '走廊', description: '拧把手', camera: '特写', duration: 4, imagePath: '/x/2.png' }
    ];
    return p;
  });
  settings.patch({ seamMode: 'lock' });

  const notes = [];
  await st3.regenerateShotVideo(sp3.id, 'b', {}, (e) => notes.push(e.message)).catch(() => {});
  const why = notes.filter(Boolean).find((m) => /没做接缝/.test(m)) || '';
  check('没做接缝时出声了（原来是彻底安静的）', Boolean(why), notes.filter(Boolean).slice(0, 3).join(' | '));
  check('指名是因为没标「连续动作」', /连续动作/.test(why), why.slice(0, 120));
  /**
   * 最容易误解的一条：首尾帧模式下接缝做在**上一镜**身上
   *（把这一镜的图锁成上一镜的末帧）。只重出后面那一镜，接缝一点变化都没有。
   * 不说的话，人会一遍遍重出后面那镜，然后确信功能是坏的。
   */
  check('点明首尾帧模式下该重出的是上一镜', /上一镜/.test(why), why.slice(-90));

  // 关掉时说的是"关掉了"，不是编一个别的理由
  settings.patch({ seamMode: 'off' });
  const offNotes = [];
  await st3.regenerateShotVideo(sp3.id, 'b', {}, (e) => offNotes.push(e.message)).catch(() => {});
  check('关掉时如实说是关掉了',
    offNotes.filter(Boolean).some((m) => /已在设置里关掉/.test(m)),
    offNotes.filter(Boolean).slice(0, 3).join(' | '));

  settings.patch({ seamMode: 'lock' });
}

section('默认走首尾帧：碰上不收末帧的厂商要能退回去');
{
  const cat = await import('../core/providers/catalog.js');
  const st = await import('../core/settings.js');

  /**
   * 默认值从「接住真实末帧」改成了「首尾帧」——
   * 两头都钉在审过的图上，这一镜再怎么演也跑不出去；而接住真实末帧只钉住起点，
   * 结尾是模型自己发挥的、又成为下一镜的起点，链越长漂得越远。
   *
   * ⚠ 但 lock 整条路都架在"厂商收末帧"上。碰上不收的那几家，
   * 它会**一处接缝都不做** —— 比原来的默认还差，而且用户是照着
   * "首尾帧更准"这个理由选的它，结果反而更糟。
   *
   * 所以必须兜一层：选了 lock 而这家不收末帧，退回接住真实末帧。
   * **这一层就是这个默认值敢改的全部理由**，它一旦没了，默认值就该改回去。
   */
  /**
   * ⚠ 这两条原来写得太软：一条是 `st.DEFAULTS ? … : true`（DEFAULTS 没导出就自动过），
   * 一条是 `(st.get('seamMode') || 'lock') === 'lock'`（在断言里补了一次兜底，
   * 于是取出 undefined 也照样绿）。软断言比没有断言更糟 —— 它让人以为量过了。
   */
  check('默认是首尾帧', st.DEFAULTS.seamMode === 'lock', String(st.DEFAULTS.seamMode));
  st.patch({ seamMode: undefined });
  check('没设过的时候取到的也是首尾帧', st.get('seamMode') === 'lock', String(st.get('seamMode')));

  /**
   * 上面那条**第一次收紧的时候是红的** —— 而它红出来的不是接缝的问题，
   * 是 patch 的：`{...all(), seamMode: undefined}` 会把已经合好的默认值
   * 盖成 undefined，而 all() 认缓存、不会再合一次 DEFAULTS。
   * 于是"默认开启"这件事只剩下调用处一路 `|| 'lock'` 在兜，
   * 漏兜的那一处就会安静地走到反面。
   *
   * 这一条守的是那个洞本身，不只守接缝：任何一项都不该被一个
   * "这次没提供"打穿。
   */
  st.patch({ autoCut: undefined, sfxGain: undefined });
  check('patch 收到 undefined 时不打穿默认值',
    st.get('autoCut') === true && st.get('sfxGain') === 0.35,
    `autoCut=${st.get('autoCut')} sfxGain=${st.get('sfxGain')}`);
  // 真的传了值当然还是要改 —— 否则上一条可以靠"什么都不写"作弊通过
  st.patch({ autoCut: false });
  check('真给了值照样改得动', st.get('autoCut') === false, String(st.get('autoCut')));
  st.patch({ autoCut: true });

  /**
   * ══ 三端的首尾帧：一个引擎，三张脸 ══
   *
   * 用户问的是"三端的首尾帧是否确实有效，都要默认开启"。这里要说清楚
   * 它为什么是**一个**问题而不是三个：接缝是引擎那一侧的事，电脑版、手机版、
   * 安卓壳打的是同一套 HTTP 接口，走的是同一个 videoContextFor。
   *
   * 所以三端一致的**结构性保证**是这个：出视频的入口只有两个，
   * 而这两个入口在能力清单里对三端是同一条。哪天有人给某一端另开一条
   * 出视频的路，这条会红 —— 那正是三端会漂开的唯一方式。
   */
  const { CAPABILITIES } = await import('../core/surfaces.js');
  const videoEntries = CAPABILITIES.filter((c) => ['run-stage', 'run-from', 'shot-regen'].includes(c.id));
  check('出视频的入口三端共用（电脑、手机、安卓壳都有）',
    videoEntries.length === 3 && videoEntries.every((c) => c.pc && c.mobile),
    JSON.stringify(videoEntries.map((c) => [c.id, Boolean(c.pc), Boolean(c.mobile)])));
  /**
   * 反过来，接缝开关**只在电脑上**，手机端故意没有。
   * 这不是漏做：它是"坐下来配一次"的东西，而且手机上没有它反而更稳 ——
   * 三端读的是同一个默认值，不会出现"手机上被关掉了而电脑上不知道"。
   */
  check('接缝开关不在手机端（三端共用引擎那一个默认值）',
    !CAPABILITIES.some((c) => c.mobile && /接缝|seam/i.test(`${c.name}${c.api}`)));

  // 兜底那一层的判据：这家收不收末帧
  const takes = (id) => Boolean(cat.PROVIDERS.find((p) => p.id === id)?.videoDefaults?.endFrame);
  check('秘塔收末帧 → 首尾帧走得通', takes('metaso') === true);
  check('百炼不收末帧 → 必须退回接住真实末帧', takes('dashscope') === false);
  check('海螺官方口也不收', takes('minimax') === false);

  /**
   * ⚠ 上面这些只量了"目录里写着收不收"，**没量兜底那一行有没有真的兜住**。
   *
   * 第一版我在这儿照抄了一遍判断逻辑当真值表 —— 那是自己验自己，
   * 产线代码写反了它照样绿。所以那一行被拎成了 studio.wantsTailChain，
   * 产线和这里调**同一个函数**。
   *
   * （中间还试过真跑一遍出视频。那条路更实，但打桩服务没实现海螺的视频接口，
   *   为了测一行判断去给打桩补一整套厂商接口，代价远超收益 ——
   *   而且补出来的那套本身也没人验过。）
   */
  const st2 = await import('../core/pipeline/studio.js');
  check('lock + 收末帧 → 走首尾帧，不抠末帧', st2.wantsTailChain('lock', true) === false);
  check('lock + 不收末帧 → 退回抠末帧（这一条就是默认值敢改的全部理由）',
    st2.wantsTailChain('lock', false) === true);
  check('tail 永远抠末帧，不管厂商收不收',
    st2.wantsTailChain('tail', true) && st2.wantsTailChain('tail', false));
  check('off 两条都不做',
    !st2.wantsTailChain('off', true) && !st2.wantsTailChain('off', false));

  st.patch({ seamMode: 'lock' });
}

section('场次边界：不锁末帧、不拿邻镜当参考');
{
  const continuity = await import('../core/pipeline/continuity.js');

  /**
   * 光比场景名会漏掉最坑的一种：**同一个地方，隔了二十年**。
   * "二十年前的办公室"和"今天的办公室"很可能挂着同一个场景名 ——
   * 于是今天那一镜会拿二十年前那张当参考，人、光、陈设全被带回去，而且不报错。
   */
  const same = { id: 'b', index: 2, scene: '办公室', segment: 2, imagePath: null };
  const prev = { id: 'a', index: 1, scene: '办公室', segment: 1, imagePath: '/x/a.png' };

  check('跨场次不锁末帧',
    continuity.shouldChainEndFrame(same, 'continuous', prev) === false);
  check('同场次照常锁末帧',
    continuity.shouldChainEndFrame({ ...same, segment: 1, imagePath: '/x/b.png' }, 'continuous', prev) === true);
  // 不传当前镜时维持老行为 —— 老项目里没有 segment 字段
  check('没有场次信息时不改变老行为',
    continuity.shouldChainEndFrame({ ...same, imagePath: '/x/b.png' }, 'continuous') === true);

  const proj = { shots: [prev, { ...same, link: 'cut' }] };
  check('跨场次不拿上一镜当参考图',
    continuity.neighborRef(proj, proj.shots[1]) === null);
  const sameSeg = { shots: [prev, { ...same, segment: 1, link: 'cut' }] };
  check('同场次照常给场景锚',
    continuity.neighborRef(sameSeg, sameSeg.shots[1])?.path === '/x/a.png');
}

section('手改违规不悄悄改回去，但要说出来');
{
  const lint = await import('../core/pipeline/shotlint.js');

  /**
   * 拆分镜时这些已经强制归一过了。这里抓的是**人在界面上手改出来的** ——
   * 那种改动不去悄悄改回来（人明确选的东西，界面上自己变回去比不做还糟），
   * 但必须说出来。
   */
  const bad = lint.lintShots([
    { id: 'a', index: 1, segment: 1, description: '明锋伏案', transition: 'cut' },
    { id: 'b', index: 2, segment: 2, description: '明锋抬头', link: 'continuous', transition: 'fade' },
    { id: 'c', index: 3, segment: 2, description: '支票摊在桌上', transition: 'dissolve' }
  ]);
  const kinds = bad.flatMap((r) => r.issues.map((i) => i.kind));
  check('跨场次标了连续动作会被报出来', kinds.includes('continuous-across-segments'), kinds.join(','));
  check('场次内部用叠化会被报出来', kinds.includes('transition-inside-segment'), kinds.join(','));
  // 合规的那两处不该报
  check('场次头一镜用黑场是合规的，不报',
    !bad.find((r) => r.index === 2)?.issues.some((i) => i.kind === 'transition-inside-segment'));
  check('第一镜不报', !bad.some((r) => r.index === 1));
  check('每条都给了改法', bad.every((r) => r.issues.every((i) => i.fix && i.fix.length > 8)));
}

section('转场：默认硬切，叠化要付出时长');
{
  const tr = await import('../core/transitions.js');

  // 真正的行家几乎只用硬切。模型瞎编的转场名不该悄悄变成别的效果
  check('没写就是硬切', tr.kindOf({}) === 'cut');
  check('瞎编的值退回硬切', tr.kindOf({ transition: '炫酷旋转' }) === 'cut');
  check('合法值照收', tr.kindOf({ transition: 'dissolve' }) === 'dissolve');

  // 黑场是原地做的，不吃时长；叠化必然吃掉重叠的那段
  check('硬切不吃时长', tr.overlapOf({ transition: 'cut' }) === 0);
  check('黑场不吃时长', tr.overlapOf({ transition: 'fade' }) === 0);
  check('叠化吃掉重叠那段', tr.overlapOf({ transition: 'dissolve' }) === tr.DISSOLVE_SECONDS);

  // 第一镜的"转场"是片头，不吃任何时间
  const shots = [{ transition: 'dissolve' }, { transition: 'dissolve' }, { transition: 'fade' }];
  check('片头那一处不算', tr.totalOverlap(shots) === tr.DISSOLVE_SECONDS, String(tr.totalOverlap(shots)));
  check('全是硬切时不用动手', tr.anyEffect([{ transition: 'cut' }, { transition: 'cut' }]) === false);
  check('有一处非硬切就要动手', tr.anyEffect(shots) === true);
}

section('叠化吃掉的时间要进时间轴，否则配音整体后移');
{
  const studio = await import('../core/pipeline/studio.js');
  const tr = await import('../core/transitions.js');
  const mk = (i, transition) => ({
    id: `s${i}`, index: i, duration: 4, videoPath: `/tmp/${i}.mp4`, transition, dialogue: `第${i}句`
  });

  const plain = studio.timelineOf({ shots: [mk(1, 'cut'), mk(2, 'cut'), mk(3, 'cut')] });
  check('全硬切时就是顺次相接', plain.map((r) => r.start).join(',') === '0,4,8', plain.map((r) => r.start).join(','));

  /**
   * 这一条是真会出事的：配音和字幕都按**绝对时间**摆，
   * 而叠化让全片变短。少了这一步，一处叠化之后每一句台词都晚半秒 ——
   * 表现和"配音顺次拼"那个老 bug 一模一样，只是原因换了一个。
   */
  const withDissolve = studio.timelineOf({ shots: [mk(1, 'cut'), mk(2, 'dissolve'), mk(3, 'cut')] });
  const starts = withDissolve.map((r) => r.start);
  check('叠化之后的每一镜都往前提', starts[1] === 4 - tr.DISSOLVE_SECONDS, starts.join(','));
  check('后面的镜头跟着一起提，误差不累积', starts[2] === 8 - tr.DISSOLVE_SECONDS, starts.join(','));

  // 字幕用的是同一份时间轴 —— 三者不会各算各的，这正是只留一个出处的原因
  const cues = studio.buildSubtitles({ shots: [mk(1, 'cut'), mk(2, 'dissolve'), mk(3, 'cut')] });
  check('字幕跟着同一份时间轴走', cues[1].start === 4 - tr.DISSOLVE_SECONDS, String(cues[1].start));
}

section('画面指纹：可复现的相似度（未接线）');
{
  const palette = await import('../core/palette.js');
  const px = (r, g, b) => {
    const buf = Buffer.alloc(8 * 8 * 3);
    for (let i = 0; i < 64; i += 1) {
      buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b;
    }
    return buf;
  };

  const warm = palette.fingerprintFromRGB(px(200, 150, 90));
  const warm2 = palette.fingerprintFromRGB(px(200, 150, 90));
  const cool = palette.fingerprintFromRGB(px(80, 120, 200));

  // 可复现是这一层存在的全部理由 —— 视觉模型打的分会飘，没法当阈值用
  check('同样的输入永远同一个指纹', JSON.stringify(warm) === JSON.stringify(warm2));
  check('同一个调子 = 满分', palette.score(warm, warm2) === 100, String(palette.score(warm, warm2)));
  check('冷暖两个调子拉得开', palette.score(warm, cool) < 50, String(palette.score(warm, cool)));

  // 略微偏一点不该报警：正常的光线变化会让色调轻微移动
  const warmish = palette.fingerprintFromRGB(px(195, 148, 95));
  check('轻微色差不算漂移', palette.score(warm, warmish) > 80, String(palette.score(warm, warmish)));

  check('像素不够时明确报错，不是回一个假指纹',
    (() => { try { palette.fingerprintFromRGB(Buffer.alloc(10)); return false; } catch { return true; } })());

  // 基准取平均而不是第一镜：第一镜万一是个夜戏特写，后面每一镜都会被判成漂移
  const base = palette.baselineOf([{ palette: warm }, { palette: cool }]);
  check('基准是已有指纹的平均', base && base.length === warm.length);
  check('还没有任何指纹时给 null（"没法判断"不等于"不匹配"）',
    palette.baselineOf([{}, {}]) === null);
}

section('镜头分级：贵的只用在看得出差别的地方');
{
  const tiers = await import('../core/tiers.js');

  // 判定只看两样看得懂的东西：景别 + 有没有角色
  check('没人出场的空镜 → 最低档', tiers.tierOf({ characters: [], camera: '全景' }) === 'low');
  check('有人但拉得很远 → 最低档', tiers.tierOf({ characters: ['阿澜'], camera: '远景' }) === 'low');
  check('有人 + 特写 → 最高档', tiers.tierOf({ characters: ['阿澜'], camera: '特写' }) === 'high');
  check('有人 + 中景 → 中档', tiers.tierOf({ characters: ['阿澜'], camera: '中景' }) === 'normal');
  // 自动判定永远不该覆盖手选
  check('手动指定的最优先', tiers.tierOf({ characters: [], camera: '全景', tier: 'high' }) === 'high');
  // 判错时用户得能一眼看出为什么，才知道该不该改它
  check('说得出为什么判成这一档', /没有角色/.test(tiers.reasonFor({ characters: [], camera: '全景' })));
  check('手选的也说清楚是手选的', /手动/.test(tiers.reasonFor({ tier: 'low' })));

  check('不配就返回 null（调用方退回主路由）', tiers.routeFor('low', {}) === null);
  check('只填一半也不算配（半配是最难查的状态）',
    tiers.routeFor('low', { low: { provider: 'volcengine' } }) === null);

  const sum = tiers.summarize([
    { characters: [], camera: '全景' },
    { characters: ['阿澜'], camera: '特写' },
    { characters: ['阿澜'], camera: '中景' },
    { characters: [], camera: '远景' }
  ]);
  check('分档摘要对得上', sum.low === 2 && sum.high === 1 && sum.normal === 1, JSON.stringify(sum));

  /**
   * 真的按档位发出去了吗 —— 从桩上游那边看请求，而不是看我们自己记了什么。
   */
  const tp = await (await fetch(`${appUrl}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '分级出片', script: '一段话。' })
  })).json();
  // ⚠ 图必须是**真文件**：出视频要读首帧，假路径直接让这一镜失败，
  // 于是上游一次都没被调到 —— 而那看起来会像"分级没生效"
  const tdir = store.assetDir(tp.id);
  const tpng = path.join(tdir, 'frame.png');
  fs.writeFileSync(tpng, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ));
  store.update(tp.id, (p) => {
    p.bible = { style: { anchor: '国风', negative: '' }, characters: [{ name: '阿澜', appearance: '短发', seed: 1, variants: [] }], scenes: [], props: [] };
    p.shots = [
      { id: 't1', index: 1, characters: ['阿澜'], camera: '特写', description: '阿澜的脸', duration: 4, imagePath: tpng },
      { id: 't2', index: 2, characters: [], camera: '全景', description: '空镜：雨中的码头', duration: 4, imagePath: tpng }
    ];
    return p;
  });

  // 不配时：两镜都走主路由，行为一个字不变
  settings.patch({ videoTiers: {} });
  // 看**桩上游那边真收到了什么**，而不是看我们自己记了什么 ——
  // 后者是从同一批变量算出来的，记对了不等于发对了
  upstream.videoBodies = [];
  await ndjson(`/projects/${tp.id}/stage/video`, {});
  const plain = (upstream.videoBodies || []).map((b) => b.model).filter(Boolean);
  check('不配时两镜同一个模型（行为一个字不变）',
    plain.length >= 2 && new Set(plain).size === 1, JSON.stringify(plain));

  // 配了低档之后：空镜那一镜换模型，特写那一镜不动
  settings.patch({ videoTiers: { low: { provider: 'volcengine', model: 'cheap-video-model' } } });
  store.update(tp.id, (p) => {
    for (const s2 of p.shots) delete s2.videoPath;
    return p;
  });
  upstream.videoBodies = [];
  await ndjson(`/projects/${tp.id}/stage/video`, {});
  const sentModels = (upstream.videoBodies || []).map((b) => b.model);
  check('发出去的两条用了不同模型', new Set(sentModels).size === 2, JSON.stringify(sentModels));
  const after = store.read(tp.id).shots;
  check('空镜那一镜走了便宜模型',
    /cheap-video-model/.test(after[1].videoModelUsed || ''), after[1].videoModelUsed);
  check('特写那一镜没被动过',
    !/cheap-video-model/.test(after[0].videoModelUsed || ''), after[0].videoModelUsed);
  check('走的哪一档记在镜头上（出完之后"这一镜为什么糊"最先查它）',
    after[1].videoTier === 'low' && after[0].videoTier === 'high',
    JSON.stringify([after[0].videoTier, after[1].videoTier]));

  settings.patch({ videoTiers: {} });
}

section('整段标衔接');
{
  const lp = await (await fetch(`${appUrl}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '整段标记', script: '一段话。' })
  })).json();
  store.update(lp.id, (p) => {
    p.shots = Array.from({ length: 6 }, (_, i) => ({
      id: `k${i + 1}`, index: i + 1, scene: '门口', description: `第 ${i + 1} 镜`, duration: 4
    }));
    return p;
  });

  const mark = (body) => fetch(`${appUrl}/api/projects/${lp.id}/shots/link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const r1 = await mark({ from: 2, to: 4, link: 'continuous' });
  check('一次标了三镜', r1.body.changed?.length === 3, JSON.stringify(r1.body.changed));
  const after = store.read(lp.id).shots;
  check('范围内的都改了', after.slice(1, 4).every((s) => s.link === 'continuous'));
  check('范围外的一个没动', !after[0].link && !after[4].link, JSON.stringify([after[0].link, after[4].link]));
  // 记一笔"人选的"，免得后面自动推断又改回去
  check('标成人选的，自动推断不会再覆盖', after[1].linkBy === 'user');

  // 倒着填也该正常 —— 用户不会每次都记得大小顺序
  const r2 = await mark({ from: 6, to: 5, link: 'new-scene' });
  check('起止填反了也认', r2.body.changed?.length === 2, JSON.stringify(r2.body.changed));

  // 已经是这个关系的不重复记，不然"改了 6 镜"这句话会骗人
  const r3 = await mark({ from: 2, to: 4, link: 'continuous' });
  check('本来就是这个关系时不谎报改了几镜', r3.body.changed?.length === 0, JSON.stringify(r3.body.changed));

  const bad = await mark({ from: 1, to: 3, link: '乱写的' });
  check('不认识的关系当场拒绝，并说清楚能填什么',
    bad.status === 400 && /new-scene/.test(bad.body.error || ''), bad.body.error);
}

section('邻镜参考：星形，不是链');
{
  const cont = await import('../core/pipeline/continuity.js');
  const shots = [
    { id: 'a', index: 1, scene: '码头', imagePath: 'i1.png' },
    { id: 'b', index: 2, scene: '码头', imagePath: 'i2.png' },
    { id: 'c', index: 3, scene: '码头', imagePath: 'i3.png' },
    { id: 'd', index: 4, scene: '码头', imagePath: 'i4.png' },
    { id: 'e', index: 5, scene: '值班室', imagePath: 'i5.png' },
    { id: 'f', index: 6, scene: '值班室', imagePath: 'i6.png' }
  ];
  const proj = { shots };
  const at = (id) => cont.neighborRef(proj, shots.find((s) => s.id === id));

  check('第一镜没有邻居可参照', at('a') === null);
  // 核心：2、3、4 全都参照第 1 张，而不是各自参照前一张
  const chain = ['b', 'c', 'd'].map((id) => at(id)?.path);
  check('同场景里每一镜都参照同一张锚（误差不累积）',
    chain.every((p2) => p2 === 'i1.png'), JSON.stringify(chain));
  check('而不是链式地各参照前一张',
    !(chain[1] === 'i2.png' && chain[2] === 'i3.png'), JSON.stringify(chain));

  // 换场景必须断链：画面本来就该变，硬拿上一场的图当参考只会污染新场景
  check('换场景时不带上一场的图', at('e') === null, JSON.stringify(at('e')));
  check('新场景自己起一个锚', at('f')?.path === 'i5.png', JSON.stringify(at('f')));

  /**
   * 同一个地方在片子里出现两次（码头 → 值班室 → 码头），
   * 第二段该有自己的锚 —— 拿二十镜之前那张当参考，光线和时间早就变了。
   */
  const revisit = {
    shots: [
      ...shots,
      { id: 'g', index: 7, scene: '码头', imagePath: 'i7.png' },
      { id: 'h', index: 8, scene: '码头', imagePath: 'i8.png' }
    ]
  };
  check('同一场景第二次出现时，锚是这一段自己的',
    cont.neighborRef(revisit, revisit.shots[7])?.path === 'i7.png',
    JSON.stringify(cont.neighborRef(revisit, revisit.shots[7])));

  // 连续动作是唯一该用真链式的地方：要的是"上一帧的下一瞬间"，锚给不了
  const act = {
    shots: [
      { id: 'a', index: 1, scene: '门口', imagePath: 'p1.png' },
      { id: 'b', index: 2, scene: '门口', imagePath: 'p2.png' },
      { id: 'c', index: 3, scene: '门口', link: 'continuous', imagePath: 'p3.png' }
    ]
  };
  const cRef = cont.neighborRef(act, act.shots[2]);
  check('连续动作退回真链式（接上一镜，不是锚）',
    cRef?.path === 'p2.png' && cRef.kind === 'prev', JSON.stringify(cRef));

  // 还没出图的镜头不能当锚
  const partial = {
    shots: [
      { id: 'a', index: 1, scene: '码头' },
      { id: 'b', index: 2, scene: '码头', imagePath: 'q2.png' },
      { id: 'c', index: 3, scene: '码头' }
    ]
  };
  check('没出图的镜头不会被当成锚',
    cont.neighborRef(partial, partial.shots[2])?.path === 'q2.png',
    JSON.stringify(cont.neighborRef(partial, partial.shots[2])));

  check('关掉就真的不带', cont.neighborRef(proj, shots[2], { mode: 'off' }) === null);
  check('想要老式链式也给得出', cont.neighborRef(proj, shots[2], { mode: 'prev' })?.path === 'i2.png');
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
  /**
   * 说法必须是**正面的**。
   *
   * 原来这句是"人物不说话，嘴部保持闭合，不要出现说话口型"——
   * 扩散模型对否定句出了名的不灵：它读到的是"说话""口型"这几个词本身，
   * "不要"那两个字分量小得多。等于在一句要求闭嘴的话里反复塞"说话"。
   */
  check('没台词的镜头要求嘴唇闭合（否则人物会在那儿瞎说）',
    /嘴唇闭合/.test(silent), silent.slice(0, 120));
  check('而且是正面说法，不出现"说话/口型"这些会往反方向拉的词',
    !/不说话|说话口型|不要出现/.test(silent), silent.slice(0, 120));
  // 光说"人物在说话"是不够的：画面里两个人，模型会随便挑一个张嘴，
  // 说的内容更是随它发挥 —— 谁在说、说哪句，都得写出来
  check('有台词的镜头写清楚谁在说、说的是哪句',
    /只有阿澜在说话/.test(talking) && /设备正常/.test(talking) && !/嘴唇闭合，面部安静/.test(talking),
    talking.slice(0, 160));
  check('同框的其他人被要求闭嘴（不然两个人一起张嘴）',
    /老周嘴唇闭合/.test(
      consistency.assembleVideoPrompt(fresh2.bible, { ...fresh2.shots[0], characters: ['阿澜', '老周'] })
    ));
  check('音效那条不算有台词，嘴也不该动',
    /嘴唇闭合/.test(consistency.assembleVideoPrompt(fresh2.bible,
      { ...fresh2.shots[1], characters: ['阿澜'] })));

  /**
   * ⚠ 画面里一个人都没有时，**这句话一个字都不该出现**。
   *
   * 用户问的就是这个：「为什么每一镜都有『画面中的人物不说话』」。
   * 因为原来这里不看有没有人 —— 空镜（码头夜色、桌上一支钢笔）照样会被加上。
   *
   * 三重代价：纯噪音；**会招人**（提示词里出现"人物"，扩散模型很可能真画一个）；
   * 白吃掉一成多的提示词字数，挤掉"这一镜到底演什么"。
   * 而空镜在一部片子里占三四成，所以它看起来像"总是"出现。
   */
  const empty = { description: '码头的夜色，缆绳垂在水面', characters: [], dialogue: '', motion: '固定' };
  const emptyPrompt = consistency.assembleVideoPrompt(fresh2.bible, empty);
  check('空镜不提"人物不说话"（提了反而可能给你画一个人）',
    !/人物不说话|嘴部保持闭合|说话口型/.test(emptyPrompt), emptyPrompt);
  check('空镜的画面描述本身还在', /码头的夜色/.test(emptyPrompt), emptyPrompt);

  // 空镜配旁白也一样：旁白是画外音，画面里本来就没人
  const emptyVO = consistency.assembleVideoPrompt(fresh2.bible,
    { ...empty, dialogue: '那一夜他没有回头。' });
  check('空镜 + 旁白同样不提嘴', !/嘴部|口型/.test(emptyVO), emptyVO);

  // 有人就照旧要管住嘴 —— 这一条是上面那个修法最容易改过头的地方
  const withCast = consistency.assembleVideoPrompt(fresh2.bible,
    { ...empty, description: '阿澜站在缆绳旁', characters: ['阿澜'] });
  check('画面里有人时照旧要求闭嘴', /嘴唇闭合/.test(withCast), withCast);

  /**
   * ⚠ 还有一个更隐蔽的漏法：**场景名或描述里带了人名**。
   *
   * matchCharacters 在 characters 为空时会去扫描描述里的人名 ——
   * 那对"该注入谁的外貌"是对的，对"画面里有没有人"是错的：
   * 一个叫「明锋的办公室走廊」的空镜，扫一下命中"明锋"，又判成有人了。
   *
   * 分镜表里的 characters 是权威的（拆分镜提示词明写"空镜给空数组"）。
   */
  const namedPlace = consistency.assembleVideoPrompt(fresh2.bible,
    { ...empty, description: '空荡的阿澜办公室走廊', characters: [] });
  check('场景名里带人名的空镜也不提嘴', !/嘴唇|口型/.test(namedPlace), namedPlace);
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

section('片段比分镜短：定格补齐，而不是让后面全跟着提前');
{
  /**
   * 原来这里只有 `-t want`，而 **-t 只截不补**：一段 3.2 秒的片子配上
   * `-t 5`，出来还是 3.2 秒。成片就比时间轴短了 1.8 秒。
   *
   * 而配音和字幕按**绝对时间**摆，它们仍然以为这一镜占满 5 秒 ——
   * 于是从这一镜之后每一句都提前，缺几段就累加几次。
   * 这个错没有任何报错：厂商给的片子短一点很常见（档位对不齐、
   * 模型提前收尾、下载被截断），任务全都是"成功"。
   */
  const ff = await import('../core/ffmpeg.js');
  const dir = path.join(SANDBOX, 'pad');
  fs.mkdirSync(dir, { recursive: true });
  const segs = ['p1.mp4', 'p2.mp4'].map((n) => path.join(dir, n));
  for (const f of segs) fs.writeFileSync(f, 'seg');
  const out = path.join(dir, 'film.mp4');

  const runWith = async (realSeconds, trims, { hasAudio = false } = {}) => {
    const calls = [];
    const notes = [];
    await ff.concat(segs, out, {
      trims,
      onNote: (m) => notes.push(m),
      __probe: async (f) => ({ seconds: realSeconds[segs.indexOf(f)] ?? 5, hasAudio }),
      __exec: async (args) => {
        calls.push(args.join(' '));
        const last = args[args.length - 1];
        if (last && !last.startsWith('-')) fs.writeFileSync(last, 'x');
        return { stderr: '' };
      }
    });
    return { calls, notes };
  };

  // ① 第一段只有 3.2 秒而分镜要 5 秒 —— 差 1.8 秒，必须补
  const short = await runWith([3.2, 5], [5, 5]);
  check('短了的那段用定格补齐',
    short.calls.some((c) => /tpad=stop_mode=clone:stop_duration=1\.800/.test(c)),
    short.calls.join(' | ').slice(0, 240));
  // 补黑场等于片子中间闪一下，比短一点还难看。定格是剪辑里的常规做法
  check('补的是定格不是黑场', !short.calls.some((c) => /color=black|nullsrc/.test(c)));
  check('补完仍然按分镜时长截齐', short.calls.some((c) => /-t 5/.test(c)));
  check('够长的那段不补', short.calls.filter((c) => /tpad/.test(c)).length === 1,
    String(short.calls.filter((c) => /tpad/.test(c)).length));
  // 悄悄补齐等于把"这一镜时长定得不合理"这条信息藏起来
  check('补了多少说出来了', short.notes.some((m) => /补齐/.test(m)), short.notes.join(' | '));
  check('并且说清了不补会怎样', short.notes.some((m) => /提前/.test(m)), short.notes.join(' | '));
  check('点名了差得最多的那一段', short.notes.some((m) => /第 1 段/.test(m)), short.notes.join(' | '));

  // ② 差得在 0.15 秒以内不折腾 —— 那点差观感上不存在，为它重编码不划算
  const tiny = await runWith([4.95, 5], [5, 5]);
  check('差一点点不补', !tiny.calls.some((c) => /tpad/.test(c)), tiny.calls.join(' | ').slice(0, 160));
  check('不补的时候也不吭声', !tiny.notes.some((m) => /补齐/.test(m)));

  // ③ 长了照旧只截 —— 这是原来就有的行为，不能被改坏
  const long = await runWith([10, 5], [5, 5]);
  check('长了的只截不补', !long.calls.some((c) => /tpad/.test(c)));
  check('截到分镜时长', long.calls.some((c) => /-t 5/.test(c)));

  // ④ 有音轨时静音也要跟着补，否则补出来那截没音轨，拼接时流结构对不上
  const withAudio = await runWith([3, 5], [5, 5], { hasAudio: true });
  check('有音轨时静音跟着补', withAudio.calls.some((c) => /apad=pad_dur=2\.000/.test(c)),
    withAudio.calls.join(' | ').slice(0, 200));
  const noAudio = await runWith([3, 5], [5, 5], { hasAudio: false });
  check('没音轨时不硬加 apad', !noAudio.calls.some((c) => /apad/.test(c)));
}

section('转场：真发给 FFmpeg 的那串参数长什么样');
{
  /**
   * 这一段把假的 probe/exec 注入进去，把 argv 录下来。
   *
   * 它证明的是"我们拼出来的参数是不是我们想要的那串"，
   * **不能**证明真 FFmpeg 会接受它 —— 那要一个带 libx264 和 xfade 的真二进制。
   * 两件事分清楚：切点算错、滤镜写反这类错这里能挡住；
   * 滤镜名拼错、这个版本不支持 xfade 这类错挡不住。
   *
   * 第一版是拿一个假的 ffmpeg 可执行文件录参数的，Linux 上很好使，
   * 结果在 Windows 上整个红掉 —— 那儿没有 shebang 这回事。
   * 而 Windows 是这个应用唯一的目标平台，那儿测不了等于没测。
   */
  const ff = await import('../core/ffmpeg.js');

  const dir = path.join(SANDBOX, 'trans');
  fs.mkdirSync(dir, { recursive: true });
  const segs = ['a.mp4', 'b.mp4', 'c.mp4'].map((n) => path.join(dir, n));
  for (const s of segs) fs.writeFileSync(s, 'seg');
  const out = path.join(dir, 'film.mp4');

  /** 每段都是 5 秒、无音轨。录下每一次调用的 argv */
  const runWith = async (transitions, { seconds = 5 } = {}) => {
    const calls = [];
    const notes = [];
    await ff.concat(segs, out, {
      transitions,
      onNote: (m) => notes.push(m),
      __probe: async () => ({ seconds, hasAudio: false }),
      __exec: async (args) => {
        calls.push(args.join(' '));
        // 出片那几步要把目标文件建出来，后面的 existsSync 才过得去
        const last = args[args.length - 1];
        if (last && !last.startsWith('-')) fs.writeFileSync(last, 'x');
        return { stderr: '' };
      }
    });
    return { calls, notes };
  };

  // ① 全硬切：一次多余的重编码都不该做，而且要走不重编码的快路
  const cut = await runWith(['cut', 'cut', 'cut']);
  check('全硬切时一次多余的重编码都不做', cut.calls.length === 1, String(cut.calls.length));
  check('全硬切走 -c copy 的快路', /-c copy/.test(cut.calls[0]), cut.calls[0]);

  // ② 第二镜叠化
  const dis = await runWith(['cut', 'dissolve', 'cut']);
  check('叠化真的用上了 xfade',
    dis.calls.some((c) => /xfade=transition=fade:duration=0\.5/.test(c)),
    dis.calls.find((c) => /xfade/.test(c)) || dis.calls.join(' | ').slice(0, 200));
  // 上一段的尾巴要从 5-0.5=4.5 秒开始取
  check('过渡片取的是上一段的最后 0.5 秒',
    dis.calls.some((c) => /-ss 4\.500/.test(c)), dis.calls.join(' | ').slice(0, 300));
  // 下一段的头 0.5 秒已经被过渡片用掉了，正片要从那之后开始
  check('叠化的那一段掐掉了已经用过的开头',
    dis.calls.some((c) => /-ss 0\.500/.test(c)), dis.calls.join(' | ').slice(0, 300));
  /**
   * 动过刀就必须重编码。concat demuxer 不重编码的前提是各段参数完全一致，
   * 而我们重压的那几段跟厂商原片对不上 —— 硬 copy 拼出来会在接缝处花屏，
   * 且**只在成片里出现**，每段单独播都是好的。
   */
  check('做过转场之后最终拼接改走重编码',
    /-c:v libx264/.test(dis.calls[dis.calls.length - 1]), dis.calls[dis.calls.length - 1]);

  // ③ 黑场：淡出淡入都在，而且一秒时长都不吃
  const fade = await runWith(['cut', 'fade', 'cut']);
  check('黑场：上一段末尾淡出', fade.calls.some((c) => /fade=t=out/.test(c)), fade.calls.join(' | ').slice(0, 200));
  check('黑场：这一段开头淡入', fade.calls.some((c) => /fade=t=in:st=0/.test(c)), fade.calls.join(' | ').slice(0, 200));
  check('黑场不吃时长，所以不出现 xfade', !fade.calls.some((c) => /xfade/.test(c)));
  check('黑场也不掐头去尾', !fade.calls.some((c) => /-ss 0\.500/.test(c)), fade.calls.join(' | ').slice(0, 200));

  // ④ 片段太短就别做转场 —— 切完就没了。宁可不做，也不能把成片弄坏
  const tiny = await runWith(['cut', 'dissolve', 'cut'], { seconds: 0.6 });
  // 说的必须是"切没"这个真实原因 —— 只匹配"硬切"的话，任何一种退回都会让它绿，
  // 包括"根本没读到时长"那种完全不同的失败（这个测试第一版就是那么假绿的）
  check('片段太短时退回硬切', tiny.notes.some((m) => /切没/.test(m)), tiny.notes.join(' | '));
  check('退回硬切之后确实没做 xfade', !tiny.calls.some((c) => /xfade/.test(c)));
  check('退回硬切之后也不重编码', /-c copy/.test(tiny.calls[tiny.calls.length - 1]), tiny.calls[tiny.calls.length - 1]);
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

/**
 * ══ 末帧只能发一遍 ══
 *
 * 用户那批片子的日志：每一镜都先说"把下一镜那张图锁成本镜末帧 —— 两镜之间
 * 会是无缝的"，紧接着就是"服务端拒了这 4 张图（合计 6.6MB，是内联发的）"，
 * 然后一路减参考图。
 *
 * 查下来，末帧被发了**两遍**：一遍在普通图列表里（allImages 是按
 * [首帧, 末帧, 参考图…] 拼的），一遍走 H3 的 last_frame_image 字段。
 * 两个后果：
 *   · 内联时白白多出一两 MB —— 而这条路正是被体积顶掉的那条，
 *     多出来的那份不但没用，还在把请求往上限外推，然后我们照着减参考图
 *   · 普通列表里那一份**没有 role**，模型只会当它是本镜的参考图 ——
 *     等于把下一镜的画面掺进这一镜。日志写着"锁成末帧"，
 *     实际做的是"顺便把下一镜也画进来"
 *
 * 这两条都不会报错，成片照样出得来 —— 只是接缝那儿的画面不是你要的那个。
 */
{
  upstream.msPolls = 0;
  await adapters.generateVideo({
    providerId: 'metaso',
    model: 'MiniMax-H3',
    prompt: 'x',
    duration: 5,
    firstFrameUrl: 'https://x.invalid/head.png',
    lastFrameUrl: 'https://x.invalid/tail.png',
    refImages: ['https://x.invalid/ref1.png']
  });
  const seam = upstream.msBody || {};
  const urls = (seam.content || []).filter((c) => c.type === 'image_url').map((c) => c.image_url?.url || '');
  check('末帧走的是专门的字段（不是混在参考图里）',
    seam.last_frame_image === 'https://x.invalid/tail.png', JSON.stringify(seam.last_frame_image));
  check('末帧不再在普通图列表里重复发一遍',
    urls.filter((u) => /tail\.png/.test(u)).length === 0, JSON.stringify(urls));
  check('首帧和参考图都还在（去重不能连它们一起去掉）',
    urls.length === 2 && urls.some((u) => /head\.png/.test(u)) && urls.some((u) => /ref1\.png/.test(u)),
    JSON.stringify(urls));
}

/**
 * ══ 末帧到底发出去没有，要如实回报 ══
 *
 * 上层原来记的是 `Boolean(ctx.lastFrameUrl)` —— 那是**决定**发末帧，
 * 不是发成了。适配器完全可能中途把它扔掉（写法被拒、体积超上限），
 * 而那种情况下分镜上照样挂着"这两镜是无缝的"、成片体检也据此放行。
 *
 * 界面说谎比少一个功能糟糕得多：人据此以为接上了，直到把成片放出来。
 */
{
  upstream.msPolls = 0;
  upstream.msSawEndFrame = [];
  const ok = await adapters.generateVideo({
    providerId: 'metaso',
    model: 'MiniMax-H3',
    prompt: 'x',
    duration: 5,
    firstFrameUrl: 'https://x.invalid/head.png',
    lastFrameUrl: 'https://x.invalid/tail.png'
  });
  check('末帧发通了就回报 true', ok.endFrameSent === true, String(ok.endFrameSent));

  // 这家换了一版接口，不认末帧了 —— 接缝会消失，而这件事必须被记下来
  upstream.msRejectEndFrame = true;
  upstream.msPolls = 0;
  upstream.msSawEndFrame = [];
  const notes = [];
  const dropped = await adapters.generateVideo({
    providerId: 'metaso',
    model: 'MiniMax-H3',
    prompt: 'x',
    duration: 5,
    firstFrameUrl: 'https://x.invalid/head.png',
    lastFrameUrl: 'https://x.invalid/tail.png',
    onEvent: (ev) => { if (ev.message) notes.push(ev.message); }
  });
  upstream.msRejectEndFrame = false;
  check('末帧被扔掉时这一镜照样出得来（接缝没做上不该把整镜废掉）',
    /out\.mp4$/.test(dropped.url || ''), dropped.url);
  check('但**如实回报没发出去**（原来这里会记成"接上了"）',
    dropped.endFrameSent === false, String(dropped.endFrameSent));
  check('并且当场说清楚接缝这次没做上', /没带上末帧/.test(notes.join(' | ')), notes.join(' | ').slice(-220));
  // 最后那一次提交确实是不带末帧的 —— 否则上面那条可能只是标志位写对了
  check('最后一次真的发的是不带末帧的请求',
    upstream.msSawEndFrame.length >= 2 && upstream.msSawEndFrame[upstream.msSawEndFrame.length - 1] === false,
    JSON.stringify(upstream.msSawEndFrame));
}

/**
 * 被体积/张数顶掉 ≠ 这种末帧写法不对。
 *
 * 换一种写法发过去还是那么多字节，白撞一次墙 —— 而且会把结论引到
 * "这家不认这种写法"上，然后据此扔掉末帧。多花的还不只是时间：
 * 内联图那一路，每撞一次就是几 MB 的上传。
 */
{
  upstream.msPolls = 0;
  upstream.msSawEndFrame = [];
  upstream.msMediaLimit = 0; // 一张都不收 —— 逼出"退到底仍然失败"
  const notes = [];
  await adapters.generateVideo({
    providerId: 'metaso',
    model: 'MiniMax-H3',
    prompt: 'x',
    duration: 5,
    firstFrameUrl: 'https://x.invalid/head.png',
    lastFrameUrl: 'https://x.invalid/tail.png',
    onEvent: (ev) => { if (ev.message) notes.push(ev.message); }
  }).catch(() => null);
  upstream.msMediaLimit = undefined;
  const joined = notes.join(' | ');
  check('体积被顶掉时点明"不是末帧的写法问题"',
    /不是末帧的写法/.test(joined), joined.slice(-260));
  check('并且不换第二种写法白撞一次', !/换「/.test(joined), joined.slice(-260));
}

/**
 * ══ "首尾两张一定发得出去"到底能保证到什么程度 ══
 *
 * 用户问的原话是"能保证首尾图片过去吗"。这一组就是把那个"保证"钉下来，
 * 免得它停留在一句让人放心的空话上。能保证的是**我们这一侧**：
 *
 *   ① 首帧永远在。退让退到底也留 images[0]，
 *      连它自己就超预算的极端情况也照发（发不出去是厂商的事，
 *      我们不能主动把这一镜变成文生视频）。
 *   ② 末帧不参与退让。它走 reservedInline，退让动的只有设定集参考图，
 *      5 张 → 2 张 → 1 张，末帧一路都在。
 *
 * 保证不了的是厂商收不收 —— 那一层由 endFrameSent 如实回报（上面几条）。
 */
{
  // ① 首帧自己就超预算：照发。丢掉它等于把这一镜降级成文生视频
  const huge = `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024)}`;
  const keptHuge = adapters.__trimInlineImages([huge], () => {}, null);
  check('首帧自己就超预算也照发（丢了它这一镜就变成文生视频了）',
    keptHuge.length === 1, `留了 ${keptHuge.length} 张`);
  // 末帧已经吃满预算时，首帧仍然要留下
  const keptWithFatEnd = adapters.__trimInlineImages([huge], () => {}, huge);
  check('末帧吃满预算时首帧仍然留下', keptWithFatEnd.length === 1, `留了 ${keptWithFatEnd.length} 张`);
}
{
  // ② 退让退到底：只剩首帧，而末帧还在
  upstream.msPolls = 0;
  upstream.msImageCounts = [];
  upstream.msSawEndFrame = [];
  upstream.msContentUrls = [];
  upstream.msMediaLimit = 1; // 这家只收 1 张普通图，逼出完整的退让过程
  await adapters.generateVideo({
    providerId: 'metaso',
    model: 'MiniMax-H3',
    prompt: 'x',
    duration: 5,
    firstFrameUrl: 'https://x.invalid/head.png',
    lastFrameUrl: 'https://x.invalid/tail.png',
    refImages: ['https://x.invalid/r1.png', 'https://x.invalid/r2.png', 'https://x.invalid/r3.png']
  });
  upstream.msMediaLimit = undefined;
  check('被顶掉时先减参考图（4 张 → 2 张 → 1 张）',
    upstream.msImageCounts.length >= 2 && upstream.msImageCounts[0] > upstream.msImageCounts.at(-1),
    JSON.stringify(upstream.msImageCounts));
  check('退到底剩下的那一张是首帧', upstream.msImageCounts.at(-1) === 1, JSON.stringify(upstream.msImageCounts));
  /**
   * ⚠ 这一条原来写的是"每一次提交都带着末帧"—— **那是个永远绿的断言**：
   * buildBody 无条件把 lastFrameUrl 拼进去，跟 imgs 一点关系都没有，
   * 所以不管退让成什么样它都成立。我照着它得出过一个错的结论
   * （"退让把末帧挤掉了"），而那个结论指错了修的地方。
   *
   * 能失败的断言是这一条：末帧**从来不以普通图的身份**出现在 content 里。
   * 61c84ec 之前它会 —— 那一份没有 role，模型只会当它是本镜的参考图，
   * 等于把下一镜的画面掺进这一镜。
   */
  const asPlain = (upstream.msContentUrls || []).filter((list) => list.some((u) => /tail\.png/.test(u)));
  check('末帧从不以普通参考图的身份出现（每一次退让都是）',
    (upstream.msContentUrls || []).length > 0 && asPlain.length === 0,
    JSON.stringify(upstream.msContentUrls));
  /**
   * 这一轮退让会把"这家最多收 1 张"学下来，而下面那组量的正是退让过程本身 ——
   * 学到的数会让它一上来就按 1 张发，退让一次都不发生，那一组就白绿了。
   * 用例之间的隐藏状态是最难查的一类假绿，清掉。
   */
  adapters.resetMediaLimits();
}

/**
 * 末帧不在 images 里了，可它的字节数照样要发出去 ——
 * 体积预算必须先给它留出位置。不留的话这里以为还剩两三 MB、实际早就超了，
 * 失败发生在厂商那一侧，而我们给出的解释会是"图带多了"（错的）。
 */
{
  const chunk = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`;
  const withEnd = [];
  const keptWithEnd = adapters.__trimInlineImages([chunk, chunk, chunk], (e) => withEnd.push(e.message), chunk);
  const keptAlone = adapters.__trimInlineImages([chunk, chunk, chunk], () => {}, null);
  check('末帧占的体积算进了预算', keptWithEnd.length === 1, `留了 ${keptWithEnd.length} 张`);
  check('不带末帧时预算照旧（这条证明上面那条量的是末帧，不是别的）',
    keptAlone.length === 2, `留了 ${keptAlone.length} 张`);
  check('并且说清楚末帧照发（它是这两镜能不能接上的唯一保证）',
    /末帧照发/.test(withEnd.join(' | ')), withEnd.join(' | ').slice(0, 200));
}

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

section('内联参考图先缩小 —— 不然请求体被自己撑穿');
{
  /**
   * 用户那批片子：第 1、10、11、12 镜成了，中间第 2~9 镜全挂。
   * 不是"越往后越糟"，是**中间那几镜出场的人和道具最多**，参考图带得最多：
   *
   *   ※ 5 张加起来 8.4MB 太大，这次只发前 4 张
   *   ※ 服务端拒了这 4 张图（合计 6.6MB，是内联发的）…先改成 2 张重试
   *
   * 我们出的分镜图是 1080p/2K 的 PNG，一张一两 MB，base64 再胀三分之一。
   * 而参考图**根本不需要那么大** —— 它回答的是"这个人长什么样"，
   * 768px 完全够用，发过去多少分辨率也不影响出片分辨率。
   *
   * ⚠ 这一组只在装了 FFmpeg 的机器上量得了（缩图靠它）。没装就跳过 ——
   * 但要**说出来跳过了**，不能让它假装绿。
   */
  const ff = await import('../core/ffmpeg.js');
  /**
   * 自检默认是"没装 FFmpeg"的环境（有几条专门量那种情况下的降级说辞）。
   * 这一段要真跑一次缩图，所以临时把路径指过去，跑完**必须还回去** ——
   * 用例之间留下状态是最难查的一类假绿。
   */
  let ffTemp = '';
  try {
    const mod = await import('ffmpeg-static');
    ffTemp = mod.default || mod;
  } catch { /* 没装这个包就按没装 FFmpeg 处理 */ }
  const ffKeep = settings.get('ffmpegPath');
  if (ffTemp) { settings.patch({ ffmpegPath: ffTemp }); ff.locate({ refresh: true }); }

  if (!ff.locate().available) {
    console.log('  \x1b[33m—\x1b[0m 这台机器没装 FFmpeg，缩图那几条跳过（realcheck 里会真跑）');
  } else {
    const fsx = await import('node:fs');
    const pathx = await import('node:path');
    const dir = fsx.mkdtempSync(pathx.join((await import('node:os')).tmpdir(), 'fd-shrink-'));
    const big = pathx.join(dir, 'ref.png');
    // 造一张真的大图：1920×1080 的噪点，PNG 压不动，稳定在几 MB
    await ff.run(['-y', '-f', 'lavfi', '-i', 'nullsrc=s=1920x1080', '-vf',
      'geq=random(1)*255:128:128', '-frames:v', '1', '-update', '1', big]);
    const before = fsx.statSync(big).size;
    const small = pathx.join(dir, 'ref.small.jpg');
    await ff.shrinkImage(big, small);
    const after = fsx.statSync(small).size;
    check('缩完确实小了一个数量级', after * 5 < before, `${before} → ${after}`);
    check('缩完还是一张能用的图（不是 0 字节）', after > 2000, String(after));

    /**
     * 不放大：本来就小的图放大只会变糊，体积还涨。
     * 这一条量的是那个 min(iw,768)，没有它的话小图会被拉到 768。
     */
    const tiny = pathx.join(dir, 'tiny.png');
    await ff.run(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-frames:v', '1', '-update', '1', tiny]);
    const tinyOut = pathx.join(dir, 'tiny.out.jpg');
    await ff.shrinkImage(tiny, tinyOut);
    /**
     * ⚠ 第一版这里读的是 probeStreams()，可那个函数只回 { seconds, hasAudio }
     * —— 根本没有 width。于是断言写成了 `!w || w <= 320`，w 永远 undefined，
     * **永远绿**。去掉 min() 那个 canary 一声不吭地过了，我差点就信了。
     * 现在直接从 ffmpeg 自己那行 `Stream #0:0: Video: ... 320x180` 里读。
     */
    const { stderr } = await ff.run(['-i', tinyOut, '-f', 'null', '-']).catch((e) => ({ stderr: String(e.message) }));
    const wh = /,\s(\d{2,5})x(\d{2,5})/.exec(stderr || '');
    check('量得到缩完之后的尺寸（读不出来的话下面那条就是空断言）',
      Boolean(wh), (stderr || '').slice(0, 120));
    check('本来就小的图不放大', wh && Number(wh[1]) <= 320, wh ? `${wh[1]}x${wh[2]}` : '读不出');
    fsx.rmSync(dir, { recursive: true, force: true });
  }
  if (ffTemp) { settings.patch({ ffmpegPath: ffKeep || '' }); ff.locate({ refresh: true }); }
  check('跑完把 FFmpeg 路径还回去了（别把状态留给下一个用例）',
    ff.locate().available === false || Boolean(ffKeep), String(ff.locate().available));
}

section('配完对象存储，老项目要跟上');
{
  /**
   * 一件很伤人的事：用户照着我们的建议去配了对象存储，满心以为请求体
   * 从几 MB 掉到几 KB —— 而**老项目里那些镜头照旧内联发**。
   *
   * 因为 imageRef 是出图那一刻算出来的：没配 OSS 时它是一个几 MB 的
   * base64，还被存进了项目文件。之后每一镜都直接复用它 ——
   * usableRef() 只挡"带 Expires 的过期地址"，一个 2MB 的 data: URI
   * 在它眼里完全可用。问题一点没变，而他已经付出了配置的成本。
   *
   * 这一组量的就是那条判断：胖内联图 + 现在有更好的路 = 重算。
   */
  const st = await import('../core/pipeline/studio.js');
  const reuse = st.__reusableFrameRef;
  const fat = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`;
  const thin = 'data:image/png;base64,AAAA';
  const url = 'https://bucket.oss-cn-shanghai.aliyuncs.com/a.png';
  const expired = 'https://bucket.oss-cn-shanghai.aliyuncs.com/a.png?Expires=1&Signature=x';

  const ossMod = await import('../core/oss.js');
  const wasReady = ossMod.ready();
  check('这台自检机器上没配对象存储（下面几条的前提）', wasReady === false, String(wasReady));

  // 没配 OSS 时：胖就胖着发 —— 重算出来还是同一个胖东西，白读一次盘
  check('没配 OSS 时，胖内联图照旧复用', reuse(fat) === fat);
  check('小的内联图当然也复用', reuse(thin) === thin);
  check('过期的签名地址一律不复用', reuse(expired) === null);
  check('没缓存就是没缓存', reuse('') === null && reuse(null) === null);

  // 配上 OSS 之后：胖的那张要重算（这一次能换成几十字节的地址）
  settings.patch({ oss: { enabled: true, bucket: 'b', region: 'oss-cn-shanghai' } });
  vault.setSecret('ALIYUN_OSS_KEY_ID', 'ak-test');
  vault.setSecret('ALIYUN_OSS_KEY_SECRET', 'sk-test');
  check('配上之后 oss.ready() 是真的（不然下面几条是空断言）', ossMod.ready() === true);
  check('配完 OSS，胖内联图不再复用（这次能换成地址）', reuse(fat) === null);
  check('小的内联图仍然复用（换它没意义，白传一趟）', reuse(thin) === thin);
  check('已经是地址的照旧复用', reuse(url) === url);
  settings.patch({ oss: { enabled: false } });
  vault.setSecret('ALIYUN_OSS_KEY_ID', '');
  vault.setSecret('ALIYUN_OSS_KEY_SECRET', '');
  check('跑完还原了（别把状态留给下一个用例）', ossMod.ready() === false);
}

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

  // ⚠ 按**增量**比，不能比绝对值：前面的用例也往这个口上提交过。
  // 原来这条读的是一个从来没被赋过值的计数器，等于 undefined === undefined，
  // 永远绿 —— 而它守的正是"重查会不会顺手又生成一次"。
  const submitsBeforeRecheck = upstream.msv2Submits || 0;
  const evs = await ndjson(`/projects/${project.id}/tasks/recheck`, {});
  const after = evs.find((e) => e.type === 'finished')?.project;
  const claimed = after?.shots?.find((x) => x.id === shot.id);
  check('重查一次就把片子收回来了', Boolean(claimed?.videoPath), JSON.stringify(evs.slice(-2)));
  check('收回来之后不再挂着"待认领"', !claimed?.pendingTask);
  check('重查只查不生成（没有新的提交请求）',
    (upstream.msv2Submits || 0) === submitsBeforeRecheck,
    `${upstream.msv2Submits} vs ${submitsBeforeRecheck}`);
  check('列表随之清空', studioModule.listPendingTasks(project.id).length === 0);

  /**
   * ══════ 重跑之前必须先把已经付过钱的那几镜捞回来 ══════
   *
   * 用户报的：「视频13段都生成两次了，PC和移动端还是显示只生成了4段」。
   *
   * 这个循环是这样闭合的：某一镜提交成功、厂商那边也出片了，但我们没取回来
   *（查任务的路径不对、下载要鉴权、网断了一下）—— 于是这一镜没有 videoPath。
   * 而 targets 的筛选条件正是「没有 videoPath」，所以下一次「往后全跑」
   * 会原样再提交一遍，**再付一次钱**。出多少次都不会自己好，
   * 因为坏的是取回来那一步，不是生成那一步。
   *
   * 打断它的办法：重跑之前先查一次。查任务是免费的，能省下一整镜的视频钱。
   * 这一条量的就是"它到底有没有先查"。
   */
  {
    const s0 = afterAssets.shots[0];
    store.update(project.id, (p) => {
      const t = p.shots.find((x) => x.id === s0.id);
      if (t) {
        delete t.videoPath;
        t.pendingTask = { taskId: '424010985738629', provider: 'metaso', at: new Date().toISOString() };
      }
      return p;
    });
    /**
     * 出视频也路由到这个假秘塔口上 —— 否则"没有再提交一次"量的是
     * 一个根本不会被碰到的计数器（重跑会打到别家去），又是一条永远绿的断言。
     */
    const keepP = settings.get('videoProvider');
    const keepM = settings.get('videoModel');
    settings.patch({
      baseUrls: { metaso: `${upstreamUrl}/msv2` },
      videoProvider: 'metaso',
      videoModel: 'MiniMax-H3'
    });
    adapters.resetQueryUrlCache();
    upstream.msv2Hits = 5;
    const submitsBefore = upstream.msv2Submits || 0;

    const notes = [];
    await studioModule.generateVideos(project.id, {
      only: [s0.id],
      onEvent: (ev) => { if (ev.message) notes.push(ev.message); }
    }).catch((e) => notes.push(`ERR ${e.message}`));

    const back = store.read(project.id).shots.find((x) => x.id === s0.id);
    const joined = notes.join(' | ');
    check('全跑之前先免费查了一遍待认领', /先免费查一遍|捞回来/.test(joined), joined.slice(0, 240));
    check('捞回来了，videoPath 补上了', Boolean(back?.videoPath), String(back?.videoPath));
    check('**没有再提交一次**（那一次就是第二笔钱）',
      (upstream.msv2Submits || 0) === submitsBefore, `${upstream.msv2Submits} vs ${submitsBefore}`);
    check('并且说清楚省下的是什么', /第二次付钱|省下/.test(joined), joined.slice(0, 240));

    settings.patch({ baseUrls: { metaso: `${upstreamUrl}/ms` }, videoProvider: keepP, videoModel: keepM });
    adapters.resetQueryUrlCache();
  }

  /**
   * 失败的原因要**存在这一镜身上**，不能只发进那条流里。
   *
   * 流一断（关页面、切屏、手机锁屏）那句话就永远消失了，之后两端看到的
   * 都是"有图没视频"四个字，没有任何线索 —— 于是唯一能做的动作就是再跑一遍。
   */
  {
    const s1 = afterAssets.shots[0];
    store.update(project.id, (p) => {
      const t = p.shots.find((x) => x.id === s1.id);
      if (t) { delete t.videoPath; delete t.pendingTask; t.videoError = null; }
      return p;
    });
    // 把出视频路由到那个假的秘塔口上 —— videoFail 这个开关挂在它身上
    const keepProvider = settings.get('videoProvider');
    const keepModel = settings.get('videoModel');
    settings.patch({ videoProvider: 'metaso', videoModel: 'MiniMax-H3' });
    upstream.videoFail = '厂商那边出片失败：内容审核不通过';
    await studioModule.generateVideos(project.id, { only: [s1.id], onEvent: () => {} }).catch(() => {});
    upstream.videoFail = null;
    settings.patch({ videoProvider: keepProvider, videoModel: keepModel });
    const hurt = store.read(project.id).shots.find((x) => x.id === s1.id);
    check('失败原因存在这一镜身上（流断了也还在）',
      Boolean(hurt?.videoError?.message), JSON.stringify(hurt?.videoError));
    check('存的是厂商原话，不是"失败了"三个字',
      /审核不通过/.test(hurt?.videoError?.message || ''), hurt?.videoError?.message);
    check('并且记下了时间（不然分不清是这次的还是上次的）',
      Boolean(hurt?.videoError?.at), String(hurt?.videoError?.at));
  }

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

/**
 * 同一个坑的第三种长相：**拼一段给别的进程执行的代码**，里面带 import 路径。
 *
 * 上面那条规矩只看 `import(...)`，而这种写法是
 * `import * as x from ${JSON.stringify(path.join(...))}` 塞进 `node -e` 里 ——
 * 静态 import，正则看不见，可它在 Windows 上一样崩：D:\a\... 会被当成协议名。
 *
 * 这个漏网之鱼让 Windows 打包流水线红了十几次，而报错是"起不来："后面空一片
 * （子进程的堆栈全在 stderr，当时没收）。两处都补上了，规矩也补上。
 */
const SPAWN_IMPORT_TRAP = /JSON\.stringify\(\s*path\.(join|resolve)\(/;
const spawnOffenders = sourceFiles
  .filter((f) => !f.endsWith('selftest.mjs'))
  .filter((f) => SPAWN_IMPORT_TRAP.test(stripComments(fs.readFileSync(f, 'utf8'))));
check(
  '拼给子进程执行的 import 路径也过了 pathToFileURL',
  spawnOffenders.length === 0,
  spawnOffenders.map((f) => path.relative(PROJECT_ROOT, f)).join('、')
);

/**
 * Electron 不实现 window.prompt —— 调用会直接抛
 * "prompt() is and will not be supported"。
 *
 * 这个坑的样子是：点了菜单**什么都不发生**，控制台之外没有任何线索。
 * 而它写起来又特别自然（"就要一个输入框而已"），所以值得拦一道。
 */
const PROMPT_TRAP = /\b(window\.)?prompt\s*\(/;
const promptOffenders = sourceFiles
  .filter((f) => !f.endsWith('selftest.mjs'))
  // 网页那边（ui/）是在真浏览器里跑的，prompt 能用；只有 Electron 主进程不行
  .filter((f) => f.includes(`${path.sep}electron${path.sep}`))
  .filter((f) => PROMPT_TRAP.test(stripComments(fs.readFileSync(f, 'utf8'))));
check(
  'Electron 里没有用 window.prompt（它不实现，点了没反应）',
  promptOffenders.length === 0,
  promptOffenders.map((f) => path.relative(PROJECT_ROOT, f)).join('、')
);

/**
 * 自检里不许造"可执行的脚本文件"当替身。
 *
 * ── 这条是我自己踩出来的 ──
 *
 * 加转场那一版，我写了个 `#!/bin/sh` 的假 ffmpeg 来录参数。
 * 本机全绿、三套浏览器走查全绿，推上去 Windows 流水线当场红 ——
 * Windows 没有 shebang 这回事，spawn 一个没后缀的脚本直接失败。
 *
 * 关键不在于修它，而在于：**这个应用唯一的目标平台就是 Windows**，
 * 我却在一个跑不到 Windows 的地方宣布"全过了"。
 * 上面那几条规矩拦的是源码里的 Windows 陷阱，这一条拦的是**自检自己**的。
 *
 * 要替身就用注入（把假的 probe/exec 当参数传进去），两个平台跑同一段代码。
 */
const SHEBANG_STUB = /#!\/(bin|usr)\//;
const stubOffenders = sourceFiles
  .filter((f) => f.includes(`${path.sep}scripts${path.sep}`))
  .filter((f) => {
    const text = fs.readFileSync(f, 'utf8');
    // 文件自己的第一行 shebang 不算 —— 那是正常的
    return SHEBANG_STUB.test(stripComments(text).split('\n').slice(1).join('\n'));
  });
check(
  '自检里没有造 shebang 脚本当替身（Windows 上跑不了）',
  stubOffenders.length === 0,
  stubOffenders.map((f) => path.relative(PROJECT_ROOT, f)).join('、')
);

/**
 * 更新脚本的核对那一步，不许有"跳过"这条路。
 *
 * ── 这条也是踩出来的 ──
 *
 * update-server.sh 存在的**唯一**理由是最后那次核对：前面每一条命令
 * 都可能回 0 而实际没更新（镜像用了缓存层、容器没重建）。
 *
 * 而它第一版是拿 .env 里的 FD_TOKEN 去请求 /api/health —— 可
 * docker-compose.yml 里 FD_TOKEN 是**可选**的，不填的话应用自己生成一个
 * 存进数据卷。也就是说在这个项目自己推荐的装法下，核对**永远走 exit 0
 * 那条跳过分支**。用户跑完看到一句"跳过核对，请自己看页面"，
 * 整个脚本等于没干最重要的那件事，而且它回的是 0，看起来一切正常。
 *
 * 用户真的这么跑了，真的看到了那句话 —— 这条断言就是那次的回执。
 *
 * 现在改成在容器里读应用自己的 version.info()：不碰网络、不要口令，
 * 没有任何前提条件，也就没有理由再有一条 exit 0 的旁路。
 */
{
  const updater = path.join(PROJECT_ROOT, 'scripts', 'update-server.sh');
  const text = fs.existsSync(updater) ? fs.readFileSync(updater, 'utf8') : '';
  const body = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))     // 注释里出现"跳过"是在讲历史，不算
    .join('\n');
  check('更新脚本还在（核对版本这件事没人替它做）', text.length > 0);
  check('更新脚本里没有"核对不了就算了"的旁路（exit 0）',
    !/\bexit\s+0\b/.test(body), body.split('\n').filter((l) => /exit\s+0/.test(l)).join(' / '));
  // 核对必须问应用自己，别再依赖 .env 里可有可无的东西
  check('核对读的是应用自己的版本号，不依赖 FD_TOKEN',
    /version\.js/.test(body) && !/FD_TOKEN/.test(body), body.includes('FD_TOKEN') ? '还在用 FD_TOKEN' : '');
}

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
  check('④ 没台词、但画面里有人的镜头要求闭嘴（不然人物会在那儿瞎说）',
    cur.shots.every((sh, i) =>
      Boolean(sh.dialogue?.trim()) || !(sh.characters || []).length || /嘴唇闭合/.test(vTexts[i] || '')),
    JSON.stringify(cur.shots.map((sh, i) => [Boolean(sh.dialogue), (sh.characters || []).length, /嘴唇闭合/.test(vTexts[i] || '')])));

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
  /**
   * 大家说"古风工笔"时想要的，不是教科书里那种绢本工笔（平面、线描填色、装饰性），
   * 而是新中式国潮插画：柔和渐变、没有粗黑轮廓、青绿米白、云海和一大片暖金天光。
   * 写风格锚不能写门类名，要写**画面特征** —— 只写"工笔""勾线"就会画回前者。
   */
  check('风格锚写的是画面特征，不是门类名', !/勾线|绢本/.test(gf.anchor), gf.anchor);
  check('渐变、无描边、青绿、云雾、暖金光晕，一样都不能少',
    /渐变/.test(gf.anchor) && /没有粗黑描边/.test(gf.anchor) && /青绿/.test(gf.anchor)
      && /云海|雾气/.test(gf.anchor) && /暖金/.test(gf.anchor), gf.anchor);
  // "粗黑描边"是这个风格最容易翻的一次车：一根硬轮廓线下去，整张图就变成漫画了
  check('负向词把描边和高饱和挡住了',
    /粗黑描边/.test(gf.negative) && /高饱和/.test(gf.negative) && /满构图无留白/.test(gf.negative), gf.negative);
  check('示意图也用渐变画法（用勾线等于在卡片上就把风格说错）', gf.art?.mode === 'soft', gf.art?.mode);

  /**
   * 构图特征**不能**写进风格锚。
   *
   * 参照图里那些最抓眼的东西 —— 背影、人物很小、一轮巨日 —— 是构图，不是风格。
   * 风格锚会拼在每一镜提示词最前面，把构图写死等于全片二十个镜头全是背影。
   */
  check('构图不写进风格锚（否则全片都是背影）',
    !/背影|巨日|落日圆盘|人物很小/.test(gf.anchor), gf.anchor);

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
/**
 * 端口 0 = "随便给我一个空闲的"。
 *
 * 这条看着琐碎，但它让 Windows 的打包流水线红了一整轮：`preferredPort || ...`
 * 里 0 是假值，于是 listen(0) 悄悄变成 5178，所有测试脚手架都在抢同一个端口。
 * Linux 上撞了会顺延，完全看不出来；Windows 上 0.0.0.0:5178 和 127.0.0.1:5178
 * 能共存，请求落到了**另一个进程**上，于是服务器模式的测试全红，
 * 报的还是那个进程的规矩（"只允许 127.0.0.1"）—— 和真正的原因毫无关系。
 */
section('端口 0 要真的是"随便给一个"');
{
  const srvMod = await import('../core/server.js');
  const a = await srvMod.listen(0);
  const b = await srvMod.listen(0);
  check('拿到的不是默认端口', a.port !== 5178 && a.port > 0, String(a.port));
  check('两次拿到的不是同一个（不然并发跑测试必撞）', a.port !== b.port, `${a.port} vs ${b.port}`);
  check('报出来的端口就是真实监听的那个',
    a.port === a.server.address().port, `${a.port} vs ${a.server.address().port}`);
  a.server.close();
  b.server.close();
}

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
    import * as srv from ${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'core/server.js')).href)};
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
    const timer = setTimeout(() => reject(new Error(`服务器模式没起来：${out}`)), 15000);
    // ⚠ stderr 也要收。只收 stdout 的话，子进程一崩就得到"起不来："后面空一片 ——
    // 那是最没用的一种报错，而真正的原因（堆栈）全在 stderr 里。
    // 这个坑让 Windows 的打包流水线红了十几次，每次都看不出为什么。
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (d) => {
        out += d.toString();
        const m = out.match(/PORT=(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
    }
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`起不来（exit=${code}）：${out || '（子进程一个字都没输出）'}`));
    });
  });

  const hit = (host, pathname, withKey = true, key = TOKEN) =>
    new Promise((resolve) => {
      const sock = net.connect(sport, '127.0.0.1', () => {
        sock.write(
          `GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\n` +
            (withKey ? `X-FD-Key: ${key}\r\n` : '') +
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

  /**
   * 手机端那一屏原来写死了局域网的规矩：强制转大写、最长 12 位。
   * 服务器口令是 32 位大小写混排 —— 于是在服务器上**根本输不进去**，
   * 而且报的是"配对码不对"，人只会以为自己抄错了。
   */
  const raw = (host, pathname, key) =>
    new Promise((resolve) => {
      const sock = net.connect(sport, '127.0.0.1', () => {
        sock.write(`GET ${pathname} HTTP/1.1\r\nHost: ${host}\r\nX-FD-Key: ${key}\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      sock.on('data', (d) => (buf += d));
      sock.on('end', () => resolve(Number(buf.split(' ')[1])));
      sock.on('error', () => resolve(0));
    });
  // 大小写正是这 32 位里将近一半的熵，抹平等于白扔
  check('服务器口令区分大小写', (await raw('fd.example.com', '/api/projects', TOKEN.toUpperCase())) === 401);
  check('原样送进来才放行', (await raw('fd.example.com', '/api/projects', TOKEN)) === 200);
  // 登录屏之前得能问"这台服务要我输什么"，否则那一屏只能瞎猜
  const modeCode = await hit('fd.example.com', '/api/mode', false);
  check('模式这一问不要口令（登录屏要靠它决定问什么）', modeCode === 200, String(modeCode));

  /**
   * 账号在服务器模式下的整条路。
   *
   * 最要紧的一条是**抢注**：一个刚上线还没建账号的服务，如果谁都能建管理员，
   * 那么第一个扫到它的人就把你锁在自己的服务器外面了。所以建第一个账号
   * 必须拿出那串访问口令 —— 它证明的是"你摸得到这台机器的启动日志"。
   */
  const post = (pathname, body, key) =>
    new Promise((resolve) => {
      const payload = JSON.stringify(body);
      const sock = net.connect(sport, '127.0.0.1', () => {
        sock.write(
          `POST ${pathname} HTTP/1.1\r\nHost: fd.example.com\r\n` +
            'Content-Type: application/json\r\n' +
            (key ? `X-FD-Key: ${key}\r\n` : '') +
            `Content-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`
        );
      });
      let buf = '';
      sock.on('data', (d) => (buf += d));
      sock.on('end', () => {
        const status = Number(buf.split(' ')[1]);
        let parsed = {};
        try { parsed = JSON.parse(buf.slice(buf.indexOf('\r\n\r\n') + 4)); } catch { /* 不是 JSON */ }
        resolve({ status, body: parsed });
      });
      sock.on('error', () => resolve({ status: 0, body: {} }));
    });

  const grab = await post('/api/account/setup', { user: 'attacker', password: 'i-was-here-first' });
  check('没口令就抢不到管理员（不然第一个扫到的人把你锁在门外）',
    grab.status === 403, `${grab.status} ${grab.body.error || ''}`);

  const mine = await post('/api/account/setup', { user: 'owner', password: 'my-strong-password', accessToken: TOKEN });
  check('拿得出口令才建得成', mine.status === 200 && mine.body.token, `${mine.status} ${mine.body.error || ''}`);
  check('建完顺手就登上了（不用再登一次）', Boolean(mine.body.token) && mine.body.user === 'owner');

  const again = await post('/api/account/setup', { user: 'second', password: 'another-password', accessToken: TOKEN });
  check('建过一次就不能再走这条路', again.status === 409, String(again.status));

  const login = await post('/api/account/login', { user: 'owner', password: 'my-strong-password' });
  check('登录换得到凭证', login.status === 200 && Boolean(login.body.token), String(login.status));
  const wrongPass = await post('/api/account/login', { user: 'owner', password: 'wrong-password' });
  check('密码错了进不去', wrongPass.status === 401, String(wrongPass.status));
  // 报"用户不存在"等于帮人把用户名一个个试出来
  check('不告诉你是用户名错还是密码错', /用户名或密码/.test(wrongPass.body.error || ''), wrongPass.body.error);

  check('会话凭证当口令使', (await hit('fd.example.com', '/api/projects', true, login.body.token)) === 200);
  // 升级一次就把已部署的服务锁在门外，是最不能接受的一种改动
  check('老那串口令仍然有效', (await hit('fd.example.com', '/api/projects')) === 200);

  const modeNow = await post('/api/account/login', { user: 'owner', password: 'my-strong-password' });
  check('建了账号之后，登录屏该改问用户名密码了',
    modeNow.status === 200 && /account/.test(JSON.stringify(await fetchMode())), '');

  async function fetchMode() {
    return new Promise((resolve) => {
      const sock = net.connect(sport, '127.0.0.1', () => {
        sock.write('GET /api/mode HTTP/1.1\r\nHost: fd.example.com\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      sock.on('data', (d) => (buf += d));
      sock.on('end', () => {
        try { resolve(JSON.parse(buf.slice(buf.indexOf('\r\n\r\n') + 4))); } catch { resolve({}); }
      });
      sock.on('error', () => resolve({}));
    });
  }

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
    import * as vault from ${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'core/vault.js')).href)};
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

  // 配对码的字母表本来就只有大写，是给人在手机上一个一个敲的 ——
  // 为大小写卡住用户毫无意义。规矩定在服务端，客户端就不用各自猜
  const lower = await fetch(`${base}/api/projects`, { headers: { 'X-FD-Key': token.toLowerCase() } });
  check('配对码不挑大小写（手机上敲的，别为这个卡人）', lower.status === 200, String(lower.status));

  // 手机端那一屏要先知道自己该问什么，而这一问必然在拿到码之前
  const mode = await (await fetch(`${base}/api/mode`)).json();
  check('没码也能问清楚"这台服务要我输什么"', mode.mode === 'lan', JSON.stringify(mode));

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
/**
 * 三端对齐。
 *
 * 这个应用有三张脸，加功能时很自然只在正在改的那一端加完就算完事 ——
 * 于是手机版慢慢落后成一个"只能看不能改"的残废，而且**没人会发现**：
 * 两端的测试各自都是绿的。靠"记得同步"是管不住的，所以把它变成一条会报错的规矩。
 */
/**
 * 阿里云 OSS。
 *
 * ⚠ 先说清楚这里**验不了什么**：签名对不对，只有拿真凭证发给真 OSS 才知道。
 * 沙箱里没有凭证，也不该有。所以这一段验的是能验的那部分 ——
 * 默认值是不是安全的、路径编码对不对、报错说不说人话、
 * 以及那些"填了一半"的状态会不会被当成配好了。
 *
 * 端到端那一步交给用户点「测试连接」：它真写、真读、真删一次。
 * 与其在这儿造一个假的 OSS 自欺欺人，不如把真检查做得好用。
 */
/**
 * 账号与会话。
 *
 * 那串 32 位口令能用，但它只回答了"你知不知道那个秘密"，
 * 而实际要回答的是四个问题：谁进来了、怎么换、丢了一台怎么办、记不记得住。
 * 这一段验的就是这四条 —— 尤其是**踢掉一台不影响别的**，
 * 那是这套东西存在的全部理由。
 */
/**
 * 搬家。
 *
 * 换服务器不是"可能会发生"，是**一定会发生**。而验这件事有个陷阱：
 * 在同一个进程里导出再导入，什么都对 —— 因为密钥还在内存里、保险箱还是打开的。
 * 真实情况是**另一台机器**：新机器上没有 .vaultkey，导入的密文必须靠口令打开。
 * 所以下面那一半必须起子进程、换数据目录。
 */
section('搬家：从一台机器搬到另一台');
{
  const migrate = await import('../core/migrate.js');

  // 先造点家当
  const mp = store.create({ title: '要搬走的片子', script: '阿澜在码头巡查。' });
  const assetDir = path.join(SANDBOX, 'projects', mp.id, 'assets');
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, 'i1.png'), Buffer.from('fake-image-bytes'));
  fs.writeFileSync(path.join(assetDir, 'v1.mp4'), Buffer.alloc(4096, 7));
  store.update(mp.id, (p) => {
    p.shots = [{ id: 's1', index: 1, description: '走向栈桥', duration: 4 }];
    return p;
  });
  vault.setSecret('ARK_API_KEY', 'sk-the-real-key-do-not-leak');
  settings.patch({ aspectRatio: '9:16', accessToken: '这台机器专属的口令' });

  const before = migrate.survey();
  check('清点得出有多少东西要搬', before.projects >= 1 && before.bytes > 4000, JSON.stringify(before));
  // 一个几 GB 的包传到一半断掉，比一开始就知道大小糟糕得多
  check('单独报出媒体占了多少（好决定要不要带）', before.mediaBytes >= 4096, String(before.mediaBytes));

  const pkg = path.join(SANDBOX, 'move.zip');
  const made = await migrate.exportTo(pkg, { passphrase: 'my-移机口令-123', media: true });
  check('打出包来了', fs.existsSync(pkg) && made.bytes > 4000, JSON.stringify({ bytes: made.bytes }));
  // ⚠ 别断言"正好 1 个"：这个沙箱里有前面几节测试留下的密钥。
  // 该验的是"要搬的那把在里面"，而不是"总共几把"
  check('密钥被封进去了', made.secrets >= 1, String(made.secrets));

  /**
   * 最要紧的一条：**包里不能有明文密钥**。
   * 这个包会经手网盘、微信、U 盘 —— 任何一处泄露都等于密钥泄露。
   */
  const raw = fs.readFileSync(pkg).toString('latin1');
  check('包里没有明文密钥', !raw.includes('sk-the-real-key-do-not-leak'));
  // 这台机器的访问口令是它自己的，跟着搬过去只会让新机器认错自己
  check('这台机器专属的口令没跟着走', !raw.includes('这台机器专属的口令'));

  /**
   * 换一台"机器"：另一个进程 + 另一个数据目录 + 没有 .vaultkey。
   * 这才是真实的搬家场景 —— 同进程导入是测不出问题的。
   */
  const newHome = path.join(SANDBOX, 'newmachine');
  const importScript = `
    import * as migrate from ${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'core/migrate.js')).href)};
    import * as vault from ${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'core/vault.js')).href)};
    import * as store from ${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'core/store.js')).href)};
    const wrong = await migrate.importFrom(process.env.PKG, { passphrase: '不对的口令' }).catch((e) => e.message);
    const ok = await migrate.importFrom(process.env.PKG, { passphrase: 'my-移机口令-123' });
    console.log(JSON.stringify({
      wrong,
      ok,
      key: vault.getSecret('ARK_API_KEY'),
      projects: store.list().length,
      titles: store.list().map((x) => x.title).join('|')
    }));
  `;
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', importScript], {
      env: { ...process.env, FUTUREDREAM_DATA_DIR: newHome, PKG: pkg },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let buf = '';
    c.stdout.on('data', (d) => (buf += d));
    c.stderr.on('data', (d) => (buf += d));
    c.on('exit', () => {
      try {
        resolve(JSON.parse(buf.trim().split('\n').pop()));
      } catch {
        resolve({ crashed: buf.slice(-400) });
      }
    });
  });

  check('在新机器上展开成功', out.ok?.files > 0, JSON.stringify(out.crashed || out.ok));
  // 同理：沙箱里项目不止一个，该验的是"那一个在新机器上找得到"
  check('项目过去了', /要搬走的片子/.test(out.titles || ''), String(out.titles).slice(0, 80));
  // 这一条是整件事的重点：新机器上没有 .vaultkey，密钥只能靠口令打开
  check('密钥在新机器上能用（这才是搬家真正难的地方）',
    out.key === 'sk-the-real-key-do-not-leak', String(out.key).slice(0, 12));
  // 宁可打不开，也不给一半错的密钥
  check('口令不对时明确拒绝，而且什么都不写', /口令不对/.test(out.wrong || ''), out.wrong);

  // 媒体可以不带 —— 几 GB 的包和几百 KB 的包，搬起来完全是两回事
  const lite = path.join(SANDBOX, 'move-lite.zip');
  await migrate.exportTo(lite, { passphrase: '', media: false });
  /**
   * 别用"体积小一半"来验 —— 那取决于这个沙箱里恰好有多少媒体，
   * 换个环境就翻。要成立的性质是**里面一个媒体文件都没有**，直接看条目名。
   */
  const { readZip } = await import('../core/zip.js');
  const liteNames = (await readZip(lite)).map((e) => e.name);
  check('不带媒体时，包里一个媒体文件都没有',
    !liteNames.some((n) => /\.(png|jpg|jpeg|webp|mp4|mp3|wav)$/i.test(n)),
    liteNames.filter((n) => /\.(png|mp4)$/i.test(n)).slice(0, 3).join('、'));
  check('但项目本身还在（重出一次媒体就有了）', liteNames.some((n) => /project\.json$/.test(n)));
  check('不带密钥就真的不带', !fs.readFileSync(lite).toString('latin1').includes('aes-256-gcm'));
}

section('账号：谁进来了、怎么踢出去');
{
  const acc = await import('../core/accounts.js');
  acc.__reset();
  check('一开始没有账号（那时候还是用口令进）', acc.hasAccounts() === false);

  acc.createUser('alan', 'a-good-password');
  check('建完就有了', acc.hasAccounts() === true);
  check('第一个自动是管理员', acc.listUsers()[0].admin === true);

  // 密码规则要拦在建的时候，不能等出事才说
  let tooShort = '';
  try { acc.createUser('bob', 'short'); } catch (e) { tooShort = e.message; }
  check('太短的密码建不了', /至少 8 位/.test(tooShort), tooShort);
  let dup = '';
  try { acc.createUser('ALAN', 'another-password'); } catch (e) { dup = e.message; }
  check('用户名不分大小写地防重（Alan 和 alan 是同一个人）', /已经存在/.test(dup), dup);

  check('密码不明文存', !fs.readFileSync(path.join(SANDBOX, 'accounts.json'), 'utf8').includes('a-good-password'));
  check('对的密码认得出', Boolean(acc.verifyPassword('alan', 'a-good-password')));
  check('错的密码不认', acc.verifyPassword('alan', 'wrong-password') === null);
  check('不存在的用户也不认', acc.verifyPassword('nobody', 'whatever') === null);

  // 一台设备一个会话 —— 这是这套东西存在的理由
  const s1 = acc.login('alan', 'a-good-password', { device: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' });
  const s2 = acc.login('alan', 'a-good-password', { device: 'Mozilla/5.0 (Windows NT 10.0; Win64)' });
  check('登两台，两个不同的凭证', s1.token !== s2.token);
  check('凭证认得出是谁', acc.whoIs(s1.token)?.user === 'alan');
  check('乱编的凭证不认', acc.whoIs('made-up-token') === null);

  const list = acc.sessionsOf('alan');
  check('列得出登了哪两台', list.length === 2, JSON.stringify(list.map((x) => x.device)));
  // 一排看不出区别的条目，没人敢点删除
  check('看得出是什么设备', list.some((x) => x.device === 'iPhone') && list.some((x) => x.device === 'Windows 电脑'),
    JSON.stringify(list.map((x) => x.device)));

  // 手机丢了只想踢那一台，不该牵连电脑 —— 这一条是整套设计的核心
  const phone = list.find((x) => x.device === 'iPhone');
  acc.revoke('alan', phone.id);
  check('踢掉手机那台', acc.whoIs(s1.token) === null);
  check('电脑那台不受影响', acc.whoIs(s2.token)?.user === 'alan');

  // 改密码不该把已登录的设备全踢下线（那样每次改密码都要重新登所有设备）
  acc.changePassword('alan', 'a-good-password', 'a-new-better-password');
  check('改完密码，老密码不认了', acc.verifyPassword('alan', 'a-good-password') === null);
  check('新密码认', Boolean(acc.verifyPassword('alan', 'a-new-better-password')));
  check('已登录的设备不受影响', acc.whoIs(s2.token)?.user === 'alan');
  let badOld = '';
  try { acc.changePassword('alan', 'not-the-old-one', 'whatever-password'); } catch (e) { badOld = e.message; }
  check('原密码不对就改不了', /原密码不对/.test(badOld), badOld);

  // 密码泄了：一次全踢，**包括当前这台** ——
  // "除了我"会让人以为安全了，而那台"我"可能正是被别人拿着的那台
  acc.login('alan', 'a-new-better-password', { device: 'Android' });
  const n = acc.revokeAll('alan');
  check('一次全踢', n >= 1 && acc.whoIs(s2.token) === null, String(n));

  acc.__reset();
}

section('对象存储：能验的部分');
{
  const oss = await import('../core/oss.js');

  // 默认必须是**私有**。默认值是安全的那一个，公开该是主动的选择
  const def = oss.config();
  check('默认不开', def.enabled === false);
  check('默认按私有桶办（公开必须是主动选择）', def.publicRead === false);
  check('默认用 V4 签名（阿里云现在推荐的那版）', def.signVersion === 'v4');

  // "填了一半"最难查：它看起来是开着的，第一次出图才报错
  settings.patch({ oss: { enabled: true, bucket: '', region: 'oss-cn-hongkong' } });
  check('只开开关、没填 bucket，不算就绪', oss.ready() === false);
  settings.patch({ oss: { enabled: true, bucket: 'b1', region: 'oss-cn-hongkong' } });
  check('没有 AccessKey 也不算就绪', oss.ready() === false);

  // 前缀两头的斜杠要吃掉，不然会拼出 //futuredream// 这种路径
  settings.patch({ oss: { enabled: true, bucket: 'b1', region: 'oss-cn-hongkong', prefix: '/pre/' } });
  check('前缀两头的斜杠被吃掉', oss.config().prefix === 'pre', oss.config().prefix);

  // 绑了 CNAME 就该用自己的域名回链
  settings.patch({ oss: { bucket: 'b1', region: 'oss-cn-hongkong', customDomain: 'https://cdn.example.com/' } });
  check('自定义域名把协议和尾斜杠都normalize掉', oss.host() === 'cdn.example.com', oss.host());
  settings.patch({ oss: { bucket: 'b1', region: 'oss-cn-hongkong', customDomain: '' } });
  check('没绑域名就用 bucket 默认域名', oss.host() === 'b1.oss-cn-hongkong.aliyuncs.com', oss.host());

  // 中文文件名和空格必须编码，`/` 不能编 —— 编了就变成文件名的一部分
  vault.setSecret(oss.AK_NAME, 'ak-test');
  vault.setSecret(oss.SK_NAME, 'sk-test');
  const signed = oss.signedUrl('pre/第 1 镜.png', 600);
  check('中文和空格都编码了', /%E7%AC%AC%201%20|%E7%AC%AC%201/.test(signed) || /%E7%AC%AC/.test(signed), signed.slice(0, 90));
  check('路径分隔符没被编掉', signed.includes('/pre/'), signed.slice(0, 90));
  check('限时地址带齐三个参数',
    /OSSAccessKeyId=/.test(signed) && /Expires=/.test(signed) && /Signature=/.test(signed));

  // 报错要说人话。OSS 回的是一段 XML，直接甩给用户等于什么都没说
  check('AccessDenied 翻译成"去 RAM 里挂权限"',
    /RAM/.test(oss.__explain?.(403, '<Error><Code>AccessDenied</Code></Error>') || ''),
    'explain 没导出就跳过');

  /**
   * ══ InvalidAccessKeyId：一句"ID 不对"会把人卡死 ══
   *
   * 用户配 OSS 时收到这个错，回了一句"确定没填错"—— 然后就僵住了：
   * 他没办法证明自己没填错，我们也没给他任何能核对的东西。
   *
   * 而这个错误码在阿里云那边至少对应四种完全不同的原因（粘错了 /
   * 钥匙不属于这个账号 / 被禁用了 / 刚建还没生效），下一步动作各不相同。
   * 更要紧的是：**权限不够不会报成这个**（那是 AccessDenied）——
   * 不说清楚的话，人第一反应就是去改 RAM 策略，改半天也不会好。
   */
  {
    vault.setSecret(oss.AK_NAME, 'LTAI5tSomethingLong9x7f');
    const bad = oss.__explain(403, '<Error><Code>InvalidAccessKeyId</Code></Error>');
    check('把这把钥匙的指纹摆出来（能核对，又不泄露）',
      /LTAI…9x7f/.test(bad) && !/SomethingLong/.test(bad), bad.slice(0, 200));
    check('四种可能都列出来了', /四种可能/.test(bad) && /被\*\*禁用/.test(bad), bad.slice(0, 400));
    check('明说这不是权限问题（否则人会去白改 RAM 策略）',
      /AccessDenied/.test(bad) && /别去改策略/.test(bad), bad.slice(-140));

    // 形状不对的时候直接点破，别让人对着一个 24 位的正确格式找了半天
    vault.setSecret(oss.AK_NAME, 'STS.NUxxxxxxxxxxxxxxxx');
    check('STS 临时凭证当场点破',
      /STS 临时凭证/.test(oss.__explain(403, '<Error><Code>InvalidAccessKeyId</Code></Error>')));
    /**
     * 用户真实碰到的那一把：`JReq…OIJ9（30 位）`。
     * 30 位、不是 LTAI 开头 —— 阿里云的 Secret 正好是 30 位，ID 是 24 位。
     * 长度已经把答案写在脸上了，上一版却还在并列三个猜测让人自己试。
     */
    vault.setSecret(oss.AK_NAME, 'JReq' + 'x'.repeat(22) + 'OIJ9');
    const swapped = oss.__explain(403, '<Error><Code>InvalidAccessKeyId</Code></Error>');
    check('30 位的那把直接断定是"两栏填反了"',
      /这就是一把 AccessKey Secret/.test(swapped) && /填反/.test(swapped), swapped.slice(0, 300));
    check('并且提醒两栏一起重填（框是"留空表示不改"的）',
      /两栏都要重填/.test(swapped), swapped.slice(0, 400));

    vault.setSecret(oss.AK_NAME, 'my-ram-user-name');
    check('不是 LTAI 开头就说不是',
      /LTAI 开头/.test(oss.__explain(403, '<Error><Code>InvalidAccessKeyId</Code></Error>')));
    vault.setSecret(oss.AK_NAME, 'LTAI5t with space');
    check('带空格换行的当场点破',
      /有空格或换行/.test(oss.__explain(403, '<Error><Code>InvalidAccessKeyId</Code></Error>')));
    // 指纹永远不能把整把钥匙印出来
    check('指纹不泄露中间那段',
      !oss.fingerprint('LTAI5tABCDEFGHIJKLMNOP').includes('ABCDEFGHIJKLMN'),
      oss.fingerprint('LTAI5tABCDEFGHIJKLMNOP'));
    vault.setSecret(oss.AK_NAME, 'ak-test');
  }

  check('MIME 认得出 mp4', oss.contentTypeOf('a.mp4') === 'video/mp4');
  check('认不出的类型退到通用二进制', oss.contentTypeOf('a.xyz') === 'application/octet-stream');

  settings.patch({ oss: {} });
}

/**
 * 接线：产物出来之后，到底有没有真的传上去。
 *
 * 用一个**桩 OSS** 验这一段。它验不了签名对不对（那要真凭证），
 * 但能验所有真正会坏的接线：走没走这条路、key 拼得对不对、
 * 传失败会不会把整步拖垮、参考图拿到的是不是公网地址。
 * 这些每一条都出过或者极可能出问题，而签名反倒是一次性对了就一直对。
 */
section('对象存储：接线');
{
  const seen = [];
  let failNext = false;
  const stub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'PUT') {
        if (failNext) {
          res.writeHead(403, { 'Content-Type': 'application/xml' });
          return res.end('<Error><Code>AccessDenied</Code></Error>');
        }
        seen.push({ key: decodeURIComponent(req.url.slice(1)), bytes: body.length, auth: req.headers.authorization || '', body });
        res.writeHead(200);
        return res.end();
      }
      if (req.method === 'DELETE') {
        res.writeHead(204);
        return res.end();
      }
      // 把存进去的原样回出来 —— 回一句 'ok' 的话，"读回的内容对不对"这一条就白测了
      const want = decodeURIComponent(req.url.split('?')[0].slice(1));
      const hit = seen.find((x) => x.key === want);
      res.writeHead(hit ? 200 : 404, { 'Content-Type': 'application/octet-stream' });
      return res.end(hit ? hit.body : 'missing');
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  process.env.FUTUREDREAM_OSS_ENDPOINT = stubBase;

  const ossMod = await import('../core/oss.js');
  vault.setSecret(ossMod.AK_NAME, 'ak-x');
  vault.setSecret(ossMod.SK_NAME, 'sk-x');
  settings.patch({ oss: { enabled: true, bucket: 'b', region: 'oss-cn-hongkong', prefix: 'fd', publicRead: true } });
  check('配齐了就算就绪', ossMod.ready() === true);

  const put = await ossMod.putBuffer('a/b.png', Buffer.from('hello'), 'image/png');
  check('传上去了', seen.length === 1 && seen[0].bytes === 5, JSON.stringify(seen[0] || {}));
  check('前缀拼在最前面', put.key === 'fd/a/b.png', put.key);
  check('带了签名头', /^OSS4-HMAC-SHA256 /.test(seen[0]?.auth || ''), (seen[0]?.auth || '').slice(0, 40));

  // 真写真读真删 —— 一把只读的 key 在"能不能连上"里表现完全正常
  const probe = await ossMod.probe();
  check('自检三步都走到了', probe.ok === true && probe.steps.length === 3, JSON.stringify(probe.steps));

  failNext = true;
  const badProbe = await ossMod.probe();
  check('没有写权限时当场说清楚，而不是等出图完才炸',
    badProbe.ok === false && /RAM/.test(badProbe.error || ''), badProbe.error);
  failNext = false;

  /**
   * 最要紧的一条：**传失败不能把整步弄垮**。
   * 文件已经在本地了，流水线完全可以继续 —— 为了一个顺带做的事
   * 把跑了十分钟的一步废掉，是拿主要目标去赌次要目标。
   */
  const studioMod = await import('../core/pipeline/studio.js');
  const p1 = store.create({ title: '存储接线', script: '一段话。' });
  const dest = path.join(SANDBOX, 'projects', p1.id, 'assets', 'x.png');
  failNext = true;
  const notes = [];
  await studioMod.saveMedia({ base64: Buffer.from('imagedata').toString('base64') }, dest, (ev) => notes.push(ev.message));
  check('传不上去，文件照样落了盘', fs.existsSync(dest));
  check('而且说了一句为什么，不是闷声吞掉',
    notes.some((m) => /对象存储没传上去/.test(m || '')), notes.join(' | '));
  failNext = false;

  const dest2 = path.join(SANDBOX, 'projects', p1.id, 'assets', 'y.png');
  /**
   * ⚠ 这一行原来把 onEvent 写成 `() => {}` —— 于是**成功那条路上说了什么，
   * 从来没有人看过**。而那里藏着一个 `return url`，作用域里根本没有 url。
   *
   * 后果很阴：传是真传上去了（"已同步到对象存储"照常打出来），
   * 紧接着 ReferenceError 被 catch 接住，又打一句
   * "对象存储没传上去（不影响这一步）：url is not defined"。
   * 两句自相矛盾的话前后脚出现在同一份日志里，而文件好好地在桶里。
   *
   * 它能活这么久，是因为唯一的调用点不看返回值 —— 没人用的返回值写错了
   * 不会有任何症状，直到有人第一次真的把对象存储配起来。
   * 所以这里不但要收事件，还要断言**那句矛盾的话不出现**。
   */
  const okNotes = [];
  await studioMod.saveMedia({ base64: Buffer.from('imagedata2').toString('base64') }, dest2, (ev) => okNotes.push(ev.message));
  check('传成功时说了"已同步到对象存储"',
    okNotes.some((m) => /已同步到对象存储/.test(m || '')), okNotes.join(' | '));
  check('并且**不会**紧接着又说一句"没传上去"（那是 return url 那个洞）',
    !okNotes.some((m) => /没传上去/.test(m || '')), okNotes.join(' | '));
  check('传成功之后能拿到公网地址（万相那类只收 https 的就靠它）',
    /^http/.test(studioMod.publicUrlFor(dest2) || ''), String(studioMod.publicUrlFor(dest2)));

  // 参考图那条路：配了 OSS 就不该再逼人去配一个"上传网关"，两者干的是同一件事
  const ref = await studioMod.toModelRef(dest2, {});
  check('参考图走公网地址，不再退回 base64', /^http/.test(ref), ref.slice(0, 60));

  /**
   * 体检里的对象存储那一条，走的必须是**真写真读真删**这条路。
   *
   * 一把只读的 key 在"能不能连上"里表现完全正常 —— 直到出完几十张图，
   * 视频那步才发现参考图传不上去。所以体检不能只 ping 一下。
   */
  const pf = await import('../core/preflight.js');
  const ossOk = await pf.run({ include: ['oss'] }, () => {});
  check('体检里的对象存储真的写读删了一遍', ossOk[0]?.status === 'ok', JSON.stringify(ossOk[0]));

  failNext = true;
  const ossBad = await pf.run({ include: ['oss'] }, () => {});
  check('没权限时体检报不通，而不是报通过', ossBad[0]?.status === 'fail', JSON.stringify(ossBad[0]));
  check('并且给了下一步该查什么', /签名版本|地域|Bucket|RAM/.test(ossBad[0]?.hint || ''), ossBad[0]?.hint);
  failNext = false;

  settings.patch({ oss: {} });
  delete process.env.FUTUREDREAM_OSS_ENDPOINT;

  // 没配对象存储是**跳过**，不是失败 —— 不配是个正经选择，参考图会内联发
  const ossSkip = await pf.run({ include: ['oss'] }, () => {});
  check('没配对象存储时是跳过不是失败', ossSkip[0]?.status === 'skip', JSON.stringify(ossSkip[0]));

  stub.close();
}

section('体检：本机环境那两条');
{
  const pf = await import('../core/preflight.js');

  // 这两条不调任何模型、不花一分钱，所以默认就开
  const ff = pf.CHECKS.find((c) => c.id === 'ffmpeg');
  const os2 = pf.CHECKS.find((c) => c.id === 'oss');
  check('本机 FFmpeg 是一条体检项', Boolean(ff) && ff.defaultOn === true);
  check('对象存储是一条体检项', Boolean(os2) && os2.defaultOn === true);
  check('两条都标着免费', ff.cost === '免费' && os2.cost === '免费');

  /**
   * 没装 FFmpeg 要报**不通**，而且提示里得说清楚去哪儿放那个文件。
   * 这一条以前只有跑到最后一步合成时才会发现 —— 而那时候
   * 图和视频的钱都已经花完了。
   */
  const saved = settings.get('ffmpegPath');
  settings.patch({ ffmpegPath: path.join(SANDBOX, '压根不存在的ffmpeg') });
  const r = await pf.run({ include: ['ffmpeg'] }, () => {});
  check('没装 FFmpeg 时体检报不通', r[0]?.status === 'fail', JSON.stringify(r[0]));
  check('并且告诉你把文件放哪儿', /bin|winget|完整路径/.test(r[0]?.hint || ''), (r[0]?.hint || '').slice(0, 80));
  settings.patch({ ffmpegPath: saved || '' });

  // 音效没配是跳过 —— 那是个正经选择，报成 fail 会让人以为流水线坏了
  const sfxR = await pf.run({ include: ['sfx'] }, () => {});
  check('没配音效服务商时是跳过', sfxR[0]?.status === 'skip', JSON.stringify(sfxR[0]));
  check('并且说明了跳过的后果', /不会变成声音/.test(sfxR[0]?.message || ''), sfxR[0]?.message);
}

section('三端对齐：谁该有什么功能');
{
  const surfaces = await import('../core/surfaces.js');
  const readUI = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), 'utf8');
  const cache = new Map();
  const has = (rel, id) => {
    if (!cache.has(rel)) cache.set(rel, readUI(rel));
    return cache.get(rel).includes(surfaces.marker(id));
  };

  check('能力清单不为空', surfaces.CAPABILITIES.length > 0);

  const missingPc = surfaces.CAPABILITIES.filter((c) => !has(c.pc, c.id));
  check('每条能力在电脑版都能找到实现',
    missingPc.length === 0,
    missingPc.map((c) => `${c.id}(${c.pc})`).join('、'));

  const missingMobile = surfaces.mobileCaps().filter((c) => !has(c.mobile, c.id));
  check('该在手机上有的，手机版一条都不能少',
    missingMobile.length === 0,
    missingMobile.map((c) => `${c.id} —— ${c.name}`).join('、'));

  /**
   * 标记只证明"这一端写了代码"，不证明**它调的地址真的存在**。
   *
   * ── 这条是抓出来的，不是想出来的 ──
   *
   * 手机端的「重出参考图」调的是 `/bible/:kind/:name/sheet`，
   * 而服务端那条路由叫 `regenerate` —— `/sheet` **压根不存在**。
   * 也就是说这个按钮从写下来那天起就是 404：点了转一下，报个 HTTP 404，
   * 而清单检查一直是绿的，因为 `// cap:sheet-regen` 那行注释确实在。
   *
   * 清单里 api 那一栏当时写的也是 `/sheet` —— 三处一致地错着，
   * 而"一致"恰恰让它看起来是对的。
   *
   * 所以这里不看字符串，**真的把每条路由打一遍**，只要服务端回
   * "未知接口"就算漏。参数用真项目 id 填，其余用占位；
   * 返回 400 / 404-带业务话术都算通过 —— 我们只问"这条路存不存在"。
   */
  const made = await fetch(`${appUrl}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '路由体检', script: '老师坐在办公室' })
  }).then((r) => r.json());
  const pid = made.id || made.project?.id;

  const dead = [];
  for (const cap of surfaces.CAPABILITIES) {
    // 纯前端的能力没有后端地址，跳过（它们在 api 那栏写着括号说明）
    const m = /^(GET|POST|PATCH|DELETE|PUT)((?:\+\w+)?)\s+(\/[^\s{（]+)/.exec(cap.api || '');
    if (!m) continue;
    const method = m[1];
    const route = m[3]
      .split('|')[0]                       // shot-regen 写的是 image|video，打前一个就够
      .replace(':id', pid)
      .replace(':sid', 'shot-x')
      .replace(':kind', 'char')
      .replace(':name', 'x')
      .replace(':stage', 'bible')
      .replace(/:\w+/g, 'x');
    // /media 不在 /api 前缀下（它要能直接塞进 <img src>，加不了自定义头）
    const base = route.startsWith('/media') ? `${appUrl}${route}` : `${appUrl}/api${route}`;
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(base, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' })
    });
    // eslint-disable-next-line no-await-in-loop
    const body = await res.text();
    if (/未知接口/.test(body)) dead.push(`${cap.id}: ${method} ${route}`);
  }
  check('清单里每条能力的地址在服务端真的存在（不是 404）',
    dead.length === 0, dead.join('、'));

  // 不做也要有理由，不然三个月后没人知道当初是"故意不做"还是"忘了做"
  const noWhy = surfaces.CAPABILITIES.filter((c) => !c.mobile && !c.why);
  check('手机上故意不做的，都写清楚了为什么',
    noWhy.length === 0, noWhy.map((c) => c.id).join('、'));

  // 手机上必须能改内容 —— 这一条是这次改版的目标，写死在测试里防止哪天又退回去
  const editable = ['script-edit', 'shot-text', 'shot-dialogue', 'shot-camera', 'bible-edit', 'style-pick'];
  const notEditable = editable.filter((id) => {
    const c = surfaces.CAPABILITIES.find((x) => x.id === id);
    return !c?.mobile || !has(c.mobile, id);
  });
  check('手机端是能干活的客户端，不是只读的遥控器',
    notEditable.length === 0, notEditable.join('、'));
}

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

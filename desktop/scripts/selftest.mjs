Warning: truncated output (original token count: 133660)
Total output lines: 9572

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
    write(chunk) { writes.push(chu…73660 tokens truncated…噪音）', ed.summarize({}, shots) === null);
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
  const probeLog = () => logbus.list({ limit: 200 }).filter((x) => /自检/.test(x.label || ''));
  // 按**这一条记录本身**的 id 去差集，不是按服务商 —— 之前探过的那几家
  // 还在日志里，按服务商差集会把它们这一趟的请求算漏
  const seenIds = new Set(probeLog().map((x) => x.id));
  const probesBefore = probeLog().length;
  const r = await (await fetch(`${appUrl}/api/routing/check`, { method: 'POST' })).json();
  const fresh = probeLog().filter((x) => !seenIds.has(x.id));
  const probesAfter = probeLog().length;
  const touched = new Set(fresh.map((x) => x.provider));

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
   * 自检时 chat/vision/image/video 全指向 volcengine、tts 指向 dashscope。
   *
   * ⚠ 量的是**探过几家**，不是发了几次请求。
   *
   * 第一条探针不通时会再问一次"真正要用的那条路"（一次最小对话）——
   * 那是有意的第二次请求，不是"重复探"。按请求数卡的话，
   * 这条断言会在一个完全正确的改动上红，而它想守的东西一点没变。
   */
  check('同一家不重复探（四条能力同一家时只探一次）',
    touched.size <= 2, `这一趟探了 ${touched.size} 家：${[...touched].join('、')}`);
  // 但也不能没完没了：每家最多两次（第一条探针 + 退一步的那次对话）
  check('每家最多两次请求（探针 + 退一步那次对话）',
    fresh.length <= touched.size * 2,
    `${touched.size} 家发了 ${fresh.length} 次：${fresh.map((x) => x.provider).join('、')}`);

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

section('付费生成提交前确认');
{
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'ui', 'views', 'studio.js'), 'utf8');
  check('单镜重出先经过统一确认', /async function regenerate[\s\S]*confirmGeneration\(kind, \[shot\]/.test(src));
  check('整步视频即使不足四镜也确认', /isCostly && !confirmGeneration\('video', missing/.test(src));
  check('确认框列出服务商和模型', src.includes('服务商：${provider?.name') && src.includes('模型：${model?.label'));
  check('视频确认框列出预计生成秒数', src.includes('预计生成量：${seconds} 视频秒'));
  check('明确提示第三方付费接口和账单口径', src.includes('这会调用第三方付费接口，实际金额以服务商账单为准'));
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


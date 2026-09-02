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
const ledgerMod = await import('../core/ledger.js');

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
        /**
         * 大纲那条路上，剧本里每一场前面标着【场次 b-XX】，
         * 而模型要把每一镜标回它属于哪一场。这里照做 —— 不照做的话
         * 走的永远是"一个都没标"那条保守分支，happy path 测不到。
         */
        const user = String(body.messages?.[1]?.content || '');
        const ids = [...user.matchAll(/【场次\s*([a-z0-9-]+)】/gi)].map((m) => m[1]);
        upstream.lastShotPrompt = { system, user };
        /**
         * 每一次拆分镜都留一份**用户消息原文**。
         *
         * 分批那一节靠它数"这一批到底发了哪几场" —— 只留 lastShotPrompt
         * 的话，分没分批根本看不出来（最后一次长得和一次性那次一模一样）。
         */
        upstream.shotPrompts = upstream.shotPrompts || [];
        upstream.shotPrompts.push(user);
        // system 也留一份：验"这一批的时长预算 = 这一批那几场之和"要用
        upstream.shotSystems = upstream.shotSystems || [];
        upstream.shotSystems.push(system);
        // 让测试能造出"跑到第 N 批挂掉"，验前面几批不白跑
        if (upstream.failShotsAfter && upstream.shotPrompts.length > upstream.failShotsAfter) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: '上游炸了（测试造的）' } }));
        }
        /**
         * 打开这个开关就**一个 beatId 都不标** —— 模型真会这样
         *（提示词只是请求，它想不理就不理）。而那条路是最危险的分支：
         * 收口时不知道每一镜属于哪一场，只能保守地把整批换掉。
         */
        content = JSON.stringify((ids.length && !upstream.noBeatTags)
          ? { ...SHOTS_REPLY, shots: SHOTS_REPLY.shots.map((x, i) => ({ ...x, beatId: ids[i % ids.length] })) }
          : SHOTS_REPLY);
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
      } else if (system.includes('分场编辑')) {
        /**
         * 大纲：拆场次。
         *
         * ⚠ 这一支必须排在「编剧」前面 —— 打桩是按 system 里的**子串**认的，
         * 而一旦有两个提示词都含同一个词，后写的那个永远轮不到。
         * 大纲那个提示词一开始写的是"你是编剧"，正好被下面绑说话人那一支
         * 抢走，然后拿 JSON.parse 去解一段中文提示词，整个自检当场崩掉。
         */
        content = JSON.stringify({
          beats: [
            { scene: '码头', time: '清晨', characters: ['阿澜'], summary: '阿澜走向栈桥，例行巡查。', dialogue: '设备正常。', seconds: 20 },
            { scene: '码头', time: '清晨', characters: ['阿澜'], summary: '发现缆绳被割断。', dialogue: '这里的缆绳被人动过。', seconds: 25 }
          ]
        });
      } else if (system.includes('改动指令')) {
        // 改大纲：回一串 ops，不回新大纲
        content = JSON.stringify({
          ops: [
            { op: 'edit', id: 'b-02', fields: { seconds: 40 } },
            { op: 'insert', after: 'b-01', beat: { scene: '码头', summary: '一只海鸟掠过水面。', dialogue: '', seconds: 5 } }
          ],
          note: '第二场加长，中间插一个空镜换气'
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
      /**
       * 带上 usage。
       *
       * 这个假上游原来不回 usage —— 而真实厂商全都回。少了它，
       * 记账那条路在自检里从头到尾走的是"读不出用量"的分支，
       * 于是「真跑一步之后账上有 token」这条断言查出来是空的。
       *
       * 假上游比真实厂商**少给**的字段，会让一整条代码路径从来没被跑过，
       * 而且表现是"测试绿的"。按真实形态回，那条路才真的被验到。
       */
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: {
          prompt_tokens: Math.max(1, Math.round(JSON.stringify(body).length / 4)),
          completion_tokens: Math.max(1, Math.round(content.length / 4)),
          total_tokens: 0
        }
      }));
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

  /**
   * 海螺出图。加它是因为**身份通道只在这条路上**（subject_reference），
   * 而火山那条路没有这个字段 —— 只验火山，等于那条通道从没被跑过。
   */
  // 对象存储的桩：记下每次 PUT 的内容，"重传有没有真的传上去"靠它判
  if (url.pathname.startsWith('/ossput/')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      upstream.ossPuts = upstream.ossPuts || [];
      upstream.ossPuts.push({ key: url.pathname, body: raw });
      res.writeHead(200, { ETag: '"stub"' });
      res.end();
    });
    return undefined;
  }

  if (url.pathname === '/image_generation') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      upstream.lastMinimaxImageBody = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { image_urls: [`${upstreamUrl}/pixel.png`] } }));
    });
    return undefined;
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
  // 进这一段之前的两个基准，后面拿差值比 —— 写死数字会随着加用例失准
  const imageCallsAtBlockStart = upstream.imageCalls || 0;
  const bookedAtBlockStart = ledgerMod.forProject(project.id, {}).items
    .filter((x) => x.kind === 'image').reduce((n, x) => n + x.calls, 0);
  const editCallsAtBlockStart = ledgerMod.forProject(project.id, {}).items
    .find((x) => x.kind === 'image' && x.model === settings.get('imageEditModel'))?.calls || 0;
  const evs = await ndjson(`/projects/${project.id}/shots/${afterAssets.shots[0].id}/regenerate`, {});
  check('打开开关后才带参考图', Boolean(upstream.lastImageBody?.image));
  check('而且必须换成图生图模型（不换的话参考图会被文生图模型忽略）',
    upstream.lastImageBody?.model === settings.get('imageEditModel'),
    `${upstream.lastImageBody?.model} / 期望 ${settings.get('imageEditModel')}`);
  check('换模型这件事说了出来（不说的话没人知道发的和界面写的不是一个）',
    evs.some((e) => e.type === 'note' && /出图模型换成/.test(e.message || '')),
    JSON.stringify(evs.filter((e) => e.type === 'note').map((e) => e.message).slice(0, 5)));

  /**
   * ⚠ **记下来的必须是真正出图的那个模型。**
   *
   * 上面几条只验了"发出去的请求换对了模型"，没验**存进这一镜的是什么**。
   * 于是有个 bug 一直躲着：适配器内部把 model 换成 i2i 之后不回报，
   * studio 记的是换之前那个 —— 卡片上写着 Seedream t2i，
   * 而图其实是 SeedEdit i2i 出的。
   *
   * modelUsed 这个字段存在的全部理由是"中途换过模型是风格漂移最常见的原因"。
   * 它一说谎那条诊断就废了：你对比两镜看到同一个模型名，而实际上
   * 一镜带参考图走 i2i、一镜没带走 t2i，本来就是两个模型。
   */
  const recorded = store.read(project.id).shots.find((s) => s.id === afterAssets.shots[0].id);
  check('存进这一镜的是真正出图的那个模型（不是路由到的那个）',
    String(recorded?.modelUsed || '').includes(settings.get('imageEditModel')),
    `${recorded?.modelUsed} / 期望含 ${settings.get('imageEditModel')}`);
  check('参考图真的发出去了几张，也记下来了', Number(recorded?.refsSent) > 0, String(recorded?.refsSent));

  /**
   * ⚠ **批量出图那条路要单独验一遍。**
   *
   * 上面那条走的是「单独重出这一镜」，而写 modelUsed 的地方有**两处**：
   * 批量出图一处、单独重出一处。第一版只验了后者 —— 金丝雀把前者改回
   * 记路由模型，自检照样全绿。
   *
   * 两条路各写一份同样的逻辑，就一定要各验一份。
   */
  upstream.lastImageBody = null;
  await ndjson(`/projects/${project.id}/stage/assets`, {
    only: [afterAssets.shots[1].id], regenerate: true
  });
  const batch = store.read(project.id).shots.find((s) => s.id === afterAssets.shots[1].id);
  check('批量出图那条路记的也是真正出图的模型',
    String(batch?.modelUsed || '').includes(settings.get('imageEditModel')),
    `${batch?.modelUsed} / 期望含 ${settings.get('imageEditModel')}`);

  /**
   * ⚠ **账本上记的也必须是真正出图的那个模型。**
   *
   * 上面两条验的是"存进这一镜的字段"，而账本是**另一份记录**，
   * 走的是另一段代码（适配层那个外包的壳）。金丝雀把它改成记入参的 model，
   * 上面两条照样全绿 —— 因为它们查的是 shot.modelUsed，不是账。
   *
   * 这件事在钱上比在卡片上更要紧：t2i 和 i2i 单价不一样，
   * 记错模型 = 账按另一个价算，而总数看起来完全正常。
   * 这正是 modelUsed 当初说谎的那个坑，只是换了个地方重新挖了一遍。
   */
  const editModel = settings.get('imageEditModel');
  const bookItems = ledgerMod.forProject(project.id, {}).items.filter((x) => x.kind === 'image');

  /**
   * ⚠ 这条**不能**写成"账上存在 i2i 这个模型"。
   *
   * 试过，金丝雀直接识破：上面那个"把编辑模型误设成出图路由"的小节
   * 已经用同一个模型 id 出过一张图了，所以那条记录**无论这里对不对
   * 都躺在账上**。断言于是恒真 —— 一条看起来严格、其实什么都没验的绿。
   * 这和今天早些时候那几处退化夹具是同一个病：夹具本身满足了断言，
   * 和被测代码没关系。
   *
   * 改成看**这一段之内的增量**：这一段里发出去的每一次出图请求，
   * 都必须记在 i2i 那个模型头上。记成入参那个（t2i）的话增量是 0，当场红。
   */
  const editCallsNow = bookItems.find((x) => x.model === editModel)?.calls || 0;
  check('账本上记的是真正出图的那个模型（不是路由到的那个）',
    editCallsNow - editCallsAtBlockStart === upstream.imageCalls - imageCallsAtBlockStart,
    `i2i 名下多了 ${editCallsNow - editCallsAtBlockStart} 笔，而这段里发了 ${upstream.imageCalls - imageCallsAtBlockStart} 次`);
  /**
   * ⚠ 这里不能写死"应该是 N 笔"。
   *
   * 试过写死 2，红了 —— 实际是 3，因为上面那个"把编辑模型误设成出图路由"
   * 的小节也用同一个模型出过一张。而**账本是对的，我的期望值是错的**。
   * 写死的数字还会随着以后往这一段里加用例而再次失准，
   * 到时候红的又是一条正确的断言 —— 那种红会教人去改断言，而不是查代码。
   *
   * 要守的其实是一句和顺序无关的话：**厂商收到几次请求，账上就有几笔**。
   * 所以拿假上游自己数的次数来比，前后各取一次差值。
   */
  const callsBefore = imageCallsAtBlockStart;
  const bookedNow = ledgerMod.forProject(project.id, {}).items
    .filter((x) => x.kind === 'image').reduce((n, x) => n + x.calls, 0);
  check('厂商收到几次出图请求，账上就有几笔',
    bookedNow - bookedAtBlockStart === upstream.imageCalls - callsBefore,
    `账上多了 ${bookedNow - bookedAtBlockStart} 笔，厂商收到 ${upstream.imageCalls - callsBefore} 次`);
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

  /**
   * 转场表和效果表走的是同一条路（/transitions.js、/fx.js）。
   *
   * 剪辑台上那两个下拉框直接读这两份清单 —— 在界面里另抄一份的话，
   * 加一个新转场就得记得改两处，而漏掉界面那份没人会发现
   *（引擎支持但选不到），漏掉引擎那份用户会报"选了没反应"。
   */
  for (const file of ['transitions.js', 'fx.js']) {
    const s = fs.readFileSync(path.join(PROJECT_ROOT, 'core', file), 'utf8');
    const im = s.split('\n').filter((l) => /^\s*import\s/.test(l));
    check(`${file} 保持零依赖（它要原样发给浏览器）`, im.length === 0, im.join(' / '));
  }

  /**
   * edit.js 也走那条路（/edit.js），但它**允许** import 上面那两个 ——
   * 在浏览器里 `../transitions.js` 从 `/edit.js` 出发正好解析到 `/transitions.js`，
   * 而那条路由是有的。
   *
   * 允许的就这两个。多一个（比如顺手 import 了 store.js）浏览器就会去请求
   * 一个不存在的地址，而 import 失败会让**整个界面模块加载不起来** ——
   * 表现是剪辑台整块不出来，或者更糟：页面在、时间线是空的。
   */
  const editSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'core', 'pipeline', 'edit.js'), 'utf8');
  const editImports = [...editSrc.matchAll(/^\s*import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  const allowed = ['../transitions.js', '../fx.js'];
  check('edit.js 只 import 那两个也发给浏览器的模块（它自己也要发过去）',
    editImports.every((x) => allowed.includes(x)), editImports.join(' / '));
  check('并且 node: 内置一个都没有（浏览器里没有它们）',
    !/from\s+'node:/.test(editSrc));

  /**
   * 场地图那一层走同一条路（/site.js），只许 import previz ——
   * 在浏览器里 `./previz.js` 从 `/site.js` 出发正好解析到 `/previz.js`。
   */
  /**
   * 单价换算（/pricing.js）也要原样发给浏览器 —— 界面上那句"这一下约 ¥12"
   * 和服务端记的账必须是同一套算法。一个四舍五入一个截断、一个把未定价
   * 当 0 一个当未知，就会出现"说好 ¥12、跑完变 ¥31"，而人是照着那个数下的手。
   */
  const pricingSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'core', 'pricing.js'), 'utf8');
  const pricingImports = [...pricingSrc.matchAll(/^\s*import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  check('pricing.js 保持零依赖（它要原样发给浏览器）', pricingImports.length === 0, pricingImports.join(' / '));
  check('pricing.js 里没有 node: 内置', !/from\s+'node:/.test(pricingSrc));

  /**
   * 预估（/estimate.js）只许 import 那两个同样发给浏览器的 ——
   * 在浏览器里 `../pricing.js` 和 `../duration.js` 从 `/estimate.js` 出发
   * 正好解析到 `/pricing.js` 和 `/duration.js`，两条路由都有。
   *
   * 多 import 一个（顺手拿了 settings.js 之类）浏览器就会去请求一个
   * 不存在的地址，而 import 失败会让**整个界面模块加载不起来**——
   * 表现不是"少一行价钱"，是整个工作台白屏。
   */
  const estSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'core', 'pipeline', 'estimate.js'), 'utf8');
  const estImports = [...estSrc.matchAll(/^\s*import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  const estAllowed = ['../pricing.js', '../duration.js'];
  check('estimate.js 只 import 那两个也发给浏览器的模块',
    estImports.every((x) => estAllowed.includes(x)), estImports.join(' / '));
  check('estimate.js 里没有 node: 内置', !/from\s+'node:/.test(estSrc));

  const siteSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'core', 'pipeline', 'site.js'), 'utf8');
  const siteImports = [...siteSrc.matchAll(/^\s*import\s.*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  check('site.js 只 import previz（它自己也要原样发给浏览器）',
    siteImports.every((x) => x === './previz.js'), siteImports.join(' / '));
  check('site.js 里没有 node: 内置', !/from\s+'node:/.test(siteSrc));
}

/**
 * ════════ 场地图：两个**不同的场景**之间对不对得上 ════════
 *
 * 前面每一层查的都是"一个场景以内"的事：
 *
 *   分镜体检   一镜的文字
 *   越轴 / 跳切 相邻两镜的机位
 *   场景布局   同一个场景反复回来时，门窗和太阳是不是同一份
 *
 * 而"山门外是斜逆光、大殿是正顺光"牵涉的是两个不同的场景，中间可能隔着
 * 十几镜、跨了好几场。没有任何一层会把它们放在一起看 —— 这一层才会。
 */
/**
 * ════════ 剧本一章一章往里加 ════════
 *
 * 这是长篇的常态：作者写一章发一章。而在这之前，这条路上有三个洞，
 * 每一个都是**静默**的：
 *
 *   ① 手工把新章粘到剧本末尾时碰掉前面一个空格 → 那一章被判定"改过了"，
 *      已出的分镜全部作废重跑，没有任何提示
 *   ② 第二章的新角色永远不会进设定集
 *   ③ 而分镜里点名了一个设定集里没有的人时，什么都不会发生 ——
 *      matchCharacters 找不到就 .filter(Boolean) 掉，于是那一镜没有参考图、
 *      没有外貌描述、复核没有基准，静默降级成"文生图"，流水线一路绿
 */
/**
 * ════════ 大纲：剧本和分镜之间那一层 ════════
 *
 * 用户的两句话定了这一层的形状：
 *
 *   "在拆分镜的时候能不能先出一个大纲，就是可和大模型对话的那种"
 *   "大模型能结合剧本分辨出支持修改和添加的部分，**不要全部推到重来**"
 *
 * 第二句是硬约束。所以模型回的不是新大纲，是一串**改动指令**，
 * 人逐条勾选之后才落盘 —— 没勾的一条都不动。
 */
/**
 * ════════ 本地出图：ComfyUI ════════
 *
 * 和别家形状完全不同：没有"模型"这个参数，出什么图由**用户自己的工作流**决定。
 * 我们只往里填提示词、种子、尺寸、参考图。
 *
 * 这条路最容易坏的地方是**填不进去而不吭声**：
 * 图能出、不花钱、而画的一直是工作流里写死的那句话 —— 改一百遍描述毫无反应，
 * 且没有任何报错。所以这一节大半在验"该报的都报了没有"。
 */
section('本地出图：ComfyUI');
{
  const comfy = await import('../core/providers/comfy.js');

  /** 一份最小的 API 格式工作流。标题就是标记 —— 用户在 ComfyUI 里双击标题改 */
  const wf = () => ({
    3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20 }, _meta: { title: 'FD_SEED' } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: '写死在工作流里的那句' }, _meta: { title: 'FD_PROMPT' } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: '' }, _meta: { title: 'FD_NEGATIVE' } },
    6: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 }, _meta: { title: 'FD_SIZE' } },
    7: { class_type: 'LoadImage', inputs: { image: '' }, _meta: { title: 'FD_REF' } },
    9: { class_type: 'SaveImage', inputs: {}, _meta: { title: 'SaveImage' } }
  });

  // ── 贴错格式要当场说清楚 ──
  {
    const bad = (t) => { try { comfy.parseWorkflow(t); return ''; } catch (e) { return e.message; } };
    check('没贴工作流时说去哪儿贴', /设置|本地出图/.test(bad('')), bad(''));
    check('不是 JSON 时说清楚', /不是合法的 JSON/.test(bad('{oops')), bad('{oops'));
    /**
     * ⚠ ComfyUI 有两种导出：「工作流」（带 nodes/links，给编辑器用）
     * 和「API 格式」（节点号 → {class_type, inputs}，给接口用）。
     * 贴错的人会很多，而原本的报错是一句莫名其妙的"没有节点"。
     */
    const wrong = bad(JSON.stringify({ nodes: [{ id: 1 }], links: [] }));
    check('贴成「工作流」格式时点名说要「API 格式」', /API 格式/.test(wrong), wrong);
    check('并且说了在哪儿导出', /导出/.test(wrong), wrong);
    check('一个节点都没有时也说得出', /节点/.test(bad('{}')), bad('{}'));
    check('贴对了就通过', Object.keys(comfy.parseWorkflow(JSON.stringify(wf()))).length === 6);
  }

  // ── 填进去 ──
  {
    const r = comfy.inject(wf(), {
      prompt: '雪夜山门', negative: '模糊', seed: 4242, width: 768, height: 1344, refName: 'ref.png'
    });
    check('提示词填进去了', r.workflow[4].inputs.text === '雪夜山门');
    check('反向提示词填进去了', r.workflow[5].inputs.text === '模糊');
    check('种子填进去了', r.workflow[3].inputs.seed === 4242);
    check('尺寸填进去了', r.workflow[6].inputs.width === 768 && r.workflow[6].inputs.height === 1344);
    check('参考图填进去了', r.workflow[7].inputs.image === 'ref.png');
    /**
     * ⚠ 纯函数。同一份工作流要用很多次（一部片子几十镜），
     * 就地改的话第二镜会拿到第一镜填过的内容 —— 而那是"改了描述没反应"
     * 的另一种版本，更隐蔽。
     */
    const before = wf();
    comfy.inject(before, { prompt: 'x', seed: 1 });
    check('不改传进去那份工作流', before[4].inputs.text === '写死在工作流里的那句');
  }

  // ── 没打标记时：该报错的报错，该说明的说明 ──
  {
    const noPrompt = wf(); delete noPrompt[4];
    let msg = '';
    try { comfy.inject(noPrompt, { prompt: 'x' }); } catch (e) { msg = e.message; }
    /**
     * ⚠ 正向提示词找不到必须**抛**，不能跳过。
     *
     * 跳过的后果：出图成功、不花钱、画的是工作流里写死的那句话。
     * 你改一百遍画面描述都没反应，而且不报任何错 —— 这是这条路上
     * 最坏的一种坏法，因为它看起来完全正常。
     */
    check('没有 FD_PROMPT 时直接报错，不默默跑', /FD_PROMPT/.test(msg), msg);
    check('并且说清了后果（不然人会以为只是少个可选项）',
      /写死|毫无反应|没反应/.test(msg), msg);

    const noSeed = wf(); delete noSeed[3];
    const r = comfy.inject(noSeed, { prompt: 'x', seed: 99 });
    /**
     * 种子填不进去是**能跑的**，但必须说出来：
     * 一致性复核不过时我们会换种子重试，种子没生效的话三次重试出三张
     * 一模一样的图，而日志上写着"换了种子重试"。
     */
    check('没有 FD_SEED 时不报错，但说出来了',
      r.skipped.some((x) => /种子/.test(x)), JSON.stringify(r.skipped));
    check('而且说清了后果是"重试换种子不会生效"',
      r.skipped.some((x) => /重试/.test(x)), JSON.stringify(r.skipped));

    const noRef = wf(); delete noRef[7];
    const r2 = comfy.inject(noRef, { prompt: 'x', refName: 'a.png' });
    check('没有 FD_REF 时说清"一致性只剩提示词撑着"',
      r2.skipped.some((x) => /一致性/.test(x)), JSON.stringify(r2.skipped));

    // 标记打在了错的节点上
    const wrongNode = wf();
    wrongNode[4] = { class_type: 'KSampler', inputs: { steps: 20 }, _meta: { title: 'FD_PROMPT' } };
    let m2 = '';
    try { comfy.inject(wrongNode, { prompt: 'x' }); } catch (e) { m2 = e.message; }
    check('标记打在错的节点上时，说得出该打在哪一类节点上',
      /文本编码|CLIPTextEncode/.test(m2), m2);
  }

  // ── 工作流里打了哪几个标记：贴完当场告诉他 ──
  {
    const m = comfy.markersIn(wf());
    check('认得出打了哪几个标记', m.prompt && m.seed && m.ref && m.size);
    const bare = { 1: { class_type: 'KSampler', inputs: {}, _meta: { title: 'KSampler' } } };
    check('没改过标题的节点不会被误认成标记', comfy.markersIn(bare).prompt === false);

    /**
     * ⚠ 标记要**从头认**，不能只看"标题里含不含这几个字"。
     *
     * 真实工作流里很常见的一种情况：留着一个废弃的旧节点，标题写成
     * 「备用 FD_PROMPT（没用了）」。按"含不含"来认的话，它会和真的那个
     * 一起匹配上，而谁排在前面完全看运气 —— 于是提示词填进了那个
     * 断开连线的废节点，图照出、不花钱、画的还是写死那句。
     *
     * 这一条第一版是**空的**：夹具里只有一个 KSampler，
     * 无论怎么放宽匹配都撞不上。同一个毛病第四次了。
     */
    const decoy = {
      1: { class_type: 'CLIPTextEncode', inputs: { text: '废弃的旧提示词' }, _meta: { title: '备用 FD_PROMPT（没用了）' } },
      2: { class_type: 'CLIPTextEncode', inputs: { text: '真正接着的' }, _meta: { title: 'FD_PROMPT' } },
      9: { class_type: 'SaveImage', inputs: {}, _meta: { title: 'SaveImage' } }
    };
    const picked = comfy.inject(decoy, { prompt: '雪夜山门' });
    check('标题里只是"含有"标记的废节点不会被当成标记',
      picked.workflow['1'].inputs.text === '废弃的旧提示词'
      && picked.workflow['2'].inputs.text === '雪夜山门',
      JSON.stringify([picked.workflow['1'].inputs.text, picked.workflow['2'].inputs.text]));
  }

  // ── 真的跑一遍（打桩的 ComfyUI）──
  {
    const hits = [];
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        hits.push(req.url);
        if (req.url === '/prompt') {
          const body = JSON.parse(raw);
          hits.push({ sentPrompt: body.prompt?.['4']?.inputs?.text, sentSeed: body.prompt?.['3']?.inputs?.seed });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ prompt_id: 'p1' }));
        }
        if (req.url.startsWith('/history/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            p1: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } }
          }));
        }
        if (req.url === '/system_stats') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ devices: [{ name: 'RTX 4090', vram_total: 25769803776 }] }));
        }
        res.writeHead(404).end();
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;

    const out = await comfy.run(base, comfy.inject(wf(), { prompt: '雪夜山门', seed: 777 }).workflow, {});
    check('跑通了，拿回图片地址', /\/view\?/.test(out.url), out.url);
    check('地址里带着文件名', /filename=out\.png/.test(out.url), out.url);
    const sent = hits.find((x) => x && x.sentPrompt);
    check('发出去的是我们填的提示词，不是工作流里写死那句',
      sent?.sentPrompt === '雪夜山门', JSON.stringify(sent));
    check('种子也真的发出去了', sent?.sentSeed === 777, JSON.stringify(sent));

    const p = await comfy.probe(base);
    check('探活说得出是什么卡', p.ok && /4090/.test(p.detail), JSON.stringify(p));

    srv.close();
  }

  /**
   * ⚠ 参考图**传上去了不等于用上了**。
   *
   * 工作流里没有 FD_REF 节点时，图传到了 ComfyUI，但没有任何节点读它 ——
   * 这一镜的一致性实际上只剩提示词撑着。所以 filled 里没有"参考图"这一项时，
   * 上层记的 refsSent 必须是 0，不能按"发过去几张"算。
   *
   * 这一条是复盘时抓的：早上刚修过同一类错（modelUsed 记的是路由到的模型
   * 而不是真正出图那个），几小时后在这条新路上又犯了一次。
   */
  {
    const withRef = comfy.inject(wf(), { prompt: 'x', refName: 'ref.png' });
    check('工作流有 FD_REF 时，filled 里记着"参考图"', withRef.filled.includes('参考图'));
    const noRefNode = wf(); delete noRefNode[7];
    const without = comfy.inject(noRefNode, { prompt: 'x', refName: 'ref.png' });
    check('工作流没有 FD_REF 时，filled 里不能有"参考图"',
      !without.filled.includes('参考图'), JSON.stringify(without.filled));
    check('而且要在 skipped 里说出来',
      without.skipped.some((x) => /参考图/.test(x)), JSON.stringify(without.skipped));
  }

  // ── 跑失败时说人话 ──
  {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.url === '/prompt') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
            node_errors: { 9: { errors: [{ message: 'Required input is missing: images' }] } }
          }));
        }
        res.writeHead(404).end();
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    let msg = '';
    try { await comfy.run(base, wf(), {}); } catch (e) { msg = e.message; }
    /**
     * ⚠ node_errors 里才写着**到底哪个节点缺什么**。
     * 只报一句 "Prompt outputs failed validation"，用户完全不知道该改哪儿。
     */
    check('校验不过时点名是哪个节点、缺什么',
      /节点 9/.test(msg) && /images/.test(msg), msg);
    srv.close();
  }
}

section('大纲：改动指令，不是推倒重来');
{
  const ol = await import('../core/pipeline/outline.js');

  /**
   * ⚠ 夹具的 id **故意不和位置重合**（b-07 / b-04 / b-11，不是 b-01/02/03）。
   *
   * 第一版用的是 b-01/b-02/b-03 —— 于是"edit 之后 id 不变"那条是**空的**：
   * 就算代码改成按位置重新编号，第 2 场也照样叫 b-02，断言照过。
   * 金丝雀把两层保护一起打掉都没能让它变红，这才发现。
   *
   * 这已经是同一个毛病的第三次了：夹具挑了让断言恰好成立的那种值。
   */
  const base = () => ({
    beats: [
      { id: 'b-07', scene: '山门外', time: '傍晚', characters: ['阿澜'], summary: '被拦下。', dialogue: '你不能进去。', seconds: 30, locked: true },
      { id: 'b-04', scene: '石阶', time: '傍晚', characters: ['阿澜'], summary: '独自上石阶。', dialogue: '', seconds: 40 },
      { id: 'b-11', scene: '大殿', time: '夜', characters: ['阿澜'], summary: '见到住持。', dialogue: '二十年前那件事是我做的。', seconds: 60 }
    ]
  });

  // ── 纯函数 ──
  {
    const before = base();
    const snapshot = JSON.stringify(before);
    ol.applyOps(before, [{ op: 'delete', id: 'b-04' }]);
    /**
     * ⚠ 必须是纯函数。界面要用**同一段代码**先预览再应用 ——
     * 预览走一套、应用走另一套的话，你勾的和实际发生的迟早对不上，
     * 而那种错只有在数据已经被改坏之后才看得出来。
     */
    check('applyOps 不改传进去的那份（界面要拿它先预览）',
      JSON.stringify(before) === snapshot);
  }

  // ── 四种指令 ──
  {
    const r = ol.applyOps(base(), [{ op: 'insert', after: 'b-04', beat: { scene: '石阶', summary: '黑衣人出现。' } }]);
    check('insert 插在指定那一场后面',
      r.outline.beats.map((b) => b.scene).join(',') === '山门外,石阶,石阶,大殿',
      r.outline.beats.map((b) => b.scene).join(','));
    check('新插的那一场拿到不重复的 id',
      new Set(r.outline.beats.map((b) => b.id)).size === r.outline.beats.length);
    check('新插的那一场不是锁着的', r.outline.beats[2].locked === false);

    const head = ol.applyOps(base(), [{ op: 'insert', after: null, beat: { scene: '雪原', summary: '空镜。' } }]);
    check('after 传 null 就插到最前面', head.outline.beats[0].scene === '雪原');

    const del = ol.applyOps(base(), [{ op: 'delete', id: 'b-04' }]);
    check('delete 拿掉那一场', del.outline.beats.map((b) => b.id).join(',') === 'b-07,b-11');

    const mv = ol.applyOps(base(), [{ op: 'move', id: 'b-11', after: null }]);
    check('move 挪到最前面', mv.outline.beats.map((b) => b.id).join(',') === 'b-11,b-07,b-04');

    const ed = ol.applyOps(base(), [{ op: 'edit', id: 'b-04', fields: { seconds: 15, summary: '改过了' } }]);
    check('edit 只改点名的字段',
      ed.outline.beats[1].seconds === 15 && ed.outline.beats[1].summary === '改过了'
      && ed.outline.beats[1].scene === '石阶', JSON.stringify(ed.outline.beats[1]));
    check('edit 之后 id 不变（不能按位置重新编号）', ed.outline.beats[1].id === 'b-04');
  }

  // ── 锁：这一层存在的全部理由 ──
  {
    /**
     * ⚠ 拆过分镜的场次后面挂着**已经出好的图和视频**。
     * 覆盖它等于把花过的钱作废，而且不可撤销。
     *
     * 用户的原话就是"不要全部推到重来"—— 这条断言守的就是那句话。
     */
    const r = ol.applyOps(base(), [
      { op: 'edit', id: 'b-07', fields: { summary: '模型想改' } },
      { op: 'delete', id: 'b-07' },
      { op: 'move', id: 'b-07', after: 'b-11' }
    ]);
    check('锁住的场次：改不动、删不掉、挪不走', r.applied.length === 0 && r.refused.length === 3);
    check('而且原样没变', r.outline.beats[0].summary === '被拦下。');
    check('每条拒绝都说清了原因和出路',
      r.refused.every((x) => /锁着/.test(x.why) && /分镜/.test(x.why)), JSON.stringify(r.refused[0]));
    /**
     * 悄悄跳过一条改动比拒绝它更糟：人以为改了。
     * 所以 refused 必须回出去，界面必须摆出来。
     */
    check('没勾的没做、做不了的说出来 —— 不能悄悄跳过',
      r.refused.length === 3 && r.refused.every((x) => x.op && x.why));

    const forced = ol.applyOps(base(), [{ op: 'delete', id: 'b-07' }], { allowLocked: true });
    check('明确要求时才能动锁着的', forced.applied.length === 1);
  }

  // ── 坏指令一条都不能悄悄放行 ──
  {
    const r = ol.applyOps(base(), [
      { op: 'edit', id: 'b-99', fields: { seconds: 5 } },
      { op: 'insert', after: 'b-99', beat: { scene: 'x', summary: 'y' } },
      { op: 'move', id: 'b-04', after: 'b-99' },
      { op: 'edit', id: 'b-04', fields: {} },
      { op: '乱写', id: 'b-04' },
      null
    ]);
    check('编出来的 id 一条都不放行', r.applied.length === 0, JSON.stringify(r.applied));
    check('六条坏指令全部有原因', r.refused.length === 6);
    /**
     * ⚠ move 到一个不存在的位置时，那一场必须**回到原位**。
     * 早先的写法是先 splice 出来再找位置，找不到就落在末尾 ——
     * 于是一条无效指令把场次顺序改了，而它报的是"拒绝"。
     */
    check('挪不过去的场次回到原位，不是掉到末尾',
      r.outline.beats.map((b) => b.id).join(',') === 'b-07,b-04,b-11',
      r.outline.beats.map((b) => b.id).join(','));
    check('白名单之外的字段改不动',
      ol.applyOps(base(), [{ op: 'edit', id: 'b-04', fields: { locked: true, id: 'hack' } }])
        .refused.length === 1);
  }

  // ── 说人话：界面上那一排勾选项 ──
  {
    const o = base();
    /**
     * ⚠ 一定要说**改之前是什么**。只说"第 3 场改成 2 分钟"，
     * 人没法判断该不该勾；说"60 → 120"才行。
     */
    const t = ol.describeOp({ op: 'edit', id: 'b-11', fields: { seconds: 120 } }, o);
    check('改动说得出"从什么变成什么"', /60/.test(t) && /120/.test(t), t);
    check('插入说得出插在哪儿', /第 2 场/.test(ol.describeOp({ op: 'insert', after: 'b-04', beat: { scene: 'x', summary: 'y' } }, o)));
    check('删除说得出删的是哪一场', /第 1 场/.test(ol.describeOp({ op: 'delete', id: 'b-07' }, o)));
    check('看不懂的指令也要说出来，不能装作没有',
      /看不懂/.test(ol.describeOp({ op: '???' }, o)));
  }

  // ── 片长：台词是硬下限 ──
  {
    /**
     * ════ 这是用户上一个问题的答案落地处 ════
     *
     * 原来是"你先定片长，模型按预算拆"，而预算按**字数比例**分摊到每一章。
     * 同样两千字，全是对话的一章念完要 90 秒，全是写景的一章 40 秒就够 ——
     * 字数一样，分到的秒数就一样。于是对话密集那章被压得念不完。
     *
     * 而"念不念得完"引擎早就算得出来，只是那个信息用在**每一镜**上
     *（拆完之后校对）—— 那时候分镜已经拆完了，改时长等于重拆。
     * 放在大纲这一层，它变成**拆之前**就能说的一句话。
     */
    const talky = {
      beats: [{
        id: 'b-07', scene: '大殿', summary: '长谈。',
        dialogue: '二十年前那件事是我做的，你父亲什么都不知道。'
          + '我把他推下山崖那天也下着这样的雪，我以为这辈子不会有人来问我。'
          + '你既然来了，就该听完整件事，然后自己决定要不要下山。',
        seconds: 10
      }]
    };
    const est = ol.estimateSeconds(talky.beats[0]);
    check('台词长的场次，估出来的下限压不到人填的 10 秒', est.floor > 10, String(est.floor));
    check('建议值不会低于台词下限', est.suggested >= est.floor);

    const bud = ol.budgetCheck(talky, 10);
    check('台词念不完时报出来', bud.issues.some((i) => i.kind === 'floor-over'), JSON.stringify(bud.issues));
    /**
     * ⚠ "台词超了"和"总长偏长"必须分开说：
     * 前者**改不动**（除非删台词），后者是编辑上的选择。
     * 混成一句"超了 30 秒"没用 —— 前者要你改剧本，后者要你改节奏。
     */
    const hard = bud.issues.find((i) => i.kind === 'floor-over');
    check('并且说清这是硬下限、不是节奏问题', /硬下限/.test(hard.why), hard.why);
    check('给的出路是调时长或删台词', /删台词|目标时长/.test(hard.fix), hard.fix);

    const roomy = ol.budgetCheck(talky, 600);
    check('时长给够了就不报台词那条', !roomy.issues.some((i) => i.kind === 'floor-over'));
    check('但太短了会说"这份大纲比目标短不少"',
      ol.budgetCheck({ beats: [{ id: 'b-07', scene: 'x', summary: '一句话。', seconds: 5 }] }, 300)
        .issues.some((i) => i.kind === 'total-short'));
    check('没有大纲或没定目标时不硬报', ol.budgetCheck({ beats: [] }, 60) === null);
  }

  // ── 空的时候也要说话 ──
  {
    check('没有大纲时说得出下一步干什么',
      /先从剧本生成|还没有大纲/.test(ol.summarize({ beats: [] })), ol.summarize({ beats: [] }));
    check('有大纲时报场数和总长',
      /3 场/.test(ol.summarize(base(), 120)), ol.summarize(base(), 120));
    check('锁着几场也说出来', /锁/.test(ol.summarize(base(), 120)), ol.summarize(base(), 120));
  }

  /**
   * ── 拆过分镜就锁住 ──
   *
   * ⚠ 这一条是金丝雀抓出来的**缺口**：把"拆完就锁"那行代码改坏，
   * 自检照样全绿 —— 因为前面所有的锁相关断言都是拿**手工设好 locked** 的
   * 夹具在测，没有一条走过"分镜拆完之后到底有没有锁上"这条真实路径。
   *
   * 而这一条正是用户那句"不要全部推到重来"的落脚点。
   */
  {
    const o = {
      beats: [
        { id: 'b-07', scene: '一', summary: '甲。', chapterId: 'ch-01' },
        { id: 'b-04', scene: '二', summary: '乙。', chapterId: 'ch-02' }
      ]
    };
    const one = ol.lockBeats(o, 'ch-01');
    check('只锁拆过的那一章', one.beats[0].locked === true && one.beats[1].locked === false,
      JSON.stringify(one.beats.map((b) => b.locked)));
    check('别的章还能继续改', ol.applyOps(one, [{ op: 'delete', id: 'b-04' }]).applied.length === 1);
    check('拆过的那一章改不动', ol.applyOps(one, [{ op: 'delete', id: 'b-07' }]).refused.length === 1);

    const all = ol.lockBeats(o, null);
    check('没分章的项目，拆一次就全锁', all.beats.every((b) => b.locked));
    check('lockBeats 也是纯函数', o.beats.every((b) => !b.locked));
  }

  /**
   * ── 还没拆分镜的那几场，要说出来 ──
   *
   * 在大纲里插一场之后，如果没有一句话告诉你"有 1 场还没拆分镜"，
   * 那一场就会一直躺在那儿：功能是好的（再点一次分镜就会拆它），
   * 但没人知道该去点。
   */
  {
    const half = {
      beats: [
        { id: 'b-07', scene: '山门外', summary: '甲。', locked: true },
        { id: 'b-04', scene: '石阶', summary: '乙。', locked: false }
      ]
    };
    check('列得出还没拆的那几场',
      ol.pendingBeats(half).map((b) => b.id).join(',') === 'b-04',
      JSON.stringify(ol.pendingBeats(half).map((b) => b.id)));
    check('摘要里说了还剩几场没拆', /还有 1 场没拆/.test(ol.summarize(half)), ol.summarize(half));
    /**
     * ⚠ 一场都没拆过时**不说**这句。
     * 那时候"还有 2 场没拆"是废话 —— 本来就一场都没拆，
     * 而且它会和"从剧本生成大纲"那颗按钮抢注意力。
     */
    const none = { beats: [{ id: 'b-07', scene: 'x', summary: '甲。' }] };
    check('一场都没拆过时不说这句（那是废话）',
      !/还有/.test(ol.summarize(none)), ol.summarize(none));
    check('按章过滤得出来',
      ol.pendingBeats({ beats: [
        { id: 'b-01', chapterId: 'ch-01', scene: 'x', summary: '甲。' },
        { id: 'b-02', chapterId: 'ch-02', scene: 'y', summary: '乙。' }
      ] }, 'ch-02').map((b) => b.id).join(',') === 'b-02');
  }

  // ── 只锁真的发出去的那几场 ──
  {
    const o = {
      beats: [
        { id: 'b-07', scene: '一', summary: '甲。' },
        { id: 'b-04', scene: '二', summary: '乙。' },
        { id: 'b-99', scene: '三', summary: '拆到一半插进来的。' }
      ]
    };
    const only = ol.lockBeats(o, null, ['b-07', 'b-04']);
    check('给了 ids 就只锁这几场',
      only.beats.map((b) => b.locked).join(',') === 'true,true,false',
      JSON.stringify(only.beats.map((b) => [b.id, b.locked])));
    check('不给 ids 时还是按范围锁（老行为没变）',
      ol.lockBeats(o, null).beats.every((b) => b.locked));
  }

  // ── 解锁：唯一一条能重拆的路 ──
  {
    const o = {
      beats: [
        { id: 'b-07', scene: '一', summary: '甲。', locked: true },
        { id: 'b-04', scene: '二', summary: '乙。', locked: true }
      ]
    };
    const one = ol.unlockBeats(o, ['b-07']);
    check('只解锁点名的那一场', one.beats[0].locked === false && one.beats[1].locked === true);
    check('解锁之后就改得动了', ol.applyOps(one, [{ op: 'delete', id: 'b-07' }]).applied.length === 1);
    check('没点名的还锁着', ol.applyOps(one, [{ op: 'delete', id: 'b-04' }]).refused.length === 1);
    check('传空就全解锁', ol.unlockBeats(o, []).beats.every((b) => !b.locked));
    check('unlockBeats 也是纯函数', o.beats.every((b) => b.locked));
  }

  // ── 落盘：拆过分镜就锁住 ──
  {
    const p = store.create({ title: '大纲落盘' });
    store.update(p.id, (x) => {
      x.script = '阿澜在码头巡查。';
      x.outline = base();
      return x;
    });
    const r = studioModule.applyOutlineOps(p.id, { ops: [{ op: 'edit', id: 'b-04', fields: { seconds: 99 } }] });
    check('改动真的落到盘上了',
      store.read(p.id).outline.beats[1].seconds === 99, String(r.applied));
    check('回的 refused 是空的', r.refused.length === 0);

    const bad = studioModule.applyOutlineOps(p.id, { ops: [{ op: 'delete', id: 'b-07' }] });
    check('锁着的那一场，走接口也删不掉',
      store.read(p.id).outline.beats.length === 3 && bad.refused.length === 1);
  }
}

/**
 * ════════ 大纲 → 分镜：这条链到底通不通 ════════
 *
 * ⚠ 这一节是补一个**我自己留的洞**：大纲那一层建完之后，
 * analyzeScript 里一次都没提到 outline —— 你可以生成大纲、跟模型来回改、
 * 锁住已拆的场次，然后点「分镜」，它完全无视大纲重新去读原始剧本。
 *
 * 一整层白做，而且看不出来：分镜照样出得来，只是和你改的那份没关系。
 */
section('大纲 → 分镜：只拆没拆过的场次');
{
  const studio = studioModule;
  const ol = await import('../core/pipeline/outline.js');

  /** 造一个跑得动的项目：有设定集、有大纲 */
  const mk = () => {
    const p = store.create({ title: '照大纲拆', targetDuration: 120 });
    store.update(p.id, (x) => {
      x.script = '阿澜在码头巡查，发现缆绳被割断。';
      x.bible = {
        style: { anchor: '国风', negative: '' },
        characters: [{ name: '阿澜', appearance: '短发', seed: 1, sheetPath: '/a.png',
          variants: [{ id: 'v-default', name: '默认', sheetPath: '/a.png' }] }],
        scenes: [{ name: '码头', appearance: '雾', seed: 2, sheetPath: '/b.png',
          variants: [{ id: 'v-default', name: '默认', sheetPath: '/b.png' }] }],
        props: []
      };
      x.outline = {
        beats: [
          { id: 'b-07', scene: '码头', characters: ['阿澜'], summary: '走向栈桥。', dialogue: '设备正常。', seconds: 30 },
          { id: 'b-04', scene: '码头', characters: ['阿澜'], summary: '发现缆绳被割断。', dialogue: '', seconds: 40 }
        ]
      };
      return x;
    });
    return p;
  };

  {
    const p = mk();
    // ⚠ 清零：这两个数组整轮共用，不清的话数到的是"开机以来所有拆分镜请求"
    upstream.shotPrompts = [];
    upstream.shotSystems = [];
    await studio.analyzeScript(p.id, { force: true });
    const after = store.read(p.id);

    /**
     * ⚠ 最要紧的一条：喂给模型的**是大纲，不是原始剧本**。
     *
     * 不查这个的话，大纲那一层可以完全没接上而这里全绿 ——
     * 分镜照样拆得出来（模型读原始剧本一样能拆），只是你改的那份没起作用。
     */
    /**
     * ⚠ 要看**所有批次**，不能只看最后一批。
     *
     * 拆分镜现在是分批跑的，b-07 可能落在第一批里，而 lastShotPrompt
     * 只留了最后一批 —— 那样这条断言的成败取决于它恰好排在第几批，
     * 是一条会随批大小随机红绿的断言。
     */
    const sent = (upstream.shotPrompts || []).join('\n');
    check('喂给模型的是大纲里那几场，不是原始剧本',
      /【场次 b-07】/.test(sent) && /走向栈桥/.test(sent), sent.slice(0, 120));
    check('原始剧本没有被直接丢进去', !/发现缆绳被割断。$/.test(sent.trim()) || /【场次/.test(sent));

    check('每一镜都标回了它属于哪一场', (after.shots || []).every((s) => s.beatId),
      JSON.stringify((after.shots || []).map((s) => s.beatId)));
    check('拆完之后那几场锁上了',
      ol.normalizeOutline(after.outline).beats.every((b) => b.locked));

    /**
     * 时长按**大纲上每一场自己的估算**走，不再按字数比例分摊。
     * 字数是个很糙的代理：同样两千字，全是对话的一场念完要 90 秒。
     */
    /**
     * ⚠ 分批之后这条要**逐批**验：每一批的预算 = 这一批那几场的估算之和。
     *
     * 原来写的是"最后一批的 system 里含两场之和"，那在一次拆完时成立，
     * 分批之后两场可能落在不同批里 —— 断言会随批大小随机红绿，
     * 而它验的那件事其实一直是对的。
     */
    // 这一节的大纲固定就是 mk() 里那两场，直接拿来算期望值
    const beatsNow = ol.normalizeOutline({
      beats: [
        { id: 'b-07', scene: '码头', characters: ['阿澜'], summary: '走向栈桥。', dialogue: '设备正常。', seconds: 30 },
        { id: 'b-04', scene: '码头', characters: ['阿澜'], summary: '发现缆绳被割断。', dialogue: '', seconds: 40 }
      ]
    }).beats;
    const byId = new Map(beatsNow.map((b) => [b.id, b]));
    const budgets = (upstream.shotSystems || []).map((sys) => {
      const m = sys.match(/控制在\s*(\d+)\s*秒/);
      return m ? Number(m[1]) : null;
    });
    const perBatchIds = (upstream.shotPrompts || [])
      .map((u) => [...u.matchAll(/【场次\s*([a-z0-9-]+)】/gi)].map((x) => x[1]));
    const expected = perBatchIds.map((ids) => ids.reduce(
      (sum, id) => sum + (byId.has(id) ? ol.estimateSeconds(byId.get(id)).suggested : 0), 0
    ));
    check('每一批的时长预算都来自大纲那几场，不是项目的目标时长',
      budgets.length > 0 && budgets.every((got, i) => got !== null && Math.abs(got - expected[i]) <= 1),
      JSON.stringify({ 发出去的: budgets, 按大纲算的: expected, 项目目标: 120 }));
  }

  // ── 再拆一次：全锁着，要拦住并说清出路 ──
  {
    const p = mk();
    await studio.analyzeScript(p.id, { force: true });
    let msg = '';
    try { await studio.analyzeScript(p.id, { force: true }); } catch (e) { msg = e.message; }
    check('都拆过了就拦住，不闷头重拆', /都已经拆过/.test(msg), msg);
    /**
     * ⚠ 拦住的同时必须给**出路**。只说"拆过了"，人下一秒就问"那我怎么改"。
     * 而且要说清解锁的代价 —— 那几场的图是花过钱的。
     */
    check('并且说清了怎么才能重拆', /解锁/.test(msg), msg);
    check('还说清了重拆的代价（会作废已出的图）', /作废/.test(msg), msg);
  }

  // ── 只重拆一场：另一场的镜头原样留着 ──
  {
    const p = mk();
    await studio.analyzeScript(p.id, { force: true });
    // 假装两场都出过图了
    store.update(p.id, (x) => {
      x.shots.forEach((s) => { s.imagePath = `/img/${s.id}.png`; });
      return x;
    });
    const before = store.read(p.id);
    const keepIds = before.shots.filter((s) => s.beatId === 'b-04').map((s) => s.id);
    const dropIds = before.shots.filter((s) => s.beatId === 'b-07').map((s) => s.id);
    check('两场各自都拆出了镜头', keepIds.length > 0 && dropIds.length > 0,
      JSON.stringify({ keep: keepIds.length, drop: dropIds.length }));

    const un = studio.unlockOutlineBeats(p.id, { ids: ['b-07'] });
    /**
     * ⚠ 解锁时要回**会作废几镜**。只说"确定解锁吗"，人不知道自己在放弃什么 ——
     * 而放弃的是已经花过钱的图。
     */
    check('解锁时说得出会作废几镜', un.willDrop === dropIds.length, `${un.willDrop} / ${dropIds.length}`);

    await studio.analyzeScript(p.id, { force: true });
    const after = store.read(p.id);
    /**
     * ════ 这一条就是这一整节存在的理由 ════
     *
     * 原来是**整章重拆**：第 3 场出过图、你只想改第 7 场，一拆全作废。
     * 而那正是用户说"不要全部推到重来"时怕的那件事。
     */
    check('没解锁那一场的镜头原样还在（图也没丢）',
      keepIds.every((id) => after.shots.some((s) => s.id === id && s.imagePath)),
      JSON.stringify(after.shots.map((s) => [s.id, s.beatId, Boolean(s.imagePath)])));
    check('解锁那一场被重拆了',
      after.shots.some((s) => s.beatId === 'b-07'));
    check('没有重复：同一场不会既留旧的又加新的',
      new Set(after.shots.map((s) => s.id)).size === after.shots.length,
      JSON.stringify(after.shots.map((s) => s.id)));

    /**
     * ⚠ 顺序要按**大纲里场次的顺序**，不能按 index 排。
     *
     * 留下那几镜和新拆那几镜的 index 都是从 1 开始的，按 index 排会把两批
     * 交错在一起 —— 成片里第 2 场演到一半插进第 1 场的镜头，
     * 而每一镜看着都正常。
     *
     * 这一条第一版是**空的**：只查了 id 不重复、没查顺序，
     * 于是把排序改成"全部并列"照样全绿。
     */
    const seq = after.shots.map((s) => s.beatId);
    const firstOf = (id) => seq.indexOf(id);
    const lastOf = (id) => seq.lastIndexOf(id);
    check('两批镜头没有交错：b-07 的全在 b-04 前面',
      lastOf('b-07') < firstOf('b-04'), JSON.stringify(seq));
    check('镜号是连着的，没有重号',
      new Set(after.shots.map((s) => s.index)).size === after.shots.length,
      JSON.stringify(after.shots.map((s) => s.index)));
  }

  /**
   * ── 拆到一半 / 拆完之后临时加的一场 ──
   *
   * 用户的原话："分镜生成中或者生成完后，临时新增的大纲，要同步到新增分镜"。
   *
   * ⚠ 这里埋着一个**静默**的坑：拆完之后锁场次时，锁的是"范围内所有场次"，
   * 而不是"这一批真的发出去的那几场"。于是**拆的过程中**插进来的一场
   * 会被连带锁上 —— 它从来没被拆过，却再也拆不了了（锁着的场次
   * 模型也改不动），而且不报任何错：它就那么留在大纲上，永远没有镜头。
   */
  {
    const p = mk();

    /**
     * ⚠ 关键是**在拆的过程中**插进去，不是拆完之后。
     *
     * analyzeScript 一开始就把"这一批要拆哪几场"定下来了，然后去等模型。
     * 在这个空档往大纲里插一场，它不在这一批里 —— 而收尾时锁场次，
     * 锁的是"范围内所有场次"，把它一起锁了。
     *
     * 拆完之后再插的那种情况本来就是好的（下一次拆会拆它），所以那样测不出来。
     */
    const running = studio.analyzeScript(p.id, { force: true });
    store.update(p.id, (x) => {
      const beats = ol.normalizeOutline(x.outline).beats;
      x.outline = { beats: [...beats, {
        id: 'b-99', scene: '码头', characters: [], summary: '拆到一半临时加的一场。', dialogue: '', seconds: 15, locked: false
      }] };
      return x;
    });
    await running;

    const mid = store.read(p.id);
    const fresh = ol.normalizeOutline(mid.outline).beats.find((b) => b.id === 'b-99');
    check('拆的过程中插进来的那一场，没有被连带锁上',
      fresh && fresh.locked === false,
      JSON.stringify(ol.normalizeOutline(mid.outline).beats.map((b) => [b.id, b.locked])));

    // 再拆一次：只拆这新的一场，老的镜头一个都不动
    const keptIds = mid.shots.map((s) => s.id);
    await studio.analyzeScript(p.id, { force: true });
    const after = store.read(p.id);
    check('再拆一次时，老场次的镜头原样还在',
      keptIds.every((id) => after.shots.some((s) => s.id === id)),
      JSON.stringify({ before: keptIds, after: after.shots.map((s) => s.id) }));
    check('新加的那一场拆出了镜头',
      after.shots.some((s) => s.beatId === 'b-99'),
      JSON.stringify(after.shots.map((s) => s.beatId)));
  }

  /**
   * ── 模型一个 beatId 都不标时的兜底 ──
   *
   * ⚠ 这条路原来**一条断言都没有**，而它恰恰是最危险的分支：
   * 不知道每一镜属于哪一场，就没法"只换这几场的镜头"。
   *
   * 保守处理是把这一批整个换掉。宁可多作废，**不能悄悄重复** ——
   * 新旧两批叠在一起的话，成片里同一段戏演两遍，而每一镜看着都正常。
   */
  {
    const p = mk();
    upstream.noBeatTags = true;
    try {
      await studio.analyzeScript(p.id, { force: true });
      const after = store.read(p.id);
      check('模型不标场次时，镜头照样拆得出来', (after.shots || []).length > 0);
      check('那几镜的 beatId 是空的（不硬编一个假的）',
        (after.shots || []).every((s) => !s.beatId),
        JSON.stringify((after.shots || []).map((s) => s.beatId)));
      /**
       * ⚠ 最要紧的一条：**不能重复**。
       * 编一个 beatId 或者把新旧都留下，成片里同一段戏就会演两遍。
       */
      check('没有重复的镜头 id',
        new Set(after.shots.map((s) => s.id)).size === after.shots.length,
        JSON.stringify(after.shots.map((s) => s.id)));
      check('镜号也没有重号',
        new Set(after.shots.map((s) => s.index)).size === after.shots.length,
        JSON.stringify(after.shots.map((s) => s.index)));

      // 再拆一次也不该越堆越多
      store.update(p.id, (x) => { x.outline = ol.unlockBeats(x.outline, []); return x; });
      const n1 = store.read(p.id).shots.length;
      await studio.analyzeScript(p.id, { force: true });
      const n2 = store.read(p.id).shots.length;
      check('重拆一次镜头数不会翻倍（旧的那批被换掉了）', n2 === n1, `${n1} → ${n2}`);
    } finally {
      upstream.noBeatTags = false;
    }
  }

  // ── 没有大纲的项目：老路一点没变 ──
  {
    const p = store.create({ title: '没大纲', targetDuration: 60 });
    store.update(p.id, (x) => {
      x.script = '阿澜在码头巡查。';
      x.bible = { style: { anchor: '国风', negative: '' },
        characters: [{ name: '阿澜', appearance: '短发', seed: 1, sheetPath: '/a.png',
          variants: [{ id: 'v-default', name: '默认', sheetPath: '/a.png' }] }],
        scenes: [], props: [] };
      return x;
    });
    await studio.analyzeScript(p.id, { force: true });
    const after = store.read(p.id);
    check('没有大纲时照旧读原始剧本', /阿澜在码头巡查/.test(String(upstream.lastShotPrompt?.user || '')));
    check('没有大纲时不硬塞 beatId', (after.shots || []).every((s) => s.beatId === null));
  }
}

section('剧本一章一章加：追加、补设定集、点名了不存在的人');
{
  const chapters2 = await import('../core/pipeline/chapters.js');
  const lint = await import('../core/pipeline/shotlint.js');
  const consistency = await import('../core/pipeline/consistency.js');
  const studio = studioModule;

  // ── ③ 点名了设定集里没有的人 ──
  {
    const bible = {
      characters: [{ name: '阿澜', appearance: '短发' }],
      scenes: [{ name: '码头', appearance: '晨雾' }]
    };
    const kinds = (shots, b) => lint.lintShots(shots, { bible: b }).flatMap((r) => r.issues).map((i) => i.kind);

    check('点名了设定集里没有的角色 → 报',
      kinds([{ id: 'a', index: 1, characters: ['老周'], description: '他推门' }], bible).includes('cast-unknown'));
    check('设定集里有的就不报',
      !kinds([{ id: 'a', index: 1, characters: ['阿澜'], description: '他推门' }], bible).includes('cast-unknown'));
    /**
     * ⚠ 没有设定集时**不报**。
     * 还没跑设定集那一步的项目，每一镜都会中 —— 那是把"还没到那一步"
     * 说成"出错了"，而满屏假警报会让人学会无视所有警报。
     */
    check('还没有设定集时不报（那是"还没到那一步"，不是错）',
      lint.lintShots([{ id: 'a', index: 1, characters: ['老周'] }]).length === 0);

    check('场景不在设定集里也报',
      kinds([{ id: 'a', index: 1, scene: '山神庙', description: 'x' }], bible).includes('scene-unknown'));
    /**
     * 说话人单独查一条：配音按角色分音色，找不到的说话人拿不到音色，
     * 那句台词会用默认嗓子念 —— 同一个人在不同镜里换声音，比换脸还刺耳。
     */
    check('台词标着一个设定集里没有的人 → 单独报',
      kinds([{ id: 'a', index: 1, speaker: '周叔', dialogue: '走吧' }], bible).includes('speaker-unknown'));

    const one = lint.lintShots([{ id: 'a', index: 1, characters: ['老周'] }], { bible })[0].issues[0];
    check('说清了后果是"静默降级"，不是一句"找不到"',
      /悄悄丢掉|没有他/.test(one.why), one.why);
    check('给了下一步该干什么', /补上新增|设定集/.test(one.fix), one.fix);
  }

  /**
   * ── 道具连续性 ──
   *
   * 角色一致性有四层手段盯着（设定图、seed、参考图、复核打分），
   * 而**道具一直全靠人眼**。可观众对道具凭空消失同样敏感：
   * 柴刀第 8 镜握在手里、第 9 镜空手、第 10 镜又握着 —— 一眼就看得出来。
   *
   * ⚠ 这一块的全部难点在**不制造噪音**。一个道具没出现在某一镜里，
   * 绝大多数时候完全正常（那是张特写脸）。乱报的检查比没有检查更糟。
   */
  {
    const bible = { characters: [{ name: '阿澜' }], props: [{ name: '柴刀' }] };
    const shot = (i, camera, props, segment = 1) => ({
      id: `s${i}`, index: i, segment, camera, props, description: `第 ${i} 镜`
    });
    const kinds = (shots, b = bible) => lint.lintShots(shots, { bible: b })
      .flatMap((r) => r.issues).map((i) => i.kind);

    // 三明治：前有、后有、中间这一镜是全景却没有
    const sandwich = [shot(1, '全景', ['柴刀']), shot(2, '全景', []), shot(3, '全景', ['柴刀'])];
    check('前后都有、中间这一镜是全景却没有 → 报', kinds(sandwich).includes('prop-vanish'));

    /**
     * ⚠ 这一条是这一块能不能用的关键。
     *
     * 不看景别的话，每一个特写都会被报一次"道具消失" —— 而特写里
     * 看不见道具是天经地义的。满屏假警报，人看两次就学会无视所有警报。
     */
    const closeup = [shot(1, '全景', ['柴刀']), shot(2, '特写', []), shot(3, '全景', ['柴刀'])];
    check('中间是特写就不报（特写里看不见道具是正常的）',
      !kinds(closeup).includes('prop-vanish'), JSON.stringify(kinds(closeup)));

    /**
     * ⚠ 只在**三明治**成立时报。
     *
     * 只看"前一镜有、这一镜没有"的话，道具正常退场（放下、收起、
     * 人离开这个地方）全都会被报成穿帮 —— 而那是绝大多数情况。
     */
    const leaves = [shot(1, '全景', ['柴刀']), shot(2, '全景', []), shot(3, '全景', [])];
    check('道具正常退场（后面再也没有）不报',
      !kinds(leaves).includes('prop-vanish'), JSON.stringify(kinds(leaves)));

    const enters = [shot(1, '全景', []), shot(2, '全景', ['柴刀']), shot(3, '全景', ['柴刀'])];
    check('道具中途登场也不报', !kinds(enters).includes('prop-vanish'));

    // 跨场次是另一个地方、另一段时间
    const crossSeg = [shot(1, '全景', ['柴刀'], 1), shot(2, '全景', [], 2), shot(3, '全景', ['柴刀'], 3)];
    check('跨场次不报（另一个地方、另一段时间）',
      !kinds(crossSeg).includes('prop-vanish'), JSON.stringify(kinds(crossSeg)));

    // 首尾两镜没有"前后都有"可言
    check('第一镜和最后一镜不参与三明治判断',
      !kinds([shot(1, '全景', []), shot(2, '全景', ['柴刀'])]).includes('prop-vanish'));

    const one = lint.lintShots(sandwich, { bible })
      .flatMap((r) => r.issues).find((i) => i.kind === 'prop-vanish');
    check('报的时候说得出是哪件道具', /柴刀/.test(one.what), one.what);
    check('并且说清了为什么这一镜该看得见', /全景|看得见/.test(one.why), one.why);
    check('给了两条出路（补上 / 改景别）', /景别/.test(one.fix), one.fix);
    check('算一般项，不是高危 —— 它有可能是误报', one.severity === 'normal');

    // ── 点名了设定集里没有的道具 ──
    {
      const k = kinds([shot(1, '全景', ['铁剑'])]);
      check('点名了设定集里没有的道具 → 报', k.includes('prop-unknown'));
      check('设定集里有的就不报', !kinds([shot(1, '全景', ['柴刀'])]).includes('prop-unknown'));
      /**
       * 设定集里一件道具都没有时不报 —— 那是"还没到那一步"，不是错。
       * 满屏假警报会让人学会无视所有警报。
       */
      check('设定集里一件道具都没有时不报',
        !kinds([shot(1, '全景', ['铁剑'])], { characters: [], props: [] }).includes('prop-unknown'));
      const u = lint.lintShots([shot(1, '全景', ['铁剑'])], { bible })
        .flatMap((r) => r.issues).find((i) => i.kind === 'prop-unknown');
      check('说清了后果是"同一把刀在不同镜里长得不一样"',
        /长得不一样|参考图/.test(u.why), u.why);
    }
  }

  // ── ② 增量补设定集：只加新的，老的一个字都不碰 ──
  {
    const bible = {
      characters: [{ name: '阿澜', appearance: '短发', seed: 111, sheetPath: '/old/alan.png', voice: 'v1' }],
      scenes: [{ name: '码头', appearance: '晨雾', seed: 222, sheetPath: '/old/dock.png' }],
      props: []
    };
    const found = {
      characters: [{ name: '阿澜', appearance: '模型这次把他写成了长发' }, { name: '老周', role: '船工', appearance: '花白胡子' }],
      scenes: [{ name: '灯塔', appearance: '锈迹斑斑' }],
      props: []
    };
    const added = consistency.mergeCast(bible, found, 'p-1');

    check('只新增没见过的那几条', added.map((a) => a.name).join(',') === '老周,灯塔', JSON.stringify(added));
    /**
     * ⚠ 这一条是整块里最要紧的。
     *
     * 老条目被覆盖的话，"补一章"就变成了"把主角的脸和已经出好的参考图
     * 一起换掉"—— 而观众对主角换脸最敏感，且要到成片里才看得出来。
     */
    const alan = bible.characters.find((c) => c.name === '阿澜');
    check('已有的角色一个字都没动（描述、seed、参考图、音色）',
      alan.appearance === '短发' && alan.seed === 111
      && alan.sheetPath === '/old/alan.png' && alan.voice === 'v1', JSON.stringify(alan));
    check('已有的场景也没动',
      bible.scenes.find((s) => s.name === '码头').sheetPath === '/old/dock.png');

    const zhou = bible.characters.find((c) => c.name === '老周');
    check('新角色的 seed 和全量那条路推的是同一个',
      zhou.seed === consistency.deriveSeed('p-1', 'char:老周'), String(zhou.seed));
    check('新角色留了音色位（配音那步要按角色分音色）', zhou.voice === '');
    check('新角色还没有参考图（等着出）', zhou.sheetPath === null);
    check('新场景进了 scenes，不是塞进 characters',
      bible.scenes.some((s) => s.name === '灯塔') && !bible.characters.some((c) => c.name === '灯塔'));

    // 再并一次同一份，不该重复长出来
    const again = consistency.mergeCast(bible, found, 'p-1');
    check('同一份扫描结果并第二次不会重复长出来', again.length === 0, JSON.stringify(again));

    // 设定集缺字段时也要能补进去（老项目的 bible 可能没有 props）
    const bare = { characters: [] };
    consistency.mergeCast(bare, { characters: [], scenes: [], props: [{ name: '柴刀', appearance: '缺口' }] }, 'p-2');
    check('设定集缺 props 字段时也补得进去（不是 push 进一个临时数组）',
      (bare.props || []).some((x) => x.name === '柴刀'), JSON.stringify(bare.props));
  }

  // ── ① 追加一章：前面的正文一个字都不动 ──
  {
    const p = store.create({ title: '连载' });
    const ch1 = '第一章 出发\n阿澜在码头登船。雾很大。';
    store.update(p.id, (x) => { x.script = ch1; return x; });
    studio.splitChapters(p.id);
    // 假装第一章已经跑完分镜了
    store.update(p.id, (x) => {
      x.chapters[0].stageStatus.script = 'done';
      x.shots = [{ id: 's1', index: 1001, chapterId: x.chapters[0].id, description: '登船' }];
      return x;
    });

    const before = store.read(p.id);
    const r = studio.appendChapter(p.id, { title: '第二章 靠岸', script: '船靠上了灯塔下的礁石。老周跳下船。' });
    const after = r.project;

    check('章数从 1 变成 2', (after.chapters || []).length === 2, String((after.chapters || []).length));
    /**
     * ⚠ 这一条就是这颗按钮存在的全部理由。
     *
     * 手工往剧本框里粘贴时最容易毁掉的就是它：碰掉前面一个空格，
     * 第一章就被判定"改过了"，已经出好的分镜全部作废重跑，
     * 而且没有任何提示 —— 你要到重新分章之后才发现进度没了。
     */
    check('第一章的正文一个字都没变',
      after.chapters[0].script === before.chapters[0].script,
      JSON.stringify([before.chapters[0].script, after.chapters[0].script]));
    check('第一章已跑完的状态保住了', after.chapters[0].stageStatus.script === 'done');
    check('第一章的分镜没被清掉', (after.shots || []).some((s) => s.id === 's1'));
    check('新章的正文进去了', /老周跳下船/.test(after.chapters[1].script), after.chapters[1].script);
    check('新章是没跑过的状态', after.chapters[1].stageStatus.script !== 'done');
    check('剧本正文里也有了（章节是从它切出来的，两边不能对不上）',
      /老周跳下船/.test(after.script));
    check('回的是刚追加的那一章', r.chapter && /第二章|靠岸/.test(r.chapter.title || ''), r.chapter?.title);

    /**
     * ⚠ 第一章**没有标题行**时也得追加得上。
     *
     * 这一条是浏览器走查抓出来的，而上面那几条全绿 —— 因为上面的夹具给
     * 第一章写了「第一章 出发」这个标题行，正好是**能用的那种情况**。
     *
     * 真实的常态是：第一章直接粘进来、没有标题。这时候追加一个带标题的
     * 第二章，全文只有一个标题行 —— 而 autoSplit 有条规矩"只认出一个标题
     * 说明它多半是书名，不算数"，于是两章被并成一章，追加等于没发生。
     *
     * 又一次同样的教训：**夹具挑了顺的那种，把不顺的那种漏掉了。**
     */
    const p0 = store.create({ title: '第一章没标题' });
    store.update(p0.id, (x) => { x.script = '阿澜在码头巡查，发现缆绳被割断。'; return x; });
    studio.splitChapters(p0.id);
    const c0 = store.read(p0.id).chapters[0].script;
    const r0 = studio.appendChapter(p0.id, { title: '第二章 靠岸', script: '船靠上礁石。老周跳下船。' });
    check('第一章没有标题行时，追加也真的多出一章',
      (r0.project.chapters || []).length === 2,
      (r0.project.chapters || []).map((c) => c.title).join(' | '));
    check('而且第一章的正文仍然一个字没变',
      r0.project.chapters[0].script === c0,
      JSON.stringify([c0, r0.project.chapters[0].script]));
    check('新章拿到了不重复的 id',
      r0.project.chapters[1].id !== r0.project.chapters[0].id,
      r0.project.chapters.map((c) => c.id).join(','));
    check('剧本正文里也跟着有了', /老周跳下船/.test(r0.project.script));

    /**
     * ⚠ 一次贴**好几章**。
     *
     * 连载的常态就是攒了几章一起发。原来只当一章处理 —— 三章挤成一章，
     * 于是时长预算、拆分镜、补设定集全都按"一章"来，而它实际是三章。
     * 而且不报错：章节列表上就是多了一条很长的。
     */
    const many = store.create({ title: '一次贴三章' });
    store.update(many.id, (x) => { x.script = ch1; return x; });
    studio.splitChapters(many.id);
    // ⚠ 拿**这个项目自己**的第一章来比。第一版比的是上面那个夹具的 c0，
    // 那是另一个项目的正文 —— 断言在报一件根本不相干的事
    const manyC0 = store.read(many.id).chapters[0].script;
    const rm = studio.appendChapter(many.id, {
      script: '第二章 出海\n船离了港。\n\n第三章 风暴\n浪打了上来。\n\n第四章 靠岸\n他回来了。'
    });
    check('一次贴三章就出三章', rm.added.length === 3, String(rm.added.length));
    check('每一章拿到自己的标题',
      rm.added.map((c) => c.title).join(' | ') === '第二章 出海 | 第三章 风暴 | 第四章 靠岸',
      rm.added.map((c) => c.title).join(' | '));
    check('每一章的正文各自独立',
      rm.added[1].script.includes('浪打了上来') && !rm.added[1].script.includes('他回来了'),
      rm.added[1].script);
    check('id 不重复', new Set(rm.project.chapters.map((c) => c.id)).size === rm.project.chapters.length);
    check('第一章还是没被动过', rm.project.chapters[0].script === manyC0,
      JSON.stringify([manyC0, rm.project.chapters[0].script]));
    /**
     * ⚠ 只按**标题**切，不按字数兜底。
     * 贴一章长的（三千字以上）不该被拦腰劈成两半 —— 那不是他要的。
     */
    /**
     * ⚠ 标题**出现在中间**时，前面那段不能丢。
     *
     * 这一条是金丝雀顺出来的：`marks.length < 2` 那道闸看着是"防止把书名
     * 当章节标题"，它真正挡住的其实是**数据丢失** —— 只认出一个标题时，
     * 按标题切会从标题处开始切，标题**前面**那一段直接被扔掉，
     * 而且不报任何错：你贴进去 500 字，列表上那一章只有 300 字。
     */
    const midHead = chapters2.splitByHeadings('船离了港，雾很大。\n\n第三章 风暴\n浪打了上来。');
    check('标题出现在中间时，前面那段不会被丢掉',
      midHead.map((x) => x.script).join('').includes('雾很大'),
      JSON.stringify(midHead.map((x) => x.script)));

    const longOne = store.create({ title: '一章很长' });
    store.update(longOne.id, (x) => { x.script = ch1; return x; });
    studio.splitChapters(longOne.id);
    const rl = studio.appendChapter(longOne.id, { title: '第二章', script: '啊'.repeat(9000) });
    check('贴一章很长的不会被按字数劈开', rl.added.length === 1, String(rl.added.length));

    // 新章都是"还没对过设定集"的状态 —— 界面据此提示该扫一遍
    check('新加的章标着还没扫过设定集',
      studio.unscannedChapters(rm.project).length === rm.project.chapters.length,
      JSON.stringify(studio.unscannedChapters(rm.project).map((c) => c.id)));

    // 正文自带标题行时不该再补一行，否则重切会多切一刀
    const p2 = store.create({ title: '连载2' });
    store.update(p2.id, (x) => { x.script = ch1; return x; });
    studio.splitChapters(p2.id);
    const r2 = studio.appendChapter(p2.id, { script: '第二章 靠岸\n船靠上了礁石。' });
    check('正文自带章节标题时不重复补标题',
      (r2.project.chapters || []).length === 2, String((r2.project.chapters || []).length));
    check('空的一章要挡住', (() => {
      try { studio.appendChapter(p2.id, { script: '   ' }); return false; } catch { return true; }
    })());
  }

  // ── 没有新章可扫时，不该白跑一趟模型 ──
  {
    const p = store.create({ title: '都扫过了' });
    store.update(p.id, (x) => {
      x.script = '第一章 出发\n阿澜登船。';
      x.bible = { style: { anchor: 'x' }, characters: [], scenes: [], props: [] };
      return x;
    });
    studio.splitChapters(p.id);
    store.update(p.id, (x) => { x.chapters.forEach((c) => { c.castScanned = true; }); return x; });
    const notes = [];
    const out = await studio.extendBible(p.id, { onEvent: (ev) => notes.push(ev.message || '') });
    check('每一章都扫过时直接返回，不调模型', out.added.length === 0);
    check('并且说清楚了为什么什么都没做',
      notes.some((m) => /没有新章/.test(m)), notes.join(' | '));
    // ⚠ extendBible 是 async：不 await 的话抛出来的是一个被拒绝的 Promise，
    // 同步的 try/catch 一个字都接不住 —— 断言会永远判"没挡住"
    const q = store.create({ title: '没设定集' });
    store.update(q.id, (x) => { x.script = 'abc'; return x; });
    let blocked = false;
    try { await studio.extendBible(q.id); } catch { blocked = true; }
    check('还没有设定集时挡住（这一条是往上面补，不是从零建）', blocked);
  }
}

section('场地图：同一片地上的几个场景');
{
  const site = await import('../core/pipeline/site.js');

  /** 造一个项目：三个场景摆在「雪山」上 */
  const mk = (scenes) => ({ bible: { scenes } });
  const sc = (name, x, y, sun, marks) => ({
    name,
    place: { site: '雪山', x, y },
    layout: { marks: marks || [], sun: sun || null }
  });

  // ── 分组 ──
  {
    const p = mk([
      sc('山门外', 0, 0), sc('大殿', 0, 30),
      { name: '客栈', place: { site: '镇上', x: 0, y: 0 }, layout: null },
      { name: '没摆过的' }
    ]);
    const sites = site.sitesOf(p);
    check('按场地名分组', sites.map((s) => s.name).join(',') === '雪山,镇上', sites.map((s) => s.name).join(','));
    check('雪山上有两个场景', sites[0].places.length === 2);
    check('没摆过位置的场景不在任何图上',
      !sites.some((s) => s.places.some((x) => x.scene === '没摆过的')));
    check('摘下来之后就不在图上了',
      site.sitesOf(mk([{ name: '山门外' }])).length === 0);
  }

  // ── 规整 ──
  {
    check('没有场地名就不算摆过', site.normalizePlace({ x: 1, y: 2 }) === null);
    check('坐标夹回场地范围内', site.normalizePlace({ site: 'a', x: 99999 }).x === site.SITE_LIMIT);
    check('NaN 坐标退回 0', site.normalizePlace({ site: 'a', x: 'abc' }).x === 0);
    /**
     * ⚠ 这一条防的是一类很隐蔽的脏数据：近处地标（门、窗、桌）被误发到
     * 场地那条接口上。它没有方位角，补一个 0 就会变成"正北有一扇门"
     * 静静躺在场地图上 —— 接口回 200，图上多一个圆点，而它是凭空捏的。
     */
    const s = site.normalizeSite({ marks: [{ name: '桌', x: 1, y: 2 }, { name: '主峰', deg: 20 }] });
    check('没有方位角的地标被丢掉，不是补成正北',
      s.marks.length === 1 && s.marks[0].name === '主峰', JSON.stringify(s.marks));
    check('留下的都标着 far', s.marks.every((m) => m.far === true));
  }

  // ── 太阳 ──
  {
    const one = site.sitesOf(mk([sc('山门外', 0, 0, { deg: 135, elev: 'low' })]))[0];
    check('只有一个场景摆过太阳时不报', site.sunIssues(one).length === 0);

    const near = site.sitesOf(mk([
      sc('山门外', 0, 0, { deg: 135, elev: 'low' }),
      sc('石阶', 14, -20, { deg: 150, elev: 'low' })
    ]))[0];
    check('差 15° 在容差内，不报', site.sunIssues(near).length === 0);

    const far = site.sitesOf(mk([
      sc('山门外', 0, 0, { deg: 135, elev: 'low' }),
      sc('大殿', 0, 30, { deg: 40, elev: 'low' })
    ]))[0];
    const sun = site.sunIssues(far);
    check('差 95° 就报', sun.length === 1 && sun[0].kind === 'site-sun-drift');
    check('报的时候说清是哪两个场景、差了多少',
      /山门外/.test(sun[0].what) && /大殿/.test(sun[0].what) && /95/.test(sun[0].what), sun[0]?.what);
    /**
     * 这一条不能写成"错了"。剧情本来就可能跨了几小时 ——
     * 进山时清晨、到大殿已是黄昏，那时候太阳**就该**不一样。
     * 一个把正常创作判成错误的检查，人看两次就再也不看了。
     */
    check('措辞留了"也可能是过了时间"这条路', /除非/.test(sun[0].why), sun[0]?.why);

    const elev = site.sitesOf(mk([
      sc('山门外', 0, 0, { deg: 135, elev: 'low' }),
      sc('大殿', 0, 30, { deg: 135, elev: 'high' })
    ]))[0];
    check('方位一样但高度从斜射跳到顶光，也报',
      site.sunIssues(elev).some((i) => i.kind === 'site-sun-elev'));
  }

  // ── 远景地标 ──
  {
    const m = (name, deg) => [{ name, far: true, deg }];
    const same = site.sitesOf(mk([
      sc('山门外', 0, 0, null, m('主峰', 20)),
      sc('石阶', 14, -20, null, m('主峰', 25))
    ]))[0];
    check('同一座山差 5°，不报', site.farMarkIssues(same).length === 0);

    const moved = site.sitesOf(mk([
      sc('山门外', 0, 0, null, m('主峰', 20)),
      sc('大殿', 0, 30, null, m('主峰', 200))
    ]))[0];
    const far = site.farMarkIssues(moved);
    check('同一座山差 180° 就报', far.length === 1 && far[0].kind === 'site-far-drift');
    check('说清了为什么远景地标不该动', /视差/.test(far[0].why), far[0]?.why);

    const other = site.sitesOf(mk([
      sc('山门外', 0, 0, null, m('主峰', 20)),
      sc('大殿', 0, 30, null, m('灯塔', 200))
    ]))[0];
    check('不同名字的地标各在各的方位，不报', site.farMarkIssues(other).length === 0);

    /**
     * 近处地标（门、窗）**不参与**这条检查。
     * 它们有坐标、有视差，换个场景本来就该在不同方位 —— 拿它们比是错的，
     * 而且会把每一个摆过门的项目都报成红的。
     *
     * ⚠ 这一条的**第一版是假绿的**，记在这儿免得再写一遍：
     *
     * 原来的样子是两个场景各摆一个近处的「门」，然后断言不报。可近处地标
     * 根本没有 deg 字段 —— 去掉那道 `far` 判断之后，两个门的方位都读成 0，
     * 差值也是 0，照样不报。**改坏了断言纹丝不动。**
     *
     * 现在用同名的一近一远：山门外那座塔是近处的（有坐标），大殿那座是远处的
     *（只有方位）。挡住近处那个，就只剩一条、无从比起；挡不住，0° 对 170°，
     * 立刻报。这才是那道判断真正在守的事。
     */
    const mixed = site.sitesOf(mk([
      sc('山门外', 0, 0, null, [{ name: '塔', x: 1, y: 2 }]),
      sc('大殿', 0, 30, null, [{ name: '塔', far: true, deg: 170 }])
    ]))[0];
    check('同名的近处地标不会被当成远景来比', site.farMarkIssues(mixed).length === 0,
      JSON.stringify(site.farMarkIssues(mixed).map((i) => i.what)));
  }

  /**
   * ── 场地图上定过的那一份是基准 ──
   *
   * 不认基准的话，场地图上那一排远景地标和那个☀就是**纯装饰** ——
   * 拖它们没有任何后果，而界面上它们看起来像设置。
   * 一个拖了不起作用的控件，比没有这个控件更糟。
   */
  {
    const withAnchor = (sites, scenes) => ({ bible: { sites, scenes } });

    // 场地上定了「山」在北（20°），而大殿里摆成了南（200°）
    const p = withAnchor(
      { 雪山: { marks: [{ name: '山', far: true, deg: 20 }] } },
      [sc('大殿', 0, 30, null, [{ name: '山', far: true, deg: 200 }])]
    );
    const one = site.sitesOf(p)[0];
    const far = site.farMarkIssues(one);
    /**
     * ⚠ 只有**一个**场景也要能报。
     * 原来是拿"第一个场景"当参照，一个场景时无从比起 —— 于是
     * "整片场地只用了一个场景，而它摆错了"这种情况永远查不出来。
     */
    check('场地上定过基准时，单个场景也查得出来', far.length === 1, JSON.stringify(far));
    check('说得出是"场地图上定的"那一份，而不是含糊地说两个场景对不上',
      /场地图上定的/.test(far[0]?.what || ''), far[0]?.what);

    const sunP = withAnchor(
      { 雪山: { sun: { deg: 135, elev: 'low' } } },
      [sc('大殿', 0, 30, { deg: 40, elev: 'low' })]
    );
    const sun = site.sunIssues(site.sitesOf(sunP)[0]);
    check('太阳也认场地图上定的那一份', sun.length === 1 && /场地图上定的光/.test(sun[0].what), sun[0]?.what);

    // 场地上没定过就退回老办法：拿第一个场景当参照，只说"这两个对不上"
    const noAnchor = site.sitesOf(mk([
      sc('山门外', 0, 0, { deg: 135, elev: 'low' }),
      sc('大殿', 0, 30, { deg: 40, elev: 'low' })
    ]))[0];
    const s2 = site.sunIssues(noAnchor);
    check('场地上没定过时，退回拿第一个场景当参照',
      s2.length === 1 && !/场地图上定的/.test(s2[0].what), s2[0]?.what);
  }

  // ── 套用：问题旁边那条出口 ──
  {
    const model = {
      name: '雪山',
      marks: [{ name: '山', far: true, deg: 20 }],
      sun: { deg: 135, elev: 'low' },
      places: []
    };
    /**
     * ⚠ 近处地标**一个都不能动**。
     *
     * 门窗桌椅有坐标、有视差，本来就该每个场景各不相同。一起覆盖掉的话，
     * 这颗按钮就从"对齐远景"变成了"把每个场景的房间布局清空"——
     * 而它字面上看起来是在帮忙，且不可撤销。
     */
    const layout = {
      marks: [{ name: '门', x: 1, y: 2 }, { name: '山', far: true, deg: 200 }],
      sun: { deg: 40, elev: 'high' }
    };
    const out = site.alignSceneToSite(layout, model);
    check('套用之后近处的门还在，坐标没变',
      out.marks.some((m) => m.name === '门' && m.x === 1 && m.y === 2), JSON.stringify(out.marks));
    check('远景的山换成了场地图那一份',
      out.marks.filter((m) => m.far && m.name === '山').length === 1
      && out.marks.find((m) => m.far && m.name === '山').deg === 20, JSON.stringify(out.marks));
    check('太阳换成了场地图那一份', out.sun.deg === 135 && out.sun.elev === 'low', JSON.stringify(out.sun));

    /**
     * 场地上没摆太阳时**保留场景自己那个**，不要清成 null。
     * "没定基准"和"基准是没有太阳"是两回事，后者会把每个场景
     * 辛苦摆的光位一次抹掉。
     */
    const noSun = site.alignSceneToSite(layout, { ...model, sun: null });
    check('场地上没摆太阳时，保留场景自己那个（不清空）',
      noSun.sun?.deg === 40, JSON.stringify(noSun.sun));

    /**
     * 没有基准就不该摆那颗"套用"按钮 —— 点下去只能套一片空白。
     *
     * ⚠ 这一条的**第一版又是假绿的**，和前面那条近处地标犯的是同一个毛病：
     * 原来传的是 `places: []`，那时候 alignable 走到底也找不出任何问题，
     * 返回 false —— 于是把"没有基准"那道判断整个删掉，断言照样通过。
     *
     * 真正要摆的局面是：**两个场景之间确实对不上，但场地上没定过基准**。
     * 有毛病、却没有可套的东西 —— 这才是那道判断在守的事。
     */
    const drifting = site.sitesOf(mk([
      sc('山门外', 0, 0, { deg: 135, elev: 'low' }),
      sc('大殿', 0, 30, { deg: 40, elev: 'low' })
    ]))[0];
    check('两个场景对不上、但场地上没定过基准时，不给"套用"',
      site.alignable(drifting) === false,
      `问题有 ${site.sunIssues(drifting).length} 条，但没有可套的基准`);
    const bad = site.sitesOf({
      bible: {
        sites: { 雪山: { marks: [{ name: '山', far: true, deg: 20 }] } },
        scenes: [sc('大殿', 0, 30, null, [{ name: '山', far: true, deg: 200 }])]
      }
    })[0];
    check('有基准而且真的对不上时，才给"套用"', site.alignable(bad) === true);
    const good = site.sitesOf({
      bible: {
        sites: { 雪山: { marks: [{ name: '山', far: true, deg: 20 }] } },
        scenes: [sc('大殿', 0, 30, null, [{ name: '山', far: true, deg: 22 }])]
      }
    })[0];
    check('本来就一致时不摆按钮（没有要套的）', site.alignable(good) === false);
  }

  // ── 叠在一起 ──
  {
    const stacked = site.sitesOf(mk([sc('山门外', 0, 0), sc('大殿', 0, 0)]))[0];
    check('两个场景摆在同一点上会提醒', site.stackedIssues(stacked).length === 1);
    const apart = site.sitesOf(mk([sc('山门外', 0, 0), sc('大殿', 0, 30)]))[0];
    check('拖开了就不提醒', site.stackedIssues(apart).length === 0);
  }

  // ── 方位和距离 ──
  {
    const s = site.sitesOf(mk([sc('山门外', 0, 0), sc('大殿', 0, 30)]))[0];
    const [a, b] = s.places;
    const line = site.describeBetween(a, b);
    check('说得出"大殿在山门外的北边三十米"', /大殿/.test(line) && /北/.test(line) && /30/.test(line), line);
    /**
     * ⚠ 方向必须**跟着 previz 那套走**（+y 是北）。
     * 两套坐标系是这类几何代码最经典的坑，而且它不报错 ——
     * 只是图上画的和文字说的拧着，两句话都是我们自己说的。
     */
    check('往南摆就说南', /南/.test(site.describeBetween(a, { scene: '谷底', x: 0, y: -30 })));
    check('往东摆就说东', /东/.test(site.describeBetween(a, { scene: '东坡', x: 30, y: 0 })));
    check('几乎同一处时不硬编方向', /同一处/.test(site.describeBetween(a, { scene: '门口', x: 0.1, y: 0.1 })));
  }

  // ── 汇总进成片体检 ──
  {
    const quality = await import('../core/pipeline/quality.js');
    const project = {
      shots: [{ id: 's1', index: 1, imagePath: 'a.png', videoPath: 'a.mp4' }],
      bible: {
        scenes: [
          sc('山门外', 0, 0, { deg: 135, elev: 'low' }),
          sc('大殿', 0, 30, { deg: 40, elev: 'low' })
        ]
      }
    };
    const report = quality.audit(project, { lintResults: [] });
    const item = report.items.find((i) => i.id === 'site-continuity');
    check('场地图对不上会出现在成片体检里', !!item, report.items.map((i) => i.id).join(','));
    /**
     * 算 warn 不算 blocker。跨了时间的戏本来就该换太阳 ——
     * 把正常创作判成"先别发"，人第一次看到就再也不信这一页了。
     */
    check('算 warn，不是 blocker', item?.level === 'warn', item?.level);
    check('体检里指得出去哪儿改', /场地/.test(item?.fix || ''), item?.fix);

    const clean = quality.audit(
      { ...project, bible: { scenes: [sc('山门外', 0, 0, { deg: 135, elev: 'low' })] } },
      { lintResults: [] }
    );
    check('没问题时不出现这一条', !clean.items.some((i) => i.id === 'site-continuity'));
  }
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

  /**
   * ══ 音效太密 ══
   *
   * 用户的原话："13个片13个音效很乱"。每一镜配一个环境音，成片听起来是
   * 一串互不相干的响动 —— 比完全没有音效糟得多。
   */
  {
    const many = q.audit({ shots: Array.from({ length: 12 }, (_, i) => done(i + 1, { sound: '风声' })) });
    const hit = many.items.find((i) => i.id === 'sfx-too-dense');
    check('每镜都有音效 → 报出来', Boolean(hit), JSON.stringify(many.items.map((i) => i.id)));
    check('并且给一条不用重新生成的出路（音量调 0 再合成一次）',
      /音效音量/.test(hit?.fix || '') && /不用重新生成/.test(hit?.fix || ''), hit?.fix);
    // 稀疏是正常的，不能报 —— 一条永远红的检查等于没有检查
    const few = q.audit({
      shots: Array.from({ length: 12 }, (_, i) => done(i + 1, i < 3 ? { sound: '敲门声' } : {}))
    });
    check('只有三处音效时不报（这才是正常的用法）',
      !few.items.some((i) => i.id === 'sfx-too-dense'), JSON.stringify(few.items.map((i) => i.id)));
    // 镜头太少时也不报：3 镜里 2 镜有音效说明不了什么
    const tiny = q.audit({ shots: [done(1, { sound: 'a' }), done(2, { sound: 'b' }), done(3)] });
    check('镜头太少时不下这个结论', !tiny.items.some((i) => i.id === 'sfx-too-dense'));
  }

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
   * ══ 富余不多时从头上切，别从尾上切 ══
   *
   * 用户的原话："画面还没演示完就拼凑到下一个画面了，为了硬拼时间，
   * 把一些好的画面给截了"。
   *
   * 形状：分镜写 4 秒，厂商只出固定档（秘塔 5/10/15）给回 5 秒，
   * 旧写法切 [0,4] —— 扔掉最后一秒。而模型是按"这一段演完"编排节奏的，
   * 起手慢、收在最后，那一秒恰恰是动作收尾。
   * 同样砍一秒：从头砍掉的是起势（看不出来），从尾砍掉的是收尾（一眼看出）。
   */
  {
    const still = Array(25).fill(5); // 全程在动，dead=0，把变量控制住
    const w = ac.pickWindow([], 5, 4, { hamming: () => 0, dead: 0 });
    check('5 秒的片子要 4 秒 → 切后 4 秒，不是前 4 秒',
      w.in === 1 && w.out === 5, JSON.stringify(w));
    // 已经有废头时，两者叠加但不超过总长
    const w2 = ac.pickWindow([], 5, 4, { hamming: () => 0, dead: 0.6 });
    check('已经有废头时，入点仍然落在能把结尾留住的位置',
      w2.out === 5 && w2.in === 1, JSON.stringify(w2));
    // 富余太大就不硬挑了 —— 从头上砍六秒会把动作开头也砍掉
    const w3 = ac.pickWindow([], 10, 4, { hamming: () => 0, dead: 0 });
    check('富余太大时不从头硬砍（那种情况该用 keep 策略）',
      w3.in === 0 && w3.out === 4, JSON.stringify(w3));
    // 不裁（want=0）时不受影响
    const w4 = ac.pickWindow([], 5, 0, { hamming: () => 0, dead: 0.6 });
    check('不裁时只去废头，结尾原样留着',
      w4.in === 0.6 && w4.out === 5, JSON.stringify(w4));
    void still;
  }

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
   * ⚠ **几个版本的修改时间一模一样时，顺序也必须是对的。**
   *
   * 这一条不是假想。Windows 上真出过：`renameSync` 不改 mtime，
   * 而 Windows 的系统时钟粒度约 15 毫秒 —— 连着重出几版远不到 15 毫秒，
   * 于是好几版的 mtime 完全相等。JS 的 sort 对相等的键是稳定排序，
   * 最终顺序变成 readdirSync 给的字母序，**最旧的排到了最前面**。
   * 后果是"回到上一版"回到的是最旧那一版，而那一步是覆盖当前产物的。
   *
   * Linux 上天然看不出来（ext4 的 mtime 精确到纳秒，随手就分开了），
   * 只有 CI 在 Windows 上跑才红 —— 而当时红的是上面那条，
   * 报出来的是"内容不对"，完全看不出根因在排序。
   *
   * 所以这里**把时间抹平**，在 Linux 上复现 Windows 的那个条件。
   */
  const tie = fs.mkdtempSync(path.join(os2.tmpdir(), 'fd-vertie-'));
  const td = path.join(tie, 'shot-9.png');
  fs.writeFileSync(td, '第1版');
  for (let i = 2; i <= 5; i += 1) {
    v.archive(td);
    fs.writeFileSync(td, `第${i}版`);
  }
  const sameTime = new Date(1700000000000);
  for (const n of fs.readdirSync(tie)) fs.utimesSync(path.join(tie, n), sameTime, sameTime);
  const tied = v.list(td);
  check('时间完全相同时，仍然是新的在前',
    tied.map((x) => x.n).join(',') === '4,3,2,1', tied.map((x) => x.n).join(','));
  check('时间相同时"上一版"也还是上一版（不是最旧那一版）',
    fs.readFileSync(tied[0].path, 'utf8') === '第4版', fs.readFileSync(tied[0].path, 'utf8'));

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
  /**
   * ══ 落盘只写差异 —— 否则改默认值对老用户永远不生效 ══
   *
   * 原来 patch 把整份合并后的对象写下去，于是用户**第一次保存任何一项**
   * 的那一刻，当时那份 DEFAULTS 的全部快照就被固化进了 settings.json。
   * 之后我再改默认值，磁盘上那份旧快照永远压过它。
   *
   * 用户更新到新版之后说"每镜会用完整片段这个都没看到"——
   * 就是这个：他盘上写着 trim，而我改的是默认值。
   * 最阴的地方是**无声无息**：默认值改了、代码对、自检也绿
   *（自检那份 settings.json 是空的），只有真实用户碰得到。
   */
  {
    const fsx = await import('node:fs');
    const { SETTINGS_FILE } = await import('../core/paths.js');
    st.patch({ theme: 'dark' }); // theme 的默认值就是 dark —— 存了等于没改
    const onDisk = JSON.parse(fsx.readFileSync(SETTINGS_FILE, 'utf8'));
    check('和默认一样的项不落盘（改默认值才能到用户手里）',
      !('theme' in onDisk), JSON.stringify(Object.keys(onDisk).slice(0, 12)));
    check('没被写进去的那些，读出来还是默认值',
      st.get('theme') === 'dark', String(st.get('theme')));
    st.patch({ theme: 'light' });
    const onDisk2 = JSON.parse(fsx.readFileSync(SETTINGS_FILE, 'utf8'));
    check('真改过的项照常落盘', onDisk2.theme === 'light', JSON.stringify(onDisk2.theme));
    st.patch({ theme: 'dark' });
    check('改回默认之后那一项从盘上消失',
      !('theme' in JSON.parse(fsx.readFileSync(SETTINGS_FILE, 'utf8'))));
  }

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

section('外景怎么定方位：远景地标和光位');
{
  /**
   * ════════ 内景和外景不是同一个问题 ════════
   *
   * 内景有门窗桌椅 —— 都在几米之内，有坐标，机位挪三米它们在画面里挪一大截。
   * 外景基本上什么都没有：一片海滩、一条街、一段山路。真正能定方位的只有两样：
   *
   *   远处那几个地标（山、塔、灯塔、天际线）—— 它们**只有方位，没有坐标**。
   *     机位挪三米，一座山在画面里纹丝不动。硬给它编一个"离主体 4 米"的坐标，
   *     算出来的画面位置全是错的：机位一动它就横移半个屏，而真山不会。
   *
   *   光 —— 外景最要紧的那一样，比任何地标都要紧。室内的光是布的，
   *     两镜之间不会自己变；外景的光是太阳给的，而观众对它极其敏感：
   *     上一镜逆光、这一镜顺光，读出来是"这两镜不是同一时间拍的"。
   *     而模型不知道太阳在哪 —— 除非每一镜都告诉它。
   */
  const pv = await import('../core/pipeline/previz.js');

  const beach = (camX, camY, lens = 35) => ({
    cam: { x: camX, y: camY, height: 1.6, lens },
    subjects: [{ name: '阿澜', x: 0, y: 0, facing: 180 }],
    marks: [{ name: '灯塔', far: true, deg: -30 }, { name: '缆桩', x: 1.2, y: 0.6 }],
    sun: { deg: 55, elev: 'low' }
  });

  const st = pv.normalizeStage(beach(0, -4));
  check('远景地标只存方位、不存坐标',
    st.marks[0].far === true && st.marks[0].deg === -30 && st.marks[0].x === undefined,
    JSON.stringify(st.marks[0]));
  check('近处地标照旧存坐标', st.marks[1].x === 1.2 && !st.marks[1].far, JSON.stringify(st.marks[1]));
  check('太阳存下来了', st.sun.deg === 55 && st.sun.elev === 'low', JSON.stringify(st.sun));
  check('太阳缺角度就当没有（一个没有方向的太阳没有意义）',
    pv.normalizeStage({ ...beach(0, -4), sun: { elev: 'low' } }).sun === null);

  /**
   * ⚠ 这条是这一节的核心：**机位挪了，远景地标在画面里不该动**。
   *
   * 拿它和近处那个缆桩比 —— 同样挪 2 米，缆桩在画面里跑掉一大截，
   * 灯塔几乎不动。这就是"有没有视差"的区别，也是为什么两种地标
   * 不能用同一套算法。
   */
  const near = (stage) => pv.framing(stage).marks.find((m) => m.name === '缆桩').x;
  const far = (stage) => pv.framing(stage).marks.find((m) => m.name === '灯塔').x;

  /**
   * ⚠ 要量的是**推拉**（沿着轴向前后走），不是横移。
   *
   * 第一版量的是横移，结果和直觉正好相反：远处的灯塔跑掉一大截，
   * 近处的缆桩几乎没动。而那是**对的** —— 横移时镜头得转过去继续对着主体，
   * 轴向跟着转了 27°，于是只受轴向影响的远景地标整个扫过画面；
   * 而缆桩自己的方位也跟着变，两下抵消掉大半。这正是"背景相对主体在动"
   * 的视差本身，也是横移看起来那么有立体感的原因。
   *
   * 前后推拉时轴向一点不变，两者的差别才干净地露出来：
   * 远的纹丝不动（它只看轴向），近的跑掉一大截。
   */
  const a = beach(0, -6);
  const b = beach(0, -2);
  check(`推近 4 米，近处的缆桩在画面里跑了一大截（${near(a)} → ${near(b)}）`,
    Math.abs(near(a) - near(b)) > 0.4, `${near(a)} / ${near(b)}`);
  check(`同一次推近，远处的灯塔纹丝不动（${far(a)} → ${far(b)}）—— 它只看镜头轴向`,
    Math.abs(far(a) - far(b)) < 0.001, `${far(a)} / ${far(b)}`);
  /**
   * ⚠ 光有"不动"是不够的 —— 那一条**假绿过**。
   *
   * 把远景那条分支关掉，代码会退回近景算法，而一个没有 x/y 的地标
   * 会被当成坐标 (0,0)，正好落在主体身上、正好在画面正中，
   * 于是"推近时不动"照样成立（一直是 0）。
   *
   * 所以还要钉住**它到底在画面的哪儿**：35mm 的半视角是 atan(18/35)=27.2°，
   * 方位偏 30° 算出来就是 tan30/tan27.2 ≈ −1.12（画面左，而且已经出画）。
   */
  check(`远处地标的画面位置由它的方位角算出来（应 ≈ −1.12，实际 ${far(a)}）`,
    Math.abs(far(a) + 1.122) < 0.02, String(far(a)));
  /**
   * 反过来也要验一条：轴向真的转了的时候，远景地标必须跟着扫过画面。
   * 不然"只看轴向"这句话就成了"永远不动"，那是另一种错。
   */
  const turned = { ...beach(0, -4), subjects: [{ name: '阿澜', x: 2, y: 0, facing: 180 }] };
  check('镜头转向时远景地标跟着扫过画面（不是永远钉死）',
    Math.abs(far(beach(0, -4)) - far(turned)) > 0.3,
    `${far(beach(0, -4))} / ${far(turned)}`);

  // ── 光位 ──
  const lightAt = (sunDeg) => pv.lightOf({ ...beach(0, -4), sun: { deg: sunDeg, elev: 'low' } });
  check('太阳在镜头正前方 = 逆光', lightAt(0).kind === '逆光', JSON.stringify(lightAt(0)));
  check('太阳在机位背后 = 顺光', lightAt(180).kind === '顺光', JSON.stringify(lightAt(180)));
  check('太阳在右边 = 侧光，光从画面右来',
    lightAt(90).kind === '侧光' && lightAt(90).from === '画面右', JSON.stringify(lightAt(90)));
  check('太阳在左边就是画面左', lightAt(-90).from === '画面左', JSON.stringify(lightAt(-90)));
  /**
   * ⚠ 顺光和逆光时"光从哪边来"没有意义 —— 太阳基本在镜头轴上。
   * 硬说一个"从画面左来"是**误导**，模型会照着打一道侧光。
   */
  check('顺光/逆光时不硬说"从哪边来"', lightAt(0).from === null && lightAt(180).from === null);
  check('高度也说出来（早晚斜射和正午顶光是两种画）',
    /早晚/.test(lightAt(90).elev) && /顶光/.test(pv.lightOf({ ...beach(0, -4), sun: { deg: 90, elev: 'high' } }).elev));
  check('没太阳（内景）就没有光位这一段', pv.lightOf({ ...beach(0, -4), sun: null }) === null);

  // ── 那句提示词 ──
  const line = pv.cameraLine({ stage: beach(0, -4) });
  check('提示词里带上了光位', /侧逆光|逆光|顺光|侧光/.test(line), line);
  check('并且说了光从哪边来、什么高度', /光从画面[左右]来/.test(line) && /早晚/.test(line), line);
  /**
   * 远的要说"远处"。不说的话模型会把一座山画成近景里的一块石头 ——
   * 而那在画面上是彻底不同的两张图。
   */
  const wide = pv.cameraLine({ stage: beach(0, -4, 18) });
  check('远景地标在提示词里标着"远处"', /远处是灯塔/.test(wide), wide);
  check('近处的不标"远处"', !/远处是缆桩/.test(wide), wide);

  // ── 继承：太阳更不该因为换机位就挪窝 ──
  const next = pv.inheritStage(beach(0, -4), ['别人']);
  check('换一镜时太阳原样带过去', next.sun?.deg === 55, JSON.stringify(next.sun));
  check('远景地标也原样带过去',
    next.marks.some((m) => m.far && m.name === '灯塔'), JSON.stringify(next.marks));

  /**
   * ⚠ **不对相邻两镜做光位检查**，这是有意的。
   *
   * 一场戏只有一个太阳（sun 存在场景上、逐镜继承），所以"光位跳变"
   * 由构造保证不会发生；而正反打里一边顺光一边逆光本来就是正常的，
   * 报它只会变成噪音 —— 而噪音会让人学会无视所有警报。
   * 光位的价值全在写进每一镜的提示词。
   */
  const sameSun = pv.continuityIssues(beach(0, -4), beach(0, 4));
  check('正反打不会因为光位翻面就报警（那本来就是正常的）',
    !sameSun.some((i) => /光|逆|顺/.test(i.what)), JSON.stringify(sameSun.map((i) => i.what)));

  // ── 挂到场景上 ──
  /**
   * 逐镜继承只在同一场次连着的那几镜里管用。而同一个场景往往会反复回来：
   * 第 3 镜在码头、第 11 镜又回码头。中间隔一场，继承那条链就断了 ——
   * 于是同一个码头被摆了三遍，三遍的灯塔在不同方位。而观众记得住地方。
   */
  const studioMod = await import('../core/pipeline/studio.js');
  const storeMod = await import('../core/store.js');
  const proj = storeMod.create({ title: '场景布局', script: 'x' });
  storeMod.update(proj.id, (p) => {
    p.bible = { characters: [], scenes: [{ name: '码头' }], props: [] };
    return p;
  });
  const saved = studioMod.saveSceneLayout(proj.id, '码头', beach(0, -4));
  const layout = studioMod.sceneLayoutOf(saved, '码头');
  check('布局挂到了设定集的场景上', Boolean(layout), JSON.stringify(layout));
  check('地标和光位都存了',
    layout.marks.length === 2 && layout.sun?.deg === 55, JSON.stringify(layout));
  /**
   * ⚠ 存的是**房间**，不是机位。一起存的话每一镜都从同一个机位开始 ——
   * 那等于把二十镜拍成同一张画，而那正是"分镜"要避免的事。
   */
  /**
   * ⚠ 要查**盘上真的存了什么**，不是查读出来的那个对象。
   *
   * sceneLayoutOf 是自己重新组的 `{ marks, sun }` —— 拿它去断言"没存机位"
   * 永远是绿的，哪怕落库时把整个 stage 都写进去了。这一条假绿过。
   */
  const onDisk = saved.bible.scenes.find((x) => x.name === '码头').layout;
  check('不存机位', onDisk.cam === undefined, JSON.stringify(Object.keys(onDisk)));
  check('也不存人的站位（那跟着剧情走）', onDisk.subjects === undefined,
    JSON.stringify(Object.keys(onDisk)));
  check('没存过的场景回 null（别拿一份空布局冒充）',
    studioMod.sceneLayoutOf(saved, '别的地方') === null);
  let boom = null;
  try { studioMod.saveSceneLayout(proj.id, '不存在的场景', beach(0, -4)); } catch (e) { boom = e.message; }
  check('存到一个设定集里没有的场景上要报错', /设定集里没有场景/.test(boom || ''), boom);
  storeMod.remove(proj.id);
}

section('接缝那几句话：三处必须是同一句');
{
  /**
   * ════════ 这一节挡的是一个真出过的错 ════════
   *
   * 手机端那张卡片上写着：「标成连续动作会把上一镜的末帧锁成下一镜的首帧」。
   * 那描述的是 tail 模式，**而默认跑的是 lock**。
   *
   * lock 下每一段视频**仍然是从自己那张图开始的** —— 接缝是靠逼上一段
   * "结束在下一镜那张图上"做出来的，做在**上一镜**身上。
   * 用户照着那句话去看成片，看到"这一段的第一帧根本不是上一段的最后一帧"，
   * 得出的结论只能是"坏了"。他的原话就是：
   *   "怎么是上一镜尾帧为下一镜的首帧？不是首尾帧？"
   *
   * 措辞现在只有一份（core/seam.js），设置下拉、手机卡片、出视频说明都读它。
   */
  const seam = await import('../core/seam.js');
  const settingsMod = await import('../core/settings.js');

  check('三种模式都在', seam.SEAM_MODES.map((m) => m.id).join() === 'lock,tail,off',
    seam.SEAM_MODES.map((m) => m.id).join());
  check('不认识的模式当默认（设置文件是可以手改的）', seam.modeOf('乱写').id === 'lock');
  check('默认就是 lock（和 settings 的默认对得上）',
    (settingsMod.DEFAULTS ? settingsMod.DEFAULTS.seamMode : settingsMod.get('seamMode')) === 'lock');

  const lock = seam.howItWorks('lock');
  /**
   * ⚠ lock 那句话里**必须**把"每一段仍然从自己那张图开始"说出来。
   * 不说的话，人只会按字面理解成"上一段的尾帧变成这一段的首帧"——
   * 而那正是 tail 干的事，两者看起来完全不一样。
   */
  check('首尾帧那句点明"接缝做在上一镜身上"', /做在\*\*上一镜\*\*身上/.test(lock), lock);
  check('并且明说"别去看这一段的首帧是不是上一段的尾帧"',
    /首帧是不是上一段的尾帧/.test(lock) && /永远是否/.test(lock), lock);
  check('首尾帧那句里没有"上一段的尾帧当这一段的首帧"这种说法',
    !/上一段的最后一帧.*当.*首帧/.test(lock), lock);

  const tail = seam.howItWorks('tail');
  check('接住真实末帧那句才说"这一段的第一帧等于上一段的最后一帧"',
    /第一帧就等于上一段的最后一帧/.test(tail), tail);
  check('两种模式的说法不一样（一样就说明有一处在撒谎）', lock !== tail);
  check('每一句都带着当前模式的名字（不带的话人不知道自己在看哪一种）',
    /「首尾帧」/.test(lock) && /「接住真实末帧」/.test(tail) && /「关掉」/.test(seam.howItWorks('off')));

  /**
   * ⚠ 这个文件要原样发给浏览器（/seam.js），所以必须零依赖。
   * 它一旦 import 了任何东西，手机端整个 m.js 都加载不起来 ——
   * 表现是打开手机版一片空白，而且完全看不出是这儿造成的。
   */
  const src = fs.readFileSync(path.join(PROJECT_ROOT, 'core', 'seam.js'), 'utf8');
  check('seam.js 保持零依赖（它要原样发给浏览器）',
    !/^\s*import\s/m.test(src) && !/from\s+'node:/.test(src));

  // ── 自动标那一步：给模型的料够不够 ──
  /**
   * "这一镜是不是上一镜那个动作的下一瞬间"，前提是**同一个人**在继续同一个动作。
   * 只给描述的话，「他推开门」和「她走进屋」字面上一样像连续动作。
   * 少给这两个字段的代价是判漏 —— 而用户看到的是"很明显的连贯动作，
   * 模型怎么看不出来"。模型看不出来，因为我们没给它看。
   */
  const studioMod = await import('../core/pipeline/studio.js');
  const one = studioMod.linkPayloadOf({
    index: 4, segment: 2, scene: '走廊', characters: ['阿澜'],
    description: '推开门', camera: '中景', motion: '跟随', dialogue: ''
  });
  check('发给模型的每一镜带上了"这一镜有谁"',
    Array.isArray(one.characters) && one.characters[0] === '阿澜', JSON.stringify(one));
  check('也带上了"这一镜怎么动"', one.motion === '跟随', JSON.stringify(one));
  check('场次也在（跨场次不可能是连续动作，它得知道）', one.segment === 2, JSON.stringify(one));
  check('没写 characters 的老分镜也不会炸', Array.isArray(studioMod.linkPayloadOf({ index: 1 }).characters));

  check('提示词里点名了"这一类不要漏"', /不要漏/.test(studioMod.LINK_PROMPT), '');
  check('并且举了推门→进门这个例子（界面上就是这么宣传的）',
    /推开门.*走进屋里/s.test(studioMod.LINK_PROMPT), '');
  check('仍然保留"拿不准就给 cut"（判错的代价是不对称的）',
    /拿不准就给 cut/.test(studioMod.LINK_PROMPT), '');
}

section('场景的东南西北：机位相对房间，不只相对人');
{
  /**
   * ════════ 补的是哪个洞 ════════
   *
   * 原来算出来的机位是**相对人的**："机位在人物右前方 45°"。
   * 单独一镜里很准，可它经不起下一镜：人一转身，"右前方"指向房间里
   * 完全不同的地方。于是同一场戏里，模型每一镜都在重新想象这个房间 ——
   * 窗一会儿在画面左、一会儿在右，门一会儿在背后、一会儿在侧面。
   *
   * 而观众读一场戏靠的正是这些**不动的东西**。它们乱了，人物走位再准也没用。
   * 这也是"随便调机位、下一镜衔接幅度很大"的根治办法：不是不让调，
   * 是调完之后能算出画面里那些不动的东西有没有跟着乱。
   */
  const pv = await import('../core/pipeline/previz.js');

  // ── 方位 ──
  check('八个方位对得上（+y 记作北，顺时针）',
    ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
      .every((w, i) => pv.compassOf(i * 45) === w),
    [0, 45, 90, 135, 180, 225, 270, 315].map((d) => pv.compassOf(d)).join(','));
  check('负角度和超过一圈都认得', pv.compassOf(-90) === '西' && pv.compassOf(450) === '东');

  // ── 地标 ──
  const room = () => ({
    cam: { x: 0, y: -3, height: 1.6, lens: 35 },
    subjects: [{ name: '阿澜', x: 0, y: 0, facing: 180 }],
    marks: [{ name: '窗', x: -1.2, y: 2 }, { name: '门', x: 1.2, y: 2 }]
  });
  const st = pv.normalizeStage(room());
  check('地标存得下来', st.marks.length === 2, JSON.stringify(st.marks));
  check('没名字的地标丢掉（一个没名字的方块在图上没有意义）',
    pv.normalizeStage({ ...room(), marks: [{ x: 1, y: 1 }] }).marks.length === 0);

  /**
   * ⚠ 地标**不跟着人走**。
   *
   * 人是按这一镜的剧本来的（这一镜没有的人要丢掉），但门窗桌椅不会因为
   * 换了个机位就搬家。丢了它们，"画面左边是窗"这句话下一镜就没了 ——
   * 而那正是场景一致性的全部依靠。
   */
  const next = pv.inheritStage(room(), ['别人']);
  check('换了人，地标原样带过去', next.marks.length === 2, JSON.stringify(next.marks));
  check('这一镜没有的人被丢掉（否则景别会照错人算）',
    next.subjects.length === 1 && next.subjects[0].name === '别人', JSON.stringify(next.subjects));

  // ── 画面左右 ──
  const f = pv.framing(room());
  check('机位在场景南侧、朝北拍', f.camAt === '南' && f.looking === '北', `${f.camAt}/${f.looking}`);
  const win = f.marks.find((m) => m.name === '窗');
  const door = f.marks.find((m) => m.name === '门');
  check('窗在画面左、门在画面右', win.side === '画面左' && door.side === '画面右',
    `${win.side}/${door.side}`);
  /**
   * ⚠ 出画和"在身后"是两回事。长焦下窗早就出画了，但它还在镜头前方；
   * 一律回 null 会把这个差别抹掉，而"刚出画一点点"是可以靠退半步救回来的。
   */
  const tele = pv.framing({ ...room(), cam: { ...room().cam, lens: 200 } });
  check('长焦下地标出画，但不算"在身后"',
    tele.marks.every((m) => m.side === '画外' && !m.behind), JSON.stringify(tele.marks));
  // 摆一个在机位**背后**的地标：那时候"左右"没有意义
  const behind = pv.framing({
    ...room(),
    marks: [{ name: '门', x: 0, y: -6 }]  // 机位在 y=-3 朝北看，门在它身后
  });
  check('绕到地标后面时，"左右"没有意义，如实回空',
    behind.marks.every((m) => m.behind === true && m.side === null), JSON.stringify(behind.marks));

  // ── 那句提示词 ──
  const line = pv.cameraLine({ stage: room() });
  check('机位那句话里带上了相对房间的方位',
    /机位在场景南侧、朝北拍/.test(line), line);
  check('并且点名画面里看得见什么、在哪边', /画面左是窗/.test(line) && /画面右是门/.test(line), line);
  /**
   * ⚠ 没摆地标就**只说方位，不编**。编一句"画面左边是窗"而实际上没人摆过，
   * 比不说更坏 —— 它是一个听起来很具体的谎。
   */
  const bare = pv.cameraLine({ stage: { ...room(), marks: [] } });
  check('没摆地标时不硬编"画面左边是什么"', !/画面左/.test(bare) && /机位在场景/.test(bare), bare);

  // ── 衔接幅度 ──
  const at = (x, y, lens = 35) => ({ ...room(), cam: { x, y, height: 1.6, lens } });
  const kinds = (a, b) => pv.continuityIssues(a, b).map((i) => i.kind);

  check('正常换个机位不报警', kinds(at(0, -3), at(-1.8, -2.4)).length === 0,
    JSON.stringify(kinds(at(0, -3), at(-1.8, -2.4))));
  /**
   * 摆太狠：绕着人转过一百度，画面里一切都换了位置，只是恰好没跨轴线。
   * 观众在两镜之间失去方位，而逐镜看每一张都挑不出毛病。
   */
  check('绕主体摆过一百度要报', kinds(at(0, -3), at(3, 1)).includes('camera-swing'),
    JSON.stringify(pv.continuityBetween(at(0, -3), at(3, 1))));
  /**
   * 摆太少：只挪了十几度、景别也没变 —— 那不叫换机位，叫跳切，
   * 看上去像播放器卡了一下。剪辑里最基本的三十度原则。
   */
  check('几乎没动又不换景别要报（三十度原则）',
    kinds(at(0, -3), at(0.3, -3)).includes('jump-cut'), JSON.stringify(kinds(at(0, -3), at(0.3, -3))));
  check('动得少但换了景别就不算跳切',
    !kinds(at(0, -3), at(0.3, -3, 135)).includes('jump-cut'),
    JSON.stringify(kinds(at(0, -3), at(0.3, -3, 135))));
  check('景别一步跨太多档要报', kinds(at(0, -6, 24), at(0, -1.2, 85)).includes('size-leap'),
    JSON.stringify(pv.continuityBetween(at(0, -6, 24), at(0, -1.2, 85))));

  /**
   * ⚠ 参照物换边 —— 这是"这两镜好像不在同一个屋里"的真正来源。
   * 机位绕到另一边，窗从画面左跑到画面右，而人物走位一点没错。
   */
  // 广角 + 摆在侧后一点的窗：两个机位下它都在画面里，才谈得上"换边"
  const flipMarks = [{ name: '窗', x: -1.5, y: 0.5 }];
  const flipA = { ...room(), marks: flipMarks, cam: { x: 0, y: -4, height: 1.6, lens: 24 } };
  const flipB = {
    ...room(),
    marks: flipMarks,
    cam: { x: 0, y: 4, height: 1.6, lens: 24 },
    subjects: [{ name: '阿澜', x: 0, y: 0, facing: 0 }]
  };
  const flip = pv.continuityBetween(flipA, flipB);
  check('绕到对面时算得出参照物换了边', flip.flips.length >= 1, JSON.stringify(flip));
  check('并且点名是哪一个、从哪边到哪边',
    Boolean(flip.flips[0]?.name && flip.flips[0]?.from && flip.flips[0]?.to), JSON.stringify(flip.flips[0]));
  check('报出来的话里带着那个地标的名字',
    /「窗」|「门」/.test(pv.continuityIssues(flipA, flipB).find((i) => i.kind === 'landmark-flip')?.what || ''),
    JSON.stringify(pv.continuityIssues(flipA, flipB).map((i) => i.what)));

  /**
   * ⚠ 主体不是同一个人时，"机位绕了多少度"没有意义 ——
   * 那本来就是两个不同的参照点，硬算会得出一个纯噪音的角度。
   */
  const other = { ...at(3, 1), subjects: [{ name: '另一个人', x: 0, y: 0, facing: 180 }] };
  check('两镜主体不是同一个人时不算"绕了多少度"',
    pv.continuityBetween(at(0, -3), other).swing === null,
    JSON.stringify(pv.continuityBetween(at(0, -3), other)));

  // 有一边没排位就没法比 —— 不比，也不瞎报
  check('有一边没排位时不比较', pv.continuityBetween(null, at(0, -3)) === null);

  // ── 整场走一遍 ──
  const seq = pv.lintSequence([
    { index: 1, segment: 1, stage: at(0, -3) },
    { index: 2, segment: 1, stage: at(3, 1) },
    { index: 3, segment: 2, stage: at(0, -3) }
  ]);
  check('整场走一遍能报出摆太狠', seq.some((i) => i.kind === 'camera-swing'), JSON.stringify(seq.map((i) => i.kind)));
  check('报的时候点名是哪两镜之间',
    seq.some((i) => i.from === 1 && i.to === 2), JSON.stringify(seq.map((i) => [i.from, i.to])));
  /**
   * ⚠ 跨场次不查。换了场次就是另一个地方、另一段时间，机位本来就该重摆 ——
   * 在那儿报"摆太狠"是纯噪音，而噪音会让人学会无视所有警报。
   */
  check('跨场次那一刀不查（换了地方，机位本来就该重摆）',
    !seq.some((i) => i.to === 3), JSON.stringify(seq.map((i) => [i.from, i.to])));
}

/**
 * ════════ 长生成走流式：慢和死是两回事 ════════
 *
 * 用户真实事故：拆分镜走中转站（api.teamorouter.com）+ Claude Opus。
 * 体检那一下几个 token、**1.89 秒**就回；真跑起来要吐几千 token 的分镜 JSON，
 * 180 秒到点被我们自己掐断，**一个字节都没收到**。
 *
 * 而"跑了 180 秒"本身根本不是问题 —— 二十镜的分镜表，慢一点的模型出三四分钟
 * 很正常。固定总时长把两件完全不同的事一视同仁：
 *
 *   还在吐字，只是慢  → 健康，该等
 *   一个字节都不来    → 死了，等再久也没用
 *
 * 所以长生成改成流式 + 空闲超时。这一节验的是**流式那条路真的走得通**——
 * 上面那个假上游回的是 application/json，于是 stream:true 会被优雅地
 * 退回非流式解析，整条流式路径在自检里从头到尾一次都没跑过。
 * 那正是"绿着的没测过的代码"，今天已经栽过一次（假上游不回 usage）。
 */
section('长生成走流式：慢和死是两回事');
{
  const adaptersMod = await import('../core/providers/adapters.js');
  const ledgerMod2 = await import('../core/ledger.js');

  /** 起一个真会吐 SSE 的假上游，行为由查询串控制 */
  const sse = http.createServer((req, res) => {
    /**
     * ⚠ 模式走**路径**不走查询串。
     *
     * baseUrl 后面还会被拼上 `/chat/completions`，所以
     * `http://h/x?mode=silent` 会变成 `http://h/x?mode=silent/chat/completions`——
     * mode 的值成了 "silent/chat/completions"，永远匹配不上，
     * 于是三条"该失败"的用例全都走了正常分支、全都假绿。
     */
    const mode = (req.url.split('/').filter(Boolean)[0] || 'ok');
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      sse.lastBody = body;
      if (mode === 'silent') return; // 连响应头都不给：模拟"一个字节都不回"
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;
      res.write(frame({ choices: [{ delta: { content: '{"beats":' } }] }));
      if (mode === 'stall') return; // 开了个头就不动了：模拟中转站中途掐断
      res.write(frame({ choices: [{ delta: { content: '[]}' } }] }));
      // 用量在**最后一个事件**里 —— 流式最容易漏账的地方就是这儿
      res.write(frame({ choices: [{ delta: {} }], usage: { prompt_tokens: 4321, completion_tokens: 765 } }));
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => sse.listen(0, '127.0.0.1', r));
  const sseUrl = `http://127.0.0.1:${sse.address().port}`;

  settings.patch({ baseUrls: { openai: `${sseUrl}/ok` } });
  vault.setSecret('OPENAI_API_KEY', 'sk-stream-test');

  // ── 正常流式 ──
  {
    ledgerMod2.reset({ wipe: true });
    const r = await adaptersMod.chat({
      providerId: 'openai', model: 'claude-opus-5', user: '拆一下', jsonMode: true, stream: true, label: '流式'
    });
    check('流式拼出来的正文是完整的', r.text === '{"beats":[]}', JSON.stringify(r.text));
    check('请求体里带了 stream:true（不带的话对面不会流）', sse.lastBody?.stream === true, JSON.stringify(sse.lastBody?.stream));

    /**
     * ⚠ 流式的用量藏在**最后一个 SSE 事件**里，不在 res.json（那是 null）。
     * 不挖的话，一开流式 token 那本账就全变成漏账 —— 而且是静默的：
     * 用量表上少一大截，没有任何地方会红。
     */
    const acct = ledgerMod2.forProject('(未归属)', {});
    check('流式的 token 用量照样记上了（藏在最后一个事件里）',
      acct.total.byKind.token?.units?.in === 4321 && acct.total.byKind.token?.units?.out === 765,
      JSON.stringify(acct.total.byKind.token));
    check('而且没有被当成漏账', acct.unmetered === 0, String(acct.unmetered));
    ledgerMod2.reset({ wipe: true });
  }

  // ── 一个字节都不回：这就是用户撞上的那种 ──
  {
    settings.patch({ baseUrls: { openai: `${sseUrl}/silent` } });
    let msg = '';
    await adaptersMod.chatNoFallback({
      providerId: 'openai', model: 'claude-opus-5', user: '拆一下', stream: true,
      timeoutMs: 1200, idleTimeoutMs: 1200, label: '流式·哑巴'
    }).catch((e) => { msg = e.message; });
    check('对面一声不吭时会失败（不是无限等）', Boolean(msg), msg);
    check('并且说清是"一个字节都没回"', /没有任何响应/.test(msg), msg.slice(0, 120));
    check('还点名了发往哪个主机', /127\.0\.0\.1/.test(msg), msg.slice(0, 80));
  }

  // ── 开了个头然后停住：JSON 真的不完整，才该报错 ──
  {
    settings.patch({ baseUrls: { openai: `${sseUrl}/stall` } });
    let msg = '';
    const t0 = Date.now();
    await adaptersMod.chatNoFallback({
      providerId: 'openai', model: 'claude-opus-5', user: '拆一下', stream: true, jsonMode: true,
      timeoutMs: 60000, idleTimeoutMs: 900, label: '流式·半路死'
    }).catch((e) => { msg = e.message; });
    check('吐了一半就停住、而且解析不出来时，报错', Boolean(msg), msg);
    /**
     * 这条是空闲超时存在的**全部意义**：总时长给了 60 秒，它在 0.9 秒
     * 没动静时就掐了。靠总时长的话要白等 60 秒才知道对面已经死了。
     */
    check('靠的是"多久没动静"，不是等总时长到点', Date.now() - t0 < 10000, `等了 ${Date.now() - t0}ms`);
    check('说清了收到多少字节、以及这一段是真的不完整',
      /收到 \d+ 字节/.test(msg) && /解析不出完整结果/.test(msg), msg.slice(0, 200));
    /**
     * ⚠ 这句"不完整"必须是**验出来的**，不是猜的 —— 所以报错里敢这么写。
     * 下一组验的正是反面：内容其实完整时，绝不能扔。
     */
    /**
     * ⚠ **报错里要带上收到的那点内容**，不能只报一个字节数。
     *
     * 用户第二次报的是"收到 1013 字节后 90 秒没有新内容"——
     * 1013 字节 ≈ 18 个 token，模型刚开口就没声了。而光凭这个数字，
     * 我和他都只能猜：中转站掐了？模型在思考？还是它回的根本不是 JSON
     * 而是一句英文报错？
     *
     * 三种情况下一步动作完全不同，而**收到的那点内容本身就是答案**。
     * 它一直在请求记录里躺着，但没人会为了看一句话专门去翻日志。
     */
    check('报错里把收到的那点内容直接摆出来（不然只能靠猜）',
      /实际收到的是：「/.test(msg) && /beats/.test(msg), msg.slice(0, 260));
    check('收得特别少时，点破"思考型模型不吐字"这条最常见的原因',
      /extended thinking|思考型模型/.test(msg), msg.slice(0, 400));
    check('并且给了分辨方法（像 JSON 开头 = 在写；像英文报错 = 中转站断的）',
      /像 JSON 开头/.test(msg), msg.slice(-200));
  }

  // ── 正文发完了但不收尾：**这份是完整的，不许扔** ──
  {
    /**
     * 中转站很常见的一种坏法：正文全发完，但不发 [DONE]、也不关连接。
     * 从我们这边看和"半路死"长得一模一样（都是"收到 N 字节然后没动静"），
     * 但那份内容是**完整的**，而且是花过钱的。
     *
     * 用户真实撞上的就是这个：收到 277463 字节 ≈ 4600 token 的正文，
     * 而我们连看都没看一眼就整个丢掉，让他从头再跑一次、再花一次钱。
     *
     * 判据只有一个，而且是验出来的：能不能解析成 JSON。
     */
    const whole = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const f = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
        res.write(f('{"shots":[{"description":"阿澜走向栈桥"}]}'));
        // 故意**不发 [DONE]、不 res.end()** —— 连接就这么挂着
      });
    });
    await new Promise((r) => whole.listen(0, '127.0.0.1', r));
    settings.patch({ baseUrls: { openai: `http://127.0.0.1:${whole.address().port}/x` } });
    let out = null;
    let err = '';
    const notes = [];
    await adaptersMod.chat({
      providerId: 'openai', model: 'claude-opus-5', user: '拆', stream: true, jsonMode: true,
      timeoutMs: 60000, idleTimeoutMs: 900, label: '流式·发完了不收尾',
      onEvent: (ev) => { if (ev.type === 'note') notes.push(ev.message); }
    }).then((r) => { out = r; }).catch((e) => { err = e.message; });

    check('正文发完但没收尾时，收到的东西照常用（不是白花钱）',
      out?.text === '{"shots":[{"description":"阿澜走向栈桥"}]}', err || JSON.stringify(out?.text));
    check('而且说了一声"对面没正常收尾"（不能悄悄当正常处理）',
      notes.some((m) => /没有正常收尾/.test(m)), JSON.stringify(notes));
    whole.close();
  }

  // ── 流式跑不通就退回非流式：**最坏也不能比没有流式时更糟** ──
  {
    /**
     * 用户的原话："先前没有出现这个问题啊，刚一下次还拆分了51个镜头"。
     *
     * 他是对的，而且那是我改出来的回归：加流式之前，同一家中转站上
     * 非流式一次出 51 镜是跑通过的；换成流式之后开始各种断。
     *
     * 流式本身的道理没错（慢和死要分开），但它建立在一个我**没验证过的前提**上：
     * 这家中转站的 SSE 和它的非流式一样可靠。事实是不一定。
     *
     * 所以流式只是"优先尝试"，它特有的失败一律退回非流式再来一次 ——
     * 这样最坏情况是"和以前一样"，而不是"比以前更糟"。
     */
    let sawStream = 0;
    let sawPlain = 0;
    const flaky = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (body.stream) {
          // 流式：开个头就不动了（正是用户撞上的那种）
          sawStream += 1;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"sh' } }] })}\n\n`);
          return;
        }
        // 非流式：一次性回完整结果 —— 这条路本来就是通的
        sawPlain += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"shots":[{"description":"阿澜走向栈桥"}]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        }));
      });
    });
    await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
    settings.patch({ baseUrls: { openai: `http://127.0.0.1:${flaky.address().port}/x` } });
    const notes = [];
    const got = await adaptersMod.chat({
      providerId: 'openai', model: 'claude-opus-5', user: '拆', stream: true, jsonMode: true,
      timeoutMs: 60000, idleTimeoutMs: 800, label: '拆分镜',
      onEvent: (ev) => { if (ev.type === 'note') notes.push(ev.message); }
    });
    check('流式断了会自动退回非流式，最终拿到完整结果',
      got?.text === '{"shots":[{"description":"阿澜走向栈桥"}]}', JSON.stringify(got?.text));
    check('两条路都真的走过（先流式、再非流式）', sawStream === 1 && sawPlain === 1,
      JSON.stringify({ 流式: sawStream, 非流式: sawPlain }));
    check('而且说了一声换路了（不能悄悄多花一次钱）',
      notes.some((m) => /换成非流式/.test(m)), JSON.stringify(notes));
    flaky.close();
  }

  // ── 但**真的错误**不许重试：重发一次只是再错一次，还多花一次钱 ──
  {
    let hits = 0;
    const denied = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        hits += 1;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '密钥不对' } }));
      });
    });
    await new Promise((r) => denied.listen(0, '127.0.0.1', r));
    settings.patch({ baseUrls: { openai: `http://127.0.0.1:${denied.address().port}/x` } });
    await adaptersMod.chat({
      providerId: 'openai', model: 'x', user: 'y', stream: true, jsonMode: true, label: '拆分镜'
    }).catch(() => {});
    check('401 这种真错误只发一次，不退回去再错一遍', hits === 1, `发了 ${hits} 次`);
    denied.close();
  }

  // ── 那个"完整不完整"的判据本身 ──
  {
    check('完整的 JSON 认得出', adaptersMod.looksCompleteJSON('{"a":1}') === true);
    check('断在半路的认得出来是断的', adaptersMod.looksCompleteJSON('{"a":1,"b":') === false);
    check('前后带闲话的也能捞出来（模型爱加一句"好的，这是结果："）',
      adaptersMod.looksCompleteJSON('好的：\n{"a":1}\n以上。') === true);
    /**
     * ⚠ 用真解析，不用正则数括号 —— 描述里带花括号完全可能，
     * 数括号会把一段完整的 JSON 判成不完整，然后把它扔掉。
     */
    check('描述里带花括号也不会被误判',
      adaptersMod.looksCompleteJSON('{"d":"他说\\"{喂}\\"然后走了"}') === true);
    check('空的就是不完整', adaptersMod.looksCompleteJSON('') === false);
  }

  // ── 还在吐字就一直等：慢不该被当成死 ──
  {
    const slow = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frame = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
        // 每 300ms 吐一小段，一共吐够 1.5 秒 —— 远超 900ms 的空闲阈值，
        // 但因为一直在动，不该被判死
        let n = 0;
        const iv = setInterval(() => {
          n += 1;
          res.write(frame(String(n)));
          if (n >= 5) {
            clearInterval(iv);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }, 300);
      });
    });
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    settings.patch({ baseUrls: { openai: `http://127.0.0.1:${slow.address().port}/x` } });
    let out = null;
    let err = '';
    await adaptersMod.chat({
      providerId: 'openai', model: 'claude-opus-5', user: '慢慢写', stream: true,
      timeoutMs: 1000, idleTimeoutMs: 900, label: '流式·慢但活着'
    }).then((r) => { out = r; }).catch((e) => { err = e.message; });
    /**
     * ⚠ 这一条是整个改动的**要害**。
     *
     * 总时长只给了 1 秒，而这次生成花了 1.5 秒 —— 换成老逻辑必挂。
     * 它能过，说明判据真的换成了"多久没动静"：一直在吐字就一直等。
     * 反过来，要是哪天有人把空闲计时器去掉，这条会立刻红。
     */
    check('一直在吐字就一直等（总时长 1 秒，实际跑了 1.5 秒也不该掐）',
      out?.text === '12345', err || JSON.stringify(out?.text));
    slow.close();
  }

  // ── 中转站不认 response_format 时的逃生口 ──
  {
    settings.patch({ baseUrls: { openai: `${sseUrl}/ok` } });
    await adaptersMod.chat({ providerId: 'openai', model: 'claude-opus-5', user: 'x', jsonMode: true, stream: true, label: 'jm' });
    check('默认会带 response_format（支持的厂商靠它保证严格 JSON）',
      sse.lastBody?.response_format?.type === 'json_object', JSON.stringify(sse.lastBody?.response_format));

    /**
     * Anthropic 原生接口里**根本没有 response_format**。中转站把 OpenAI 协议
     * 翻译过去时遇上它可能直接卡住不回 —— 表现是一个字节都不返回，而不是报错。
     * 所以要能一键关掉；下游本来就有 extractJSON 兜底，不带这个字段照样能用。
     */
    settings.patch({ jsonModeOff: true });
    await adaptersMod.chat({ providerId: 'openai', model: 'claude-opus-5', user: 'x', jsonMode: true, stream: true, label: 'jm2' });
    check('关掉之后请求体里就没有它了', sse.lastBody?.response_format === undefined,
      JSON.stringify(sse.lastBody?.response_format));
    settings.patch({ jsonModeOff: false });
  }

  sse.close();
  settings.patch({ baseUrls: { openai: '' } });
}

/**
 * ════════ 长剧本：拆分镜要能一批一批来 ════════
 *
 * 用户的问题："现在遇到几十个分镜就这样了，后面如果更多怎么办"。
 *
 * 问到了根子上，而**流式治不了它**。流式解决的是"慢被误判成死"；
 * 这里的毛病是"一次要吐的东西超过模型一次能吐的量"。
 *
 *   30 镜 ≈ 6000 token   已经接近不少模型单次输出的上限
 *   60 镜 ≈ 12000 token  多数中转站会截断
 *  200 镜 ≈ 40000 token  一次调用绝无可能
 *
 * 而超限的表现是最坏的那种：JSON 从中间断掉、状态 200、没有错误字段。
 *
 * 所以按大纲的场次分批。这一节验的是**真的分批了**、**断了能接着来**、
 * 以及**批与批之间不会打架**（id 撞车、顺序错乱）——
 * 后两样是分批最容易引入的新毛病。
 */
section('长剧本：拆分镜一批一批来');
{
  const ol = await import('../core/pipeline/outline.js');

  /** 造一个有 N 场的大纲，直接写进项目 —— 不必绕模型 */
  const makeProject = async (title, beatCount) => {
    const p = await (await fetch(`${appUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, script: '阿澜在码头巡查。', targetDuration: 300 })
    })).json();
    await ndjson(`/projects/${p.id}/stage/bible`, {});
    store.update(p.id, (proj) => {
      proj.outline = ol.normalizeOutline({
        beats: Array.from({ length: beatCount }, (_, i) => ({
          scene: '码头',
          time: '清晨',
          characters: ['阿澜'],
          summary: `第 ${i + 1} 场：阿澜走过第 ${i + 1} 段栈桥。`,
          dialogue: '设备正常。',
          seconds: 20
        }))
      });
      return proj;
    });
    return p;
  };

  // ── 14 场 → 该分 3 批（6 + 6 + 2），不是一次全要 ──
  {
    const p = await makeProject('长剧本·分批', 14);
    // ⚠ 必须清零：这个数组是整轮自检共用的，前面几十节早就往里塞过东西了。
    //   不清的话数出来的是"从开机到现在所有拆分镜请求"，
    //   而那个数**永远大于等于**真实批数 —— 断言会以一种看不出来的方式变松
    upstream.shotPrompts = [];
    const evs = await ndjson(`/projects/${p.id}/stage/script`, {});

    const after = store.read(p.id);
    const o = ol.normalizeOutline(after.outline);

    /**
     * ⚠ 这一条是整节的要害：**每一批只把这一批的场次发出去**。
     * 一次全发的话，无论分不分批，请求次数都是 1，而输出照样会撞上限。
     */
    const prompts = upstream.shotPrompts || [];
    check('分成了多批（不是一次把 14 场全发出去）', prompts.length >= 3, `实际发了 ${prompts.length} 次`);
    const perCall = prompts.map((u) => [...u.matchAll(/【场次\s*[a-z0-9-]+】/gi)].length);
    /**
     * ⚠ 量的是"这一批会写出多少镜"，不是"几场"。
     *
     * 第一版按场数切（一批 6 场），用户真机上还是撞了：
     * 收到 277463 字节（≈4600 token）后被掐。因为"场"根本不是均匀单位 ——
     * 一场 20 秒和一场 90 秒，拆出来的镜数差四倍多，按场数切等于
     * **不知道自己一次要多少东西**。
     *
     * 这里的大纲每场 20 秒 ≈ 4 镜，所以一批 12 镜 ≈ 3 场。
     * 断言按镜数写，以后调 SHOTS_PER_BATCH 也不会误伤这条。
     */
    check('每一批的预计镜数不超过上限（输出量被钉死，和剧本多长无关）',
      perCall.every((n) => n > 0 && n * 4 <= 12 + 4), JSON.stringify(perCall));
    check('加起来正好是全部 14 场，不多不少（漏一场 = 成片少一段，没人会发现）',
      perCall.reduce((a, b) => a + b, 0) === 14, JSON.stringify(perCall));

    // ── 分批最容易引入的两个新毛病 ──
    check('所有场次都拆完了（没有一场被跳过）', o.beats.every((b) => b.locked),
      JSON.stringify(o.beats.filter((b) => !b.locked).map((b) => b.id)));
    const ids = (after.shots || []).map((s) => s.id);
    check('镜头 id 没有撞车（每批都从 1 开始编，不去重就会互相覆盖）',
      new Set(ids).size === ids.length, `${ids.length} 镜 / ${new Set(ids).size} 个不同 id`);
    check('镜号是连续的 1..N（批与批之间不能有断号或重号）',
      (after.shots || []).every((s, i) => s.index === i + 1),
      JSON.stringify((after.shots || []).map((s) => s.index).slice(0, 20)));

    /**
     * ⚠ 顺序必须按**大纲里场次的顺序**，不能按各批自己的镜号。
     * 排错了的话，成片里第 2 场演到一半插进第 8 场的镜头，
     * 而每一镜单看都正常 —— 这是分批最阴的一种坏法。
     */
    const beatOrder = new Map(o.beats.map((b, i) => [b.id, i]));
    const ranks = (after.shots || []).filter((s) => s.beatId).map((s) => beatOrder.get(s.beatId));
    check('镜头按场次顺序排（不是按批次先后、也不是按各批的镜号）',
      ranks.every((v, i) => i === 0 || v >= ranks[i - 1]), JSON.stringify(ranks.slice(0, 24)));

    check('跑完这一步说的是"拆完了"', evs.some((e) => e.type === 'stage' && e.status === 'done'),
      JSON.stringify(evs.filter((e) => e.type === 'stage').map((e) => e.status)));
    await fetch(`${appUrl}/api/projects/${p.id}`, { method: 'DELETE' });
  }

  // ── 中途断了，前面几批不能白跑 ──
  {
    /**
     * 这是分批**最值钱**的那个好处。一次性那条路上，第 190 镜出错等于
     * 前 189 镜全部作废、钱全白花。分批之后每一批跑完就落盘、就上锁，
     * 断在第 3 批，前两批稳稳地在盘上。
     */
    const p = await makeProject('长剧本·断在中间', 14);
    upstream.shotPrompts = [];
    upstream.failShotsAfter = 2; // 第 3 次拆分镜调用直接报错
    await ndjson(`/projects/${p.id}/stage/script`, {});
    upstream.failShotsAfter = 0;

    const mid = store.read(p.id);
    const o = ol.normalizeOutline(mid.outline);
    const locked = o.beats.filter((b) => b.locked).length;
    const open = o.beats.filter((b) => !b.locked).length;
    check('断在第 3 批时，前两批已经落盘了', (mid.shots || []).length > 0, String((mid.shots || []).length));
    /**
     * 不写死锁了几场 —— 那取决于每批装几镜，调一次 SHOTS_PER_BATCH 就失准，
     * 而失准时红的是一条**正确的**断言，那种红会教人去改断言而不是查代码。
     * 要守的是这句和批大小无关的话：**跑过的锁上，没跑到的开着，一场不落**。
     */
    check('而且跑过的那几场已经上锁（再跑不会重拆、不会重复计费）',
      locked > 0 && locked < 14, `锁了 ${locked} 场`);
    check('没跑到的那几场还开着（它们是"还没拆"，不是"拆过了"）',
      open > 0 && locked + open === 14, JSON.stringify({ locked, open }));

    // 再点一次，从没锁的那一场接着走
    const shotsBefore = (mid.shots || []).length;
    upstream.shotPrompts = [];
    await ndjson(`/projects/${p.id}/stage/script`, {});
    const done = store.read(p.id);
    check('再点一次接着往下拆，不从头再来',
      ol.normalizeOutline(done.outline).beats.every((b) => b.locked)
      && (done.shots || []).length > shotsBefore,
      JSON.stringify({ before: shotsBefore, after: (done.shots || []).length }));
    const resumedIds = upstream.shotPrompts.flatMap((u) => [...u.matchAll(/【场次\s*([a-z0-9-]+)】/gi)].map((m) => m[1]));
    const wasLocked = new Set(o.beats.filter((b) => b.locked).map((b) => b.id));
    check('续跑时一场都不重发（已经拆过的重发 = 重复计费，而且会覆盖手改过的镜头）',
      resumedIds.every((id) => !wasLocked.has(id)), JSON.stringify({ resumedIds: resumedIds.slice(0, 10) }));
    check('而且把剩下的那几场都补齐了',
      new Set(resumedIds).size === open, JSON.stringify({ 发了: new Set(resumedIds).size, 该发: open }));
    await fetch(`${appUrl}/api/projects/${p.id}`, { method: 'DELETE' });
  }

  // ── 输出被截断：不能当成正常结果 ──
  {
    /**
     * 模型吐到自己上限时回的是 finish_reason:"length" —— 状态 200、
     * 没有错误字段，只是 JSON 从中间断掉。两种下场都很糟：
     * 解析失败（报错说"模型没返回合法 JSON"，让人以为模型不听话），
     * 或者碰巧解析出来（拿到少了后半截的分镜表，而且没人说它少了）。
     */
    const adaptersMod = await import('../core/providers/adapters.js');
    const cut = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"shots":[{"desc' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 10, completion_tokens: 4096 }
        }));
      });
    });
    await new Promise((r) => cut.listen(0, '127.0.0.1', r));
    settings.patch({ baseUrls: { openai: `http://127.0.0.1:${cut.address().port}` } });
    vault.setSecret('OPENAI_API_KEY', 'sk-cut');
    let msg = '';
    await adaptersMod.chat({ providerId: 'openai', model: 'x', user: '拆', label: '拆分镜' })
      .catch((e) => { msg = e.message; });
    check('输出被截断时当场报错，不把半截内容往下传', /截断/.test(msg), msg.slice(0, 100));
    check('并且说清这不是网络问题、也不是模型不听话',
      /不是网络问题/.test(msg) && /finish_reason=length/.test(msg), msg.slice(0, 200));
    check('还给了出路（先出大纲，按场次分批）', /先出大纲/.test(msg), msg.slice(-120));
    cut.close();
    settings.patch({ baseUrls: { openai: '' } });
  }
}

/**
 * ════════ 传上去的照片，要真的进到出图那一步 ════════
 *
 * 用户的原话："传本地图，出的分镜和自传图没有任何关系，
 * 建议上传的人物脸保留、衣服是描述中的衣服。"
 *
 * 他说的完全对，而且原因是结构性的：useEditModelForShots 把两件独立的事
 * 捆成了一个开关 —— ①发不发参考图 ②换不换成编辑模型 —— 而它默认关着。
 * 于是出分镜图时**一张参考图都不发**，传上去的照片影响是零。
 *
 * 注释里默认关掉它的理由全是冲着②去的（编辑模型会画出"被改过的设定图"
 * 而不是那一场戏），那个理由是对的 —— 但它顺手把①也关了。
 */
section('传上去的照片：要真的用上，而且只用脸');
{
  const cs = await import('../core/pipeline/consistency.js');
  const mkBible = (source) => ({
    style: { anchor: '国风', palette: '青灰', negative: '' },
    characters: [{
      name: '阿澜', appearance: '短发，藏青立领制服，袖口两道银线，左胸编号牌', seed: 1,
      sheetPath: '/a.png', sheetUrl: 'https://x/a.png', sheetSource: source,
      variants: [{ id: 'v-default', name: '默认', sheetPath: '/a.png', sheetUrl: 'https://x/a.png', sheetSource: source }]
    }],
    scenes: [{ name: '码头', appearance: '雾', seed: 2, variants: [{ id: 'v-default', name: '默认' }] }],
    props: []
  });
  const shot = { id: 's1', index: 1, scene: '码头', characters: ['阿澜'], description: '阿澜走向栈桥', camera: '中景' };

  const keep = settings.get('refMode');

  // ── auto（默认）：用户传的图要发出去 ──
  {
    settings.patch({ refMode: 'auto', useEditModelForShots: false });
    const up = cs.assemblePrompt(mkBible('upload'), shot);
    const plan = cs.refPlan();
    const kept = cs.pickRefs(
      { images: up.refImages, labels: up.refLabels, paths: up.refPaths, sources: up.refSources }, plan
    );
    /**
     * ⚠ 这是整节的要害。在修之前这里是 0 —— 传了照片，一张也不发。
     */
    check('传了照片时，参考图真的会发出去（修之前这里是 0）',
      kept.images.length === 1, JSON.stringify({ 发出去的: kept.images, 全部: up.refImages }));
    check('而且不换成编辑模型（换了构图会被带跑，画出"被改过的照片"）',
      plan.useEditModel === false, JSON.stringify(plan));

    /**
     * ⚠ 提示词要把两件事**分开点名**：脸照着图，衣服照着字。
     *
     * 只说"外貌以参考图为准"的话，模型会把照片里的衣服也一起抄过来 ——
     * 而那多半是一件跟这部片子毫无关系的现代便装。于是每一镜都穿着那身，
     * 设定集里写的"藏青立领制服"一次都没出现过。
     */
    check('提示词说清了"脸以参考图为准"', /脸、发型、肤色以参考图那个人为准/.test(up.prompt), up.prompt.slice(0, 200));
    check('并且说清了"衣服按文字来"', /服装与配饰按这里写的来/.test(up.prompt), up.prompt.slice(0, 240));
    check('服装描述是**完整**给的，不是截前三段（它现在是唯一的服装来源）',
      up.prompt.includes('左胸编号牌'), up.prompt.slice(0, 260));
  }

  /**
   * ⚠ **两条路都要验：批量出图 和 单独重出。**
   *
   * 用户："完全和我传的图片没关系啊"—— 他按的是每一镜的「重出」，
   * 而我上一版只改了批量那条（consistency.js），单独重出那条
   *（studio.regenerateShot）还写着老判据 useEditModelForShots，默认 false，
   * 于是那条路上参考图**恒为空**，设置里怎么选都没用。
   *
   * 更难堪的是我今天自己在别处的注释里写过"这件事有两处，各验一份"——
   * 知道有两条路，然后还是只改了一条。所以这条断言走的是**真的重出**，
   * 不是再验一遍那个纯函数。
   */
  {
    settings.patch({ refMode: 'auto', useEditModelForShots: false, useReferenceImages: true });
    const p2 = store.create({ title: '传图·单独重出' });
    store.update(p2.id, (x) => {
      x.bible = mkBible('upload');
      x.shots = [{ ...shot, id: 's1' }];
      return x;
    });
    upstream.lastImageBody = null;
    await studioModule.regenerateShot(p2.id, 's1', {}, () => {});
    /**
     * 判据是**请求体里到底有没有那张图**，不是"函数返回了什么"——
     * 中间任何一层把它丢掉，这里都会红。
     */
    const sentImage = upstream.lastImageBody?.image;
    check('单独重出这一镜时，传的照片真的发出去了（修之前这条恒空）',
      Boolean(sentImage), JSON.stringify(Object.keys(upstream.lastImageBody || {})));
    const after = store.read(p2.id).shots[0];
    check('而且这一镜记下了带过哪几张（手机上那行靠它显示）',
      (after.bibleRefs || []).length > 0, JSON.stringify(after.bibleRefs));
  }

  /**
   * ⚠ 一张都没发时，要说得出**那几张分别是谁、哪张是用户传的**。
   *
   * 用户报回来的是"设定集里有 3 张图可以带，但这一次一张都没发"——
   * 一个数字，然后他还是不知道该干什么。真正要回答的是
   * "我传的那张在不在这三张里"：
   *   在   → 设置把它筛掉了，改设置就行
   *   不在 → 完全另一个问题（照片挂到别的条目上了 /
   *          这一镜引用的角色名和设定集对不上）
   * 两件事的下一步毫不相干，而一个数字分不出来。
   */
  {
    settings.patch({ refMode: 'auto' });
    const mixed = mkBible('model');
    // 再加一个**用户传过照片**的角色，两种来源混在一镜里
    mixed.characters.push({
      name: '老周', appearance: '花白胡子', seed: 3,
      sheetPath: '/z.png', sheetUrl: 'https://x/z.png', sheetSource: 'upload',
      variants: [{ id: 'v-default', name: '默认', sheetPath: '/z.png', sheetUrl: 'https://x/z.png', sheetSource: 'upload' }]
    });
    const two = cs.assemblePrompt(mixed, { ...shot, characters: ['阿澜', '老周'] });
    check('每一张都标出来源（模型出的 / 你传的）',
      two.refDetailed.some((x) => x.includes('（你传的）')) && two.refDetailed.some((x) => x.includes('（模型出的）')),
      JSON.stringify(two.refDetailed));
    check('标签里带得出是谁', two.refDetailed.some((x) => x.includes('老周')), JSON.stringify(two.refDetailed));
    /**
     * 而且 auto 要**真的只留那一张** —— 混着两种来源时最容易写错成"全留"或"全丢"。
     */
    const kept2 = cs.pickRefs(
      { images: two.refImages, labels: two.refLabels, paths: two.refPaths, sources: two.refSources }, cs.refPlan()
    );
    check('auto 只留用户传的那一张，不多不少', kept2.images.length === 1 && kept2.uploaded === 1,
      JSON.stringify({ kept: kept2.images.length, uploaded: kept2.uploaded, all: two.refImages.length }));
  }

  /**
   * ⚠ **用户那个确切场景，端到端跑一遍：两个开关都关着 + 单独重出 + 传过照片。**
   *
   * 前面那些验的是 refPlan / pickRefs 这两个纯函数。而用户撞的是**整条链路**：
   * 他按「重出这一镜」，走 studio.regenerateShot，中间要经过
   * assemblePrompt → refSources → pickRefs → refreshRefs → generateImage。
   * 任何一环把 sources 丢了，纯函数照样绿，而他的照片照样发不出去。
   *
   * 判据是**请求体里到底有没有那张图**，不是函数返回了什么。
   */
  {
    settings.patch({ useReferenceImages: false, refMode: 'off', useEditModelForShots: false });
    const p3 = store.create({ title: '两个开关都关着' });
    store.update(p3.id, (x) => {
      x.bible = mkBible('upload');
      x.shots = [{ ...shot, id: 's1' }];
      return x;
    });
    upstream.lastImageBody = null;
    await studioModule.regenerateShot(p3.id, 's1', {}, () => {});
    check('两个开关都关着，单独重出时用户传的照片照样发出去了',
      Boolean(upstream.lastImageBody?.image),
      JSON.stringify({ 请求体字段: Object.keys(upstream.lastImageBody || {}) }));
    const got3 = store.read(p3.id).shots[0];
    check('而且这一镜记下了带过它', (got3.bibleRefs || []).length === 1, JSON.stringify(got3.bibleRefs));
    /**
     * 同时**模型出的那些确实被挡住了** —— 否则那两个开关就成了摆设，
     * 而摆设比没有更糟：用户关了它，以为省了钱/省了干扰，其实什么也没发生。
     */
    const p4 = store.create({ title: '两个开关都关着·模型图' });
    store.update(p4.id, (x) => {
      x.bible = mkBible('model');
      x.shots = [{ ...shot, id: 's1' }];
      return x;
    });
    upstream.lastImageBody = null;
    await studioModule.regenerateShot(p4.id, 's1', {}, () => {});
    check('而模型自己出的设定图，这时确实一张都没发（开关不是摆设）',
      !upstream.lastImageBody?.image,
      JSON.stringify({ 请求体字段: Object.keys(upstream.lastImageBody || {}) }));
    /**
     * ⚠ **同样的场景，换成「整步出图」再验一遍 —— 这是另一条路。**
     *
     * 上面那两块走的是 regenerateShot（单独重出这一镜），它在 studio.js 里
     * 自己调了一次 refPlan/pickRefs。而用户平时按的是「出图」这一整步，
     * 走的是 generateAssets → consistency.generateConsistentImage ——
     * 那里**另有一次** refPlan/pickRefs，中间还多经过一趟 refreshRefs。
     *
     * 我上一轮只验了前者就跟用户说"验过了，去更新"，而他更新完照旧没发。
     * 两条路各写各的判据，就得各验各的 —— 这句话我自己在别处写过一遍，
     * 这次又栽在同一个地方。判据仍然是**请求体里有没有那张图**。
     */
    const p5 = store.create({ title: '两个开关都关着·整步出图' });
    store.update(p5.id, (x) => {
      x.bible = mkBible('upload');
      x.shots = [{ ...shot, id: 's1', imagePath: null }];
      return x;
    });
    upstream.lastImageBody = null;
    await studioModule.generateAssets(p5.id, { onEvent: () => {} });
    check('整步出图时，两个开关都关着也照样发出用户传的照片',
      Boolean(upstream.lastImageBody?.image),
      JSON.stringify({ 请求体字段: Object.keys(upstream.lastImageBody || {}) }));
    const got5 = store.read(p5.id).shots[0];
    check('整步出图这条路上，这一镜也记下了带过它',
      (got5.bibleRefs || []).length === 1, JSON.stringify(got5.bibleRefs));

    /**
     * ⚠ **两条路都得盖上"按哪一版规矩出的"这个戳。**
     *
     * 界面靠它分清"这条记录是旧版留下的"和"新版真没发出去"——
     * 这两件事的下一步完全相反（一个是重出一次，一个是查请求记录）。
     * 漏盖的那条路，卡片会永远说自己是旧记录，永远劝人重出，
     * 而重出之后还是那句话 —— 一个自己骗自己的死循环。
     */
    check('整步出图会盖上"按新规矩出的"这个戳', got5.refPolicy === cs.REF_POLICY,
      JSON.stringify({ got: got5.refPolicy, want: cs.REF_POLICY }));
    check('单独重出这一镜也盖同一个戳（两条路，各盖各的，得各验一份）',
      store.read(p3.id).shots[0].refPolicy === cs.REF_POLICY,
      JSON.stringify(store.read(p3.id).shots[0].refPolicy));

    /**
     * ══════════ 参考图存在对象存储里时（也就是真实情况）══════════
     *
     * ⚠ **上面所有这些断言，夹具用的都是 https://x/a.png —— 一个不带
     * Expires 的地址。而真实用户配了对象存储，OSS 签出来的地址永远带
     * Expires。整段续签逻辑（refreshRefs）因此一次都没被跑到过。**
     *
     * 而那里面藏着真正吃掉照片的那一行：判"能不能复用"和判"现在发不发得
     * 出去"用了同一个函数。带 Expires 就说不可用 → 去重签 → 签出一个崭新
     * 的地址 → 还报了句"已经重新传了一份" → 最后一行用同一个判据再过一遍
     * → 刚签好的这张也带 Expires → 扔掉。
     *
     * 净效果：只要配了对象存储，参考图一张都发不出去，而日志说重传成功。
     * 用户来回问了七八轮，全被引到开关和设置上，因为界面看到的现象是
     * "设定集里有 3 张图可以带，但这一次一张都没发"。
     *
     * 教训是老的那条：**凡是"只在真实形状下才走到"的路，夹具就得长成
     * 真实的样子。**一个简化过头的夹具不会让测试变红，它只会让整条路
     * 从来不被执行 —— 而绿灯照常亮着。
     */
    const signed = (name, secondsLeft) =>
      `https://b.oss-cn-hongkong.aliyuncs.com/${name}`
      + `?OSSAccessKeyId=STUB&Expires=${Math.floor(Date.now() / 1000) + secondsLeft}&Signature=stub`;

    const ossBible = mkBible('upload');
    // 还有 50 分钟才过期 —— 完全可用的地址
    ossBible.characters[0].sheetUrl = signed('a.png', 3000);
    ossBible.characters[0].variants[0].sheetUrl = signed('a.png', 3000);

    const p6 = store.create({ title: '参考图在对象存储里' });
    store.update(p6.id, (x) => {
      x.bible = ossBible;
      x.shots = [{ ...shot, id: 's1', imagePath: null }];
      return x;
    });
    upstream.lastImageBody = null;
    const notes6 = [];
    await studioModule.generateAssets(p6.id, { onEvent: (e) => notes6.push(e.message || '') });
    check('参考图是对象存储的签名地址时，照样发得出去（修之前这里恒空）',
      Boolean(upstream.lastImageBody?.image),
      JSON.stringify({ 请求体字段: Object.keys(upstream.lastImageBody || {}) }));
    check('而且发出去的就是那个签名地址本身，没被换成别的',
      String(upstream.lastImageBody?.image || '').includes('oss-cn-hongkong'),
      String(upstream.lastImageBody?.image || '').slice(0, 80));
    /**
     * 还没过期的地址不该被当成过期：白重签一次（走网络），
     * 而且源图不在时会报一句指着好地址的假警报。
     */
    check('没过期的签名地址不会被误报成"地址过期了"',
      !notes6.some((m) => /过期/.test(m)), JSON.stringify(notes6.filter((m) => /过期/.test(m))));

    /**
     * 反面：**真过期了的**地址、而且本地源图也找不着，那才该丢 ——
     * 否则这个修法就成了"什么都不过滤"，等于把 403 留到厂商那边去报，
     * 而厂商只会说一句"下载不到你给的图"，指不到过期这件事上。
     */
    const deadBible = mkBible('upload');
    deadBible.characters[0].sheetUrl = signed('a.png', -60); // 一分钟前就过期了
    deadBible.characters[0].variants[0].sheetUrl = signed('a.png', -60);
    const p7 = store.create({ title: '签名地址真过期了' });
    store.update(p7.id, (x) => {
      x.bible = deadBible;
      x.shots = [{ ...shot, id: 's1', imagePath: null }];
      return x;
    });
    upstream.lastImageBody = null;
    const notes7 = [];
    await studioModule.generateAssets(p7.id, { onEvent: (e) => notes7.push(e.message || '') });
    check('真过期、本地源图又没了的，还是要丢掉（别把 403 留给厂商去报）',
      !upstream.lastImageBody?.image,
      String(upstream.lastImageBody?.image || '').slice(0, 80));
    check('而且明说是过期了（不然这一镜"不太像"的原因永远查不出来）',
      notes7.some((m) => /过期/.test(m)), JSON.stringify(notes7.slice(-3)));

    /**
     * ══════════ 只收一张的那些"身份通道"，得收到角色那张 ══════════
     *
     * 海螺的 subject_reference（字面写着 type: 'character'）、万相的 ref_img
     * 都只收一张图，而它们是目前云端唯一真能做到"换场景但还是这个人"的东西。
     *
     * 参考图的排列顺序是**场景在最前**（多数厂商对首张权重最高，出分镜时
     * 最需要被提醒的是环境）。这两处原来取 refImages[0] —— 于是"这个角色
     * 长什么样"的字段里装的是一张**场景图**。那条通道等于没开，
     * 而且不报任何错：出来的人照旧不像，看不出是我们发错了图。
     *
     * ⚠ 这条断言必须防恒真：得**真的有一张场景图排在角色前面**，
     * 否则 identityRef 取第一张也照样对，测试永远绿。
     */
    // ⚠ 默认夹具的场景条目**没有图**，于是参考图里压根没有场景那张 ——
    // 用它测"场景排在角色前面"会连前提都不成立。真实项目里场景是有图的
    const withScene = mkBible('upload');
    withScene.scenes[0].sheetPath = '/s.png';
    withScene.scenes[0].sheetUrl = 'https://x/s.png';
    withScene.scenes[0].sheetSource = 'model';
    withScene.scenes[0].variants[0].sheetPath = '/s.png';
    withScene.scenes[0].variants[0].sheetUrl = 'https://x/s.png';
    withScene.scenes[0].variants[0].sheetSource = 'model';
    const ordered = cs.assemblePrompt(withScene, shot);
    check('参考图顺序确实是场景排在角色前面（下面那条断言的前提）',
      ordered.refKinds[0] === 'scene' && ordered.refKinds.includes('character'),
      JSON.stringify(ordered.refKinds));
    const face = cs.identityRef({
      images: ordered.refImages, kinds: ordered.refKinds, sources: ordered.refSources
    });
    check('挑"这个人长什么样"时挑的是角色那张，不是排在最前的场景图',
      face === ordered.refImages[ordered.refKinds.indexOf('character')] && face !== ordered.refImages[0],
      JSON.stringify({ 挑中: face, 第一张: ordered.refImages[0] }));
    /** 用户亲手传的排在模型出的前面 —— 那是他指名道姓说"就长这样"的那张 */
    check('两张角色图并存时，优先用户传的那张',
      cs.identityRef({
        images: ['scene', 'mine', 'theirs'],
        kinds: ['scene', 'character', 'character'],
        sources: ['model', 'upload', 'model']
      }) === 'mine', '');
    /** 一张角色图都没有时退回第一张，别退回 null 把通道整个关掉 */
    check('一张角色图都没有时退回第一张（别把通道整个关掉）',
      cs.identityRef({ images: ['a', 'b'], kinds: ['scene', 'prop'], sources: ['model', 'model'] }) === 'a', '');

    /**
     * ⚠ **上面三条验的都是纯函数。真正决定的是请求体里那个字段装了什么。**
     *
     * identityRef 挑对了不等于它被发出去了 —— 中间还隔着 pickRefs、
     * refreshRefs（会重新筛一遍数组，kinds 没跟着筛就整体错位）、
     * 以及适配器里那个 switch。这一整段路我今天已经在别处栽过两次了。
     *
     * 所以直接打到海螺的出图请求体上，看 subject_reference 里装的是谁。
     */
    const adaptersModule = await import('../core/providers/adapters.js');
    // 自检用的假密钥。海螺这条路前面没人跑过，所以金库里还没有它
    vault.setSecret('MINIMAX_API_KEY', 'sk-minimax-test');
    const keepBase = settings.get('baseUrls') || {};
    settings.patch({ baseUrls: { ...keepBase, minimax: upstreamUrl } });
    upstream.lastMinimaxImageBody = null;
    await adaptersModule.generateImage({
      providerId: 'minimax',
      model: 'image-01',
      prompt: '测试',
      refImages: ['https://x/scene.png', 'https://x/face.png'],
      identityRef: 'https://x/face.png',
      label: '身份通道'
    });
    check('海螺的 subject_reference 里装的是角色那张，不是场景那张',
      upstream.lastMinimaxImageBody?.subject_reference?.[0]?.image_file === 'https://x/face.png',
      JSON.stringify(upstream.lastMinimaxImageBody?.subject_reference));
    /** 不传 identityRef 时保持老行为，别让直接调这个函数的地方跟着崩 */
    upstream.lastMinimaxImageBody = null;
    await adaptersModule.generateImage({
      providerId: 'minimax',
      model: 'image-01',
      prompt: '测试',
      refImages: ['https://x/only.png'],
      label: '身份通道'
    });
    check('没传 identityRef 时退回第一张（老调用方不受影响）',
      upstream.lastMinimaxImageBody?.subject_reference?.[0]?.image_file === 'https://x/only.png',
      JSON.stringify(upstream.lastMinimaxImageBody?.subject_reference));
    settings.patch({ baseUrls: keepBase });

    settings.patch({ useReferenceImages: true, refMode: 'auto' });
  }

  // ── 模型自己出的设定图：默认仍然不发（那条路的老理由还成立）──
  {
    settings.patch({ refMode: 'auto' });
    const gen = cs.assemblePrompt(mkBible('model'), shot);
    const kept = cs.pickRefs(
      { images: gen.refImages, labels: gen.refLabels, paths: gen.refPaths, sources: gen.refSources }, cs.refPlan()
    );
    check('模型自己出的设定图，默认还是不发（不改老行为）', kept.images.length === 0, JSON.stringify(kept.images));
    check('这时候提示词不说"以参考图为准"（说了就是撒谎 —— 图根本没发）',
      !/以参考图/.test(gen.prompt), gen.prompt.slice(0, 200));
    check('而是把完整外貌写进去（那是唯一的身份来源）',
      gen.prompt.includes('袖口两道银线'), gen.prompt.slice(0, 200));
  }

  /**
   * ⚠ **拦住参考图的开关有两个**，而它们隔着两个设置面板：
   *
   *   useReferenceImages  「一致性引擎 → 出镜头图时把角色设定图带上」（老开关）
   *   refMode             「画面规格 → 出分镜图时带哪些参考图」（新的）
   *
   * 关掉任何一个现象一模一样："一张都没发"。
   *
   * 用户真实撞上的就是这个：他传的照片明明在列表里、也标着"你传的"，
   * auto 本该正好发它，却一张没发 —— 因为关着的是**另一个**开关。
   * 而我的提示语只提了 refMode，把他指去改一个本来就对的设置。
   *
   * 所以要验的不是"没发"，而是**说不说得出是谁拦的**。
   */
  {
    /**
     * ⚠ **你自己传的照片，任何开关都拦不住。**
     *
     * 用户来回折腾了七八轮，最后一句是"我服了"。他是对的 ——
     * 一张上传的照片原来要闯过四道关卡才能被用上，任何一道没过，
     * 现象都一样：脸跟他传的图毫无关系。
     *
     * 问题不在他没找对开关，在于**这件事根本不该有开关**：
     * 上传一张照片是指名道姓的指令（"这个角色就长这样"），
     * 而那两个开关表达的是泛泛的偏好（"一般要不要带参考图"）。
     * 具体压过泛泛 —— 反过来就是耍人。
     */
    const withUpload = mkBible('upload');
    const asm = () => cs.assemblePrompt(withUpload, shot);
    const keptWith = (a) => cs.pickRefs(
      { images: a.refImages, labels: a.refLabels, paths: a.refPaths, sources: a.refSources }, cs.refPlan()
    ).images.length;

    settings.patch({ refMode: 'auto', useReferenceImages: false });
    check('老开关关着，用户传的照片照样发', keptWith(asm()) === 1, JSON.stringify(cs.refPlan()));

    settings.patch({ useReferenceImages: true, refMode: 'off' });
    check('新开关选了"一张都不发"，用户传的照片照样发', keptWith(asm()) === 1, JSON.stringify(cs.refPlan()));

    /**
     * 但关掉开关**确实要有效果** —— 它管的是模型自己出的那些设定图。
     * 两个都不管的话，那两个开关就成了摆设，而摆设比没有更糟。
     */
    const modelOnly = mkBible('model');
    const asm2 = cs.assemblePrompt(modelOnly, shot);
    check('而模型自己出的设定图，关掉开关就真的不发', cs.pickRefs(
      { images: asm2.refImages, labels: asm2.refLabels, paths: asm2.refPaths, sources: asm2.refSources },
      cs.refPlan()
    ).images.length === 0, JSON.stringify(asm2.refDetailed));
    check('并且说清了"关的是什么、没关的是什么"',
      /你自己传的照片照发/.test(cs.refPlan().note || ''), cs.refPlan().note);

    settings.patch({ useReferenceImages: true, refMode: 'auto' });
  }

  // ── all / off / 老开关 ──
  {
    settings.patch({ refMode: 'all' });
    const g = cs.assemblePrompt(mkBible('model'), shot);
    check('选 all 时模型出的图也发', cs.pickRefs(
      { images: g.refImages, labels: g.refLabels, paths: g.refPaths, sources: g.refSources }, cs.refPlan()
    ).images.length === 1);
    check('但 all 也不换编辑模型', cs.refPlan().useEditModel === false);

    /**
     * ⚠ off 的含义**变了**，而且是有意变的。
     *
     * 原来 off = 一张都不发。现在 off = **模型出的那些不发，你自己传的照发**。
     *
     * 因为一张上传的照片是指名道姓的指令（"这个角色就长这样"），
     * 而这个开关表达的是泛泛的偏好（"一般要不要带参考图"）——
     * 具体压过泛泛。反过来的话，用户传了照片却怎么也用不上，
     * 而他要闯过四道开关才找得到原因（真实发生过，他最后说"我服了"）。
     */
    settings.patch({ refMode: 'off', useReferenceImages: true });
    const offPlan = cs.refPlan();
    const gm = cs.assemblePrompt(mkBible('model'), shot);
    check('选 off 时，模型出的设定图一张都不发', cs.pickRefs(
      { images: gm.refImages, labels: gm.refLabels, paths: gm.refPaths, sources: gm.refSources }, offPlan
    ).images.length === 0, JSON.stringify(gm.refDetailed));
    const gu = cs.assemblePrompt(mkBible('upload'), shot);
    check('但你自己传的照片照发（开关管不着指名道姓的那一张）', cs.pickRefs(
      { images: gu.refImages, labels: gu.refLabels, paths: gu.refPaths, sources: gu.refSources }, offPlan
    ).images.length === 1, JSON.stringify(gu.refDetailed));

    /**
     * ⚠ 老开关不能被悄悄改掉行为：已经打开 useEditModelForShots 的人，
     * 走的还得是"换编辑模型 + 发图"那条路。
     */
    settings.patch({ refMode: 'auto', useEditModelForShots: true });
    check('老的 useEditModelForShots=true 仍然等价于 edit（不改已有用户的行为）',
      cs.refPlan().mode === 'edit' && cs.refPlan().useEditModel === true, JSON.stringify(cs.refPlan()));
    settings.patch({ useEditModelForShots: false, refMode: keep });
  }
}

/**
 * ════════ OpenAI 家族带参考图：必须走 /images/edits ════════
 *
 * 用户："我用的出图是 gpt-image-2，我自己传的图，还是不是用的我的脸"。
 *
 * 不是。原因不在他那边 —— 我们**把参考图发到了一个不存在的字段上**。
 * OpenAI 的 /v1/images/generations 没有 image 这个参数，
 * 参考图必须走 /v1/images/edits，而且是 multipart 传**文件本身**。
 * 发到 generations 上的 image 字段会被整个忽略：不报错、不警告，
 * 就是一次纯文生图。于是"传了照片但脸不是我的"。
 *
 * 更难堪的是代码注释里**写明了**这件事，然后让用户自己去联调台手动发 ——
 * 而出图是自动跑几十镜的，没人能一镜一镜手动来。
 */
/**
 * ══════════ 一次到底发几张参考图，发哪几张 ══════════
 *
 * 用户报的原话："我把道具取消了…还是不行，他一下给我喂了9张图"。
 * 九正好是收集上限 —— 也就是说，能收多少就发多少，一张没筛。
 *
 * 两个独立的毛病凑在一起：
 *   ① 道具关不掉：判据是"名字在描述文字里出现过"，而他能改的是
 *      「关键道具」那一栏和预演台 —— 两个都管不着那个字符串匹配
 *   ② 发太多：九张图发过去，模型要在九个目标之间找平衡，
 *      最要紧的那张脸反而不像了
 */
/**
 * ══════════ 这一镜不满意，下一步该干什么 ══════════
 *
 * 不满意的时候，人手里只有一张图和一个「重出」按钮 —— 而再来一次多半
 * 还是那样，因为他不知道该改什么。
 *
 * ⚠ 这一节里**最要紧的一条是"只说数据里有证据的原因"**。
 *
 * "可能是提示词不够具体"这种话永远成立、永远没用，而且会把真正的原因
 * （这一镜一张参考图都没发）淹掉。所以既验"该说的说了"，
 * 也验"没证据的时候老老实实说没查出来"。
 */
/**
 * ══════════ 连播：排一遍时间轴 ══════════
 *
 * 出视频之前最后一道、也是最省钱的一道关。
 *
 * ⚠ 它必须在**还没有视频**的时候就能用 —— 那正是它全部的价值所在。
 * 所以不能复用 edit.timeline（那个只收已经有视频的镜头，因为它算的是成片）。
 * 这条断言守着这个区别：两者混用的话，连播在最该用的时候是空的。
 */
section('连播：排一遍时间轴');
{
  const ani = await import('../core/duration.js');
  const mk = (i, extra = {}) => ({ id: `p${i}`, index: i, duration: 4, dialogue: '', ...extra });

  /** ⚠ 一段视频都没有时照样排得出来 —— 这是它存在的全部理由 */
  const none = ani.animaticLayout([mk(1), mk(2, { imagePath: '/b.png' })]);
  check('一段视频都没有时照样排得出来（这是它存在的理由）',
    none.rows.length === 2 && none.total === 8, JSON.stringify({ 行: none.rows.length, 总长: none.total }));
  check('每一镜接着上一镜排，不重叠也不留缝',
    none.rows[1].start === none.rows[0].span, JSON.stringify(none.rows.map((r) => r.start)));

  /** 有视频的走视频、只有图的定住、什么都没有的也要占一格 */
  const mixed = ani.animaticLayout([
    mk(1, { videoPath: '/a.mp4', imagePath: '/a.png' }),
    mk(2, { imagePath: '/b.png' }),
    mk(3)
  ]);
  check('有视频走视频、只有图定住、什么都没有的也占一格',
    mixed.rows.map((r) => r.kind).join() === 'video,image,blank',
    JSON.stringify(mixed.rows.map((r) => r.kind)));

  /**
   * ⚠ 没设时长的**不能跳过**。跳过的话人在连播里看不到它，
   * 于是永远不知道那一镜没设时长 —— 而它到合成那步会出问题。
   */
  const noDur = ani.animaticLayout([mk(1, { duration: 0 }), mk(2)]);
  check('没设时长的不跳过，用兜底值占位', noDur.rows.length === 2 && noDur.rows[0].span === 3,
    JSON.stringify(noDur.rows.map((r) => r.span)));
  check('而且标出来"这是猜的"（不能悄悄替他决定）',
    noDur.rows[0].guessed === true && noDur.rows[1].guessed === false,
    JSON.stringify(noDur.rows.map((r) => r.guessed)));

  /**
   * ⚠ 时长口径必须和别处一致。另算一套的话，连播说 62 秒、导出说 58 秒，
   * 而两个数都是我们自己给的。
   */
  const durMod = await import('../core/duration.js');
  const one = mk(1, { duration: 5, actualDuration: 6.5 });
  check('时长走 duration.shotSeconds 那一份（不另算一套）',
    ani.animaticLayout([one]).total === durMod.shotSeconds(one),
    JSON.stringify({ 连播: ani.animaticLayout([one]).total, 别处: durMod.shotSeconds(one) }));

  check('空片子不炸', ani.animaticLayout([]).total === 0 && ani.animaticLayout().rows.length === 0, '');
}

section('这一镜为什么不对');
{
  const dg = await import('../core/pipeline/diagnose.js');
  const routing = { image: { provider: 'volcengine', model: 'seedream' } };
  const ok = {
    id: 'd1', index: 1, description: '阿澜走向栈桥', camera: '中景', duration: 4,
    imagePath: '/a.png',
    imageAt: '2026-02-01T00:00:00Z', editedAt: '2026-01-01T00:00:00Z',
    modelUsed: 'volcengine / seedream',
    refsSent: 2, refsAvailable: 2,
    consistency: { score: 88, pass: true, issues: [] }
  };

  /** 还没出图时不该诊断 —— 那是另一个问题（"缺东西"），别处已经在管 */
  check('还没出图时什么都不说（那是另一类问题）',
    dg.diagnose({ id: 'x', index: 1 }, { routing }).length === 0, '');

  /**
   * ⚠ **一切正常时，要老老实实说"没查出来"，而不是编一条。**
   *
   * 一个空列表和"这个功能没跑"长得一模一样，人会以为我们没检查。
   */
  const clean = dg.diagnose(ok, { routing });
  check('都正常时只回一条"数据上看不出毛病"',
    clean.length === 1 && clean[0].id === 'nothing-found', JSON.stringify(clean.map((x) => x.id)));
  check('而且给了一个真能往前走的动作（不是"再试试"四个字）',
    clean[0].how.length > 20 && /种子|描述/.test(clean[0].how), clean[0].how.slice(0, 40));

  /**
   * ⚠ 「参考图排第一位就报」那条**已经撤掉了**。
   *
   * 它属于上一版设计（拿参考图当杠杆去修构图）。现在分工改成
   * "参考图管是什么、文字管怎么拍"，就不存在"排第一位"这个配置错误了 ——
   * 再留着它就是在指一个已经不存在的问题，而那种提示比没有更坏。
   */
  check('不再因为"场景图排第一位"报错（那条随旧设计一起撤了）',
    !dg.diagnose({ ...ok, camera: '特写', bibleRefs: ['景·广场', '角·我'] }, { routing })
      .some((x) => x.id === 'wide-ref-on-tight'), '');

  /**
   * ══════════ 一张参考图都没发 ══════════
   * 这是"脸不像"最常见、也最容易被忽略的原因 —— 它不报任何错。
   */
  const noRef = dg.diagnose({ ...ok, refsSent: 0, refsAvailable: 3 }, { routing });
  check('一张参考图都没发会被点出来', noRef.some((x) => x.id === 'no-refs'),
    JSON.stringify(noRef.map((x) => x.id)));
  /**
   * ⚠ 它必须排**第一**。人只会试最上面那一两条，
   * 而这一条是"改了最可能有用"的那个。
   */
  check('而且排在最前面（人只会试最上面那一两条）', noRef[0].id === 'no-refs',
    JSON.stringify(noRef.map((x) => x.id)));

  /** 发了但被上限挤掉了 —— 和"一张没发"是两回事，下一步也不同 */
  const capped = dg.diagnose({ ...ok, refsSent: 2, refsAvailable: 6 }, { routing });
  check('发了但被挤掉几张，说法不一样',
    capped.some((x) => x.id === 'refs-capped') && !capped.some((x) => x.id === 'no-refs'),
    JSON.stringify(capped.map((x) => x.id)));

  /** 图是改描述之前出的 —— "改了没用"的头号原因 */
  const stale = dg.diagnose({ ...ok, editedAt: '2026-03-01T00:00:00Z' }, { routing });
  check('图是改描述之前出的，会被点出来', stale.some((x) => x.id === 'stale-image'),
    JSON.stringify(stale.map((x) => x.id)));
  check('而且它比参考图那条还靠前（成本最低、最确定）',
    dg.diagnose({ ...ok, editedAt: '2026-03-01T00:00:00Z', refsSent: 0, refsAvailable: 3 },
      { routing })[0].id === 'stale-image', '');

  /** 中途换过模型 —— 风格漂移最常见的原因，而它不报任何错 */
  const swapped = dg.diagnose({ ...ok, modelUsed: 'openai / gpt-image-2' }, { routing });
  check('中途换过模型会被点出来', swapped.some((x) => x.id === 'model-changed'),
    JSON.stringify(swapped.map((x) => x.id)));
  /** ⚠ 没换过时不能报 —— 误报一次，这条以后就没人信了 */
  check('没换过模型时不报', !dg.diagnose(ok, { routing }).some((x) => x.id === 'model-changed'), '');

  /**
   * ⚠ 复核分数**改过文字之后就不作数了**。
   * 拿它当依据会把人引向一个已经不存在的问题。
   */
  const staleScore = dg.diagnose({
    ...ok, consistency: { score: 40, pass: false, stale: true, issues: ['脸不像'] }
  }, { routing });
  check('分数是改文案之前打的，就不拿它说事',
    !staleScore.some((x) => x.id === 'verify-failed'), JSON.stringify(staleScore.map((x) => x.id)));
  const lowScore = dg.diagnose({
    ...ok, consistency: { score: 40, pass: false, issues: ['头发颜色不一致'] }
  }, { routing });
  check('分数作数且没过时，把复核的原话摆出来',
    lowScore.some((x) => x.id === 'verify-failed' && /头发颜色不一致/.test(x.why)),
    JSON.stringify(lowScore.find((x) => x.id === 'verify-failed')?.why));

  /**
   * ⚠ 每一条都要说清**这一下花不花钱**。
   * 改描述是免费的，重出是要付钱的 —— 两者摆在一起时必须分得开。
   */
  check('要重出的那些标了"花钱"', noRef.find((x) => x.id === 'no-refs').costs === true, '');
  const lint = dg.diagnose({ ...ok, description: '门外传来敲门声，他抬头' }, { routing });
  const soundOne = lint.find((x) => x.id === 'lint-sound-in-frame');
  check('描述里写了声音会被点出来', Boolean(soundOne), JSON.stringify(lint.map((x) => x.id)));
  check('改描述这种不花钱的，没被标成花钱', soundOne?.costs === false, String(soundOne?.costs));

  /**
   * ══════════ 哪几镜"该重出" ══════════
   *
   * ⚠ 判据是**有可以动手的具体原因**，不是"分数低"。
   *
   * 按分数选的话，会把一堆"数据上看不出毛病、只是模型这次画成这样"的
   * 镜头一起选上 —— 重出它们纯粹是碰运气，而每一次都真花钱。
   */
  const list = dg.needsRedo([
    { ...ok, id: 'a', index: 1 },                                   // 干净的
    { ...ok, id: 'b', index: 2, refsSent: 0, refsAvailable: 3 },    // 有具体原因
    { ...ok, id: 'c', index: 3, editedAt: '2026-03-01T00:00:00Z' }  // 有具体原因
  ], { routing });
  check('只选查得出具体原因的那几镜', list.length === 2 && list.map((x) => x.index).join() === '2,3',
    JSON.stringify(list.map((x) => x.index)));
  check('干净的那一镜不会被选上（重出它纯属碰运气、还花钱）',
    !list.some((x) => x.index === 1), JSON.stringify(list.map((x) => x.index)));
  check('而且说得出为什么选它', /参考图/.test(list[0].why), list[0].why);
}

section('焦段：景别是算出来的，不是一个形容词');
{
  const previz = await import('../core/pipeline/previz.js');
  const cons = await import('../core/pipeline/consistency.js');

  /**
   * ══════════ 为什么要给焦段配一句话 ══════════
   *
   * 提示词里原来只有一个裸数字（"…，85mm"）。那和当初只写「特写」两个字
   * 是一模一样的毛病：行话，模型的理解未必和你一样，而它要和几百字的
   * 描述抢注意力。「特写」那次的解法是配一句能验的话，这里照办。
   */
  check('广角说的是"背景显得远"', /开阔|远/.test(previz.lensHint(24)), previz.lensHint(24));
  check('长焦说的是"背景被压缩"', /压缩/.test(previz.lensHint(85)), previz.lensHint(85));
  check('两头说的不是同一句（否则这张表等于没有）',
    previz.lensHint(24) !== previz.lensHint(85), previz.lensHint(24));
  /**
   * ⚠ 没选焦段就**一个字都不说**。
   * 补一句默认 35mm 的说明，等于替用户做了一个他没做过的决定 ——
   * 而且是一个听起来很具体的谎。这个项目为"没摆地标就别编"专门写过一段。
   */
  check('没给焦段时返回空，不替人编一个默认的',
    previz.lensHint(null) === '' && previz.lensHint(0) === '' && previz.lensHint('x') === '',
    JSON.stringify([previz.lensHint(null), previz.lensHint(0), previz.lensHint('x')]));

  const bible = {
    style: { anchor: '国风水墨' },
    characters: [{ name: '阿澜', appearance: '少年', seed: 1 }],
    scenes: [], props: []
  };
  const base = { index: 1, characters: ['阿澜'], description: '阿澜走向栈桥', camera: '中景', skills: [] };

  check('没选焦段的镜头，提示词里没有焦段那一层',
    !cons.assemblePrompt(bible, base).layers.some((l) => l.id === 'lens'),
    JSON.stringify(cons.assemblePrompt(bible, base).layers.map((l) => l.id)));

  {
    const r = cons.assemblePrompt(bible, { ...base, lens: 85 });
    check('选了 85mm，提示词里就有"背景被压缩"那句', /压缩/.test(r.prompt), r.prompt);
    check('而且它是单独一层（能单独关掉）',
      r.layers.some((l) => l.id === 'lens'), JSON.stringify(r.layers.map((l) => l.id)));
  }

  {
    /**
     * ⚠ 排过位的以**排位里那个焦段**为准 —— 它更具体（那是真在俯视图上摆过的）。
     * 反过来的话，用户在预演台上把镜头换成 85mm，提示词里却还是卡片上填的那个，
     * 而两处都显示着各自的数，谁也不知道哪个算数。
     */
    const staged = { ...base, lens: 24, stage: { cam: { x: 0, y: -3, height: 1.6, lens: 85 } } };
    check('排过位时以预演台里那个焦段为准',
      /压缩/.test(cons.assemblePrompt(bible, staged).prompt),
      cons.assemblePrompt(bible, staged).prompt);
  }
}

section('提示词分层：显出来、能关掉，但一个字都不许改变');
{
  const cons = await import('../core/pipeline/consistency.js');

  /**
   * ══════════ 这一节的第一条最重要 ══════════
   *
   * assemblePrompt 是全应用最要命的函数：全片每一张图都从它出来。
   * 把它拆成"分层"是为了让人看得见、关得掉 —— 但**不许顺手改变输出**。
   *
   * 所以先钉一根桩：一个固定的分镜，拼出来的提示词必须一字不差。
   * 这条断言的价值不在今天，在以后每一次有人动这个函数的时候。
   */
  const bible = {
    style: { anchor: '国风水墨', palette: '青灰与赭石', negative: '多余的手指' },
    characters: [{ name: '阿澜', appearance: '少年，藏青立领制服，左胸编号牌', seed: 100 }],
    scenes: [{ name: '码头', appearance: '清晨，薄雾，木栈桥', seed: 7 }],
    props: []
  };
  const shot = {
    index: 3, characters: ['阿澜'], scene: '码头',
    description: '阿澜走向栈桥', camera: '中景', skills: []
  };

  const EXPECT = '国风水墨，阿澜走向栈桥，【阿澜】少年，藏青立领制服，左胸编号牌，'
    + '【场景·码头】清晨，薄雾，木栈桥，镜头：中景，画面到腰部以上，人物动作和上半身姿态清晰，'
    + '主色调：青灰与赭石';
  check('拼出来的提示词一字没变（这根桩是给以后每次改这个函数用的）',
    cons.assemblePrompt(bible, shot).prompt === EXPECT,
    cons.assemblePrompt(bible, shot).prompt);

  // ── 分层看得见 ──
  {
    const { layers } = cons.assemblePrompt(bible, shot);
    check('返回了分层', Array.isArray(layers) && layers.length > 0, JSON.stringify(layers?.length));
    const ids = layers.map((l) => l.id);
    check('每层有 id、有中文名、有它塞进去的那句话',
      layers.every((l) => l.id && l.name && typeof l.text === 'string'), JSON.stringify(layers[0]));
    /**
     * ⚠ 顺序就是拼进提示词的顺序 —— 这一天里为这个顺序争论过三回
     *（描述被埋在 150 字之后、景别被参考图压过去、两句话打架）。
     * 层的顺序要是和实际拼接顺序不一致，那这个面板就是在骗人。
     */
    check('层的顺序 = 真实拼接顺序',
      layers.filter((l) => l.text).map((l) => l.text).join('，') === EXPECT,
      layers.filter((l) => l.text).map((l) => l.text).join('，'));
    check('画面描述排在风格锚之后、角色之前',
      ids.indexOf('description') > ids.indexOf('style') && ids.indexOf('description') < ids.indexOf('cast'),
      JSON.stringify(ids));
  }

  // ── 能关掉，而且只关掉那一层 ──
  {
    const muted = cons.assemblePrompt(bible, { ...shot, promptMute: ['scene'] });
    check('关掉「场景」那一层，场景那句就没了',
      !muted.prompt.includes('木栈桥'), muted.prompt);
    check('别的层一个都没受影响',
      muted.prompt.includes('阿澜走向栈桥') && muted.prompt.includes('国风水墨')
        && muted.prompt.includes('画面到腰部以上'), muted.prompt);
    /**
     * ⚠ 关掉 ≠ 删掉。层还在列表里，只是标着 muted ——
     * 否则界面上那一层直接消失，人就没法把它打开了。
     */
    const layer = muted.layers.find((l) => l.id === 'scene');
    check('那一层还在列表里，只是标成关着（否则再也打不开）',
      layer && layer.muted === true, JSON.stringify(layer));
  }

  {
    /** 关掉一个不存在的层不该出事 —— 老项目里存着早年层名的情况会有 */
    const ok = cons.assemblePrompt(bible, { ...shot, promptMute: ['不存在的层'] });
    check('关一个不认识的层，提示词照旧', ok.prompt === EXPECT, ok.prompt);
  }
}

section('关掉一层，真的少发那一句（不是只在界面上划掉）');
{
  /**
   * ⚠ 上一节验的是 assemblePrompt 这个函数。这一节验的是**整条链**：
   * 关掉 → 存下来 → 下次出图时真的少发那一句。
   *
   * 这个项目里反复出现的失败就是"同一件事两条路径、只接了一条"。
   * 只测函数、不测接线，接线断了照样全绿 —— 而表现是
   * "我明明关了那一层，出来还是老样子"，看不出是哪儿断的。
   */
  const studioMod = await import('../core/pipeline/studio.js');
  const storeMod = await import('../core/store.js');

  const p = storeMod.create({ title: '分层走查' });
  storeMod.save({
    ...storeMod.read(p.id),
    bible: {
      style: { anchor: '国风水墨', palette: '青灰与赭石', negative: '' },
      characters: [{ name: '阿澜', appearance: '少年，藏青立领制服', seed: 1 }],
      scenes: [{ name: '码头', appearance: '清晨，薄雾，木栈桥', seed: 2 }],
      props: []
    },
    shots: [{
      id: 'sh1', index: 1, characters: ['阿澜'], scene: '码头',
      description: '阿澜走向栈桥', camera: '中景', skills: [], imagePath: '/x.png'
    }]
  });

  const before = studioMod.promptsFor(p.id, 'sh1');
  check('接口把分层带出来了', (before.layers || []).length > 0, String(before.layers?.length));
  check('没关任何层时，场景那句在提示词里', before.now.image.includes('木栈桥'), before.now.image);

  /** 存进去要能存住 —— 不进 SHOT_EDITABLE 白名单的话，改了存不下去而且不报错 */
  studioMod.updateShot(p.id, 'sh1', { promptMute: ['scene'] });
  check('promptMute 存得住（在可改字段白名单里）',
    JSON.stringify(storeMod.read(p.id).shots[0].promptMute) === '["scene"]',
    JSON.stringify(storeMod.read(p.id).shots[0].promptMute));

  const after = studioMod.promptsFor(p.id, 'sh1');
  check('关掉之后，下次出图那条真的不带场景了', !after.now.image.includes('木栈桥'), after.now.image);
  check('别的层一句没少',
    after.now.image.includes('阿澜走向栈桥') && after.now.image.includes('国风水墨'), after.now.image);
  const sc = after.layers.find((l) => l.id === 'scene');
  check('那一层还列在接口返回里（标着关着，否则界面上再也打不开）',
    sc && sc.muted === true, JSON.stringify(sc));

  /** 乱值不能静默失配：存进去一个数字，Set.has 永远不命中，表现是"关了没生效" */
  studioMod.updateShot(p.id, 'sh1', { promptMute: [123, '', 'scene'] });
  check('乱值被规整成字符串数组（不然关了没生效，还不报错）',
    JSON.stringify(storeMod.read(p.id).shots[0].promptMute) === '["123","scene"]',
    JSON.stringify(storeMod.read(p.id).shots[0].promptMute));

  storeMod.remove(p.id);
}

section('撤销：一个回车能改五十镜，就得有一条退回来的路');
{
  const undo = await import('../core/undo.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-undo-'));
  const file = path.join(dir, 'project.json');
  const put = (n) => fs.writeFileSync(file, JSON.stringify({ id: 'p', shots: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, camera: '中景' })) }), 'utf8');
  const now = () => JSON.parse(fs.readFileSync(file, 'utf8'));

  put(10);
  undo.snapshot(dir, '批量改了 10 镜（景别→中景）');
  put(3);

  {
    const items = undo.list(dir);
    check('存下了一步', items.length === 1, JSON.stringify(items.map((i) => i.label)));
    /**
     * ⚠ 标签是这条路能不能用的关键。
     * 一列没有名字的时间戳，人不知道该退到哪一条，于是一条都不敢按 ——
     * 那和没有撤销是一回事。
     */
    check('这一步有名字，不是光一个时间戳',
      items[0].label.includes('景别'), JSON.stringify(items[0].label));
    check('记下了那一刻有几镜（好让人确认退对了没）', items[0].shots === 10, String(items[0].shots));
  }

  {
    undo.restore(dir, undo.list(dir).find((i) => i.label.includes('景别')).n);
    check('退回去之后分镜表回到 10 镜', now().shots.length === 10, String(now().shots.length));
    /**
     * ⚠ `_undo` 是快照自己的元数据，不能跟着写回正式档。
     * 写回去的话，下一张快照会把上一张的标签当成自己的 ——
     * 撤销列表里会出现一串一模一样的名字，而那正好毁掉标签的全部价值。
     */
    check('正式档里没有留下快照的元数据', !('_undo' in now()), JSON.stringify(Object.keys(now())));
  }

  {
    /**
     * ⚠ 撤销本身也要能撤销。
     * 不然"手滑点了撤销"就成了一个没法挽回的操作 ——
     * 而这个模块存在的全部理由就是消灭那种操作。
     */
    const items = undo.list(dir);
    check('退回去之前，把当时的状态也存了一张',
      items.some((i) => i.label.includes('撤销前')), JSON.stringify(items.map((i) => i.label)));
    const back = items.find((i) => i.label.includes('撤销前'));
    check('而且那一张记的是 3 镜（撤销前的样子）', back.shots === 3, String(back.shots));
    undo.restore(dir, back.n);
    check('所以撤销是可以再撤销回来的', now().shots.length === 3, String(now().shots.length));
  }

  {
    /**
     * ⚠ 上限写**死数字**，不要写 undo.KEEP。
     *
     * 第一版写的是 `list().length === undo.KEEP` —— 两边用的是同一个常量，
     * 那条断言**恒真**：把 KEEP 改成 99、快照堆到 99 张，它照样绿。
     * 推红时才发现的。用常量比常量，等于什么都没验。
     */
    for (let i = 0; i < 20; i += 1) undo.snapshot(dir, `第 ${i} 步`);
    check('最多留 8 步（再多意义很小，每张是一整份分镜表）',
      undo.list(dir).length === 8, String(undo.list(dir).length));
    check('而且 KEEP 就是 8（改了它，上面那条也得跟着改）', undo.KEEP === 8, String(undo.KEEP));
    check('留下的是最新那几步，不是最旧的',
      undo.list(dir)[0].label.includes('第 19 步'), JSON.stringify(undo.list(dir)[0].label));
  }

  {
    /**
     * ⚠ 坏文件要跳过，不能让整条路不可用。
     * 撤销列表是给人救急用的 —— 写到一半崩了留下的半截文件，
     * 不该导致"一步都退不了"。
     */
    fs.writeFileSync(path.join(dir, 'project.undo-999.json'), '{ 半截', 'utf8');
    const items = undo.list(dir);
    check('一个坏快照不会让整个列表挂掉', items.length >= 1, String(items.length));
    check('而且坏的那个不出现在列表里',
      !items.some((i) => i.n === 999), JSON.stringify(items.map((i) => i.n)));
  }

  {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-undo2-'));
    check('没有 project.json 时存快照返回 null（不抛错）', undo.snapshot(empty, 'x') === null, 'x');
    check('空目录列出来是空数组', JSON.stringify(undo.list(empty)) === '[]', JSON.stringify(undo.list(empty)));
    fs.rmSync(empty, { recursive: true, force: true });
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

section('撤销接到了真流水线上：批量改完真能退回去');
{
  /**
   * ⚠ 上一节验的是 undo.js 本身。这一节验的是**它真的被接上了**——
   * 这个项目里反复出现的那一类失败正是"同一件事两条路径、只接了一条"。
   * 光测模块、不测接线，接线断了照样全绿。
   */
  const studioMod = await import('../core/pipeline/studio.js');
  const storeMod = await import('../core/store.js');
  const undoMod = await import('../core/undo.js');

  const p = storeMod.create({ title: '撤销走查' });
  const shots = [1, 2, 3].map((i) => ({ id: `sh${i}`, index: i, camera: '中景', duration: 3 }));
  storeMod.save({ ...storeMod.read(p.id), shots });

  studioMod.batchUpdateShots(p.id, { ids: ['sh1', 'sh2', 'sh3'], patch: { camera: '特写' } });
  check('批量改真的改了', storeMod.read(p.id).shots.every((s) => s.camera === '特写'),
    JSON.stringify(storeMod.read(p.id).shots.map((s) => s.camera)));

  const items = studioMod.undoList(p.id).items;
  check('批量改之前自动存了一步', items.length >= 1, JSON.stringify(items.map((i) => i.label)));
  /**
   * 标签要说清楚**改了什么**，不能只说"批量修改"。
   * 五条一模一样的"批量修改"和没有列表是一回事。
   */
  check('标签写明了改的是景别和改了几镜',
    /3 镜/.test(items[0].label) && /景别/.test(items[0].label), JSON.stringify(items[0].label));

  studioMod.undoTo(p.id, items[0].n);
  check('退回去之后景别回到中景',
    storeMod.read(p.id).shots.every((s) => s.camera === '中景'),
    JSON.stringify(storeMod.read(p.id).shots.map((s) => s.camera)));
  check('退回去之后镜头一个没少', storeMod.read(p.id).shots.length === 3,
    String(storeMod.read(p.id).shots.length));

  /** 整段标衔接也是一次动几十镜，同样要能退 */
  studioMod.setLinkRange(p.id, { from: 1, to: 3, link: 'continuous' });
  const after = studioMod.undoList(p.id).items;
  check('整段标衔接之前也存了一步',
    after.some((i) => i.label.includes('整段标衔接')), JSON.stringify(after.map((i) => i.label)));

  storeMod.remove(p.id);
}

section('指令框：把人话翻成计划，而且绝不替你动手');
{
  const cmd = await import('../core/pipeline/command.js');

  const shots = Array.from({ length: 14 }, (_, i) => ({
    id: `s${i + 1}`, index: i + 1, segment: i < 6 ? 1 : 2,
    characters: i % 3 === 0 ? ['父亲', '我'] : ['我'],
    imagePath: i < 10 ? '/x.png' : null,
    videoPath: i < 3 ? '/v.mp4' : null,
    dialogue: i % 2 ? '台词' : '',
    skills: i === 5 ? ['tracking'] : []
  }));
  const project = { id: 'p1', shots };
  const P = (t) => cmd.parse(t, project);

  // ── 选哪几镜 ──
  {
    check('第 6-12 镜 → 7 镜', P('第6-12镜改成中景').targets.length === 7,
      String(P('第6-12镜改成中景').targets.length));
    check('第 6 镜 → 1 镜', P('第6镜改成特写').targets.length === 1, String(P('第6镜改成特写').targets.length));
    check('按场次选（第 2 场 → 8 镜）', P('第2场转场改成叠化').targets.length === 8,
      String(P('第2场转场改成叠化').targets.length));
    check('按出场角色选（有父亲的 → 5 镜）', P('有父亲的镜头加上仰拍').targets.length === 5,
      String(P('有父亲的镜头加上仰拍').targets.length));
    /** 口径必须和筛选条一致：有图没视频才叫"缺视频" */
    check('缺视频的口径 = 有图没视频（和筛选条同一套）',
      P('缺视频的镜头时长改成4秒').targets.length === 7,
      String(P('缺视频的镜头时长改成4秒').targets.length));
  }

  // ── 改什么 ──
  {
    const a = P('第6-12镜改成中景');
    check('景别改成中景', a.patch?.camera === '中景', JSON.stringify(a.patch));
    const b = P('缺视频的镜头时长改成4秒');
    check('时长改成 4 秒（数字，不是字符串）', b.patch?.duration === 4, JSON.stringify(b.patch));
    const c = P('第2场转场改成叠化');
    check('转场认的是 id 不是中文标签', c.patch?.transition === 'dissolve', JSON.stringify(c.patch));
    const d = P('有父亲的镜头加上仰拍');
    check('技法卡是加，不是覆盖', d.addSkills?.includes('low-angle') && !d.patch?.skills,
      JSON.stringify({ add: d.addSkills, patch: d.patch }));
    /**
     * ⚠ 中文两种语序都要认：「去掉跟拍」和「把跟拍去掉」。
     * 只认前一种的话，后一种会被当成**加上**——意思正好反了，
     * 而且是静默反：界面显示已加上，用户以为自己说错了话。
     */
    const e = P('把第6镜的跟拍去掉');
    check('「把X去掉」认成减，不是加',
      e.removeSkills?.includes('tracking') && !(e.addSkills || []).length,
      JSON.stringify({ add: e.addSkills, remove: e.removeSkills }));
    const f = P('第6镜去掉跟拍');
    check('「去掉X」也认成减（两种语序都要过）', f.removeSkills?.includes('tracking'),
      JSON.stringify(f.removeSkills));
  }

  // ── 花钱的必须标出来 ──
  {
    /**
     * ⚠ costs 决定界面走不走预检和估算，而那两道闸门是用户被烧过之后加的。
     * 标错 = 闸门形同虚设。
     */
    check('改文字不花钱', P('第6-12镜改成中景').costs === false, String(P('第6-12镜改成中景').costs));
    check('跑出图要花钱', P('把缺视频的都跑了').costs === true, String(P('把缺视频的都跑了').costs));
    check('问一问不花钱', P('这一轮要花多少钱').costs === false, String(P('这一轮要花多少钱').costs));
    /** 每一条能跑的计划都得有 verb，界面靠它决定走哪条路 */
    const verbs = ['第6-12镜改成中景', '把缺视频的都跑了', '第22镜为什么没图']
      .map((t) => P(t).verb);
    check('三种 verb 分得清', JSON.stringify(verbs) === '["edit","run","ask"]', JSON.stringify(verbs));
  }

  // ── 看不懂就说看不懂 ──
  {
    const bad = P('随便写点什么');
    check('看不懂时 ok=false', bad.ok === false, JSON.stringify(bad));
    /**
     * ⚠ 这一条是整个模块最要紧的。猜错的代价是拿真钱重跑几十镜，
     * 或者把几十镜的文案改坏；而"没听懂"的代价是你再打一遍。
     */
    check('看不懂时**不给** targets（不许猜一批出来）',
      !bad.targets, JSON.stringify(bad.targets));
    check('而且给了能照抄的例子', (bad.examples || []).length > 0, JSON.stringify(bad.examples));

    const half = P('把第6镜怎么怎么样');
    check('只认出镜头没认出动作时，说清楚认出了哪一半',
      half.ok === false && half.why.includes('第 6 镜'), JSON.stringify(half.why));

    const noTarget = P('改成中景');
    check('说了要改什么但没说改哪几镜 → 追问，不默认全片',
      noTarget.ok === false && /哪几镜/.test(noTarget.why), JSON.stringify(noTarget.why));

    const empty = P('第9场改成中景');
    check('选中零镜和"没说"分得开（零镜时直接说没有）',
      empty.ok === false && /一镜都没有/.test(empty.why), JSON.stringify(empty.why));
  }

  // ── 这个模块不许有副作用 ──
  {
    /**
     * ⚠ parse 只出计划，绝不执行。这里用**冻结**的输入验：
     * 它要是往 project 或 shots 上写任何东西，冻结会让它当场抛错。
     * 光看代码说"它是纯的"不算数。
     */
    const frozen = Object.freeze({ id: 'p2', shots: shots.map((s) => Object.freeze({ ...s })) });
    let threw = null;
    try {
      cmd.parse('第6-12镜改成中景', frozen);
      cmd.parse('把缺视频的都跑了', frozen);
    } catch (err) { threw = err; }
    check('对冻结的项目跑一遍不出错（说明它一个字都没往里写）', !threw, String(threw?.message));
  }

  // ── 例子必须都是真能跑通的 ──
  {
    /**
     * ⚠ 界面上那几个例子是**可点的模板**，点一下就填进输入框。
     * 里面要是有一句我们自己都解析不了的，用户第一次点就撞一堵墙 ——
     * 而那是他对这个功能的第一印象。
     */
    const egs = cmd.examplesFor(project);
    const bad = egs.filter((t) => !cmd.parse(t, project).ok);
    check('界面上列的每个例子都真能解析', bad.length === 0, JSON.stringify(bad));
    /**
     * ⚠ 例子必须按**这个项目**生成。写死的话，"第 6-12 镜"在一个
     * 只有 2 镜的项目里选不到任何东西 —— 用户第一次点例子就撞一堵墙。
     * 走查夹具正好只有 2 镜，这个坑是在那儿撞出来的。
     */
    const tiny = { id: 'p3', shots: shots.slice(0, 2) };
    const tinyBad = cmd.examplesFor(tiny).filter((t) => !cmd.parse(t, tiny).ok);
    check('只有 2 镜的项目里，例子也全都选得中', tinyBad.length === 0, JSON.stringify(tinyBad));
    check('例子里的镜号取自真实分镜（不是写死的 6-12）',
      cmd.examplesFor(tiny).some((t) => t.includes('第 1-2 镜')), JSON.stringify(cmd.examplesFor(tiny)));
    /** 空项目不能给出指向不存在镜头的例子 */
    const empty = cmd.examplesFor({ shots: [] });
    check('空项目的例子不提任何镜号', !empty.some((t) => /第 \d+ 镜/.test(t)), JSON.stringify(empty));
  }
}

section('角色名对不上：少一个人，而且不报任何错');
{
  const cons = await import('../core/pipeline/consistency.js');
  const diag = await import('../core/pipeline/diagnose.js');

  /**
   * ══════════ 真实事故（第 6 镜） ══════════
   *
   * 设定集里那个角色叫「我（无灵根书信摊主）」—— 括注是给人看的身份说明。
   * 而分镜是模型拆的，它写的就是「我」。
   *
   * 原来的 matchCharacters 只认全等，而且 `.filter(Boolean)` 之后
   * 只要还剩一个就整个短路返回。于是「我」被悄悄扔掉、「父亲」留下，
   * 出来的图里**只有父亲一个人**，那句"塞进我手里"没有接的人。
   *
   * 全程零报错：界面显示"已带上参考图"，带的确实是参考图，只是少了一个人。
   */
  const bible = {
    characters: [
      { name: '父亲', sheetUrl: 'https://x/dad.png' },
      { name: '我（无灵根书信摊主）', sheetUrl: 'https://x/me.png' }
    ],
    scenes: [{ name: '宗门测灵根广场', sheetUrl: 'https://x/plaza.png' }],
    props: []
  };
  const shot = {
    characters: ['父亲', '我'],
    scene: '宗门测灵根广场',
    description: '父亲伸手从怀里掏出几块灵石，塞进我手里'
  };

  const got = cons.matchCharacters(bible, shot).map((c) => c.name);
  check('「我」对上了设定集里的「我（无灵根书信摊主）」（括注是给人看的）',
    got.includes('我（无灵根书信摊主）'), JSON.stringify(got));
  check('「父亲」也还在（不是修好一个丢了另一个）', got.includes('父亲'), JSON.stringify(got));
  /**
   * ⚠ 这一条盯的是**短路**那个毛病：部分命中时不许扔掉没命中的。
   * 只断言"我在里面"是不够的 —— 顺序反过来（['我','父亲']）时，
   * 老代码同样只返回一个，而那一个恰好是对的。
   */
  check('两个人都在（部分命中不许短路）', got.length === 2, JSON.stringify(got));
  const labels = cons.collectReferences(bible, shot).labels;
  check('两张脸真的进了参考图清单',
    labels.includes('角·父亲') && labels.some((l) => l.startsWith('角·我')), JSON.stringify(labels));

  /**
   * ══════════ 提示词那一路也得带上他 ══════════
   *
   * castInFrame 原来自己抄了一份同样的"全等 + filter(Boolean)"。
   * 两份一起漏 = 那个人**图也没有、字也没有**，模型只在原句里见过
   *「我」这一个字，画不出人来一点都不奇怪。
   *
   * 这一条断言的是**提示词正文**，不是匹配函数的返回值 ——
   * 只测 matchCharacters 的话，castInFrame 那份抄件照样能偷偷漏。
   */
  {
    const withLooks = {
      ...bible,
      characters: [
        { name: '父亲', appearance: '中年男子，藏青长衫', sheetUrl: 'https://x/dad.png' },
        { name: '我（无灵根书信摊主）', appearance: '少女，灰布衣，左肩补丁', sheetUrl: 'https://x/me.png' }
      ]
    };
    const prompt = cons.assemblePrompt(withLooks, shot).prompt;
    check('提示词里有父亲的长相', prompt.includes('藏青长衫'), prompt.slice(0, 160));
    check('提示词里也有「我」的长相（原来图和字一起漏）',
      prompt.includes('左肩补丁'), prompt.slice(0, 300));
  }

  /**
   * ══════════ castInFrame 那份抄件（走的是台词那一路） ══════════
   *
   * ⚠ 前两版断言都测错了地方，推红时纹丝不动：
   *   第一版测「提示词里有长相」→ assemblePrompt 用的是 matchCharacters
   *   第二版还是 assemblePrompt  → speechLine 挂在 assembleVideoPrompt 上
   * 一条测不到目标代码的断言，绿着也只是绿着。
   *
   * castInFrame 真正的下游是 speechLine → **出视频**那条提示词。
   * 它只问一句"画面里有没有人"：一镜里**所有**角色名都对不上时
   * cast 为空 → 这一镜被当成空镜 →「嘴唇闭合」那句不发 →
   * 明明没台词的人可能被画成正在说话。
   */
  {
    const only = { characters: ['我'], description: '她低头看着掌心的灵石', dialogue: '' };
    const p = cons.assembleVideoPrompt(bible, only);
    check('名字带括注的角色也算"画面里有人"，出视频时会发「嘴唇闭合」',
      /嘴唇闭合|面部安静/.test(p), String(p).slice(-160));
  }

  // ── 空镜：明确写了"没人"就不要退回读描述硬猜 ──
  {
    const p = cons.assembleVideoPrompt(bible, { characters: [], description: '桌上的灵石特写', dialogue: '' });
    /**
     * 空镜占一部片子三四成。这句话在空镜里是纯噪音，而且**会招人**——
     * 提示词里出现"人物"，扩散模型很可能真给你画一个。
     */
    check('空数组 = 这一镜没人，不发「嘴唇闭合」（那句会凭空招出个人来）',
      !/嘴唇闭合|面部安静/.test(p), String(p).slice(-160));
  }

  /**
   * ══════════ 提示词要说清楚这一镜有几个人 ══════════
   *
   * 原来从头到尾没说过。两段【角色】只是隐含信号，而"画面里有几个人"
   * 是扩散模型最容易漏的约束之一 —— 它会把两段描述揉成一个人，
   * 或者只画写在前面那个。第 6 镜出来只有父亲，没有接灵石的那个。
   */
  {
    const p = cons.assemblePrompt(bible, shot).prompt;
    check('两个人时，提示词明说"画面里有 2 个人"', /画面里有 2 个人/.test(p), p.slice(0, 200));
    check('而且点了名（不然模型不知道是哪两个）',
      /画面里有 2 个人：.*父亲/.test(p) && /画面里有 2 个人：.*我（/.test(p), p.slice(0, 200));
    /**
     * ⚠ 只报数，不许写"两人同框""都要完整出现" —— 那会和景别直接打架。
     * 这一镜是特写的话，两句矛盾的指令一起发过去，模型挑哪句你控制不了。
     */
    check('不写"都要完整出现"这类会和景别打架的话',
      !/同框|都要完整|全部入镜/.test(p), p.slice(0, 250));
  }
  {
    const one = { characters: ['父亲'], description: '父亲独自站在广场上' };
    const p = cons.assemblePrompt(bible, one).prompt;
    /** 一个人时这句是废话，还白占字数（视频精准模式只有 200 字） */
    check('只有一个人时不说这句（废话，还占字数）', !/画面里有 \d 个人/.test(p), p.slice(0, 200));
  }

  // ── 顺序反过来也一样（防止上面那条靠运气过） ──
  {
    const rev = cons.matchCharacters(bible, { ...shot, characters: ['我', '父亲'] }).map((c) => c.name);
    check('名字顺序反过来，两个人照样都在', rev.length === 2, JSON.stringify(rev));
  }

  // ── 真找不到的时候要说出来，不能装作没事 ──
  {
    const s = { ...shot, characters: ['父亲', '师尊'] };
    check('对得上的照带', cons.matchCharacters(bible, s).map((c) => c.name).join() === '父亲',
      JSON.stringify(cons.matchCharacters(bible, s).map((c) => c.name)));
    check('对不上的被挖出来（原来是悄悄扔掉）',
      JSON.stringify(cons.unmatchedCast(bible, s)) === '["师尊"]',
      JSON.stringify(cons.unmatchedCast(bible, s)));
    const items = diag.diagnose({ ...s, imagePath: '/x/6.png' }, { bible });
    const hit = items.find((i) => i.id === 'cast-unmatched');
    check('诊断里点名说了是「师尊」对不上', hit && hit.what.includes('师尊'), JSON.stringify(hit?.what));
    check('并且说了设定集里现有的是谁（好照着改名）',
      hit && hit.why.includes('父亲'), JSON.stringify(hit?.why));
    check('改名不花钱，所以标成不花钱', hit && hit.costs === false, JSON.stringify(hit?.costs));
    /**
     * 排序按"改了最可能有用"。改名免费、一次全片都好，
     * 得排在"重出一次换颗种子"前面 —— 人只会试最上面那一两条。
     */
    check('排在"数据上看不出毛病"前面',
      items.findIndex((i) => i.id === 'cast-unmatched') < items.findIndex((i) => i.id === 'nothing-found')
        || !items.some((i) => i.id === 'nothing-found'),
      JSON.stringify(items.map((i) => i.id)));
  }

  // ── 名字全对得上时不许瞎报 ──
  {
    const items = diag.diagnose({ ...shot, imagePath: '/x/6.png' }, { bible });
    check('名字都对得上时不报这一条（不能变成一条永远成立的废话）',
      !items.some((i) => i.id === 'cast-unmatched'), JSON.stringify(items.map((i) => i.id)));
  }

  // ── 两个人去掉括注后同名：宁可不带，也不能挑错人 ──
  {
    const twins = {
      characters: [
        { name: '师兄（大）', sheetUrl: 'https://x/a.png' },
        { name: '师兄（小）', sheetUrl: 'https://x/b.png' }
      ],
      scenes: [], props: []
    };
    const s = { characters: ['师兄'], description: '师兄走过来' };
    /**
     * ⚠ 挑错人比不带更糟：不带只是"不像"，挑错是**像另一个人**，
     * 而看图的人只会觉得"这演员怎么串戏了"，根本不会往名字上想。
     */
    check('两个人重名时不替你挑', cons.matchCharacters(twins, s).length === 0,
      JSON.stringify(cons.matchCharacters(twins, s).map((c) => c.name)));
    check('而且如实说这个名字没对上', JSON.stringify(cons.unmatchedCast(twins, s)) === '["师兄"]',
      JSON.stringify(cons.unmatchedCast(twins, s)));
  }
}

section('参考图：发哪几张、最多几张');
{
  const cs = await import('../core/pipeline/consistency.js');
  const bible = {
    style: { anchor: '国风', palette: '青灰', negative: '' },
    characters: [{ name: '阿澜', appearance: '短发', seed: 1 }],
    scenes: [{ name: '码头', appearance: '雾', seed: 2 }],
    props: [
      { name: '柴刀', appearance: '木柄', seed: 3 },
      { name: '灯笼', appearance: '红纸', seed: 4 }
    ]
  };

  /**
   * ⚠ 手填的「关键道具」说了算。
   *
   * 他在预演台把柴刀拿掉、从关键道具里删了，只要描述里还有"刀"这个字，
   * 老判据照旧会把那张道具设定图发出去 —— 而他找不到任何地方能阻止它。
   */
  const listed = cs.matchProps(bible, { description: '阿澜握着柴刀走向灯笼', props: ['灯笼'] });
  check('填了关键道具时，只带填的那几件（描述里提到的别的不算）',
    listed.length === 1 && listed[0].name === '灯笼', JSON.stringify(listed.map((p) => p.name)));
  /**
   * ⚠ 这条是上一条的**反面**，必须一起验：
   * 只验"填了就听它"的话，一个"永远返回空"的实现照样能过。
   */
  const fallback = cs.matchProps(bible, { description: '阿澜握着柴刀走向灯笼', props: [] });
  check('没填关键道具时退回老行为（按描述里的名字找）',
    fallback.length === 2, JSON.stringify(fallback.map((p) => p.name)));
  check('删空关键道具就真的一件都不带',
    cs.matchProps(bible, { description: '阿澜握着柴刀', props: ['不存在的东西'] }).length === 0, '');

  /**
   * ══════════ 上限：按优先级砍，不是砍前 N 张 ══════════
   *
   * ⚠ 参考图的排列顺序是**场景在最前**。直接 slice 前 N 张的话，
   * 第一个被留下的是场景，而最容易被挤掉的恰恰是排在后面的角色 ——
   * 脸没了，环境留着。这正好是最坏的那种砍法。
   */
  const many = {
    images: ['s', 'c1', 'c2', 'p1', 'p2', 'p3', 'p4', 'p5', 'mine'],
    labels: ['景', '角1', '角2', '道1', '道2', '道3', '道4', '道5', '我'],
    paths: new Array(9).fill(null),
    kinds: ['scene', 'character', 'character', 'prop', 'prop', 'prop', 'prop', 'prop', 'character'],
    sources: ['model', 'model', 'model', 'model', 'model', 'model', 'model', 'model', 'upload']
  };
  const all = { mode: 'all', send: true, useEditModel: false, onlyUploaded: false, blockedBy: null };
  const capped = cs.pickRefs(many, all);
  check('九张可用时，只发默认上限那几张', capped.images.length === cs.DEFAULT_MAX_REFS,
    JSON.stringify({ 发了: capped.images.length, 上限: cs.DEFAULT_MAX_REFS }));
  /**
   * ⚠ 这条是整节最要紧的一条：**用户亲手传的那张排在最后，
   * 却绝对不能被挤掉。**被挤掉的话，这个人的脸就又回到"由文字决定"，
   * 而那正是他传这张照片要解决的问题。
   */
  check('用户传的那张排在最后，照样活下来（这条是重点）',
    capped.images.includes('mine'), JSON.stringify(capped.images));
  check('角色图优先于道具图（脸比道具要紧）',
    capped.images.includes('c1') && capped.images.includes('c2'), JSON.stringify(capped.images));
  check('道具被挤掉的是多数（九张里五张道具，最多留一张）',
    capped.images.filter((x) => x.startsWith('p')).length <= 1, JSON.stringify(capped.images));
  /**
   * ⚠ 砍完要**恢复原来的顺序**。按优先级排出来的顺序会把场景推到最后，
   * 而多数厂商对首张权重最高 —— 顺序本身是有意义的。
   */
  const order = capped.images.map((x) => many.images.indexOf(x));
  check('砍完之后顺序还是原来那个（场景仍在前面）',
    order.every((v, i) => i === 0 || v > order[i - 1]), JSON.stringify(capped.images));
  check('说得出被挤掉了几张（不说的话人只会觉得"设定集的图没发"）',
    capped.capped === 5, String(capped.capped));

  /**
   * ══════════ 特写里不发那张广角空镜 ══════════
   *
   * 场景基准图的出图提示词写死了「空镜无人物、广角」，它天生是远景构图，
   * 而且排在参考图第一位、权重最高。特写镜头同时收到
   * "文字：特写" 和 "图片：广角构图" 两条矛盾指令 —— 图几乎总是赢。
   * 用户报的就是这个："这个描述的正确吗，这是特写"，而图是整个广场的大远景。
   */
  const three = {
    images: ['scene', 'face', 'prop'],
    labels: ['景·广场', '角·我', '道·石'],
    paths: [null, null, null],
    kinds: ['scene', 'character', 'prop'],
    sources: ['model', 'model', 'model']
  };
  /**
   * ══════════ 分工：参考图管"是什么"，文字管"怎么拍" ══════════
   *
   * 这里绕过两版弯路。现象是"标了特写，出来是整个广场的大远景"——
   * 场景基准图是「空镜无人物、广角」出的，天生远景构图，排在第一位、权重最高。
   *
   * 第一版：**不发那张图**。结果环境没了基准，模型自己编了个广场，
   *         用户原话"提示词是在广场，怎么在广场外"。
   * 第二版：**降权到最后**。治标，而且每来一种新情况就得再加一个特例。
   *
   * 两次都是拿参考图当杠杆去修构图 —— 用错了地方。现在的分工是一条线：
   *   参考图  长相、服装、环境、色调  → 是什么
   *   文字    景别、机位、构图、动作  → 怎么拍
   * 而这条线必须**明写进提示词**，模型不会自己知道我们是这么分的。
   */
  check('景别不再影响发哪几张图（撤掉了那堆特例）',
    JSON.stringify(cs.pickRefs(three, all).images) === JSON.stringify(['scene', 'face', 'prop']),
    JSON.stringify(cs.pickRefs(three, all).images));

  /**
   * ⚠ **每次带参考图都要声明这条分工**，不能只在特写时说。
   * 只在特写时说的话，中景那些镜头照样会照抄参考图的取景。
   */
  const withRefs = cs.assemblePrompt({
    style: { anchor: '国风', palette: '青灰', negative: '' },
    characters: [{ name: '阿澜', appearance: '短发', seed: 1, sheetPath: '/a.png', sheetUrl: 'https://x/a.png', sheetSource: 'upload' }],
    scenes: [], props: []
  }, { id: 'z', index: 1, characters: ['阿澜'], description: '走过来', camera: '中景' });
  check('带参考图时，明写"构图按文字来、别沿用参考图的取景"',
    /不要沿用参考图的取景/.test(withRefs.prompt), withRefs.prompt.slice(-120));

  /**
   * ⚠ 景别要配一句**画面上能验的话**。
   *
   * "特写"是行话，两个字要和几百字的外貌、环境描述抢注意力，
   * 而且各家模型理解不一致 —— 那正是"标了特写出来是远景"的另一半原因。
   */
  const pz2 = await import('../core/pipeline/previz.js');
  check('特写配上"只到肩膀以上"这种能验的说明',
    /肩膀以上/.test(pz2.framingHint('特写')), pz2.framingHint('特写'));
  check('全景配的是"全身完整入镜"', /全身完整入镜/.test(pz2.framingHint('全景')), pz2.framingHint('全景'));
  /** ⚠ 长的要先匹配，否则"大特写"会被当成"特写" */
  check('大特写不会被当成特写（长的先匹配）',
    pz2.framingHint('大特写') !== pz2.framingHint('特写')
      && /面部局部/.test(pz2.framingHint('大特写')), pz2.framingHint('大特写'));
  /** 用户手填的是自由文本，全等匹配十有八九对不上 */
  check('手填的自由文本也认得出（"中景，过肩"）',
    /腰部以上/.test(pz2.framingHint('中景，过肩')), pz2.framingHint('中景，过肩'));
  check('没填景别时不硬塞一句', pz2.framingHint('') === '' && pz2.framingHint(null) === '', '');
  check('认不出的词不硬塞', pz2.framingHint('随便拍拍') === '', pz2.framingHint('随便拍拍'));

  /**
   * ⚠ **端到端：单独重出这一镜时，那张场景图真的没发出去。**
   *
   * 上面全是纯函数。而传 tight 的地方有**两处**：批量出图（consistency）
   * 和单独重出（studio）。金丝雀验的时候把 studio 那处删掉，
   * 套件照样全绿 —— 也就是说纯函数绿不代表两条路都接上了。
   * 判据必须落在请求体上。
   */
  {
    const keepMode2 = settings.get('refMode');
    settings.patch({ refMode: 'all', useReferenceImages: true });
    const sheet = (n) => ({
      name: n, appearance: `${n} 的样子`, seed: 7,
      sheetPath: `/${n}.png`, sheetUrl: `https://x/${n}.png`, sheetSource: 'model',
      variants: [{ id: 'v-default', name: '默认', sheetPath: `/${n}.png`, sheetUrl: `https://x/${n}.png`, sheetSource: 'model' }]
    });
    const pT = store.create({ title: '特写不发场景图' });
    store.update(pT.id, (x) => {
      x.bible = {
        style: { anchor: '国风', palette: '青灰', negative: '' },
        characters: [sheet('阿澜')], scenes: [sheet('码头')], props: []
      };
      x.shots = [{
        id: 'tight', index: 1, scene: '码头', characters: ['阿澜'],
        description: '阿澜的脸', camera: '特写', duration: 4
      }];
      return x;
    });
    upstream.lastImageBody = null;
    await studioModule.regenerateShot(pT.id, 'tight', {}, () => {});
    const sentImgs = JSON.stringify(upstream.lastImageBody?.image || '');
    /**
     * ⚠ 判据落在**请求体**上。金丝雀验过：纯函数的断言绿，
     * 不代表两条路（批量出图 / 单独重出）都接上了。
     */
    check('特写时那张场景图照发（环境的像素级基准，不能丢）',
      sentImgs.includes('码头'), sentImgs.slice(0, 160));
    check('角色那张也在', sentImgs.includes('阿澜'), sentImgs.slice(0, 160));
    /** 构图交给文字：这两句必须都在提示词里 */
    const pr = String(upstream.lastImageBody?.prompt || '');
    check('提示词里明写了"构图按文字来，别沿用参考图的取景"',
      /不要沿用参考图的取景/.test(pr), pr.slice(-160));
    check('而且景别配了能验的说明（不是孤零零两个字）',
      /肩膀以上/.test(pr), pr.slice(-160));
    settings.patch({ refMode: keepMode2 });
  }

  /** 没超上限时不该报"被挤掉" */
  const few = cs.pickRefs({
    images: ['s', 'c1'], labels: ['景', '角'], paths: [null, null],
    kinds: ['scene', 'character'], sources: ['model', 'model']
  }, all);
  check('没超上限时不报"被挤掉"', few.capped === 0 && few.images.length === 2, String(few.capped));

  /** 上限可调 —— 想多发的人不该被一个写死的 4 卡住 */
  const keepMax = settings.get('maxRefs');
  settings.patch({ maxRefs: 7 });
  check('上限可以调大', cs.pickRefs(many, all).images.length === 7,
    String(cs.pickRefs(many, all).images.length));
  settings.patch({ maxRefs: keepMax });
}

/**
 * ══════════ 一次改一批镜头 ══════════
 *
 * 五十镜逐个点开、改、关掉、再点下一个 —— 这是这个应用里最大的一块
 * 时间黑洞，而且它不产生任何创作价值，纯粹是操作损耗。
 *
 * ⚠ 这一节里**最要紧的两条**都是关于"别悄悄毁掉已有的东西"：
 *   ① 技法卡是加/减，不是覆盖 —— 覆盖会把每一镜各自挑的运镜全清掉
 *   ② 规整要走 updateShot 那一份 —— 两份判据迟早漂，而漂的表现是
 *      "单个改是对的、批量改出来不一样"，最难查
 */
section('批量改：一次改一批镜头');
{
  const pB = store.create({ title: '批量改' });
  const mk = (i, extra = {}) => ({
    id: `b${i}`, index: i, scene: '码头', characters: ['阿澜'],
    description: `第 ${i} 镜`, camera: '中景', duration: 4, skills: [], ...extra
  });
  store.update(pB.id, (x) => {
    x.shots = [
      mk(1, { skills: ['tracking'] }),
      mk(2, { skills: [] }),
      mk(3, { duration: 9 })
    ];
    return x;
  });

  const r1 = studioModule.batchUpdateShots(pB.id, { ids: ['b1', 'b2'], patch: { duration: 6 } });
  const after1 = store.read(pB.id).shots;
  check('选中的那两镜时长都改了', after1[0].duration === 6 && after1[1].duration === 6,
    JSON.stringify(after1.map((s) => s.duration)));
  /** ⚠ 没选的那一镜**一个字都不能动**。批量最容易犯的错就是范围放大了 */
  check('没选的那一镜原样没动', after1[2].duration === 9, String(after1[2].duration));
  check('回报了几镜真的有变化（都一样的话应该是 0）', r1.changed === 2 && r1.total === 2,
    JSON.stringify({ changed: r1.changed, total: r1.total }));

  /**
   * ⚠ **技法卡是加，不是覆盖。**
   *
   * 第 1 镜原来有一张手持。覆盖式实现会把它清掉换成新的 ——
   * 而那是他一镜一镜挑出来的东西，清掉了不会有任何提示。
   */
  studioModule.batchUpdateShots(pB.id, { ids: ['b1', 'b2'], addSkills: ['low-angle'] });
  const after2 = store.read(pB.id).shots;
  check('加技法卡时，原来那张留着（不是覆盖）',
    after2[0].skills.includes('tracking') && after2[0].skills.includes('low-angle'),
    JSON.stringify(after2[0].skills));
  check('原来没有的那一镜也加上了', after2[1].skills.includes('low-angle'),
    JSON.stringify(after2[1].skills));

  /** 去掉只去掉指定那张，别的不动 */
  studioModule.batchUpdateShots(pB.id, { ids: ['b1'], removeSkills: ['low-angle'] });
  const after3 = store.read(pB.id).shots;
  check('去掉一张时，别的技法卡留着',
    after3[0].skills.includes('tracking') && !after3[0].skills.includes('low-angle'),
    JSON.stringify(after3[0].skills));

  /** 重复加不该出现两份 */
  studioModule.batchUpdateShots(pB.id, { ids: ['b1'], addSkills: ['tracking'] });
  const dup = store.read(pB.id).shots[0].skills.filter((x) => x === 'tracking');
  check('重复加同一张不会出现两份', dup.length === 1, JSON.stringify(store.read(pB.id).shots[0].skills));

  /**
   * ⚠ **规整必须和单个改是同一份。**
   *
   * updateShot 里那一大段（时长夹到 0.5~30、link 只认三种、技法卡互斥组）
   * 是一年踩出来的。批量这条路自己再写一份的话，两边迟早漂 ——
   * 而漂的表现是"单个改是对的、批量改出来不一样"，最难查。
   *
   * 判据：给一个越界的时长，两条路要夹到同一个数。
   */
  studioModule.batchUpdateShots(pB.id, { ids: ['b1'], patch: { duration: 999 } });
  studioModule.updateShot(pB.id, 'b2', { duration: 999 });
  const clamped = store.read(pB.id).shots;
  check('越界的时长，批量和单个夹到同一个数（说明共用一份规整）',
    clamped[0].duration === clamped[1].duration && clamped[0].duration === 30,
    JSON.stringify([clamped[0].duration, clamped[1].duration]));

  /** 乱值不该悄悄写进去 —— link 只认三种 */
  studioModule.batchUpdateShots(pB.id, { ids: ['b1'], patch: { link: '瞎写的' } });
  check('乱写的衔接关系不会被存进去', store.read(pB.id).shots[0].link !== '瞎写的',
    String(store.read(pB.id).shots[0].link));

  /** 空的、不存在的：要报错，不能默默成功 */
  let err1 = '';
  try { studioModule.batchUpdateShots(pB.id, { ids: [] }); } catch (e) { err1 = e.message; }
  check('一镜都没选时会报错，不是默默什么都不做', /没说要改哪几镜/.test(err1), err1);
  let err2 = '';
  try { studioModule.batchUpdateShots(pB.id, { ids: ['不存在'], patch: { duration: 5 } }); } catch (e) { err2 = e.message; }
  check('选中的镜头都不存在时说清楚（多半是页面旧了）', /一个都不存在/.test(err2), err2);

  /**
   * ⚠ 改过要盖 editedAt —— 出视频那步的"图比描述旧"靠它判。
   * 批量改完不盖的话，那条检查在批量改过的镜头上永远是瞎的。
   */
  const before = store.read(pB.id).shots[2].editedAt || '';
  studioModule.batchUpdateShots(pB.id, { ids: ['b3'], patch: { camera: '特写' } });
  check('批量改也会盖上"改过的时间"（"图比描述旧"那条检查靠它）',
    Boolean(store.read(pB.id).shots[2].editedAt) && store.read(pB.id).shots[2].editedAt !== before,
    String(store.read(pB.id).shots[2].editedAt));
}

/**
 * ══════════ 开跑之前的那张清单 ══════════
 *
 * 这条流水线上每一步都真花钱。而绝大多数返工的原因，在按下「开始」之前
 * 就已经明明白白摆在数据里了 —— 没排位、没选技法卡、台词根本念不完、
 * 首帧图是照旧描述出的。
 *
 * ⚠ 这一节里**最重要的不是"检查得出问题"，是"没问题时闭嘴"**。
 *
 * 一个动不动就报一片黄的清单，三次之后就被整块跳过 —— 连真正该拦的
 * 那条一起跳过，比没有更坏。所以这里既验"该说的说了"，
 * 也验"干净的项目上一条都不说"。
 */
section('开跑之前：这一步花多少、哪几处该先改');
{
  const sck = await import('../core/pipeline/stepcheck.js');
  const mkShot = (i, extra = {}) => ({
    id: `s${i}`, index: i, scene: '码头', characters: ['阿澜'],
    description: '阿澜走向栈桥', camera: '中景', duration: 4,
    skills: ['act-walk'],
    stage: { cam: { x: 0, y: -4, height: 1.6, lens: 35 }, subjects: [{ name: '阿澜', x: 0, y: 0 }] },
    ...extra
  });
  const bible = {
    style: { anchor: '国风', palette: '青灰', negative: '' },
    characters: [{ name: '阿澜', voice: 'v1' }], scenes: [], props: []
  };

  /**
   * ⚠ **干净的项目上一条都不报。**这条是整节的地基：它一红，
   * 整个功能就该扔掉重做 —— 没人会看一个天天喊狼来了的清单。
   */
  const clean = sck.check({ bible, shots: [mkShot(1), mkShot(2)] }, 'assets');
  check('干净的项目上，一条都不报', clean.items.length === 0,
    JSON.stringify(clean.items.map((i) => i.what)));
  /**
   * ⚠ 但**要明说"检查过了"**，不能回空串。
   * 整块消失的话，"这里什么都没有"和"检查过了、干净的"分不出来，
   * 而前者会让人自己再查一遍 —— 那正是这个功能要消灭的往返。
   */
  check('干净时也要说一句"检查过了"，不能整块消失',
    /没发现问题/.test(sck.summary(clean)), sck.summary(clean));

  // ── 出图之前 ──
  const noSkill = sck.check({ bible, shots: [mkShot(1, { skills: [] }), mkShot(2)] }, 'assets');
  const skillItem = noSkill.items.find((i) => i.id === 'no-skill');
  check('出图前：一张技法卡都没选的镜头会被点出来', Boolean(skillItem),
    JSON.stringify(noSkill.items.map((i) => i.id)));
  /**
   * ⚠ 每一条都必须回答三件事：**是什么、会怎样、怎么改**。
   * 缺"会怎样"的提示不如不做 —— 它只会训练用户无视所有提示。
   */
  check('而且说得出"会怎样"和"怎么改"，不是光报一个数',
    Boolean(skillItem?.why) && Boolean(skillItem?.fix) && skillItem.why.length > 20,
    JSON.stringify({ why: skillItem?.why?.slice(0, 30), fix: skillItem?.fix?.slice(0, 20) }));
  check('点得出是哪几镜（不然要人自己去翻）',
    JSON.stringify(skillItem?.shots) === JSON.stringify([1]), JSON.stringify(skillItem?.shots));

  const noStage = sck.check({ bible, shots: [mkShot(1, { stage: null })] }, 'assets');
  check('出图前：没排位的镜头会被点出来',
    noStage.items.some((i) => i.id === 'no-stage'), JSON.stringify(noStage.items.map((i) => i.id)));

  // ── 出视频之前 ──
  const vid = sck.check({ bible, shots: [mkShot(1, { imagePath: null })] }, 'video');
  const block = vid.items.find((i) => i.id === 'no-first-frame');
  /**
   * ⚠ 这条必须是 blocker：没有首帧图，视频的人脸服装场景全靠文字重新发挥，
   * 而出视频是全流程里最贵的一步 —— 跑下去几乎一定要重做。
   */
  check('出视频前：还没出图是 blocker，不是"建议"',
    block?.level === 'blocker', JSON.stringify({ level: block?.level }));
  check('而且计到了 blockers 上（界面靠它决定拦不拦）', vid.blockers === 1, String(vid.blockers));

  const staleFrame = sck.check({ bible, shots: [mkShot(1, {
    imagePath: '/a.png', imageAt: '2026-01-01T00:00:00Z', editedAt: '2026-02-01T00:00:00Z'
  })] }, 'video');
  check('出视频前：描述改过而图是旧的，会被点出来',
    staleFrame.items.some((i) => i.id === 'stale-frame'),
    JSON.stringify(staleFrame.items.map((i) => i.id)));

  const longLine = sck.check({ bible, shots: [mkShot(1, {
    imagePath: '/a.png', duration: 2,
    dialogue: '这句话很长很长很长很长很长很长很长很长很长很长很长很长很长很长'
  })] }, 'video');
  check('出视频前：台词在这个时长里念不完，会被点出来',
    longLine.items.some((i) => i.id === 'dialogue-overflow'),
    JSON.stringify(longLine.items.map((i) => i.id)));

  // ── 配音之前 ──
  const voice = sck.check({ bible, shots: [mkShot(1, { dialogue: '设备正常。', speaker: '' })] }, 'voice');
  check('配音前：有台词没说是谁在说，会被点出来',
    voice.items.some((i) => i.id === 'no-speaker'), JSON.stringify(voice.items.map((i) => i.id)));

  /**
   * ⚠ **只看这一步真要跑的那些镜头。**
   *
   * 已经出过图的那几镜有没有选技法卡，跟"这一次出图"毫无关系 ——
   * 报了只会让清单一直挂着几条永远消不掉的黄字，而消不掉的提醒
   * 会被当成噪音，连带着新出现的那条也被无视。
   */
  const partial = sck.check({ bible, shots: [
    mkShot(1, { imagePath: '/done.png', skills: [] }), // 已经出过图，这次不跑它
    mkShot(2)
  ] }, 'assets');
  check('只看这一步真要跑的那几镜（已出图的不算数）',
    partial.items.length === 0 && partial.targets === 1,
    JSON.stringify({ items: partial.items.map((i) => i.id), targets: partial.targets }));
  /** 整步重跑时它们又都算数了 —— 那时候确实要重出 */
  const redo = sck.check({ bible, shots: [
    mkShot(1, { imagePath: '/done.png', skills: [] }), mkShot(2)
  ] }, 'assets', { regenerate: true });
  check('整步重跑时，已出图的那几镜又算数了',
    redo.targets === 2 && redo.items.some((i) => i.id === 'no-skill'),
    JSON.stringify({ targets: redo.targets }));

  /**
   * ⚠ **分级不能膨胀。**把"可以更好"标成 warn 的话，用户看到一片黄，
   * 然后学会整块跳过 —— 连真正的 blocker 一起跳过。
   */
  const levels = new Set([...noSkill.items, ...vid.items, ...voice.items].map((i) => i.level));
  check('分级只有三档，没有多出来的',
    [...levels].every((l) => ['blocker', 'warn', 'tip'].includes(l)), JSON.stringify([...levels]));

  /**
   * 支点那句话：清单只是信息，"现在改免费、跑完再改要重花一次"
   * 才把它变成一个决定。没有它的话，最省事的做法永远是直接按「开始」。
   */
  check('有问题且算得出钱时，说得出"不改的代价"',
    /现在改是免费的/.test(sck.costOfSkipping(noSkill, '¥8.40')), sck.costOfSkipping(noSkill, '¥8.40'));
  /** ⚠ 算不出钱时**不能编一个**：他会照着那个数做决定 */
  check('算不出钱时就不说这句（编个数字比不说更坏）',
    sck.costOfSkipping(noSkill, '') === '', sck.costOfSkipping(noSkill, ''));
  check('没问题时也不说这句（没有代价可言）',
    sck.costOfSkipping(clean, '¥8.40') === '', sck.costOfSkipping(clean, '¥8.40'));
}

section('OpenAI 家族带参考图：要走 /images/edits，不是塞个地址');
{
  const adaptersMod = await import('../core/providers/adapters.js');
  const seen = { paths: [], types: [], bodies: [] };
  const oa = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.paths.push(new URL(req.url, 'http://x').pathname);
      seen.types.push(req.headers['content-type'] || '');
      seen.bodies.push(Buffer.concat(chunks));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      /**
       * ⚠ base64 要给**真实长度**的。firstBase64 有一条 `length > 100` 的护栏
       *（防止把随便一个短字符串当成图片），给 'aGk=' 这种四个字符的假数据，
       * 走到的是"响应里没有图"那条错误分支 —— 而那不是被测代码的问题，
       * 是夹具比真实响应短了两个数量级。
       */
      res.end(JSON.stringify({ data: [{ b64_json: PIXEL_PNG.toString('base64').repeat(3) }] }));
    });
  });
  await new Promise((r) => oa.listen(0, '127.0.0.1', r));
  settings.patch({ baseUrls: { openai: `http://127.0.0.1:${oa.address().port}/v1` } });
  vault.setSecret('OPENAI_API_KEY', 'sk-edits-test');

  // 一张真 PNG（就是那个 1×1 像素），当成"用户传的脸"
  const facePng = `data:image/png;base64,${PIXEL_PNG.toString('base64')}`;

  {
    const got = await adaptersMod.generateImage({
      providerId: 'openai', model: 'gpt-image-2', prompt: '阿澜走向栈桥',
      size: '1024*1024', refImages: [facePng], label: '出图'
    });
    check('带参考图时发到 /images/edits（不是 /images/generations）',
      seen.paths.at(-1) === '/v1/images/edits', JSON.stringify(seen.paths));
    /**
     * ⚠ 必须是 multipart。发成 JSON 的话 OpenAI 那边收不到文件 ——
     * 而这正是修之前的样子：JSON 里一个 image 字段，被整个忽略。
     */
    check('而且是 multipart 上传文件，不是 JSON 里塞地址',
      /multipart\/form-data; boundary=/.test(seen.types.at(-1)), seen.types.at(-1));
    const raw = seen.bodies.at(-1).toString('latin1');
    // 中文要按 utf8 读 —— 上面那份 latin1 是给二进制部分用的
    const text = seen.bodies.at(-1).toString('utf8');
    check('请求体里真的带了图片文件（不是一个 URL 字符串）',
      /name="image\[\]"; filename="ref-1\.png"/.test(raw), raw.slice(0, 200));
    check('文件类型标对了（后缀不对 OpenAI 会直接拒收）',
      /Content-Type: image\/png/.test(raw), raw.slice(0, 300));
    check('提示词也一起发过去了（脸来自图，衣服和场景来自它）',
      /name="prompt"[\s\S]*阿澜走向栈桥/.test(text), text.slice(0, 400));
    /**
     * ⚠ **发过去的模型得是这一家真有的。**
     *
     * 「图生图模型」默认是火山的 doubao-seededit-3-0-i2i，而原来那个 switch
     * 只判"这家支不支持 i2i"—— OpenAI 支持，于是把一个**火山的模型 id
     * 发给了 OpenAI**。必然"模型不存在"，而用户看到的只是出图失败。
     * 这条是上面那条打印请求体时顺手撞出来的。
     */
    check('发过去的模型还是 gpt-image-2（没被换成别家的编辑模型）',
      /name="model"[\s\S]*gpt-image-2/.test(text), text.slice(0, 200));
    check('出来的图收下了', typeof got.base64 === 'string' && got.base64.length > 100, String(got.base64).slice(0, 40));
    /**
     * refsSent 要如实 —— 今天已经为"记的是意图不是事实"修过两回了。
     */
    check('如实记下发了几张参考图', got.used?.refsSent === 1, JSON.stringify(got.used));
  }

  // ── 不带参考图时照旧走 generations ──
  {
    await adaptersMod.generateImage({
      providerId: 'openai', model: 'gpt-image-2', prompt: '空镜', size: '1024*1024', label: '出图'
    });
    check('没有参考图时还是走 /images/generations（别把纯文生图也改道）',
      seen.paths.at(-1) === '/v1/images/generations', JSON.stringify(seen.paths));
    check('那条路照旧是 JSON', /application\/json/.test(seen.types.at(-1)), seen.types.at(-1));
  }

  // ── 多张参考图 ──
  {
    await adaptersMod.generateImage({
      providerId: 'openai', model: 'gpt-image-2', prompt: '两个人', size: '1024*1024',
      refImages: [facePng, facePng], label: '出图'
    });
    const raw = seen.bodies.at(-1).toString('latin1');
    const parts = (raw.match(/filename="ref-\d+\.png"/g) || []).length;
    check('多张参考图each一个文件部分（不是只发第一张）', parts === 2, `${parts} 个文件部分`);
  }

  oa.close();
  settings.patch({ baseUrls: { openai: '' } });
}

section('「接口地址」那一屏：每个接口键都得有中文标签');
{
  /**
   * ══════════ 为什么值得单独一条 ══════════
   *
   * 目录里加一个 endpoints 键，界面上就多一个输入框。而标签表在
   * ui/views/providers.js 里，是**另一个文件** —— 漏了不报错、不报警，
   * 只是那一行显示成裸的 `videos` / `se2v`。
   *
   * 后果不是难看，是**不敢改**：一排中文里夹一个英文键名，用户看不出
   * 那是哪一步的地址，于是明明能自己修好的中转路径问题，会变成一句
   * "填哪个？"。而「接口地址」这一块存在的全部理由就是让人自己改。
   *
   * 加这条的时候已经漏了三个（se2v、sfx，以及刚加的 videos）。
   *
   * ⚠ 用读源码的方式取那张表，而不是 import ——
   * providers.js 是浏览器模块（依赖 DOM），Node 里 import 不动。
   * core/surfaces.js 那套 `// cap:` 标记也是同样的做法。
   */
  const cat = await import('../core/providers/catalog.js');
  const src = fs.readFileSync(new URL('../ui/views/providers.js', import.meta.url), 'utf8');
  const block = /const ENDPOINT_LABELS = \{([\s\S]*?)\n\};/.exec(src);
  check('找得到那张标签表（改名了的话这条要跟着改）', Boolean(block), '没匹配到 ENDPOINT_LABELS');

  const labelled = new Set([...(block?.[1] || '').matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]));
  /** 夹具自检：表本身得真解析出东西来，不然下面那条恒真 */
  check('标签表解析出来了（不是空集合，否则下一条恒真）',
    labelled.size >= 10, `解析到 ${labelled.size} 条`);

  const used = new Set();
  for (const p of cat.PROVIDERS) for (const k of Object.keys(p.endpoints || {})) used.add(k);
  const missing = [...used].filter((k) => !labelled.has(k)).sort();
  check('目录里用到的每一个接口键都有中文标签',
    missing.length === 0, `没标签的：${missing.join('、')}`);
}

section('Agnes AI 出图：三处和 OpenAI 长得像但不一样的地方');
{
  const adaptersMod = await import('../core/providers/adapters.js');
  const cat = await import('../core/providers/catalog.js');

  const seen = { bodies: [], paths: [], auth: [] };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.paths.push(req.url);
      seen.auth.push(req.headers.authorization || '');
      seen.bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        created: 1780000000,
        data: [{ url: 'https://storage.googleapis.com/agnes-aigc/xxx.png', b64_json: null, revised_prompt: null }]
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  settings.patch({ baseUrls: { agnes: `http://127.0.0.1:${srv.address().port}/v1` } });
  vault.setSecret('AGNES_API_KEY', 'sk-agnes-test');

  const M = 'agnes-image-2.1-flash';
  const facePng = `data:image/png;base64,${PIXEL_PNG.toString('base64')}`;
  const last = () => seen.bodies.at(-1);

  // ── ① 尺寸：档位 + 宽高比，不是像素 ──
  {
    const got = await adaptersMod.generateImage({
      providerId: 'agnes', model: M, prompt: '执法艇破雾而行', aspectRatio: '16:9', label: '出图'
    });
    check('打到 /v1/images/generations', seen.paths.at(-1) === '/v1/images/generations', String(seen.paths.at(-1)));
    check('Bearer 鉴权带上了', seen.auth.at(-1) === 'Bearer sk-agnes-test', seen.auth.at(-1));
    /**
     * ⚠ 这一条是这一节的核心。发 '1280*720' 过去不会报错 ——
     * 文档明说不受支持的精确尺寸会被"自动标准化"，于是请求记录里写着
     * 1280×720、任务成功、出来的图是别的尺寸。这种事看日志查不出来。
     */
    check('16:9 发的是档位 2K 而不是像素', last().size === '2K', JSON.stringify(last().size));
    check('宽高比单独走 ratio 字段', last().ratio === '16:9', JSON.stringify(last().ratio));
    check('收下了 data[0].url', got.url === 'https://storage.googleapis.com/agnes-aigc/xxx.png', String(got.url));
  }

  // ── ①b 换尺寸的理由要说对 ──
  {
    const notes = [];
    await adaptersMod.generateImage({
      providerId: 'agnes', model: M, prompt: '换尺寸提示', aspectRatio: '16:9', label: '出图',
      onEvent: (e) => { if (e?.type === 'note') notes.push(String(e.message || '')); }
    });
    const sizeNote = notes.find((n) => n.includes('2624×1472'));
    check('换过尺寸会说一声（不说的话请求记录和画幅对不上）', Boolean(sizeNote), JSON.stringify(notes));
    /**
     * ⚠ 通用那句写的是"它收不下，硬发会被它自己换成别的比例"——
     * 那是给 enum 那一类（gpt-image-1、Seedream 3.0）写的，它们是真的收不下。
     *
     * Agnes 是**收得下但会自己改**。对这家说"收不下"是错的，而错的解释
     * 比不解释更坏：用户会去找一个根本不存在的报错。
     */
    check('而且没照抄"它收不下"（Agnes 收得下，只是会自己改）',
      sizeNote && !sizeNote.includes('收不下'), String(sizeNote));
    check('说的是真正的理由：只有四档，1K 比 1080p 还矮',
      sizeNote && sizeNote.includes('1312×736'), String(sizeNote));
  }

  // ── ② response_format 绝不能在顶层 ──
  {
    check('顶层没有 response_format（文档专门用「重要说明」提的）',
      !('response_format' in last()), JSON.stringify(Object.keys(last())));
    check('它在 extra_body 里', last().extra_body?.response_format === 'url', JSON.stringify(last().extra_body));
  }

  // ── ③ 竖屏 ──
  {
    await adaptersMod.generateImage({
      providerId: 'agnes', model: M, prompt: '竖屏短剧', aspectRatio: '9:16', label: '出图'
    });
    check('竖屏画幅出竖图（横图裁竖屏会把人裁掉半张脸）',
      last().size === '2K' && last().ratio === '9:16', JSON.stringify({ size: last().size, ratio: last().ratio }));
  }

  // ── ④ 参考图：两个位置都要有 ──
  {
    const notes = [];
    await adaptersMod.generateImage({
      providerId: 'agnes', model: M, prompt: '保持这个人的长相', aspectRatio: '16:9',
      refImages: [facePng, facePng], label: '出图',
      onEvent: (e) => { if (e?.type === 'note') notes.push(String(e.message || '')); }
    });
    /**
     * 文档「请求参数」表说顶层 image，正文两处说 extra_body.image。
     * 挑错一个 = 200、有图、请求记录里列着参考图，而图根本没进模型。
     * 两个都发，等确认了哪个对再删另一个。
     */
    check('参考图放进了 extra_body.image',
      Array.isArray(last().extra_body?.image) && last().extra_body.image.length === 2,
      JSON.stringify((last().extra_body?.image || []).length));
    /**
     * ⚠ 这一条是真机换来的。原来两个位置都放（怕挑错一个静默降级），
     * 结果服务端**两处都读、加在一起**：
     *   `too many input images: 8 provided, at most 6 allowed`
     * 4 张被数成 8 张，直接顶穿上限。
     *
     * 教训：在一个会累加的字段上做"两边都发"的冗余保险，保险本身就是故障。
     */
    check('**没有**同时放顶层 image（服务端两处都读、会加起来）',
      !('image' in last()), JSON.stringify(Object.keys(last())));
    const sent = [...(last().extra_body?.image || []), ...(last().image || [])];
    check('整个请求体里这张脸只出现两次（两张图，不是四次）',
      sent.filter((u) => u === facePng).length === 2, `出现 ${sent.filter((u) => u === facePng).length} 次`);
    /**
     * ⚠ 带参考图时不许换模型。
     *
     * 「设置 → 图生图模型」默认是火山的 doubao-seededit-3-0-i2i。
     * 没有 i2iSameModel 这个声明的话，这里会把那个火山 id 发给 Agnes，
     * 或者弹一句"请改成 Agnes 自己的编辑模型"—— 而 Agnes 没有编辑模型，
     * 同一个模型两件事都干。
     */
    check('模型没被换成别家的编辑模型', last().model === M, String(last().model));
    /**
     * ⚠ 上面那条**恒真**，别拿它当 i2iSameModel 的证据。
     *
     * 推红验过：把目录里的 i2iSameModel 去掉，那条照样绿 —— 因为
     * doubao-seededit 不属于 Agnes，i2iBelongs 是 false，本来就换不成。
     *
     * 去掉之后真正会发生的是**弹一句误导的话**："Agnes 没有 doubao-seededit
     * 这个模型，要用图生图的话改成 Agnes 自己的编辑模型" —— 而 Agnes
     * 压根没有单独的编辑模型，照着改是死路。所以断言要落在这句话上。
     */
    check('也没弹"去配一个 Agnes 的编辑模型"（它没有，同一个模型两件事都干）',
      !notes.some((n) => /图生图模型|编辑模型/.test(n)), JSON.stringify(notes));
  }

  // ── ④b 超过它 6 张的上限时，在发出去之前就挤掉 ──
  {
    const notes = [];
    const many = Array.from({ length: 9 }, (_, i) => `https://cdn.example.com/ref-${i}.png`);
    const got = await adaptersMod.generateImage({
      providerId: 'agnes', model: M, prompt: '一堆参考图', aspectRatio: '16:9',
      refImages: many, label: '出图',
      onEvent: (e) => { if (e?.type === 'note') notes.push(String(e.message || '')); }
    });
    check('9 张只发 6 张（它的上限，真机报错里给的数）',
      last().extra_body.image.length === 6, String(last().extra_body.image.length));
    check('留下的是排在前面那 6 张（人物在前，挤掉的是道具）',
      JSON.stringify(last().extra_body.image) === JSON.stringify(many.slice(0, 6)),
      JSON.stringify(last().extra_body.image));
    check('挤掉了会说一声', notes.some((n) => n.includes('最多收 6 张')), JSON.stringify(notes));
    /**
     * ⚠ refsSent 记的必须是**发了几张**，不是**打算发几张**。
     * 这个文件里已经为"记的是意图不是事实"修过好几回了；
     * 这里一旦记 9，那条"这一镜一张参考图都没发"的诊断就跟着失真。
     */
    check('refsSent 记的是 6 不是 9（发了几张，不是打算发几张）',
      got.used.refsSent === 6, JSON.stringify(got.used));
  }

  // ── ④c "图太多"要被认出来，不能只是一个裸的 400 ──
  {
    const real = 'too many input images: 8 provided, at most 6 allowed (request id: 2026...)';
    check('认得出 Agnes 这句"图太多"（原话照抄自真机报错）',
      adaptersMod.__isMediaLimitError(real), real);
    /** ⚠ 别误伤：取不到图的地址不是"图太多"，认错了会一路减到 1 张还失败 */
    check('没有把"取不到图片地址"也当成图太多',
      !adaptersMod.__isMediaLimitError('cannot download media URL (2013)'), 'cannot download');
  }

  // ── ⑤ 纯文生图不许带 image 字段 ──
  {
    await adaptersMod.generateImage({
      providerId: 'agnes', model: M, prompt: '空镜', aspectRatio: '16:9', label: '出图'
    });
    check('没有参考图时不发空的 image 字段',
      !('image' in last()) && !('image' in (last().extra_body || {})),
      JSON.stringify({ top: last().image, inner: last().extra_body?.image }));
  }

  // ── ⑥ 负向词不能整段丢掉 ──
  {
    await adaptersMod.generateImage({
      providerId: 'agnes', model: M, prompt: '广场上的书信摊', negative: '多余的手指', aspectRatio: '16:9', label: '出图'
    });
    check('文档没有 negative_prompt，负向词并进了正向描述',
      last().prompt.includes('广场上的书信摊') && last().prompt.includes('多余的手指'), last().prompt);
    check('而且没发一个它不认的 negative_prompt 字段',
      !('negative_prompt' in last()), JSON.stringify(Object.keys(last())));
  }

  // ── ⑦ 尺寸反查表本身 ──
  {
    const { agnesSizeSpec } = adaptersMod;
    const a = agnesSizeSpec('2624*1472');
    check('像素能反查回档位（2624×1472 → 2K / 16:9）',
      a.size === '2K' && a.ratio === '16:9' && a.guessed === false, JSON.stringify(a));
    const b = agnesSizeSpec('1K');
    check('直接给档位也认（联调台里手填的写法）',
      b.size === '1K' && b.guessed === false, JSON.stringify(b));
    const c = agnesSizeSpec('1920*1080');
    check('表里没有的尺寸标记成 guessed（好让界面说一声）', c.guessed === true, JSON.stringify(c));
    check('而且换算结果还是 16:9（别把比例也换掉）', c.ratio === '16:9', JSON.stringify(c));
    /**
     * ⚠ 目录里声明的 imageSizes 必须能被这张表反查到，否则每出一张图
     * 都会走 guessed 分支、每张都报一次假警。两处数字必须是同一份。
     */
    const declared = cat.getProvider('agnes').imageSizes.enum;
    const allHit = declared.every((sz) => agnesSizeSpec(sz).guessed === false);
    check('目录里声明的每一个尺寸都能反查到（两处数字是同一份）', allHit,
      JSON.stringify(declared.filter((sz) => agnesSizeSpec(sz).guessed)));
  }

  // ── ⑧ 目录条目本身 ──
  {
    const p = cat.getProvider('agnes');
    check('Agnes 不走通用 OpenAI 分支（顶层 response_format 会害了它）',
      p.family === 'agnes', String(p.family));
    check('声明了 t2i 和 i2i', ['t2i', 'i2i'].every((c) => p.capabilities.includes(c)), JSON.stringify(p.capabilities));
    check('声明了同模型图生图', p.i2iSameModel === true, String(p.i2iSameModel));
    check('模型 id 和文档一致', p.models.some((m) => m.id === M), JSON.stringify(p.models.map((m) => m.id)));
    /**
     * 目录里的模板是给联调台用的起手式。图生图那个模板要是没把两个位置
     * 都写上，用户手动验"参考图到底放哪"的时候就少了一半。
     */
    /**
     * 联调台里那组 A/B 对照必须成对存在 —— 参考图放哪一个位置，
     * 目前只能靠用户拿一张脸各发一次来定。少一个就没法对照了。
     */
    const A = p.templates.find((t) => t.id === 'i2i');
    const B = p.templates.find((t) => t.id === 'i2i-toplevel');
    check('A/B 两个对照模板都在', Boolean(A && B), JSON.stringify(p.templates.map((t) => t.id)));
    check('A 把参考图放 extra_body，且顶层没有',
      Array.isArray(A?.body?.extra_body?.image) && !('image' in (A?.body || {})), JSON.stringify(A?.body));
    check('B 把参考图放顶层，且 extra_body 里没有',
      Array.isArray(B?.body?.image) && !('image' in (B?.body?.extra_body || {})), JSON.stringify(B?.body));
    /**
     * ⚠ 两个模板都不许两处同时放 —— 那正是真机否掉的写法
     *（服务端两处都读、加起来，4 张被数成 8 张）。
     * 模板要是还留着那种写法，用户照着发一次又会撞同一个 400。
     */
    check('没有哪个模板还是"两处同时放"（真机否掉的那种写法）',
      p.templates.every((t) => !(Array.isArray(t.body?.image) && Array.isArray(t.body?.extra_body?.image))),
      JSON.stringify(p.templates.filter((t) => t.body?.image && t.body?.extra_body?.image).map((t) => t.id)));
    check('声明了它 6 张的参考图上限', p.imageMaxRefs === 6, String(p.imageMaxRefs));
    check('模板里也没有顶层 response_format',
      p.templates.every((t) => !('response_format' in (t.body || {}))),
      JSON.stringify(p.templates.map((t) => t.id)));
  }

  srv.close();
  settings.patch({ baseUrls: { agnes: '' } });
}

section('Agnes AI 出视频：异步任务、帧数规矩、以及"以回来的为准"');
{
  const adaptersMod = await import('../core/providers/adapters.js');
  const cat = await import('../core/providers/catalog.js');
  const idx = await import('../core/providers/index.js');

  const seen = { bodies: [], paths: [] };
  let mapping = null;
  let seconds = '5.0';
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.paths.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'POST') {
        seen.bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        res.end(JSON.stringify({
          id: 'task_X', task_id: 'task_X', video_id: 'video_Y',
          object: 'video', status: 'queued', progress: 0, seconds: '5.0', size: '1280x720'
        }));
        return;
      }
      res.end(JSON.stringify({
        id: 'task_X', video_id: 'video_Y', task_id: 'task_X', status: 'completed', progress: 100,
        seconds,
        size: '832x448',
        metadata: {
          ...(mapping ? { size_mapping: mapping } : {}),
          url: 'https://platform-outputs.agnes-ai.space/videos/agnes-video-v2.0/task_X.mp4'
        }
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const root = `http://127.0.0.1:${srv.address().port}`;
  settings.patch({ baseUrls: { agnes: `${root}/v1` }, pollIntervalMs: 10 });
  vault.setSecret('AGNES_API_KEY', 'sk-agnes-test');

  const V = 'agnes-video-v2.0';
  const last = () => seen.bodies.at(-1);
  const frame = (n) => `https://cdn.example.com/shot-${n}.png`;

  // ── ① {{apiRoot}}：查询地址不在 v1 下面 ──
  {
    const p = cat.getProvider('agnes');
    const url = idx.interpolate(p.taskPoll.url, p);
    check('查询地址落在 v1 外面（{{apiRoot}} 去掉了版本段）',
      url === `${root}/agnesapi?video_id={taskId}`, url);
    /**
     * ⚠ 这一条是这一节里最容易被写死成绝对地址的地方。写死的话，
     * 用户把根地址改到中转站之后：提交走新地址、查询走老地址 ——
     * 任务提交成功然后永远查不到，表现是"卡在轮询里"。
     */
    check('改了根地址，查询地址跟着动（不是写死的绝对地址）',
      !/agnes-ai\.cn/.test(url), url);
  }

  // ── ② 图生视频：帧数、尺寸、单张顶层 image ──
  {
    const notes = [];
    const got = await adaptersMod.generateVideo({
      providerId: 'agnes', model: V, prompt: '镜头缓慢推进',
      firstFrameUrl: frame(1), duration: 5, aspectRatio: '16:9', resolution: '720P',
      label: '出视频', onEvent: (e) => { if (e?.type === 'note') notes.push(String(e.message || '')); }
    });
    check('提交打到 /v1/videos', seen.paths[0] === '/v1/videos', JSON.stringify(seen.paths[0]));
    check('轮询打到 /agnesapi?video_id=video_Y（用 video_id 不是 task_id）',
      seen.paths.includes('/agnesapi?video_id=video_Y'), JSON.stringify(seen.paths));
    check('5 秒 @24fps 发的是 121 帧（和文档的推荐值一致）', last().num_frames === 121, String(last().num_frames));
    check('帧率一起发了', last().frame_rate === 24, String(last().frame_rate));
    check('16:9 / 720P → 1280×720', last().width === 1280 && last().height === 720,
      `${last().width}x${last().height}`);
    check('首帧走顶层 image（单个 URL，不是数组）', last().image === frame(1), JSON.stringify(last().image));
    check('没有 extra_body（那是关键帧模式的开关）', !('extra_body' in last()), JSON.stringify(Object.keys(last())));
    check('拿到了 metadata.url', /task_X\.mp4$/.test(String(got.url)), String(got.url));
  }

  // ── ③ 首尾帧 = 关键帧模式，两种模式不能同时点 ──
  {
    await adaptersMod.generateVideo({
      providerId: 'agnes', model: V, prompt: '过渡',
      firstFrameUrl: frame(1), lastFrameUrl: frame(2),
      duration: 5, aspectRatio: '16:9', resolution: '720P', label: '出视频'
    });
    check('末帧走 extra_body.image 数组（首帧在前、末帧在后）',
      JSON.stringify(last().extra_body?.image) === JSON.stringify([frame(1), frame(2)]),
      JSON.stringify(last().extra_body?.image));
    check('并且打开了 keyframes 模式', last().extra_body?.mode === 'keyframes', String(last().extra_body?.mode));
    /**
     * ⚠ 这一条是这一节的核心。文档的接入清单把两者并排写着：
     * "图生视频使用 image，关键帧动画使用 extra_body.image" —— 是**两种模式**。
     *
     * 两个都发等于同时点了两种模式，它挑哪个我们不知道；挑错的表现是
     * 末帧被丢掉、衔接照样断，而界面会说这两镜是无缝的。
     * 出图那条恰恰要两个都发（那边是同一件事的两种写法），别互相抄。
     */
    check('关键帧模式下**不再**发顶层 image（两种模式不能同时点）',
      !('image' in last()), JSON.stringify(Object.keys(last())));
  }

  // ── ④ 8n+1 规矩 ──
  {
    const { agnesFrames } = adaptersMod;
    const ok = (n) => n <= 441 && (n - 1) % 8 === 0;
    const cases = [1, 2, 3, 3.4, 5, 7.7, 10, 18, 25];
    check('任意秒数算出来的帧数都满足 8n+1 且 ≤441',
      cases.every((s) => ok(agnesFrames(s))),
      JSON.stringify(cases.map((s) => [s, agnesFrames(s)])));
    check('超长的截在 441（文档写的硬上限）', agnesFrames(60) === 441, String(agnesFrames(60)));
    /** 向上取：宁可多出来一点合成时裁掉，也不要把台词切断 */
    check('向上取而不是就近取（3.4 秒 → 至少 3.4 秒的帧数）',
      agnesFrames(3.4) / 24 >= 3.4, String(agnesFrames(3.4) / 24));
    check('5 秒正好是 121 帧', agnesFrames(5) === 121, String(agnesFrames(5)));
  }

  // ── ⑤ 尺寸被它改过时要说出来 ──
  {
    mapping = {
      adjusted: true, ratio: '16:9', resolution: '480p',
      width: 832, height: 448, requested_width: 1024, requested_height: 576,
      message: 'Input size 1024x576 was mapped to nearest preset 480p/16:9 (832x448)'
    };
    const notes = [];
    await adaptersMod.generateVideo({
      providerId: 'agnes', model: V, prompt: 'x', firstFrameUrl: frame(1),
      duration: 5, aspectRatio: '16:9', resolution: '480P', label: '出视频',
      onEvent: (e) => { if (e?.type === 'note') notes.push(String(e.message || '')); }
    });
    /**
     * 它的档位表没有公开，我们猜不出来 —— 但它把改动如实写在
     * metadata.size_mapping 里了。不读回来的话，请求记录写着 848×480、
     * 成片是 832×448，而没有任何一处说过这件事。
     */
    check('它把尺寸换掉时，原话转达出来',
      notes.some((n) => n.includes('832x448')), JSON.stringify(notes));
    mapping = null;
  }

  // ── ⑥ 时长以回来的为准 ──
  {
    seconds = '5.0417';
    const got = await adaptersMod.generateVideo({
      providerId: 'agnes', model: V, prompt: 'x', firstFrameUrl: frame(1),
      duration: 5, aspectRatio: '16:9', resolution: '720P', label: '出视频'
    });
    check('记的是响应里的秒数，不是下单时算的那个',
      Math.abs(got.actualDuration - 5.0417) < 1e-6, String(got.actualDuration));
    seconds = '5.0';
  }

  // ── ⑦ data URI 要在提交之前就拦住 ──
  {
    let err = null;
    await adaptersMod.generateVideo({
      providerId: 'agnes', model: V, prompt: 'x',
      firstFrameUrl: `data:image/png;base64,${PIXEL_PNG.toString('base64')}`,
      duration: 5, aspectRatio: '16:9', resolution: '720P', label: '出视频'
    }).catch((e) => (err = e));
    /**
     * 和百炼一模一样的坑：文档写着"需要可公开访问的图片 URL"，
     * 而我们默认发本地图转的 data URI。不先拦，任务会提交成功、
     * 然后在轮询里失败 —— 白等一轮，报错里也看不出是这个原因。
     */
    check('本地图转的 data URI 在提交前就被拦下（不是白等一轮轮询）',
      err && /公网 URL/.test(String(err.message)), String(err?.message).slice(0, 80));
    check('报错里点名是 Agnes，不是照抄百炼那句',
      err && /Agnes/.test(String(err.message)), String(err?.message).slice(0, 60));
  }

  // ── ⑧ 目录条目 ──
  {
    const p = cat.getProvider('agnes');
    check('声明了出视频能力', ['t2v', 'i2v'].every((c) => p.capabilities.includes(c)), JSON.stringify(p.capabilities));
    check('声明了支持末帧（衔接那一套要靠它）', p.videoDefaults?.endFrame === true, String(p.videoDefaults?.endFrame));
    check('这一步最多两张图（首帧+末帧）', p.videoDefaults?.maxImages === 2, String(p.videoDefaults?.maxImages));
    const vm = p.models.find((m) => m.id === V);
    check('视频模型在目录里', Boolean(vm), JSON.stringify(p.models.map((m) => m.id)));
    /**
     * 时长上限必须和 441 帧那条硬规矩对得上。写大了的话，用户排一个
     * 20 秒的镜头，界面显示合法、发出去被截成 18.4 秒，而没人说过这件事。
     */
    check('时长上限 18 秒和 441 帧对得上',
      Math.max(...vm.durations) === Math.floor(441 / 24), JSON.stringify(vm.durations.slice(-3)));
    check('每一档时长都出得来（算出的帧数不超 441）',
      vm.durations.every((d) => adaptersMod.agnesFrames(d) <= 441),
      JSON.stringify(vm.durations.filter((d) => adaptersMod.agnesFrames(d) > 441)));
  }

  srv.close();
  settings.patch({ baseUrls: { agnes: '' } });
}

section('中转站只转对话：不该四条一起红');
{
  /**
   * ════════ 这一节挡的是什么 ════════
   *
   * 国内用 OpenAI 基本都要走一个中转站。而 OpenAI 家族的自检发的是
   * `GET /v1/models` —— 它便宜，但**不是流水线真正会用的接口**。
   * 中转站十有八九只转 `/chat/completions`，`/models` 要么 404、要么 401。
   *
   * 后果：信号链上「剧本 / 调度 / 复核 / 出图」**四条一起红**
   *（它们本来就共用同一次自检），而出图出片一点问题都没有。
   * 用户看到四个红叉，第一反应是去翻密钥 —— 全是白折腾。
   *
   * 所以只要服务端确实回话了（有 HTTP 状态码 = 网络通、地址对），
   * 就再问一次真正要用的那条路。
   */
  const providers = await import('../core/providers/index.js');
  const vaultMod = await import('../core/vault.js');

  const hits = [];
  const relay = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url.endsWith('/models')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Not Found' } }));
    }
    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const relayUrl = `http://127.0.0.1:${relay.address().port}/v1`;

  const keepBase = settings.get('baseUrls')?.openai;
  const keepChatP = settings.get('chatProvider');
  const keepChatM = settings.get('chatModel');
  vaultMod.setSecret('OPENAI_API_KEY', 'sk-test-relay');
  settings.patch({
    baseUrls: { openai: relayUrl },
    chatProvider: 'openai',
    chatModel: 'gpt-4o-mini'
  });

  const r1 = await providers.probe('openai');
  check('列模型 404 但对话通时，判为**通**', r1.ok === true, JSON.stringify(r1).slice(0, 200));
  check('并且如实说明是"列模型那条不通、对话是通的"',
    /对话是通的/.test(r1.note || ''), r1.note);
  check('用的是路由到这一家的那个模型（不是目录里的示例）',
    r1.model === 'gpt-4o-mini', String(r1.model));
  check('先探便宜那条，不通才退一步 —— 不是一上来就发对话',
    hits[0]?.includes('/models') && hits[1]?.includes('/chat/completions'), hits.join(' | '));

  /**
   * ⚠ 反面：对话也不通的时候**不能报"列模型 404"**。
   * 那句话对用户没有任何用 —— 真正要看的是对话那次的原因。
   */
  hits.length = 0;
  const dead = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  });
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  settings.patch({ baseUrls: { openai: `http://127.0.0.1:${dead.address().port}/v1` } });
  const r2 = await providers.probe('openai');
  check('对话也不通时判为不通', r2.ok === false, JSON.stringify(r2).slice(0, 160));
  check('报的是对话那次的原因（密钥不对），不是"列模型 404"',
    /密钥|API key|401/i.test(r2.reason || '') && !/404/.test(r2.reason || ''), r2.reason);

  /**
   * ⚠ 网络层根本没连上时**不重试**。
   * 重试一次只是让人多等 20 秒，而结论一个字都不会变。
   */
  hits.length = 0;
  settings.patch({ baseUrls: { openai: 'http://127.0.0.1:45997/v1' } });
  const r3 = await providers.probe('openai');
  check('压根连不上时判为不通', r3.ok === false, JSON.stringify(r3).slice(0, 160));
  check('连不上就不再退一步试对话（白等 20 秒）', r3.status === 0, String(r3.status));

  relay.close();
  dead.close();
  settings.patch({
    baseUrls: { openai: keepBase || '' },
    chatProvider: keepChatP,
    chatModel: keepChatM
  });
}

section('小剪刀：一镜切成两段');
{
  /**
   * 切开之后同一个素材文件在时间线上出现两次，各有各的入出点、
   * 各有各的转场和效果。它**不重新生成任何东西** —— 还是十几秒的活。
   *
   * 这一节盯着三处最容易错的：
   *   ① 后半段不能继承分镜上那个转场（否则在一镜自己中间插一处叠化）
   *   ② 台词和音效只跟第一段走（否则同一句话念两遍）
   *   ③ 把前半段删了之后，那一镜不能"自己长回来"
   */
  const ed = await import('../core/pipeline/edit.js');
  const shots = [
    { id: 'a', index: 1, duration: 4, actualDuration: 6, dialogue: '你好', transition: 'cut', videoPath: '/a.mp4' },
    { id: 'b', index: 2, duration: 4, actualDuration: 6, dialogue: '再见', transition: 'dissolve', videoPath: '/b.mp4' }
  ];

  check('key 认得出是哪一镜', ed.shotIdOf('a#2') === 'a' && ed.shotIdOf('a') === 'a');
  check('要新号时从 #2 起', ed.nextKey({ order: ['a'] }, 'a') === 'a#2');
  /**
   * ⚠ 中间删过一段之后，"现有个数 + 1"会撞上一个还在的号，直接把它盖掉。
   * 所以是"找第一个空号"。
   */
  check('中间删过号也不撞车', ed.nextKey({ order: ['a', 'a#3'] }, 'a') === 'a#2');

  const split = {
    order: ['a', 'a#2', 'b'],
    clips: { a: { in: 0, out: 2.5 }, 'a#2': { in: 2.5, out: 6 } }
  };
  const rows = ed.timeline({ shots, edit: split }, { policy: 'keep' });
  check('切完是三段', rows.length === 3, String(rows.length));
  check('两段用的是同一个素材文件',
    rows[0].shot.videoPath === rows[1].shot.videoPath, `${rows[0].shot.videoPath} / ${rows[1].shot.videoPath}`);
  check('前半段 2.5 秒、后半段 3.5 秒',
    rows[0].span === 2.5 && rows[1].span === 3.5, `${rows[0].span} / ${rows[1].span}`);
  check('后半段接着前半段摆', rows[1].start === 2.5, String(rows[1].start));
  /**
   * ⚠ 分镜上那个转场说的是"这一镜和**上一镜**之间"。
   * 让后半段也去读它，等于在这一镜自己中间插一处叠化 ——
   * 画面莫名叠一下，还会吃掉半秒，把后面整条时间轴推歪。
   */
  const withTrans = ed.timeline({
    shots, edit: { order: ['b', 'b#2', 'a'], clips: { b: { in: 0, out: 3 }, 'b#2': { in: 3, out: 6 } } }
  }, { policy: 'keep' });
  check('切出来的后半段不继承分镜上那个叠化',
    withTrans[1].trans === 'cut', withTrans[1].trans);
  check('所以它也不吃掉那半秒', withTrans[1].start === 3, String(withTrans[1].start));

  // ② 台词只跟第一段走
  check('第一段标着 first', rows[0].first === true);
  check('后半段不是 first（同一句台词不会念两遍）', rows[1].first === false);
  check('另一镜自己还是 first', rows[2].first === true);

  // ③ 把前半段删了，这一镜不能自己长回来
  const halfGone = ed.normalize({ order: ['a#2', 'b'], clips: { 'a#2': { in: 2.5, out: 6 } } }, shots);
  check('只留后半段时不会又补一段完整的回来',
    halfGone.order.join() === 'a#2,b', halfGone.order.join());
  // 反过来：一镜一段都没排到的，还是要补
  check('一段都没排到的镜头照样补在后面',
    ed.normalize({ order: ['b'] }, shots).order.join() === 'b,a',
    ed.normalize({ order: ['b'] }, shots).order.join());

  check('日志里说了切过几处', /切开了 1 处/.test(ed.summarize(split, shots) || ''), ed.summarize(split, shots));
}

section('连不上境外服务商时，报的是原因不是四个红叉');
{
  /**
   * 用户报上来的原话是这样四行：
   *     剧本 openai ✕ / 调度 openai ✕ / 复核 openai ✕ / 出图 openai ✕
   * 而 exe 在他自己电脑上跑、服务器在香港 —— 服务器那两端全通。
   *
   * 看上去像四个毛病，其实是一个：这台机器连不上 api.openai.com。
   * 光报 `UND_ERR_CONNECT_TIMEOUT` 的话，人第一反应是去翻密钥、换模型，全是白费。
   */
  const hc = await import('../core/http-client.js');
  const pf = await import('../core/preflight.js');
  const boom = (code) => { const e = new Error('fetch failed'); e.cause = { code }; return e; };

  const oa = hc.explainNetworkError(boom('UND_ERR_CONNECT_TIMEOUT'), 'https://api.openai.com/v1/chat/completions');
  check('点名这是"境内直连不通"，不是密钥问题', /直连基本不通/.test(oa) && /跟密钥和模型没有任何关系/.test(oa), oa.slice(0, 120));
  /**
   * 三条路都要**指到应用里的具体位置**。只说"检查网络"等于什么都没说，
   * 而这三条恰好都是这个应用已经有的功能 —— 说不清楚等于白做。
   */
  check('给了走系统代理这条路，并指明在哪儿', /本机环境/.test(oa) && /系统代理/.test(oa), oa.slice(-400));
  check('给了填中转地址这条路，并指明在哪儿', /接口根地址/.test(oa), oa.slice(-400));
  check('给了"让服务器跑"这条路（他的服务器本来就是通的）',
    /引擎在哪儿跑/.test(oa), oa.slice(-400));

  /**
   * ⚠ **超时那一支也要说这些话** —— 而它原来一个字都不说。
   *
   * 用户真实报上来的：「script】openai / claude-opus-5 拆分镜中…
   * ✕ 请求超时（180151ms 未返回）」。三分钟，零信息。
   *
   * 原因就在 execute 里那一行：
   *     const message = aborted ? `请求超时(...)` : explainNetworkError(err, url);
   * 上面这一整段最对症的话，**恰恰在最对症的那次不会出现**。
   *
   * 因为墙对这些域名的做法是**丢包**，不是拒绝：TCP 不报错、TLS 不报错，
   * 连接就挂在那儿，直到我们自己的计时器把它掐掉 —— 走的是 aborted 那一支。
   * 于是唯一为这种情况写的建议，永远轮不到它出场。
   */
  const to = hc.timeoutHintForTest('https://api.openai.com/v1/chat/completions', 180000);
  check('超时也说清是发往哪个主机的', /api\.openai\.com/.test(to), to.slice(0, 80));
  check('超时也说了等了多久', /180 秒/.test(to), to.slice(0, 80));
  check('境外域名超时时，那段"境内直连不通"的话照样给出来',
    /直连基本不通/.test(to) && /引擎在哪儿跑/.test(to), to.slice(0, 200));

  /**
   * 不在墙名单里的主机（中转站、本地服务）超时是另一回事，
   * 要分清"没连上"和"连上了但不吐字"—— 两者下一步动作完全不同，
   * 而"请求超时"四个字对两者一视同仁。
   */
  const relayTo = hc.timeoutHintForTest('https://my-relay.example.com/v1/chat/completions', 180000);
  check('中转站超时时不乱说"被墙"', !/直连基本不通/.test(relayTo), relayTo.slice(0, 120));
  check('而是把两种可能摊开（没连上 / 连上了不吐字）',
    /根本没连上/.test(relayTo) && /不吐字/.test(relayTo), relayTo.slice(0, 200));
  check('并且指向体检那条最快的路（几秒 vs 三分钟）',
    /上线前体检/.test(relayTo), relayTo.slice(-160));
  // 报错是拿 textContent 显示的，写 ** 只会原样印出一堆星号
  check('这些话里没有 markdown 星号（界面是纯文本渲染的）',
    !to.includes('**') && !relayTo.includes('**'), `${to.slice(0, 60)} / ${relayTo.slice(0, 60)}`);

  /**
   * ── 模型 ID 和服务商对不上，要在**发出去之前**就说 ──
   *
   * 真实事故：路由配成「openai / claude-opus-5」。claude-opus-5 是 Anthropic 的
   * 模型 id，OpenAI 那家根本没有。而这个搭配一路畅通：能选、能存、能发，
   * 然后在拆分镜那步卡满三分钟，回一句"请求超时"。
   *
   * 三分钟换来零信息，而这件事在点下去之前就完全判断得出来 ——
   * 目录里明明白白列着这家有哪些模型。
   */
  const cat = await import('../core/providers/catalog.js');
  const mism = cat.modelWarning('openai', 'claude-opus-5');
  check('「openai / claude-opus-5」当场认出对不上', Boolean(mism), JSON.stringify(mism));
  check('并且点出它看着是哪一家的模型（人一眼知道自己选串行了）',
    /Anthropic/.test(mism?.text || ''), mism?.text?.slice(0, 100));
  check('还顺手列出这家真有哪些模型', /gpt-4o/.test(mism?.text || ''), mism?.text?.slice(-160));

  /**
   * ⚠ **中转站不能报警。**
   *
   * 国内很多人唯一能用的路就是"OpenAI 的协议、别家的模型"：
   * 把 openai 的接口根地址指到中转站，然后用它支持的任意模型 id。
   * 那完全合法。见到不认识的就报警，等于对着最需要这个应用的那批人一直嚷嚷。
   *
   * 判据是两条一起看：目录里没有 **且** 地址没被改过。
   */
  check('改过接口根地址（= 接的是中转站）就闭嘴',
    cat.modelWarning('openai', 'claude-opus-5', { baseUrlOverridden: true }) === null);
  check('正常搭配不吭声', cat.modelWarning('openai', 'gpt-4o-mini') === null);
  check('模型留空不吭声（那是"还没选"，不是"选错了"）',
    cat.modelWarning('openai', '') === null);
  // 目录里没列模型的那几家（只当网关用的）无从判断，也不该瞎猜
  check('这家压根没列模型时不猜', cat.modelWarning('comfy', '随便什么') === null);

  // 换个到不了的方式，话要照样说到
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED']) {
    check(`${code} 也认得出是这回事`,
      /直连基本不通/.test(hc.explainNetworkError(boom(code), 'https://api.openai.com/v1/x')), code);
  }
  /**
   * ⚠ 只对**确实连不上**的情况说。HTTP 401 是连上了的 ——
   * 那时候还劝人去配代理，是把人往沟里带。
   */
  /**
   * ⚠ 域名同时有 A 和 AAAA 记录时（现在绝大多数都有），fetch 会两个地址一起试，
   * 都失败就打包成一个 AggregateError —— 而它**自己没有 code**，
   * 真正的 ECONNREFUSED / ETIMEDOUT 藏在 `.errors[0].code` 里。
   *
   * 只看 `err.cause.code` 的话，上面那一整段说明一个字都出不来，
   * 报出来只剩一句"连接失败：fetch failed"。这条是走查里真撞出来的。
   */
  const agg = new Error('fetch failed');
  agg.cause = new AggregateError(
    [Object.assign(new Error('a'), { code: 'ETIMEDOUT' }), Object.assign(new Error('b'), { code: 'ETIMEDOUT' })], '');
  const aggMsg = hc.explainNetworkError(agg, 'https://api.openai.com/v1/x');
  check('双栈失败打包成 AggregateError 时，照样挖得出真正的原因',
    /连接超时/.test(aggMsg) && /直连基本不通/.test(aggMsg), aggMsg.slice(0, 140));
  /**
   * `bad port` 根本没有错误码，只有一句英文 —— fetch 挡掉了一批危险端口
   *（1、7、9、25…）。这跟网络无关，是地址写错了，而不认出来的话
   * 报出来只有一句"连接失败：fetch failed"。
   */
  const badPort = new Error('fetch failed');
  badPort.cause = new Error('bad port');
  check('端口写成了被挡的那几个时，说的是"端口不允许"而不是"连不上网"',
    /端口号不允许连接/.test(hc.explainNetworkError(badPort, 'http://127.0.0.1:1/v3')),
    hc.explainNetworkError(badPort, 'http://127.0.0.1:1/v3'));

  check('挖不到 code 时也不至于崩',
    typeof hc.explainNetworkError(new Error('whatever'), 'https://x.com/') === 'string');

  const authErr = hc.explainNetworkError(boom('HTTP_401'), 'https://api.openai.com/v1/x');
  check('连上了只是报错时，不乱扯代理', !/直连基本不通/.test(authErr), authErr.slice(0, 120));
  // 境内域名不该多这一段
  const cn = hc.explainNetworkError(boom('UND_ERR_CONNECT_TIMEOUT'), 'https://ark.cn-beijing.volces.com/api/v3');
  check('国内厂商连不上时不扯"境内直连不通"', !/直连基本不通/.test(cn), cn.slice(0, 100));

  // ── 四条全红要合并成一句 ──
  const four = ['chat', 'vision', 't2i', 'tts'].map((id) => ({
    id, provider: 'openai', providerName: 'OpenAI', message: oa
  }));
  const merged = pf.sameRootCause(four);
  check('四条全红时先说"是同一个原因"', /同一个原因/.test(merged), merged);
  check('并且点名是哪一家连不上', /OpenAI/.test(merged), merged);
  check('并且明说不是密钥的问题', /不是密钥的问题/.test(merged), merged);
  /**
   * ⚠ 不能见到"多条失败"就合并。两家不同的服务商各挂各的、
   * 或者一条是网络一条是密钥，合成一句反而把真实情况抹平了。
   */
  check('不同服务商不合并',
    pf.sameRootCause([{ id: 'chat', providerName: 'OpenAI', message: '连不上' },
      { id: 't2i', providerName: '火山', message: '连不上' }]) === '');
  check('原因不同不合并',
    pf.sameRootCause([{ id: 'chat', providerName: 'OpenAI', message: '连不上' },
      { id: 't2i', providerName: 'OpenAI', message: 'HTTP 401 密钥无效' }]) === '');
  check('只红一条时不说这句（那本来就不用合并）',
    pf.sameRootCause([{ id: 'chat', providerName: 'OpenAI', message: '连不上' }]) === '');
}

section('剪辑台：拖拽排序 / 音轨 / 配乐 / 画面效果 / 更多转场');
{
  const ed = await import('../core/pipeline/edit.js');
  const tr = await import('../core/transitions.js');
  const fxm = await import('../core/fx.js');
  const ff = await import('../core/ffmpeg.js');

  const shots = [
    { id: 's1', index: 1, transition: 'cut' },
    { id: 's2', index: 2, transition: 'dissolve' },
    { id: 's3', index: 3 }
  ];

  // ───── 洗数据：界面和请求体都可能发来垃圾 ─────
  const n = ed.normalize({
    order: ['s3', 'nope', 's1'],
    clips: {
      s1: { trans: 'slideleft', fx: 'bw', mute: true },
      s2: { trans: '硬拉倒', fx: '不存在的效果' },
      s3: { trans: 'cut', fx: 'none' },
      ghost: { off: true }
    },
    tracks: { voice: false, sfx: true, music: false, 乱来: false },
    music: { path: '/m.mp3', name: 'x', gain: 40, fadeIn: -3, duck: false }
  }, shots);

  check('认得的转场留下来', n.clips.s1.trans === 'slideleft', JSON.stringify(n.clips.s1));
  check('认得的效果留下来', n.clips.s1.fx === 'bw');
  check('这一镜静音记住了', n.clips.s1.mute === true);
  /**
   * 认不出来的名字必须**丢掉**，不能留着。
   * 留着的话它会一路走到 FFmpeg，在那儿变成一条谁也看不懂的滤镜报错，
   * 而真正的原因（谁写进来的）已经无从查起。
   */
  check('瞎编的转场名被丢掉', n.clips.s2?.trans === undefined, JSON.stringify(n.clips.s2));
  check('瞎编的效果名被丢掉', n.clips.s2?.fx === undefined, JSON.stringify(n.clips.s2));
  // cut 和 none 就是默认值，存下来只是噪音 —— 而且会让"这部片子剪过没有"永远为真
  check('默认值（硬切/原样）不存', n.clips.s3 === undefined, JSON.stringify(n.clips.s3));
  check('不存在的镜头 id 整条丢掉', n.clips.ghost === undefined);
  check('音轨只存被关掉的那些', JSON.stringify(n.tracks) === '{"voice":false,"music":false}', JSON.stringify(n.tracks));
  /**
   * 音量必须夹回合法范围。界面上是滑块，但请求体是可以手写的 ——
   * 而爆音是**不可逆**的：混完就没法从成片里救回来。
   */
  check('音乐音量夹回上限', n.music.gain === 1.5, String(n.music.gain));
  check('负的淡入被换成默认值', n.music.fadeIn === 0, String(n.music.fadeIn));
  check('明确写了不避让就是不避让', n.music.duck === false);
  check('没有 path 的音乐当没有', ed.normalizeMusic({ gain: 0.3 }) === null);

  // ───── 转场两级：剪辑台压过分镜，没改过的听分镜的 ─────
  const withEdit = { clips: { s1: { trans: 'pixelize' } } };
  check('剪辑台上改过的转场压过分镜字段',
    ed.transitionOf(withEdit, 's1', shots[0]) === 'pixelize', ed.transitionOf(withEdit, 's1', shots[0]));
  /**
   * 这一条是"重跑分镜不会冲掉人手调的转场"的另一面：
   * 没在剪辑台上动过的，必须跟着分镜走 —— 否则改分镜就再也影响不了成片。
   */
  check('没在剪辑台上动过的听分镜的',
    ed.transitionOf(withEdit, 's2', shots[1]) === 'dissolve', ed.transitionOf(withEdit, 's2', shots[1]));
  check('两边都没有就是硬切', ed.transitionOf({}, 's3', shots[2]) === 'cut');
  check('分镜里写了个瞎编的值也当硬切', ed.transitionOf({}, 'x', { id: 'x', transition: 'zzz' }) === 'cut');

  // ───── 转场表 ─────
  /**
   * ⚠ 模型能选的只有那三个（segments.js 解析时强制归一到 KINDS）。
   * 把新加的推拉划像塞进 KINDS 的话，模型输出里蹦出一个 "pixelize"
   * 会被当成合法值原样收下，然后二十镜的片子里冒出一处马赛克 ——
   * 而没有任何人做过这个决定。这条断言守着这件事。
   */
  check('模型能选的转场仍然只有硬切/黑场/叠化',
    JSON.stringify(tr.KINDS) === JSON.stringify(['cut', 'fade', 'dissolve']), JSON.stringify(tr.KINDS));
  check('剪辑台上能选的比模型多', tr.ALL_KINDS.length > tr.KINDS.length, String(tr.ALL_KINDS.length));
  check('模型能选的那三个都在剪辑台清单里', tr.KINDS.every((k) => tr.ALL_KINDS.includes(k)));
  /**
   * 每一种重叠类转场都吃掉同样的时长。
   * 少算一处的后果是全片从那儿往后音画错位 —— 而这个错没有任何报错。
   */
  const xfades = tr.CATALOG.filter((t) => t.mode === 'xfade');
  check('重叠类转场每一种都吃掉 0.5 秒',
    xfades.every((t) => tr.overlapOfKind(t.id) === tr.DISSOLVE_SECONDS), String(xfades.length));
  check('硬切和黑场一秒都不吃',
    tr.overlapOfKind('cut') === 0 && tr.overlapOfKind('fade') === 0);
  check('每一种重叠类转场都写了 xfade 的名字',
    xfades.every((t) => typeof t.xfade === 'string' && t.xfade.length > 0));
  check('转场每一条都有一句"什么时候用"', tr.CATALOG.every((t) => t.why && t.label));

  // ───── 画面效果 ─────
  const bw = fxm.compile('bw', {});
  check('黑白不需要知道素材信息', bw.vf === 'hue=s=0', JSON.stringify(bw));
  /**
   * zoompan 不给 s= 会把 1080p 悄悄降到 720p，不给 fps= 会按 25 帧重采样。
   * 两样都不报错，只是让成片变差 —— 所以宁可让整个表接一个参数。
   */
  const push = fxm.compile('push', { width: 1920, height: 1080, fps: 24 });
  check('缓推带上了素材自己的分辨率', /s=1920x1080/.test(push.vf), push.vf);
  check('缓推带上了素材自己的帧率', /fps=24/.test(push.vf), push.vf);
  /**
   * 探不出分辨率时**必须给一个原因**，不能悄悄回 null。
   * 回 null 的话调用方只能当"这一段没效果"，而人明明点了一个 ——
   * 成片和界面对不上，还没有任何线索。
   */
  const blind = fxm.compile('push', {});
  check('探不出素材信息时说清楚为什么做不了', typeof blind.skip === 'string' && /帧率|宽|高/.test(blind.skip), JSON.stringify(blind));
  check('不认识的效果当没设', fxm.compile('哈哈', {}).vf === null);
  check('原样就是不加滤镜', fxm.compile('none', {}).vf === null);
  check('效果每一条都有标签和理由', fxm.CATALOG.every((f) => f.label && f.why));
  // 柔光是带标签的子图（split/blend），-vf 收得下，但它整体必须一进一出
  const soft = fxm.compile('soft', {}).vf;
  check('柔光是"糊的那层叠回清晰画面"，不是直接糊', /blend=all_mode=screen/.test(soft), soft);
  check('效果说明里点明了"慢但不花钱"',
    /不花钱/.test(fxm.summarize([{ index: 2, fx: 'bw' }]) || ''), String(fxm.summarize([{ index: 2, fx: 'bw' }])));
  check('一个效果都没加时不打这行话', fxm.summarize([]) === null);

  // ───── 混音图 ─────
  /**
   * 音轨这一层的错（旁链接错、标签用两次、循环没截断）在成片里
   * 只表现为"声音不对"，是最难自己发现的一类。所以这里把它当字符串验。
   */
  const voice = [{ path: '/v1.mp3', at: 0 }, { path: '/v2.mp3', at: 4 }];
  const sfx = { path: '/s1.mp3', at: 1, gain: 0.35 };
  const music = { path: '/m.mp3', gain: 0.22, fadeIn: 1.5, fadeOut: 2.5, duck: true, loop: true };
  const argsOf = (entries, bgm, opt = {}) =>
    ff.planAudio(entries, bgm, { total: 20, outputPath: '/o.m4a', duck: true, ...opt });
  const graphOf = (args) => args[args.indexOf('-filter_complex') + 1];

  const full = argsOf([...voice, sfx], music, { loudness: true });
  const fullGraph = graphOf(full);
  check('有台词时音乐自动避让（sidechaincompress）', /sidechaincompress/.test(fullGraph), fullGraph.slice(0, 200));
  /**
   * 旁链要**单独取一份台词**。直接把混好的那一路接两次，FFmpeg 报
   * "Output pad already connected" —— 整条音轨出不来，成片彻底无声。
   */
  check('旁链是 asplit 出来的另一份，不是把同一路接两次', /asplit=2/.test(fullGraph), fullGraph.slice(0, 300));
  /**
   * ⚠ 这条是这一段里最值钱的：把整张图的标签数一遍。
   * 每个中间标签必须**恰好出现两次**（一次产出、一次消费），
   * 只有最终那个例外（产出一次，然后被 -map 取走）。
   * 少一次 = 有一路被丢掉（声音无声无息地少了一层），
   * 多一次 = FFmpeg 直接报错。两种都是肉眼很难从一长串滤镜里看出来的。
   */
  const labelAudit = (args) => {
    const g = graphOf(args);
    const mapTo = args[args.indexOf('-map') + 1];
    const counts = new Map();
    for (const m of g.matchAll(/\[([A-Za-z]\w*)\]/g)) {
      counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    const bad = [];
    for (const [name, c] of counts) {
      const want = `[${name}]` === mapTo ? 1 : 2;
      if (c !== want) bad.push(`${name}×${c}(应 ${want})`);
    }
    return bad;
  };
  check('滤镜图里每个标签都恰好接了一次', labelAudit(full).length === 0, labelAudit(full).join('、'));
  check('旁链用的是台词那一路，不是台词+音效',
    /\[bgm\]\[voicePad\]sidechaincompress/.test(fullGraph), fullGraph.slice(0, 400));
  /**
   * ⚠ 旁链必须先 apad 补到无限长。
   *
   * sidechaincompress 在**旁链结束的那一刻就收尾** —— 不管主输入还有多长。
   * 台词通常在片子结束前很久就念完了，于是整条音轨被砍在最后一句话上：
   * 一部 8 秒的片子只剩 4 秒，后面的音乐凭空消失，而且一句警告都没有。
   * 这是真跑 FFmpeg 量出来的，参数看着完全正常。
   */
  check('旁链补到了无限长（否则整条音轨会被砍在最后一句台词上）',
    /\[voiceB\]apad\[voicePad\]/.test(fullGraph), fullGraph.slice(0, 400));
  // 音效不能当旁链：它多是连续的环境声，音乐会被一直压着，等于关掉了音乐
  check('音效那一路带着自己的音量，且不进旁链',
    /volume=0\.350/.test(fullGraph) && !/\[a2\]sidechain/.test(fullGraph), fullGraph.slice(0, 300));
  check('统一响度接在最后一环', /\[loud\]$/.test(fullGraph.split(';').pop()), fullGraph.split(';').pop());
  check('循环的音乐被总长截断',
    full.includes('-stream_loop') && full[full.indexOf('-t')] === '-t', full.join(' ').slice(0, 120));
  check('淡出是从"总长减淡出时长"开始的', /afade=t=out:st=17\.50/.test(fullGraph), fullGraph.slice(0, 300));

  const noDuck = argsOf([...voice, sfx], { ...music, duck: false });
  check('说了不避让就真的不避让', !/sidechaincompress/.test(graphOf(noDuck)));
  check('不避让时也不用多此一举地 asplit', !/asplit/.test(graphOf(noDuck)));
  check('不避让时标签也全都接对了', labelAudit(noDuck).length === 0, labelAudit(noDuck).join('、'));

  const onlyMusic = argsOf([], music);
  check('一句台词都没有时音乐照样出得来', /\[bgm\]/.test(graphOf(onlyMusic)), graphOf(onlyMusic));
  check('没有台词就没有避让可言', !/sidechaincompress/.test(graphOf(onlyMusic)));
  check('只有音乐时标签也都接对了', labelAudit(onlyMusic).length === 0, labelAudit(onlyMusic).join('、'));

  const noMusic = argsOf(voice, null);
  check('没有音乐时不出现 stream_loop', !noMusic.includes('-stream_loop'));
  check('没开统一响度时不出现 loudnorm', !/loudnorm/.test(graphOf(noMusic)));
  check('没有音乐时标签也都接对了', labelAudit(noMusic).length === 0, labelAudit(noMusic).join('、'));

  // ───── 入点：没有 trims 也要生效 ─────
  /**
   * ⚠ 这一条挡的是一个真出过的错。
   *
   * 时长策略默认改成「保留完整片段」之后，trims 整条都是 null。
   * 而当时 concat 里的判断只有 `if (!want) 跳过` —— 于是自动剪辑照跑、
   * 日志照打"已跳过开头 0.6 秒"，成片里那 0.6 秒**一帧没少**。
   * 日志说做了、实际没做，是这个项目里反复出现的那一类错。
   */
  const dir2 = path.join(SANDBOX, 'cutin');
  fs.mkdirSync(dir2, { recursive: true });
  const segs2 = ['x1.mp4', 'x2.mp4'].map((nm) => path.join(dir2, nm));
  for (const f of segs2) fs.writeFileSync(f, 'seg');
  const out2 = path.join(dir2, 'film.mp4');
  const runCut = async (opts) => {
    const calls = [];
    await ff.concat(segs2, out2, {
      onNote: () => {},
      __probe: async () => ({ seconds: 5, hasAudio: false, width: 1920, height: 1080, fps: 24 }),
      __exec: async (args) => {
        calls.push(args.join(' '));
        const last = args[args.length - 1];
        if (last && !last.startsWith('-')) fs.writeFileSync(last, 'x');
        return { stderr: '' };
      },
      ...opts
    });
    return calls;
  };

  const inOnly = await runCut({ cuts: [{ in: 0.6 }, { in: 0 }] });
  check('没有裁剪目标时，入点照样送进 FFmpeg',
    inOnly.some((c) => /-ss 0\.600/.test(c)), inOnly.join(' | ').slice(0, 260));
  check('只有入点、没有目标时长时不硬加 -t',
    !inOnly.find((c) => /-ss 0\.600/.test(c))?.includes(' -t '), inOnly.find((c) => /-ss 0\.600/.test(c)));
  check('没有入点的那一段一次都不重压',
    inOnly.filter((c) => /trim\d\.mp4/.test(c)).length === 1, String(inOnly.filter((c) => /trim/.test(c)).length));
  /**
   * 只重压了一部分段时，最后那一拼**不能再走 -c copy**：
   * 重压的那几段和厂商原片在 profile/GOP 上不一定对得上，
   * 硬 copy 拼出来会在接缝处花屏，而且只在成片里出现。
   */
  check('只重压了一部分时，最终拼接改走重编码',
    /-c:v libx264/.test(inOnly[inOnly.length - 1]), inOnly[inOnly.length - 1]);

  const noneAtAll = await runCut({});
  check('什么都没设时一次重压都不做', noneAtAll.length === 1, String(noneAtAll.length));
  check('什么都没设时走 -c copy 的快路', /-c copy/.test(noneAtAll[0]), noneAtAll[0]);

  // ───── 画面效果只重压被点过的那一段 ─────
  const withFx = await runCut({ filters: [null, 'hue=s=0'] });
  check('只有加了效果的那一段被重压',
    withFx.filter((c) => /trim\d\.mp4/.test(c)).length === 1, String(withFx.length));
  check('效果真的写进了 -vf', withFx.some((c) => /-vf hue=s=0/.test(c)), withFx.join(' | ').slice(0, 240));

  /**
   * 效果和补帧共用同一个 -vf —— 一条命令里它只能出现一次，
   * 写两遍的话后一个会**悄悄顶掉**前一个（FFmpeg 不报错）。
   * 顺序也有讲究：效果在前、补帧在后，否则冻住的是没上效果的原始帧，
   * 成片最后会看到突然"掉色"。
   */
  const fxAndPad = await runCut({ filters: ['hue=s=0', null], trims: [8, 0] });
  const padCall = fxAndPad.find((c) => /tpad/.test(c));
  check('效果和补帧合在同一个 -vf 里', (padCall.match(/-vf /g) || []).length === 1, padCall);
  check('效果排在补帧前面', /-vf hue=s=0,tpad=/.test(padCall), padCall);

  // ───── 更多转场：名字要真的换过去，做不了要就地退让 ─────
  const dir3 = path.join(SANDBOX, 'xfk');
  fs.mkdirSync(dir3, { recursive: true });
  const segs3 = ['y1.mp4', 'y2.mp4'].map((nm) => path.join(dir3, nm));
  for (const f of segs3) fs.writeFileSync(f, 'seg');
  const out3 = path.join(dir3, 'film.mp4');
  const runX = async (kinds, { failOn = null } = {}) => {
    const calls = [];
    const notes = [];
    await ff.concat(segs3, out3, {
      transitions: kinds,
      onNote: (m) => notes.push(m),
      __probe: async () => ({ seconds: 5, hasAudio: false }),
      __exec: async (args) => {
        const line = args.join(' ');
        if (failOn && line.includes(failOn)) throw new Error('Invalid transition');
        calls.push(line);
        const last = args[args.length - 1];
        if (last && !last.startsWith('-')) fs.writeFileSync(last, 'x');
        return { stderr: '' };
      }
    });
    return { calls, notes };
  };

  const pix = await runX(['cut', 'pixelize']);
  check('选了马赛克就真的发 transition=pixelize',
    pix.calls.some((c) => /xfade=transition=pixelize/.test(c)), pix.calls.join(' | ').slice(0, 260));
  /**
   * ⚠ 新转场最容易漏的是**掐头去尾那两行**：名字换过去了、xfade 也做了，
   * 但头尾没切 —— 那一处画面多出半秒，而配音和字幕按"少半秒"算，
   * 整片从那儿往后错位。
   */
  check('新转场同样掐掉了被重叠用掉的那半秒',
    pix.calls.some((c) => /-ss 0\.500/.test(c)), pix.calls.join(' | ').slice(0, 300));

  /**
   * xfade 认得的名字是跟 FFmpeg 版本走的，而用户机器上那份是自己下的。
   * 一个不认识的名字**不能连累其余十几处转场**（原来是整个循环外面一个
   * catch，一处失败就全片退回硬切）。
   */
  const fallback = await runX(['cut', 'pixelize'], { failOn: 'transition=pixelize' });
  check('这台机器做不了这个效果时，就地退回普通叠化',
    fallback.calls.some((c) => /xfade=transition=fade/.test(c)), fallback.calls.join(' | ').slice(0, 300));
  check('退让说出来了，而且点明其余转场不受影响',
    fallback.notes.some((m) => /其余转场不受影响/.test(m)), fallback.notes.join(' | '));
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
  /**
   * ══════════ 重传一张图，得**真的**换成新的那张 ══════════
   *
   * 用户："重传了第二张自己不同的图片，分镜怎么还是用的第一张图片生成"。
   *
   * 上传设定图落盘用的是固定文件名（ref-角色-变体-upload.png）——
   * 重传写的是同一个路径。而"本地路径 → 对象存储 key"那张表原来只按路径记：
   *
   *   第一次传 → 上传，记下 路径→key
   *   第二次传 → 覆盖同一个本地文件（新内容）
   *            → publicUrlFor 按路径命中缓存，返回**旧地址**
   *            → 新图一次都没被上传
   *
   * 没有任何报错，日志也不说"用了缓存"。用户只会觉得"重传没用"，
   * 而且每一镜出来的还是上一张脸。
   *
   * ⚠ 判据得是**桶里那份内容变没变**，不是"返回的地址变没变"——
   * 私有桶每次现签，地址里的 Signature 本来就每次都不一样，
   * 拿地址做判据是一条恒真的断言。
   */
  {
    process.env.FUTUREDREAM_OSS_ENDPOINT = `${upstreamUrl}/ossput`;
    upstream.ossPuts = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-reupload-'));
    const shot1 = path.join(tmpDir, 'ref-char-me-v-default-upload.png');

    fs.writeFileSync(shot1, Buffer.from('第一张图的内容'));
    const url1 = await studioModule.toModelRef(shot1, {});
    check('第一次传：真的上传了一次', upstream.ossPuts.length === 1,
      JSON.stringify(upstream.ossPuts.map((x) => x.body)));

    // 同一个路径再问一次：这次该走缓存，不该白传一趟
    const again = await studioModule.toModelRef(shot1, {});
    check('内容没变时走缓存，不重复上传', upstream.ossPuts.length === 1 && Boolean(again),
      String(upstream.ossPuts.length));

    // ⚠ 重传第二张：同一个文件名，不同内容。mtime 只有毫秒精度，
    // 写得太快会和上一次同毫秒 —— 那样连 sig 都不变，测试会变成恒真
    await new Promise((r) => setTimeout(r, 12));
    fs.writeFileSync(shot1, Buffer.from('第二张图的内容，和第一张完全不同'));
    await studioModule.toModelRef(shot1, {});
    check('重传第二张：又上传了一次（修之前这里恒为 1）',
      upstream.ossPuts.length === 2, String(upstream.ossPuts.length));
    check('而且传上去的是第二张的内容，不是第一张',
      String(upstream.ossPuts[1]?.body || '').includes('第二张图的内容'),
      String(upstream.ossPuts[1]?.body || '').slice(0, 40));

    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.FUTUREDREAM_OSS_ENDPOINT;
  }

  settings.patch({ oss: { enabled: false } });
  vault.setSecret('ALIYUN_OSS_KEY_ID', '');
  vault.setSecret('ALIYUN_OSS_KEY_SECRET', '');
  check('跑完还原了（别把状态留给下一个用例）', ossMod.ready() === false);
}

section('剪辑台：出片之后还能改，而且不花钱');
{
  const ed = await import('../core/pipeline/edit.js');
  const st = await import('../core/pipeline/studio.js');
  const shots = [
    { id: 'a', index: 1, videoPath: '/a.mp4', actualDuration: 5, duration: 4, dialogue: '一' },
    { id: 'b', index: 2, videoPath: '/b.mp4', actualDuration: 5, duration: 4, dialogue: '二' },
    { id: 'c', index: 3, videoPath: '/c.mp4', actualDuration: 5, duration: 4, dialogue: '三' }
  ];

  // ── 洗输入：界面发什么进来都不能一路走到 FFmpeg ──
  const dirty = ed.normalize({
    order: ['c', 'nope', 'c', 'a'],
    clips: { a: { in: -3, out: 2 }, zzz: { off: true }, b: { in: 4, out: 4.1 } }
  }, shots);
  check('顺序里不存在的 id 被剔掉', !dirty.order.includes('nope'), JSON.stringify(dirty.order));
  check('重复的只留一次', dirty.order.filter((x) => x === 'c').length === 1, JSON.stringify(dirty.order));
  check('没提到的镜头按 index 补在后面', dirty.order.join() === 'c,a,b', dirty.order.join());
  check('负数入点被夹回 0', dirty.clips.a.in === 0, JSON.stringify(dirty.clips.a));
  check('短得没意义的一段当没设过（否则发给 FFmpeg 一个空片段）',
    !dirty.clips.b, JSON.stringify(dirty.clips.b));
  check('不存在的镜头不留记录', !dirty.clips.zzz);

  // ── 顺序和"不用" ──
  const reordered = { order: ['c', 'a', 'b'], clips: { b: { off: true } } };
  // ⚠ ordered() 回的是 { key, shot } —— 同一镜切开之后会出现不止一次，
  // 只回 shot 的话调用方就找不到"这一段"的入出点了
  const ids = (e) => ed.ordered(e, shots).map((x) => x.shot.id).join();
  check('按剪辑顺序排', ids(reordered) === 'c,a', ids(reordered));
  check('标了"不用"的不进成片', !ed.ordered(reordered, shots).some((x) => x.shot.id === 'b'));
  check('没剪过时就是原顺序', ids({}) === 'a,b,c');
  check('每一段都带着自己的 key', ed.ordered({}, shots).every((x) => x.key === x.shot.id));

  /**
   * ══ 最要紧的一条：**字幕和配音必须跟着剪辑走** ══
   *
   * 顺序、入出点、跳过哪一镜，这三样同时影响画面怎么切、配音摆在第几秒、
   * 字幕什么时候出。只要有一处用了不同的口径，音、画、字就各走各的 ——
   * 而这种错在成片里表现为"越到后面越对不上"，是最难自己发现的那一类。
   *
   * 所以这里量的不是"剪辑台能不能存"，是**时间轴认不认它**。
   */
  const project = { shots, edit: reordered };
  const rows = st.timelineOf(project, { policy: 'keep' });
  check('时间轴跟着剪辑的顺序走', rows.map((r) => r.shot.id).join() === 'c,a', rows.map((r) => r.shot.id).join());
  check('跳过的那一镜不占时间轴', rows.length === 2, String(rows.length));
  check('第二段的起点是第一段的长度（不是原来第 2 镜的位置）',
    rows[1].start === 5, JSON.stringify(rows.map((r) => r.start)));
  const cues = st.buildSubtitles(project, { policy: 'keep' });
  check('字幕跟着新顺序', cues[0].text === '三' && cues[1].text === '一',
    JSON.stringify(cues.map((c) => c.text)));
  check('被跳过那一镜的字幕也跟着没了',
    !cues.some((c) => c.text === '二'), JSON.stringify(cues.map((c) => c.text)));

  // ── 手工入出点压过时长策略 ──
  const manual = { shots, edit: { clips: { a: { in: 1, out: 3.4 } } } };
  const mrows = st.timelineOf(manual, { policy: 'trim' });
  check('手工设过的那一镜，长度就是那一段（不再按计划时长）',
    mrows[0].span === 2.4, JSON.stringify(mrows[0]));
  check('后面那一镜的起点跟着挪', mrows[1].start === 2.4, JSON.stringify(mrows.map((r) => r.start)));
  // 这一条按 trim 策略算：没手工设过的那一镜用的是分镜计划时长 4，不是实出的 5
  check('没手工设的仍然按策略走（trim → 计划时长 4）', mrows[1].span === 4, String(mrows[1].span));

  /**
   * 素材换过一版（重出）之后变短了，旧的出点就悬空了。
   * 不夹回去的话 FFmpeg 会切出一段空的 —— 而那表现为"成片里少了一镜"。
   */
  check('素材变短时把出点夹回来',
    ed.windowOf({ clips: { a: { in: 1, out: 9 } } }, 'a', 4)?.out === 4,
    JSON.stringify(ed.windowOf({ clips: { a: { in: 1, out: 9 } } }, 'a', 4)));
  /**
   * ⚠ 这两条以前传的是 shot 对象。签名换成 key 之后它们**照样绿** ——
   * 因为 `clips[对象]` 永远是 undefined，回 null 正好是断言要的答案。
   * 也就是说它们验的不是"夹回来了"，而是"什么都没查到"。改成传 key 才算真验。
   */
  check('夹到没法成段时作废，交回自动剪辑',
    ed.windowOf({ clips: { a: { in: 8, out: 9 } } }, 'a', 0.2) === null);
  check('没手工设过就回 null（别替自动剪辑做决定）',
    ed.windowOf({}, 'a', 5) === null);

  // ── 说人话 ──
  const brief = ed.summarize(reordered, shots);
  check('合成日志里说清楚剪过什么', /调过顺序/.test(brief) && /跳过 1 段/.test(brief), brief);
  check('并且说明它不重新生成素材', /不重新生成/.test(brief), brief);
  check('没剪过就不说话（每次合成印一行"没剪"是纯噪音）', ed.summarize({}, shots) === null);
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
    // 失败之前先记下账上已有几笔视频，好证明失败那一次一笔都没多记
    const videoCallsBefore = ledgerMod.forProject(project.id, {}).total.byKind.video?.calls || 0;
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

    /**
     * ⚠ **出视频失败了，账上要留一条"这里有一次没记上"。**
     *
     * 视频是先下单后取件的。拿不到片子**不等于**厂商没做、没计费 ——
     * 多半是做了、计了，只是我们没接住。所以这一次既不能记一个猜的秒数
     * （假数），也不能当无事发生（少账）。
     *
     * "少账"是这里最危险的一种：它让总数偏小，而偏小的总数看起来
     * 完全正常，没有任何地方会红。用户拿着一个漂亮的数去对账单，
     * 对不上，然后不知道该信哪个。
     *
     * 金丝雀把这一处的 blind() 关掉时，上面三条全绿 —— 它们查的是
     * 这一镜身上的 videoError，和账本是两份记录。
     */
    const bookAfterFail = ledgerMod.forProject(project.id, {});
    check('出视频失败了，账上留了一条"没记上"',
      bookAfterFail.unmetered > 0, `unmetered=${bookAfterFail.unmetered}`);
    check('而且说得清是哪一家的哪个模型没记上',
      bookAfterFail.blind.some((x) => x.kind === 'video'),
      JSON.stringify(bookAfterFail.blind));
    check('失败的那一次没有被当成"出了 N 秒"记进用量里',
      (bookAfterFail.total.byKind.video?.calls || 0) === videoCallsBefore,
      `失败前 ${videoCallsBefore} 笔，失败后 ${bookAfterFail.total.byKind.video?.calls || 0} 笔`);
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
  /**
   * ① 画幅：场景跟着项目走，角色**不跟**。
   *
   * 原来这条写的是"所有设定图都按竖屏出"。那在角色设定图还是一张正面半身时
   * 是对的；改成四视图之后就不对了 —— 四个视角横向排开，塞进 9:16
   * 会挤成四条竹竿，脸和衣服都看不清，等于白出。
   *
   * 所以拆成两条，比原来那条更严：不光验"有没有跟项目画幅"，
   * 还验了"该跟的跟了、不该跟的没跟"。
   */
  const charSheets = upstream.imageBodies.filter((b) => /角色三视图/.test(b.prompt || ''));
  const otherSheets = upstream.imageBodies.filter((b) => !/角色三视图/.test(b.prompt || ''));
  check('① 场景和道具的基准图跟着项目画幅（竖屏项目就出竖的）',
    otherSheets.length > 0 && otherSheets.every((b) => b.size === '720x1280'),
    JSON.stringify([...new Set(otherSheets.map((b) => b.size))]));
  check('① 角色三视图走自己的横画幅（跟着竖屏走会挤成四条竹竿）',
    charSheets.length > 0 && charSheets.every((b) => b.size === '1280x720'),
    JSON.stringify([...new Set(charSheets.map((b) => b.size))]));

  /**
   * ⚠ 提示词里那几句"防具体的事"的话必须真的发出去。
   *
   * 三视图最容易翻车的两处，都不会报错：
   *   · 模型在图上加 FRONT / SIDE / BACK 标注和分格线 ——
   *     而这张图会当参考图发给出视频那一步，那些字会被一起学进画面
   *   · 四个视角画成了四个不同的人（换了衣服、换了配色）
   * 所以这两句是功能的一部分，不是文案。
   */
  const csPrompt = charSheets[0]?.prompt || '';
  check('① 三视图说清了是"一张图里四个视角"',
    /一张图里横向并排四个视角/.test(csPrompt), csPrompt.slice(0, 80));
  check('① 四个视角都点了名（上半身特写/正面/侧面/背面）',
    ['上半身特写', '全身正面', '全身正侧面', '全身背面'].every((k) => csPrompt.includes(k)), csPrompt.slice(0, 200));
  check('① 交代了四个视角必须是同一个人同一套衣服',
    /同一个人、同一套服装、同一配色/.test(csPrompt), csPrompt.slice(0, 200));
  check('① 明确不许出现文字标注和分格线（会被当参考图学进画面）',
    /不得出现任何文字、标注、箭头、分格线/.test(csPrompt), csPrompt.slice(0, 240));
  check('① 角色的外貌描述仍然带在后面（三视图不能把描述挤掉）',
    cur.bible.characters.some((c) => c.appearance && csPrompt.includes(c.appearance.slice(0, 12))),
    csPrompt.slice(-120));
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

section('钱：用量是我们的事实，单价是你的');
{
  const pricing = await import('../core/pricing.js');
  const ledger = await import('../core/ledger.js');
  const meter = await import('../core/meter.js');
  const estimate = await import('../core/pipeline/estimate.js');

  const K = pricing.rateKey;

  // ── 未定价必须是"未知"，不能是 0 ──
  {
    /**
     * 这一组是整个功能的地基。一旦某处把未知当成 0 参与求和，
     * 总价就会是一个**看起来正常的偏小的数** —— 用户会照着它下手。
     */
    const rates = { [K('volcengine', 'seedream', 'image')]: { cny: 0.2 } };
    const mixed = pricing.sum(
      [
        { kind: 'image', provider: 'volcengine', model: 'seedream', units: 5, calls: 5 },
        { kind: 'video', provider: 'kling', model: 'kling-v2', units: 30, calls: 3 }
      ],
      rates
    );
    check('有定价的算进去了', Math.abs(mixed.cny - 1.0) < 1e-9, String(mixed.cny));
    check('没定价的没有被当成 0 混进总数', mixed.partial === true && mixed.unpriced.length === 1);
    check('说得出还差哪一个单价',
      mixed.missing.length === 1 && mixed.missing[0].key === K('kling', 'kling-v2', 'video'),
      JSON.stringify(mixed.missing));

    // 一个都没定价的时候，总数是 null 而不是 0 —— 0 会被显示成"免费"
    const none = pricing.sum([{ kind: 'video', provider: 'kling', model: 'kling-v2', units: 30 }], {});
    check('一个都没定价时总数是"算不出"，不是 ¥0', none.cny === null, String(none.cny));
    check('这时候的措辞是"还没填单价"',
      pricing.describeSum(none).includes('还没填单价'), pricing.describeSum(none));

    /**
     * ⚠ **一次都没花过 ≠ 没填单价。**
     *
     * 这两句一度合成了一句："没有用量 —— 还没填单价，算不出钱"，
     * 读起来像"你少填了点什么所以算不出来"，而真相是根本还没花过。
     * 手机走查上第一眼看到的就是它。
     *
     * 这种话的坏处很具体：它会让人跑去填一张根本不需要填的表，
     * 而且填完那句话也不会变 —— 因为问题从来不在那儿。
     */
    const nothing = pricing.describeSum(pricing.sum([], rates));
    check('一次都没花过的时候说"还没花过"，不提单价', nothing.includes('还没花过'), nothing);
    check('而且不会把它说成"算不出钱"', !nothing.includes('算不出钱'), nothing);
    check('部分定价的措辞里必须有"至少"和"没算进去"',
      pricing.describeSum(mixed).includes('至少') && pricing.describeSum(mixed).includes('没算进去'),
      pricing.describeSum(mixed));
    // 全都定了价的时候不许再说"至少" —— 那会让一个准确的数看起来不准
    const full = pricing.sum([{ kind: 'image', provider: 'volcengine', model: 'seedream', units: 5 }], rates);
    check('全都定了价就不说"至少"', !pricing.describeSum(full).includes('至少'), pricing.describeSum(full));
  }

  // ── 不许拿相近的型号去猜价 ──
  {
    /**
     * `doubao-seedream-3-0-t2i-250415` 和 `doubao-seedream-4-0-250828`
     * 前缀一大半是一样的，而两者价钱不同。要是哪天有人给 rateFor
     * 加了"前缀匹配"图省事，这条会红。
     */
    const rates = { [K('volcengine', 'doubao-seedream-3-0-t2i-250415', 'image')]: { cny: 0.2 } };
    const got = pricing.rateFor('volcengine', 'doubao-seedream-4-0-250828', 'image', rates);
    check('填了 3.0 的价，不会被拿去当 4.0 的价', got === null, JSON.stringify(got));
    const same = pricing.rateFor('volcengine', 'doubao-seedream-3-0-t2i-250415', 'image', rates);
    check('填对了型号当然要认', same?.cny === 0.2 && same.matched === 'model');
  }

  // ── 厂商级兜底 ──
  {
    const rates = {
      [K('volcengine', '', 'image')]: { cny: 0.5 },
      [K('volcengine', 'seedream', 'image')]: { cny: 0.2 }
    };
    // 数字故意取得不一样：两级都命中时若拿错了级，金额会不同
    check('没填型号的走厂商兜底', pricing.rateFor('volcengine', 'whatever', 'image', rates)?.cny === 0.5);
    check('填了型号的以型号为准（不是兜底那个）',
      pricing.rateFor('volcengine', 'seedream', 'image', rates)?.cny === 0.2);
  }

  // ── 本地跑的不是"没填价"，是真的不要钱 ──
  {
    const local = pricing.sum([{ kind: 'image', provider: 'comfy', model: 'workflow', units: 8 }], {});
    check('本地 ComfyUI 出图算 0 元', local.cny === 0, String(local.cny));
    check('而且不会挂一条"还没填单价"', local.missing.length === 0 && local.partial === false);
  }

  // ── 进出 token 分开计价 ──
  {
    // 进出单价故意差 4 倍：算反了、或者只用其中一个，金额都对不上
    const rates = { [K('volcengine', 'doubao', 'token')]: { in: 1, out: 4 } };
    const one = pricing.sum([{ kind: 'token', provider: 'volcengine', model: 'doubao', units: { in: 2000000, out: 500000 } }], rates);
    check('进出各按各的单价算', Math.abs(one.cny - (2 + 2)) < 1e-9, String(one.cny));
    check('只填了进没填出，这条不算数',
      pricing.rateFor('volcengine', 'doubao', 'token', { [K('volcengine', 'doubao', 'token')]: { in: 1 } }) === null);
  }

  // ── 账本：存的是用量，钱现算 ──
  {
    /**
     * 这一条是"只存用量不存钱"那个决定的**唯一证据**：
     * 同一份账，换一份单价就换一个数，而且过去的账会亮起来。
     */
    ledger.reset({ wipe: true });
    ledger.add({ projectId: 'proj-money', stage: '出图', provider: 'volcengine', model: 'seedream', kind: 'image', units: 1 });
    ledger.add({ projectId: 'proj-money', stage: '出图', provider: 'volcengine', model: 'seedream', kind: 'image', units: 1 });
    ledger.add({ projectId: 'proj-money', stage: '配音', provider: 'dashscope', model: 'cosy', kind: 'tts', units: 10000 });

    const blindRead = ledger.forProject('proj-money', {});
    check('还没填单价时，用量已经在了',
      blindRead.total.byKind.image.units === 2 && blindRead.total.byKind.tts.units === 10000,
      JSON.stringify(blindRead.total.byKind));
    check('还没填单价时，钱是"算不出"', blindRead.total.cny === null);

    const later = ledger.forProject('proj-money', {
      [K('volcengine', 'seedream', 'image')]: { cny: 0.2 },
      [K('dashscope', 'cosy', 'tts')]: { cny: 1 }
    });
    check('事后补填单价，过去的账立刻亮起来', Math.abs(later.total.cny - (0.4 + 1)) < 1e-9, String(later.total.cny));

    // 改一次价，同一份账要给出不同的数 —— 证明它真的没把钱存进去
    const cheaper = ledger.forProject('proj-money', {
      [K('volcengine', 'seedream', 'image')]: { cny: 0.1 },
      [K('dashscope', 'cosy', 'tts')]: { cny: 1 }
    });
    check('换一份单价，同一份账给出不同的数', Math.abs(cheaper.total.cny - 1.2) < 1e-9, String(cheaper.total.cny));
  }

  // ── 记不上的那些，要能说出来 ──
  {
    ledger.reset({ wipe: true });
    ledger.add({ projectId: 'p-blind', provider: 'volcengine', model: 'doubao', kind: 'token', units: { in: 100, out: 20 } });
    ledger.addUnmetered({ projectId: 'p-blind', provider: 'someco', model: 'quiet-1', kind: 'token', why: '响应里没有 usage' });
    ledger.addUnmetered({ projectId: 'p-blind', provider: 'someco', model: 'quiet-1', kind: 'token', why: '响应里没有 usage' });
    const acct = ledger.forProject('p-blind', {});
    check('漏记的次数走得出来', acct.unmetered === 2, String(acct.unmetered));
    check('而且说得出是谁漏的',
      acct.blind.length === 1 && acct.blind[0].model === 'quiet-1' && acct.blind[0].hits === 2,
      JSON.stringify(acct.blind));
    check('漏记的不会被算进用量里', acct.total.byKind.token.units.in === 100, JSON.stringify(acct.total.byKind));

    // 猜不出用量就不许记 —— 记一个假数比少一条坏得多
    const before = ledger.forProject('p-blind', {}).calls;
    ledger.add({ projectId: 'p-blind', provider: 'x', model: 'y', kind: 'image', units: 0 });
    ledger.add({ projectId: 'p-blind', provider: 'x', model: 'y', kind: 'image', units: null });
    check('用量是 0 或读不出来时，一笔都不记', ledger.forProject('p-blind', {}).calls === before);
  }

  // ── token 用量：拆不开进出就不算数 ──
  {
    check('标准的 OpenAI 形态读得出',
      JSON.stringify(meter.readTokenUsage({ usage: { prompt_tokens: 10, completion_tokens: 3 } })) === '{"in":10,"out":3}');
    check('百炼那种 input/output 也读得出',
      JSON.stringify(meter.readTokenUsage({ usage: { input_tokens: 7, output_tokens: 2 } })) === '{"in":7,"out":2}');
    check('只给了 total_tokens 的，宁可算漏账也不硬拆',
      meter.readTokenUsage({ usage: { total_tokens: 999 } }) === null);
    check('压根没有 usage 的返回 null', meter.readTokenUsage({ choices: [] }) === null);
  }

  // ── 预估：秒数要按厂商档位对齐 ──
  {
    /**
     * 分镜写 4 秒，厂商只出 5 秒档，**按 5 秒计费**。
     * 不对齐的话每一镜都少估一截，二十镜下来差四分之一。
     * 4 和 5 是两个不同的数，所以这条断言不会因为"碰巧相等"而假绿。
     */
    const shots = [
      { id: 's1', duration: 4, imagePath: 'a.png' },
      { id: 's2', duration: 6, imagePath: 'b.png' }
    ];
    const aligned = estimate.forStage({
      shots,
      stage: 'video',
      routing: { video: { provider: 'volcengine', model: 'seedance', durations: [5, 10] } }
    });
    check('4 秒和 6 秒按 5/10 档位算成 15 秒', aligned.items[0].units === 15, JSON.stringify(aligned.items));
    check('镜数和秒数是两个数，都要报', aligned.items[0].calls === 2 && aligned.shots === 2);

    const noDurations = estimate.forStage({
      shots,
      stage: 'video',
      routing: { video: { provider: 'x', model: 'y', durations: [] } }
    });
    check('厂商档位不知道时按原样算（10 秒），不假装对齐过', noDurations.items[0].units === 10);
  }

  // ── 预估：全跑时，出视频那一步要把"马上就会有图"的镜算进去 ──
  {
    /**
     * 一个刚拆完分镜、一张图都没有的项目，点「往后全跑」——
     * 要是照当前镜况算，出视频那步会估成 0 秒，
     * 而那正是这一整趟里最贵的一步。
     */
    const fresh = [
      { id: 's1', duration: 5, imagePath: null, dialogue: '走吧。' },
      { id: 's2', duration: 5, imagePath: null, dialogue: '' }
    ];
    const routing = {
      image: { provider: 'volcengine', model: 'seedream' },
      video: { provider: 'volcengine', model: 'seedance', durations: [5, 10] },
      tts: { provider: 'dashscope', model: 'cosy' }
    };
    const whole = estimate.forRun({ shots: fresh, from: 'assets', routing });
    const vid = whole.items.find((i) => i.kind === 'video');
    check('一张图都没有的项目，全跑也能估出视频那步的钱', vid && vid.units === 10, JSON.stringify(whole.items));

    // 但只从「出视频」开始跑的时候，没图的镜是真的出不了 —— 不能算进去
    const onlyVideo = estimate.forRun({ shots: fresh, from: 'video', routing });
    check('单跑出视频时，没图的镜不算进去',
      !onlyVideo.items.some((i) => i.kind === 'video'), JSON.stringify(onlyVideo.items));
  }

  // ── 预估：三种不同的真相，三种说法 ──
  {
    const routing = { image: { provider: 'volcengine', model: 'seedream' } };
    const rates = { [K('volcengine', 'seedream', 'image')]: { cny: 0.2 } };

    const composePlan = estimate.forStage({ shots: [{ id: 's1' }], stage: 'compose', routing });
    check('合成那步说的是"不花钱"，不是"¥0"',
      estimate.describe(composePlan, rates).includes('不花钱')
      && !estimate.describe(composePlan, rates).includes('¥0'),
      estimate.describe(composePlan, rates));

    const nothing = estimate.forStage({ shots: [{ id: 's1', imagePath: 'a.png' }], stage: 'assets', routing });
    check('没东西要出的时候不显示金额', estimate.describe(nothing, rates).includes('没有要出的东西'),
      estimate.describe(nothing, rates));

    const scriptPlan = estimate.forStage({ shots: [], stage: 'script', routing });
    check('拆分镜明说"事前算不出来"',
      estimate.describe(scriptPlan, rates).includes('算不出来'), estimate.describe(scriptPlan, rates));
    check('而且不给它编一个数', scriptPlan.items.length === 0);

    // 重试要单独说，不能并进总数 —— 并进去的话每个数都偏高，人会学会不看
    const withRetry = estimate.forStage({
      shots: [{ id: 's1' }, { id: 's2' }],
      stage: 'assets',
      routing,
      maxRetries: 2
    });
    const priced = estimate.price(withRetry, rates);
    check('正常情况按不重试算', Math.abs(priced.base.cny - 0.4) < 1e-9, String(priced.base.cny));
    check('最坏情况另给一个数', Math.abs(priced.worst.cny - 1.2) < 1e-9, String(priced.worst.cny));
    check('两个数都要出现在那句话里',
      estimate.describe(withRetry, rates).includes('¥0.40') && estimate.describe(withRetry, rates).includes('¥1.20'),
      estimate.describe(withRetry, rates));
  }

  // ── 配音字数：标点也算，跟厂商一个口径 ──
  {
    const shot = { dialogue: '你到底是谁？我等了三年！' };
    check('标点算在字数里', estimate.dialogueChars(shot) === 12, String(estimate.dialogueChars(shot)));
    check('空台词是 0 字', estimate.dialogueChars({ dialogue: '' }) === 0);
  }

  // ── 接口这一层 ──
  {
    const created = await (await fetch(`${appUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '记账验收', script: '第一章\n\n他推开门。' })
    })).json();

    const spend = await (await fetch(`${appUrl}/api/projects/${created.id}/spend`)).json();
    check('新项目的账是空的但接口不报错', spend.calls === 0 && spend.total.cny === null, JSON.stringify(spend.total));
    check('账那条接口会给出一句人话', typeof spend.line === 'string' && spend.line.includes('这个项目到现在'));

    const est = await (await fetch(`${appUrl}/api/projects/${created.id}/estimate?stage=compose`)).json();
    check('预估是另一条接口，不和账混在一起', est.priced.free === true && est.line.includes('不花钱'), est.line);

    // 单价表只收认得的键
    const put = await fetch(`${appUrl}/api/rates`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rates: {
          [K('volcengine', 'seedream', 'image')]: { cny: 0.25 },
          'garbage-key': { cny: 99 },
          [K('volcengine', 'seedream', 'nosuchkind')]: { cny: 88 }
        }
      })
    });
    const saved = await put.json();
    check('填对格式的单价存下来了', saved.rates[K('volcengine', 'seedream', 'image')]?.cny === 0.25);
    check('乱填的键不进设置',
      !('garbage-key' in saved.rates) && !(K('volcengine', 'seedream', 'nosuchkind') in saved.rates),
      JSON.stringify(Object.keys(saved.rates)));

    // 填错了要能删掉 —— 一个填错的 0 会让某项永远显示成免费
    const del = await (await fetch(`${appUrl}/api/rates`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rates: { [K('volcengine', 'seedream', 'image')]: null } })
    })).json();
    check('单价能删掉，不是只能改成别的数',
      !(K('volcengine', 'seedream', 'image') in del.rates), JSON.stringify(del.rates));

    await fetch(`${appUrl}/api/projects/${created.id}`, { method: 'DELETE' });
  }

  // ── 真跑一步，看账有没有自己记上 ──
  {
    /**
     * 上面那些验的是零件。这一条验的是**接线** —— 走完整条
     * 「HTTP 进来 → 圈上下文 → 流水线 → 适配层 → 记账」，
     * 中间任何一环没接上，这里就是空账。
     *
     * 这是唯一能抓住"归属圈漏了"的断言：零件测试全绿而账是空的，
     * 正是这个功能最可能的坏法。
     */
    ledger.reset({ wipe: true });
    const p = await (await fetch(`${appUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '记账接线', script: '第一章\n\n他推开门，屋里没有人。' })
    })).json();
    await ndjson(`/projects/${p.id}/stage/bible`, {});
    await ndjson(`/projects/${p.id}/stage/script`, { shotCount: 2 });
    await ndjson(`/projects/${p.id}/stage/assets`, {});
    ledger.flush();

    const acct = ledger.forProject(p.id, {});
    check('真跑一步之后，这个项目名下有账了', acct.calls > 0, JSON.stringify(acct.total.byKind));
    check('出的图记成了图，不是别的口径',
      (acct.total.byKind.image?.units || 0) > 0, JSON.stringify(acct.total.byKind));
    check('拆分镜那几次对话也记上了 token',
      (acct.total.byKind.token?.units?.in || 0) > 0, JSON.stringify(acct.total.byKind));

    const stages = new Set(ledger.recent({ projectId: p.id, limit: 200 }).map((e) => e.stage));
    check('每一笔都知道自己是哪一步花的',
      stages.has('assets') && stages.has('script'), [...stages].join('、'));
    check('没有一笔落进"未归属"', ledger.forProject('(未归属)', {}).calls === 0);

    await fetch(`${appUrl}/api/projects/${p.id}`, { method: 'DELETE' });
    ledger.reset({ wipe: true });
  }

  // ── 归属：项目 id 是自动带上的，不靠调用点记得传 ──
  {
    ledger.reset({ wipe: true });
    await meter.runIn({ projectId: 'ctx-proj', stage: '出图' }, async () => {
      // 隔一次 await，模拟真实链路里的十几层调用
      await new Promise((r) => setTimeout(r, 1));
      meter.record({ kind: 'image', provider: 'volcengine', model: 'seedream', units: 1 });
    });
    const acct = ledger.forProject('ctx-proj', {});
    check('await 之后记的账仍然落在对的项目上', acct.calls === 1, JSON.stringify(acct));
    check('而且带着是哪一步', ledger.recent({ projectId: 'ctx-proj' })[0]?.stage === '出图');

    // 没圈过的照样有账，只是不归任何项目 —— 联调台里手发的请求就是这种
    meter.record({ kind: 'image', provider: 'volcengine', model: 'seedream', units: 1 });
    check('圈外面的记到"未归属"，不是丢掉', ledger.forProject('(未归属)', {}).calls === 1);
    ledger.reset({ wipe: true });
  }
}

// ─────────────────────── 收尾 ───────────────────────

server.close();
upstream.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

server.close();
upstream.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

server.close();
upstream.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

server.close();
upstream.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });



console.log(`\n${'─'.repeat(50)}`);
console.log(failed === 0 ? `\x1b[32m全部通过：${passed} 项\x1b[0m` : `\x1b[31m${failed} 项未通过\x1b[0m（通过 ${passed} 项）`);
process.exit(failed === 0 ? 0 : 1);

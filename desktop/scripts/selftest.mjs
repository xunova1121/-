/**
 * 自检：不碰任何真实厂商、不花一分钱，用一个本地假服务把关键链路跑一遍。
 *
 *     npm run selftest
 *
 * 覆盖的是最容易悄悄坏掉的几处：密钥脱敏、SSE 分片解析、异步任务轮询、
 * 提示词装配顺序、Windows 文件名规则、以及媒体接口的目录穿越防护。
 */
import http from 'node:http';
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

  // ── 以下是给"整条流水线打桩"用的 OpenAI 兼容接口 ──

  if (url.pathname === '/v3/chat/completions') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const system = JSON.stringify(body.messages?.[0]?.content || '');
      let content;
      if (system.includes('美术总监')) {
        content = JSON.stringify(BIBLE_REPLY);
      } else if (system.includes('分镜导演')) {
        content = JSON.stringify(SHOTS_REPLY);
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ url: `${upstreamUrl}/pixel.png` }] }));
    });
    return undefined;
  }

  if (url.pathname === '/pixel.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(PIXEL_PNG);
  }

  res.writeHead(404).end();
});

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
check('镜头描述排在设定之后', assembled.prompt.indexOf('藏青') < assembled.prompt.indexOf('举起'));
check('种子 = 角色种子 + 镜号', assembled.seed === 1003);
check('参考图带上了场景和角色', assembled.refImages.length === 2);
check('负向词透传', assembled.negative === '崩脸');

const noName = consistency.assemblePrompt(bible, { index: 1, description: '老陈坐在码头', characters: [] });
check('没显式点名时按描述文本兜底匹配', noName.prompt.includes('灰布褂'));

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

const bibleEvents = await ndjson(`/projects/${project.id}/stage/bible`, {});
const afterBible = bibleEvents.find((e) => e.type === 'finished')?.project;
check('设定集跑通', Boolean(afterBible?.bible), JSON.stringify(bibleEvents.slice(-1)));
check('角色被冻结', afterBible?.bible?.characters?.[0]?.name === '阿澜');
check('角色拿到了固定种子', typeof afterBible?.bible?.characters?.[0]?.seed === 'number');
check('角色设定图已落盘', Boolean(afterBible?.bible?.characters?.[0]?.sheetPath));
check(
  '设定图转成了模型可引用的形式',
  String(afterBible?.bible?.characters?.[0]?.sheetUrl || '').startsWith('data:image/png;base64,')
);
check('场景基准图也出了', Boolean(afterBible?.bible?.scenes?.[0]?.sheetPath));
check('参考图出图次数 = 角色数 + 场景数', upstream.imageCalls === 2, `实际 ${upstream.imageCalls}`);

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
check('提示词里注入了冻结的角色外貌', upstream.imagePrompts[0]?.includes('藏青立领制服'));
check('提示词里注入了场景设定', upstream.imagePrompts[0]?.includes('晨雾未散'));
check('提示词里带上了道具（镜头描述提到了）', upstream.imagePrompts[0]?.includes('黑色方形'));
check('出图请求带了角色设定图作参考', String(upstream.lastImageBody?.image || '').length > 0);

check('复核不通过时确实重试了', shot1?.consistency?.attempts > 1, `attempts=${shot1?.consistency?.attempts}`);
check('重试用的是不同种子（同种子会复现同一个错）', new Set(upstream.imageSeeds.slice(0, 3)).size === 3,
  JSON.stringify(upstream.imageSeeds));
check('最终这一镜复核通过', shot1?.consistency?.pass === true, JSON.stringify(shot1?.consistency));
check('通过后的分数被记下来', shot1?.consistency?.score === 92);

const assetsBadShot = afterAssets?.shots?.[1];
check('第二镜也出图了', Boolean(assetsBadShot?.imagePath));

// ─────────────────────── 8. 上线前体检 ───────────────────────

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

// 打桩服务没有 /v3/models，正好用来验证"拿不到列表时给的是人话而不是空下拉"
const modelList = await (await fetch(`${appUrl}/api/providers/volcengine/models`)).json();
check('拿不到模型列表时说明白该去哪儿找', modelList.ok === false && /控制台|手动填写/.test(modelList.reason), JSON.stringify(modelList));

// ─────────────────────── 9. Windows 文件名 ───────────────────────

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

section('本地服务防护');
const traversal = await fetch(`${appUrl}/media?p=${encodeURIComponent('/etc/passwd')}`);
check('媒体接口拒绝数据目录之外的路径', traversal.status === 403);

const crossOrigin = await fetch(`${appUrl}/api/health`, { headers: { Origin: 'https://evil.example' } });
check('拒绝跨站来源', crossOrigin.status === 403);

const sameOrigin = await fetch(`${appUrl}/api/health`, { headers: { Origin: appUrl } });
check('自己的页面放行', sameOrigin.status === 200);

const uiFile = await fetch(`${appUrl}/index.html`);
check('界面文件能取到', uiFile.status === 200);

// ─────────────────────── 收尾 ───────────────────────

server.close();
upstream.close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${'─'.repeat(50)}`);
console.log(failed === 0 ? `\x1b[32m全部通过：${passed} 项\x1b[0m` : `\x1b[31m${failed} 项未通过\x1b[0m（通过 ${passed} 项）`);
process.exit(failed === 0 ? 0 : 1);

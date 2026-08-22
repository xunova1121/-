/**
 * 上线前体检：把流水线依赖的五条能力各真跑一次最小调用。
 *
 * 为什么值得单独做一个：这条流水线跑一趟要几分钟到几十分钟，
 * 如果第 04 步才发现视频模型 ID 填错，前面的时间和额度就白烧了。
 * 体检用最小代价把五条腿挨个点一遍，坏在哪、服务端原话是什么，一次说清。
 *
 * 每一项都标了代价，贵的默认不跑 —— 体检本身不该成为一笔开销。
 */
import * as settings from './settings.js';
import * as adapters from './providers/adapters.js';
import { getProvider } from './providers/catalog.js';
import { send, baseUrlOf, interpolate, diagnose, credentialStatus } from './providers/index.js';
import * as ffmpegLib from './ffmpeg.js';
import * as oss from './oss.js';
import { authHeadersFor } from './providers/index.js';

/** 64×64 的小图：暖底加一个冷蓝圆。视觉模型要能明确描述它，才算真的看懂了图。 */
const TEST_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAArUlEQVR42u3awQ1AQBBA0elXY8pRgMRVFxRAImFtzHiHKeC/i9iZWJdp+/MEAAAAAAAAAAAAAAAAAPScYZwPUxrgLPhqSgDcCe8JEV8O7wERWeLfQogs4W9BRMb4lggAssa3QojM8S0QAGSPf4oAoEL8EwQAAADUiL+LAAAAAAC+AgAAAPA3CMCLEACvwvYCAOwGbYfdB7gQcSPkSsydIAAAAAAAAAAAAAAA5WcHWxxug/xdQJEAAAAASUVORK5CYII=';

export const CHECKS = [
  {
    id: 'chat',
    label: '剧本与分镜',
    capability: 'chat',
    cost: '极低',
    note: '发一次四个 token 的对话',
    defaultOn: true
  },
  {
    id: 'vision',
    label: '一致性复核',
    capability: 'vision',
    cost: '极低',
    note: '让模型描述一张 64×64 的测试图，验证它真能读图',
    defaultOn: true
  },
  {
    id: 't2i',
    label: '出图',
    capability: 't2i',
    cost: '低',
    note: '会真的生成一张图，按各家出图单价计费',
    defaultOn: true
  },
  {
    id: 'i2v',
    label: '视频',
    capability: 'i2v',
    cost: '较高、较慢',
    note: '会真的生成一段视频，几分钟起，默认不跑',
    defaultOn: false
  },
  {
    id: 'tts',
    label: '配音',
    capability: 'tts',
    cost: '极低',
    note: '合成四个字',
    defaultOn: false
  },
  {
    id: 'sfx',
    label: '音效',
    capability: 'sfx',
    cost: '极低',
    note: '生成一秒钟的敲门声。没配音效服务商就跳过（那是个正经选择，不是错）',
    defaultOn: false
  },
  /**
   * 下面两条不调任何模型，也不花一分钱，所以默认就开。
   *
   * 它们补的是"路由体检"一直没管的那半边：**本机环境**。
   * 密钥全对、模型全通，最后照样出不来片子 —— 因为没装 FFmpeg，
   * 或者对象存储的签名不对。这两件事以前只能等跑到最后一步才发现。
   */
  {
    id: 'ffmpeg',
    label: '本机 FFmpeg',
    capability: null,
    cost: '免费',
    note: '合成、裁剪、抠帧、烧字幕全靠它。顺带查转场和补帧要用的那几个滤镜在不在',
    defaultOn: true
  },
  {
    id: 'oss',
    label: '对象存储',
    capability: null,
    cost: '免费',
    note: '真的写一个小文件、读回来、再删掉 —— 签名对不对只有这么试才知道。没配就跳过',
    defaultOn: true
  }
];

const ROUTE_KEYS = {
  chat: ['chatProvider', 'chatModel'],
  vision: ['visionProvider', 'visionModel'],
  t2i: ['imageProvider', 'imageModel'],
  i2v: ['videoProvider', 'videoModel'],
  tts: ['ttsProvider', 'ttsModel'],
  sfx: ['sfxProvider', 'sfxModel'],
  // 这两条不走服务商路由 —— 它们查的是本机环境
  ffmpeg: [null, null],
  oss: [null, null]
};

function route(checkId) {
  const [pk, mk] = ROUTE_KEYS[checkId] || [null, null];
  if (!pk) return { providerId: null, model: null, local: true };
  const s = settings.all();
  return { providerId: s[pk], model: s[mk] };
}

/**
 * 拉这家实际可用的模型列表。
 *
 * 这是解"模型 ID 到底该填什么"最直接的办法 —— 与其让用户去控制台翻，
 * 不如让应用拿着他的密钥去问一次。不是每家都提供这个接口，
 * 拿不到就明说拿不到，并告诉他去哪儿找，而不是留个空下拉框让人猜。
 */
export async function listModels(providerId) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);

  const cred = credentialStatus(provider);
  if (!cred.ready) {
    return { ok: false, models: [], reason: `缺少凭据：${cred.missing.join('、')}` };
  }

  const url = provider.endpoints?.models
    ? interpolate(provider.endpoints.models, provider)
    : `${baseUrlOf(provider)}/models`;

  const res = await send({ provider: providerId, label: '拉取模型列表', method: 'GET', url, timeoutMs: 20000 }, null);

  if (!res.ok) {
    return {
      ok: false,
      models: [],
      status: res.status,
      reason:
        res.status === 404
          ? `${provider.name} 没有提供模型列表接口（404）。请到它的控制台复制模型 ID 或推理接入点 ID，在下面的下拉框选「自定义（手动填写）」贴进去。`
          : diagnose(res)
    };
  }

  // OpenAI 兼容格式是 { data: [ { id } ] }；有些家直接回数组
  const raw = Array.isArray(res.json) ? res.json : res.json?.data || res.json?.models || [];
  const models = raw
    .map((m) => (typeof m === 'string' ? m : m.id || m.model || m.name))
    .filter(Boolean)
    .sort();

  return {
    ok: true,
    models,
    reason: models.length ? '' : '接口通了，但返回的列表是空的 —— 多半是这把 Key 还没开通任何模型。'
  };
}

/**
 * 逐个探测候选模型 ID。
 *
 * 有些厂商（方舟就是）不提供 /models 列表接口，于是"模型 ID 该填什么"
 * 就成了一道只能靠翻控制台解决的题。这里换个思路：直接拿候选清单去试，
 * 用 max_tokens=1 的最小请求，通了就是真能用 —— 把猜测变成事实。
 *
 * 只探对话类模型：出图/视频每探一次都会真出一张图或一段视频，
 * 那是实打实的开销，不该由一个"看看有啥能用"的动作产生。
 */
export async function probeCandidates(providerId, onEvent) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`未知服务商：${providerId}`);

  const cred = credentialStatus(provider);
  if (!cred.ready) return { available: [], tried: 0, reason: `缺少凭据：${cred.missing.join('、')}` };

  const ids =
    provider.candidates?.length
      ? provider.candidates
      : (provider.models || [])
          .filter((m) => !m.capability || m.capability === 'chat' || m.capability === 'vision')
          .map((m) => m.id);

  if (!ids.length) return { available: [], tried: 0, reason: '这家没有可探测的候选模型' };

  const url = interpolate(provider.endpoints?.chat || '{{baseUrl}}/chat/completions', provider);
  const available = [];
  const rejected = [];

  // 三个一批：太快容易撞限流，一个一个又太慢
  const BATCH = 3;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (model) => {
        try {
          const res = await send(
            {
              provider: providerId,
              label: `探测 ${model}`,
              method: 'POST',
              url,
              body: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
              timeoutMs: 20000
            },
            null
          );
          if (res.ok) available.push(model);
          else rejected.push({ model, status: res.status });
          onEvent?.({ type: 'candidate', model, ok: res.ok, status: res.status });
        } catch (err) {
          rejected.push({ model, status: 0, error: err.message });
          onEvent?.({ type: 'candidate', model, ok: false, status: 0 });
        }
      })
    );
  }

  return {
    available: available.sort(),
    rejected,
    tried: ids.length,
    reason: available.length
      ? ''
      : '候选清单里没有一个能用。可能是这些模型都没开通，也可能是方舟改了命名 —— 到控制台「开通管理」看一眼，或直接用 ep- 推理接入点。'
  };
}

async function runOne(checkId, ctx, onEvent) {
  const { providerId, model, local } = route(checkId);
  const provider = getProvider(providerId);
  const started = Date.now();

  const base = local
    ? { id: checkId, provider: '本机', providerName: '本机', model: '' }
    : { id: checkId, provider: providerId, providerName: provider?.name || providerId, model };
  onEvent?.({ type: 'check', status: 'running', ...base });

  const finish = (status, extra = {}) => {
    const result = { type: 'check', status, ms: Date.now() - started, ...base, ...extra };
    onEvent?.(result);
    return result;
  };

  /**
   * 本机那两条不查密钥、不查模型 —— 它们和服务商无关。
   * 分流放在最前面，否则会被下面"缺凭据"那道拦下来，
   * 报一个和实际问题毫不相干的原因。
   */
  if (local) {
    if (checkId === 'ffmpeg') return await checkFfmpeg(finish);
    if (checkId === 'oss') return await checkOss(finish);
    return finish('skip', { message: `未知的本机检查：${checkId}` });
  }

  /**
   * 音效没配 = **不做音效**，这是个正经选择，不是错。
   * 报成 fail 会让人以为流水线坏了，然后去配一个他本来就不想要的东西。
   */
  if (checkId === 'sfx' && !providerId) {
    return finish('skip', {
      message: '没配音效服务商 —— 这一步会跳过，分镜里写的「画外音效」不会变成声音',
      hint: '要音效的话去「设置 → 能力路由 → 音效」选一家。故意不回退到配音模型：那会念出"敲门声"三个字'
    });
  }

  if (!provider) return finish('fail', { message: `设置里指向了一个不存在的服务商：${providerId}` });

  const cred = credentialStatus(provider);
  if (!cred.ready) {
    return finish('fail', {
      message: `缺少凭据：${cred.missing.join('、')}`,
      hint: '去「服务商与密钥」把这把钥匙填上'
    });
  }
  if (!model) {
    return finish('fail', { message: '没有配置模型', hint: '去「设置 → 能力路由」选一个模型' });
  }

  try {
    switch (checkId) {
      case 'chat': {
        const res = await send(
          {
            provider: providerId,
            label: '体检·对话',
            method: 'POST',
            url: interpolate(provider.endpoints?.chat || '{{baseUrl}}/chat/completions', provider),
            body: { model, messages: [{ role: 'user', content: '回复"好"一个字' }], max_tokens: 8 },
            timeoutMs: 45000
          },
          null
        );
        if (!res.ok) return finish('fail', { message: diagnose(res), hint: hintFor(res, provider) });
        const text = res.json?.choices?.[0]?.message?.content ?? '';
        return finish('ok', { detail: `模型回了：${String(text).slice(0, 30) || '(空)'}` });
      }

      case 'vision': {
        const { text } = await adapters.chat({
          providerId,
          model,
          user: '这张图里有什么形状？什么颜色？十个字以内。',
          images: [TEST_IMAGE],
          temperature: 0,
          timeoutMs: 60000,
          label: '体检·视觉'
        });
        // 只要它提到圆或蓝，就说明图真的被读进去了，而不是在瞎编
        const sawIt = /圆|circle|蓝|blue/i.test(text);
        return finish(sawIt ? 'ok' : 'warn', {
          detail: `模型回了：${text.slice(0, 40)}`,
          message: sawIt ? '' : '模型有响应，但没描述出图里的圆形/蓝色 —— 它可能并不支持读图，一致性复核会失准',
          hint: sawIt ? '' : '换一个明确带视觉能力的模型'
        });
      }

      case 't2i': {
        const img = await adapters.generateImage({
          providerId,
          model,
          prompt: '一个纯色背景上的蓝色圆形，极简',
          size: '512*512',
          label: '体检·出图',
          onEvent: null
        });
        ctx.firstFrame = img.url || (img.base64 ? `data:image/png;base64,${img.base64}` : null);
        return finish('ok', { detail: img.url ? '出图成功，已拿到图片 URL' : '出图成功（base64 返回）' });
      }

      case 'i2v': {
        if (!ctx.firstFrame) {
          return finish('skip', { message: '需要先通过「出图」体检才能拿到首帧，已跳过' });
        }
        const vid = await adapters.generateVideo({
          providerId,
          model,
          prompt: '轻微推镜',
          firstFrameUrl: ctx.firstFrame,
          duration: 5,
          timeoutMs: 900000,
          label: '体检·视频',
          onEvent: (ev) => ev.type === 'poll' && onEvent?.({ type: 'poll', ...ev })
        });
        return finish('ok', { detail: `出视频成功：${String(vid.url).slice(0, 60)}…` });
      }

      case 'tts': {
        const speech = await adapters.synthesizeSpeech({
          providerId,
          model,
          text: '体检通过',
          label: '体检·配音'
        });
        if (speech.url) return finish('ok', { detail: '合成成功，已拿到音频 URL' });
        if (speech.binaryRequest) {
          const r = await fetch(speech.binaryRequest.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(speech.binaryRequest.body),
            signal: AbortSignal.timeout(60000)
          });
          if (!r.ok) return finish('fail', { message: `配音接口返回 HTTP ${r.status}` });
          return finish('ok', { detail: '合成成功（二进制音频）' });
        }
        return finish('fail', { message: '配音接口没有返回可用结果' });
      }

      case 'sfx': {
        const sfx = await adapters.generateSfx({
          providerId, model, text: '木门被敲三下', seconds: 1, label: '体检·音效'
        });
        if (sfx.url) return finish('ok', { detail: '音效生成成功，已拿到音频 URL' });
        if (sfx.binaryRequest) {
          const r = await fetch(sfx.binaryRequest.url, {
            method: sfx.binaryRequest.method,
            headers: { 'Content-Type': 'application/json', ...authHeadersFor(sfx.binaryRequest.provider) },
            body: JSON.stringify(sfx.binaryRequest.body),
            signal: AbortSignal.timeout(60000)
          });
          if (!r.ok) {
            return finish('fail', {
              message: `音效接口返回 HTTP ${r.status}：${(await r.text()).slice(0, 160)}`,
              hint: hintFor(r, provider)
            });
          }
          const bytes = (await r.arrayBuffer()).byteLength;
          // 回了 200 但只有几十字节，多半是一段错误 JSON 被当成音频 —— 那不算通过
          if (bytes < 500) return finish('warn', { message: `只回了 ${bytes} 字节，不像一段音频` });
          return finish('ok', { detail: `音效生成成功（${(bytes / 1024).toFixed(0)}KB）` });
        }
        return finish('fail', { message: '音效接口没有返回可用结果' });
      }

      default:
        return finish('skip', { message: `未知检查项：${checkId}` });
    }
  } catch (err) {
    return finish('fail', { message: err.message, hint: hintForError(err.message, provider) });
  }
}

/**
 * 本机 FFmpeg 到底行不行。
 *
 * 不只看"找不找得到" —— 找到了但版本太老，一样出不来片子，
 * 而那时候的报错是 `No such filter: 'xfade'`，出现在跑完整条流水线之后，
 * 图和视频的钱都已经花了。这几个滤镜各管一件事，缺哪个就说清楚缺了会怎样。
 */
async function checkFfmpeg(finish) {
  const bin = ffmpegLib.locate({ refresh: true });
  if (!bin.available) {
    return finish('fail', { message: '没装 FFmpeg，最后一步合成会做不了', hint: bin.hint });
  }

  const need = [
    ['xfade', '叠化转场做不了，会退回硬切'],
    ['fade', '黑场转场做不了'],
    ['tpad', '厂商给的片段比分镜短时补不齐 —— 成片会比时间轴短，配音和字幕跟着全体错位'],
    ['apad', '补出来那截没音轨，拼接时整条音轨可能从那儿断掉'],
    ['adelay', '配音没法按时间点摆，只能顺次拼 —— 那样音画必然错位'],
    ['amix', '配音和音效混不到一起'],
    ['volume', '音效压不低，一声关门就能盖掉一句台词'],
    ['subtitles', '字幕烧不进画面（只出 .srt 不受影响）']
  ];

  let filters = '';
  try {
    const r = await ffmpegLib.run(['-hide_banner', '-filters']);
    filters = r.stderr || '';
    // -filters 走的是 stdout，run() 只收 stderr，所以这条多半读不到 —— 下面兜底
  } catch {
    /* 下面用另一种办法 */
  }
  if (!/xfade/.test(filters)) {
    // 直接问某一个滤镜在不在：`-h filter=xxx` 找不到时会明说
    const has = async (name) => {
      try {
        const r = await ffmpegLib.run(['-hide_banner', '-h', `filter=${name}`]);
        return !/Unknown filter|No such filter/i.test(r.stderr || '');
      } catch (err) {
        return !/Unknown filter|No such filter/i.test(err.message || '');
      }
    };
    const missing = [];
    for (const [name, why] of need) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await has(name))) missing.push(`${name}（${why}）`);
    }
    if (missing.length) {
      return finish('warn', {
        message: `FFmpeg 能用，但缺 ${missing.length} 个滤镜：${missing.join('；')}`,
        hint: '换一个完整版 FFmpeg（官方 release 构建都带这些）。精简版和某些发行版自带的会裁掉滤镜。'
      });
    }
  }
  return finish('ok', { detail: `${bin.version}（转场、补帧、混音要用的滤镜都在）` });
}

/**
 * 对象存储真的能写能读吗。
 *
 * 签名算法只有**真发一次**才知道对不对 —— 自己写的校验代码用的是同一份
 * 理解，验来验去只是把同一个误解验两遍。所以这里走真流程：
 * 写一个小文件 → 读回来比对 → 删掉。
 *
 * 这一步免费（几个字节的读写），但它挡住的是最贵的一类失败：
 * 出完几十张图之后，视频那步才发现参考图地址厂商取不到。
 */
async function checkOss(finish) {
  if (!oss.ready()) {
    return finish('skip', {
      message: '没配对象存储 —— 参考图会以内联 base64 发出去',
      hint: '多数厂商吃得下内联图，但百炼那几个只认公网地址的接口会卡住；' +
        '而且九张参考图内联发就是几十 MB，容易超时。要用的话去「设置 → 对象存储」配。'
    });
  }
  const r = await oss.probe();
  const done = (r.steps || []).map((x) => x.name || x).join(' → ');
  if (!r.ok) {
    return finish('fail', {
      message: `对象存储不通：${r.error || '未说明'}`,
      detail: done ? `走到：${done}` : '',
      hint: '签名版本、地域节点（endpoint）、Bucket 名字、RAM 权限，这四样最容易错。' +
        '报错原文里通常已经点名了是哪一样。'
    });
  }
  return finish('ok', { detail: `写→读→删三步都通${done ? `（${done}）` : ''}` });
}

/** 针对状态码给一句"下一步该做什么"，而不是只说哪里错了 */
function hintFor(res, provider) {
  if (res.status === 404) {
    return `到「设置 → 能力路由」把模型换成 ${provider.name} 里真实存在的 ID；先用下面的「拉取可用模型」看看有哪些`;
  }
  if (res.status === 401) return '密钥不对，回「服务商与密钥」重填一次';
  if (res.status === 403) return '去控制台确认这个模型已开通、账号没欠费';
  if (res.status === 429) return '限流了，等一会儿再试，或把「轮询间隔」调大';
  return '';
}

function hintForError(message, provider) {
  if (/404|不存在|does not exist/i.test(message)) {
    return `模型 ID 多半不对。先点「拉取可用模型」看看 ${provider.name} 给了哪些`;
  }
  if (/公网|base64|上限/i.test(message)) return '这家不收内联图片，去「设置 → 上传网关」配一个图床';
  return '';
}

/**
 * 跑体检。include 不传就跑默认项（避开贵的视频）。
 * 有意串行：并发跑更容易撞限流，而体检的价值在于结论准，不在于快。
 */
export async function run({ include } = {}, onEvent) {
  const wanted = include?.length ? include : CHECKS.filter((c) => c.defaultOn).map((c) => c.id);
  const ctx = {};
  const results = [];

  onEvent?.({ type: 'begin', checks: wanted });
  for (const id of CHECKS.map((c) => c.id).filter((id) => wanted.includes(id))) {
    results.push(await runOne(id, ctx, onEvent));
  }

  const failed = results.filter((r) => r.status === 'fail');
  const warned = results.filter((r) => r.status === 'warn');
  onEvent?.({
    type: 'summary',
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    failed: failed.length,
    warned: warned.length,
    verdict: failed.length
      ? `${sameRootCause(failed) || `${failed.length} 条不通：${failed.map((f) => f.id).join('、')}`} —— 流水线跑到那一步会停`
      : warned.length
        ? '能跑，但有需要留意的地方（见上）'
        : '五条腿都通，可以开跑'
  });
  return results;
}

/**
 * 好几条一起红的时候，先看看**是不是同一个原因**。
 *
 * 用户报上来的原话是这样四行：
 *     剧本 openai ✕ / 调度 openai ✕ / 复核 openai ✕ / 出图 openai ✕
 * 看上去像四个毛病，其实是一个：这台机器连不上 api.openai.com。
 * 而结论那一行只会说"4 条不通：chat、vision、t2i、tts"，
 * 等于把同一句话拆成四份，还漏掉了唯一有用的那句。
 *
 * 一条一条去读详情当然也能看出来，但人不会 —— 四个红叉先入为主，
 * 第一反应是"密钥是不是过期了"，然后开始白折腾。
 */
export function sameRootCause(failed = []) {
  if (failed.length < 2) return '';
  const providers = new Set(failed.map((f) => f.providerName || f.provider).filter(Boolean));
  // 都指着同一家、而且都是"连不上"那一类
  const netLike = failed.filter((f) => /连不上|解析不了|连接失败|拒绝连接|掐断/.test(f.message || ''));
  if (providers.size !== 1 || netLike.length !== failed.length) return '';
  const blocked = failed.some((f) => /在中国大陆\*\*直连基本不通\*\*/.test(f.message || ''));
  return (
    `${failed.length} 条全红，但**是同一个原因**：这台机器连不上 ${[...providers][0]}。`
    + (blocked
      ? '这个域名在境内直连基本不通 —— 不是密钥的问题，往下看第一条的说明，三条路挑一条。'
      : '密钥和模型都没被验到（请求根本没发出去），先解决网络再看别的。')
  );
}

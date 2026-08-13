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
  }
];

const ROUTE_KEYS = {
  chat: ['chatProvider', 'chatModel'],
  vision: ['visionProvider', 'visionModel'],
  t2i: ['imageProvider', 'imageModel'],
  i2v: ['videoProvider', 'videoModel'],
  tts: ['ttsProvider', 'ttsModel']
};

function route(checkId) {
  const [pk, mk] = ROUTE_KEYS[checkId];
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

async function runOne(checkId, ctx, onEvent) {
  const { providerId, model } = route(checkId);
  const provider = getProvider(providerId);
  const started = Date.now();

  const base = { id: checkId, provider: providerId, providerName: provider?.name || providerId, model };
  onEvent?.({ type: 'check', status: 'running', ...base });

  const finish = (status, extra = {}) => {
    const result = { type: 'check', status, ms: Date.now() - started, ...base, ...extra };
    onEvent?.(result);
    return result;
  };

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

      default:
        return finish('skip', { message: `未知检查项：${checkId}` });
    }
  } catch (err) {
    return finish('fail', { message: err.message, hint: hintForError(err.message, provider) });
  }
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
      ? `${failed.length} 条不通：${failed.map((f) => f.id).join('、')} —— 流水线跑到那一步会停`
      : warned.length
        ? '能跑，但有需要留意的地方（见上）'
        : '五条腿都通，可以开跑'
  });
  return results;
}

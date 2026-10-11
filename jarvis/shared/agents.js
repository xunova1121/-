/**
 * 对话后端。两种实现，输出同一种事件流：
 *   { delta, emotion_hint, task_state, tool? }
 *
 *  - ClaudeAgent：Anthropic Claude（官方 SDK，流式）。content_block_delta 映射为 delta；
 *    网关从回复开头的 <emotion> 标签生成 emotion_hint；工具调用期间 task_state = processing。
 *  - MockAgent：没有 Claude 密钥时使用的本地演示智能体，规则回复 + 模拟工具调用，
 *    方便离线演示与自动化测试。
 */
import Anthropic from '@anthropic-ai/sdk';
import { EmotionTagStripper } from './emotionTag.js';

const SYSTEM_PROMPT = `你是“贾维斯”，运行在用户本机的语音助手，界面是一个会做表情的发光光核。

回复要求：
- 用简体中文，口语化，适合直接朗读：短句、少列表、不用 Markdown 表格和代码块（除非用户明确要代码）。
- 默认 1–4 句话；用户要详细说明时再展开。
- 需要本机状态（CPU、内存、网络）或当前时间时，调用对应工具，不要猜。
- 回复的第一个字符必须是一个界面表达标签：<emotion>X</emotion>，X 只能是 平静、专注、聆听、亲和、安抚、愉悦、警觉 之一，
  表示界面此刻应采用的表达风格（例如用户沮丧时用“安抚”，出现错误或风险时用“警觉”）。
  这个标签只是界面的显示风格，不代表你拥有情绪；不要在正文里提到它，也不要声称自己有真实感受。
- 回复延迟敏感：写完标签后立即开始正文。`;

const TOOLS = [
  {
    name: 'get_local_metrics',
    description: '读取本机当前的 CPU 占用、内存占用和网络状态。用户询问电脑/系统/本机运行情况时使用。',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
    eager_input_streaming: true
  },
  {
    name: 'get_current_time',
    description: '读取本机当前日期和时间（含时区）。用户询问现在几点、今天几号、星期几时使用。',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
    eager_input_streaming: true
  }
];

async function runTool(name, collectMetrics) {
  if (name === 'get_local_metrics') {
    const m = await collectMetrics();
    return JSON.stringify({ cpu: m.cpu, memory: m.memory, network: m.network });
  }
  if (name === 'get_current_time') {
    return JSON.stringify({
      iso: new Date().toISOString(),
      local: new Date().toLocaleString('zh-CN', { hour12: false }),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
  }
  throw new Error(`未知工具 ${name}`);
}

/** 只保留 user/assistant 文本轮次，并保证以 user 开头、角色交替 */
export function sanitizeHistory(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages.slice(-24) : []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = String(m.content ?? '').slice(0, 8000).trim();
    if (!content) continue;
    if (out.length && out.at(-1).role === m.role) out.at(-1).content += `\n${content}`;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export class ClaudeAgent {
  /**
   * @param {object} o
   * @param {() => Promise<object>} o.metrics  本机指标来源（Node 网关读系统，单文件版读浏览器）
   * @param {boolean} [o.browser]  在浏览器里直连 API（单文件版，密钥由用户自己填写并只存在本机）
   */
  constructor({ apiKey, model = 'claude-opus-5-5', baseURL, metrics, browser = false } = {}) {
    this.client = new Anthropic({ apiKey, ...(baseURL && { baseURL }), ...(browser && { dangerouslyAllowBrowser: true }) });
    this.model = model;
    this.metrics = metrics;
  }

  async *run(messages, { signal } = {}) {
    const convo = sanitizeHistory(messages);
    if (!convo.length || convo.at(-1).role !== 'user') throw new Error('消息历史必须以用户消息结尾');
    const stripper = new EmotionTagStripper();
    yield { delta: '', emotion_hint: null, task_state: 'processing' };

    for (let round = 0; round < 4; round++) {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        // 对话场景延迟优先：低思考强度；遭安全分类器拒绝时由服务端按类别自动换模型重试
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: convo
      }, { signal });

      for await (const ev of stream) {
        if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
          yield { delta: '', emotion_hint: null, task_state: 'processing', tool: ev.content_block.name };
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          const { text, hint } = stripper.push(ev.delta.text);
          if (text || hint) yield { delta: text, emotion_hint: hint, task_state: 'listening' };
        }
      }
      const msg = await stream.finalMessage();

      if (msg.stop_reason === 'refusal') {
        yield { delta: '抱歉，这个请求我没办法协助。', emotion_hint: '安抚', task_state: 'listening' };
        break;
      }
      if (msg.stop_reason !== 'tool_use') {
        const rest = stripper.flush();
        if (rest.text || rest.hint) yield { delta: rest.text, emotion_hint: rest.hint, task_state: 'listening' };
        if (msg.stop_reason === 'max_tokens') yield { delta: '……（回复过长，已截断）', emotion_hint: null, task_state: 'listening' };
        break;
      }

      // 工具轮：原样回传本轮 content（含思考块），再附上全部 tool_result
      convo.push({ role: 'assistant', content: msg.content });
      const results = [];
      for (const block of msg.content) {
        if (block.type !== 'tool_use') continue;
        yield { delta: '', emotion_hint: null, task_state: 'processing', tool: block.name };
        try {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: await runTool(block.name, this.metrics) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: String(err.message), is_error: true });
        }
      }
      convo.push({ role: 'user', content: results });
    }
    yield { delta: '', emotion_hint: null, task_state: 'done' };
  }
}

/** 离线演示智能体：同样的事件形状，便于不连外网时演示完整链路 */
export class MockAgent {
  constructor({ charDelayMs = 28, metrics } = {}) {
    this.model = 'mock';
    this.charDelayMs = charDelayMs;
    this.metrics = metrics;
  }

  async *run(messages, { signal } = {}) {
    const convo = sanitizeHistory(messages);
    const q = convo.at(-1)?.content ?? '';
    yield { delta: '', emotion_hint: null, task_state: 'processing' };
    await sleep(350, signal);

    let hint = '亲和';
    let text;
    if (/cpu|内存|电脑|系统|网络|状态|负载/i.test(q)) {
      yield { delta: '', emotion_hint: null, task_state: 'processing', tool: 'get_local_metrics' };
      const m = await this.metrics();
      await sleep(400, signal);
      const cpu = m.cpu?.percent;
      const mem = m.memory?.percent;
      const high = (cpu ?? 0) > 80 || (mem ?? 0) > 85;
      hint = high ? '警觉' : '平静';
      const parts = [
        cpu != null ? `${m.source === 'browser' ? '页面主线程繁忙度' : 'CPU 占用'}约 ${Math.round(cpu)}%` : null,
        m.source === 'browser'
          ? (m.memory?.usedMB != null ? `页面内存 ${m.memory.usedMB} MB` : null)
          : (mem != null ? `内存占用 ${Math.round(mem)}%（${m.memory.usedMB} / ${m.memory.totalMB} MB）` : null),
        `网络${m.network?.online ? '在线' : '离线'}`
      ].filter(Boolean);
      text = `正在处理。${parts.join('，')}。${high ? '注意，负载偏高，建议关掉不用的程序。' : '整体运行平稳。'}`;
    } else if (/几点|时间|日期|星期|今天/.test(q)) {
      yield { delta: '', emotion_hint: null, task_state: 'processing', tool: 'get_current_time' };
      await sleep(250, signal);
      hint = '平静';
      text = `现在是 ${new Date().toLocaleString('zh-CN', { hour12: false })}。`;
    } else if (/难过|烦|累|焦虑|压力|担心|糟糕/.test(q)) {
      hint = '安抚';
      text = '没关系，慢慢来。我理解这种感觉，先深呼吸一下。你愿意的话，可以说说具体发生了什么，我们一起理一理。';
    } else if (/成功|通过|完成|好消息|升职|录取/.test(q)) {
      hint = '愉悦';
      text = '太好了，恭喜你！这份努力很值得。要不要我帮你把下一步计划列一下？';
    } else if (/错误|报错|失败|崩溃|异常|危险/.test(q)) {
      hint = '警觉';
      text = '注意，听起来出现了异常。请把完整的错误信息发给我，我先帮你判断是配置问题还是代码问题。';
    } else if (/分析|计算|算一下|检索|查一下/.test(q)) {
      hint = '专注';
      text = '分析中。我会先拆解问题，再逐项检索相关信息，最后给你一个结论和依据。';
    } else {
      text = `你好，我是贾维斯。当前运行在本地演示模式（在设置里填写 Claude API Key 即可接入真正的大模型），可以试试问我“电脑现在状态怎么样”或“现在几点”。你刚才说的是：“${q.slice(0, 40)}”。`;
    }

    yield { delta: '', emotion_hint: hint, task_state: 'listening' };
    for (const ch of text) {
      await sleep(this.charDelayMs, signal);
      yield { delta: ch, emotion_hint: null, task_state: 'listening' };
    }
    yield { delta: '', emotion_hint: null, task_state: 'done' };
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdapter, DEFAULT_CONFIG } from '../src/llm/config.js';
import { classifyTask, routeFor, effortFor } from '../src/llm/router.js';
import { errorKind } from '../src/core/suggest.js';

/** 直连基线：不搜索、不换备用模型、不做瞬时重试；不记录密钥、地址、回答或内部提示。 */
export async function probeDirectModel({ adapter, model, question, signal, effort, now = Date.now, timeoutMs = 45000 }) {
  const started = now();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let firstTextMs = null;
  let responseChars = 0;
  let lastTextMs = null;
  let timer;
  const expired = new Promise((resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(signal?.aborted ? Object.assign(new Error('已取消'), { name: 'AbortError' }) : controller.signal.reason), { once: true });
    timer = setTimeout(() => {
      const error = Object.assign(new Error('直连测量超时'), { code: 'DIRECT_PROBE_TIMEOUT', kind: 'timeout' });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    if (controller.signal.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
    await Promise.race([expired, adapter.stream({
      model, effort, system: ['请用简短中文回答。', ''],
      messages: [{ role: 'user', content: question }], tools: [],
      allowWebSearch: false, maxWebSearches: 0, maxTransientRetries: 0, maxPartialRetries: 0,
      stallTimeouts: { first: 20000, between: 25000 }, signal: controller.signal,
      onText: (delta) => {
        if (!delta || controller.signal.aborted) return;
        firstTextMs ??= now() - started;
        responseChars += delta.length;
        lastTextMs = now() - started;
      }
    })]);
    return { status: 'done', firstTextMs, lastTextMs, totalMs: now() - started, responseChars };
  } catch (error) {
    const failure = controller.signal.reason?.code === 'DIRECT_PROBE_TIMEOUT' ? controller.signal.reason : error;
    return {
      status: signal?.aborted ? 'stopped' : 'error', firstTextMs, lastTextMs, totalMs: now() - started, responseChars,
      errorKind: errorKind(failure), code: failure.code || null, httpStatus: failure.status || null
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (!args.includes('--live')) {
    console.log('预览：加 --live --data-dir=<JARVIS_DATA目录> 才调用真实模型。每题默认3次，共6次，不修改服务配置。');
    return;
  }
  const dataDir = args.find((arg) => arg.startsWith('--data-dir='))?.slice(11) || env.JARVIS_DATA;
  if (!dataDir) throw new Error('缺少服务器数据目录；不要粘贴密钥');
  const rounds = Number(args.find((arg) => arg.startsWith('--rounds='))?.slice(9) || 3);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('轮数必须为1到5');
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8'));
  const cfg = { ...DEFAULT_CONFIG, ...saved };
  if (!cfg.provider || cfg.provider === 'mock') throw new Error('需要真实模型配置');
  const out = args.find((arg) => arg.startsWith('--out='))?.slice(6) || `weiyang-direct-${Date.now()}.json`;
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), results: [],
    limitations: ['使用短固定提示，不等同于未央完整上下文；差值不能全部算作调度开销。', '禁用工具、搜索、备用模型回退和瞬时错误重试；协议参数兼容降级仍可能产生额外请求，同型号也可能被中转到不同上游。', '未知Token和费用不当作零；此脚本不修改服务配置或历史会话。']
  };
  await fs.writeFile(out, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  const controller = new AbortController();
  const cancelProbe = () => controller.abort();
  process.once('SIGINT', cancelProbe);
  process.once('SIGTERM', cancelProbe);
  try {
    for (let round = 1; round <= rounds && !controller.signal.aborted; round++) {
      for (const [id, question] of [['dialogue-01', '你好'], ['dialogue-02', '用两句话解释什么是智能体，给不懂技术的人听。']]) {
        if (controller.signal.aborted) break;
        const kind = classifyTask(question);
        const route = routeFor(cfg, kind);
        const selected = createAdapter(route.cfg);
        if (selected.problem) throw new Error('模型配置不完整，请在应用中检查');
        const result = await probeDirectModel({ ...selected, question, signal: controller.signal, effort: effortFor(kind, question, cfg) });
        report.results.push({ id, round, provider: route.cfg.provider, model: selected.model, protocol: selected.adapter.kind, ...result, usage: null });
        await fs.writeFile(out, JSON.stringify(report, null, 2), { mode: 0o600 });
        console.log(JSON.stringify(report.results.at(-1)));
      }
    }
  } finally {
    process.removeListener('SIGINT', cancelProbe);
    process.removeListener('SIGTERM', cancelProbe);
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(out, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  console.log(`报告：${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('测量未完成，请检查数据目录、配置、网络和报告；未输出凭据或响应正文。');
    process.exitCode = 1;
  });
}

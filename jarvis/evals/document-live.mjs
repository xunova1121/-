import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdapter, DEFAULT_CONFIG } from '../src/llm/config.js';
import { routeFor } from '../src/llm/router.js';
import { createDocumentWorkflow } from '../src/app/doc/documentWorkflow.js';
import { errorKind } from '../src/core/suggest.js';

// 真实模型验收独立运行，不使用测试替身，不修改服务配置、对话或生产工作区。
export async function main(args = process.argv.slice(2), env = process.env) {
  const option = (key) => args.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3);
  if (!args.includes('--live')) {
    console.log(
      '预览：--live --data-dir=<服务器数据目录> --task-file=<原始需求文本> [--material-file=<材料文本>] [--out-dir=<新目录>] 才调用真实配置模型。默认expert，通常3次，修订最多5次；不搜索、不自动换服务商，Token未知。'
    );
    return;
  }
  const dataDir = option('data-dir') || env.JARVIS_DATA;
  if (!dataDir || !option('task-file')) throw new Error('需要数据目录和原始需求文件');
  const cfg = { ...DEFAULT_CONFIG, ...JSON.parse(await fs.readFile(path.join(dataDir, 'config.json'), 'utf8')) };
  const route = routeFor(cfg, 'write');
  const selected = createAdapter(route.cfg);
  if (selected.problem || selected.adapter.kind === 'mock') throw new Error('需要真实模型配置');
  const task = await fs.readFile(option('task-file'), 'utf8');
  const material = option('material-file') ? await fs.readFile(option('material-file'), 'utf8') : '';
  const output = path.resolve(option('out-dir') || `weiyang-document-live-${Date.now()}`);
  // 新目录独占，避免覆盖已有验收或用户资料。
  await fs.mkdir(output, { mode: 0o700 });
  const workspace = {
    normalize(value) {
      const result = String(value).replace(/\\/g, '/');
      if (path.isAbsolute(result) || result.split('/').includes('..')) throw new Error('路径无效');
      return result;
    },
    async write(filePath, text) {
      const target = path.join(output, workspace.normalize(filePath));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, text, { mode: 0o600, flag: 'wx' });
      return { path: filePath };
    },
    async readBlob(filePath) {
      return new Blob([await fs.readFile(path.join(output, workspace.normalize(filePath)))]);
    }
  };
  const controller = new AbortController();
  const cancel = () => controller.abort(Object.assign(new Error('已停止'), { name: 'AbortError' }));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let firstTextMs = null;
  const started = Date.now();
  const workflow = createDocumentWorkflow({
    documentWorkspace: workspace,
    llm: async ({ system, prompt: inputText, signal }) => {
      let text = '';
      const result = await selected.adapter.stream({
        model: selected.model,
        system: [system],
        messages: [{ role: 'user', content: inputText }],
        tools: [],
        signal,
        allowWebSearch: false,
        maxWebSearches: 0,
        maxTransientRetries: 0,
        maxPartialRetries: 0,
        onText(delta) {
          firstTextMs ??= Date.now() - started;
          text += delta;
        }
      });
      return result?.text || text;
    }
  });
  const report = { version: 1, provider: route.cfg.provider, model: selected.model, usage: null, live: true, visual: 'not_checked', facts: 'not_verified' };
  try {
    const result = await workflow.run(
      { task, material, format: 'md', depth: 'expert' },
      { sessionId: 'document-live', signal: controller.signal, progress: (text) => console.log(text) }
    );
    await fs.writeFile(path.join(output, '终稿.md'), result.draft, { flag: 'wx', mode: 0o600 });
    Object.assign(report, {
      business: result.business,
      calls: result.calls,
      unresolved: result.unresolved,
      stateFile: result.stateFile,
      firstModelTextMs: firstTextMs,
      totalMs: Date.now() - started
    });
  } catch (error) {
    Object.assign(report, {
      status: 'error',
      errorKind: errorKind(error),
      code: error.code || null,
      stateFile: error.stateFile || null,
      totalMs: Date.now() - started
    });
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    await fs.writeFile(path.join(output, '验收报告.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  }
  console.log(`验收文件：${output}。报告不输出凭据或响应正文；模型审查结果仍需人工核对。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('未完成：请检查本机配置、输入文件和输出目录；未输出凭据。');
    process.exitCode = 1;
  });

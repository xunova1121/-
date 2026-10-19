import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runProject } from '../server/projectExecution.mjs';

const image = process.env.JARVIS_CODE_SANDBOX_IMAGE;
assert.ok(image, '验收必须显式指定已经拉取的测试镜像');
const execute = promisify(execFile);
const records = new Map([
  ['sample/sum.mjs', 'export const sum=(a,b)=>a+b;'],
  [
    'sample/sum.test.mjs',
    "import {test} from 'node:test';import assert from 'node:assert/strict';import{sum}from'./sum.mjs';import fs from'node:fs';test('多文件与只读',()=>{assert.equal(sum(2,3),5);assert.throws(()=>fs.writeFileSync('/workspace/forbidden','x'));assert.equal(process.env.JARVIS_TEST_SECRET,undefined);});test('无网络',async()=>{await assert.rejects(fetch('https://example.com',{signal:AbortSignal.timeout(300)}));});"
  ],
  ['sample/loop.mjs', 'while(true){}']
]);
const list = async () => [...records].map(([file, data]) => ({ path: file, size: data.length }));
const read = async (file) => new Blob([records.get(file)]);
const result = await runProject({ root: 'sample', tests: ['sum.test.mjs'] }, { image, list, read });
assert.equal(result.exitCode, 0);
assert.match(result.stdout, /pass 2/);
console.log('✓ 多文件项目实际通过测试、只读挂载、隔离环境与网络禁用');

const controller = new AbortController();
let container;
let observedRunning = false;
const runDocker = async (args, options) => {
  if (args[0] === 'run') {
    container = args[args.indexOf('--name') + 1];
    // 先实际看见运行中的容器，再取消；不能把启动前取消算成运行中取消。
    void (async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const state = await execute('docker', ['inspect', '--format', '{{.State.Running}}', container]);
          if (state.stdout.trim() === 'true') {
            observedRunning = true;
            controller.abort();
            return;
          }
        } catch {
          /* 创建尚未完成，继续短时轮询 */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      controller.abort();
    })();
  }
  return execute('docker', args, { ...options, maxBuffer: 64000, env: { PATH: process.env.PATH } });
};
await assert.rejects(
  runProject(
    { root: 'sample', mode: 'run', entry: 'loop.mjs' },
    {
      image,
      list,
      read,
      signal: controller.signal,
      runDocker
    }
  ),
  (error) => error.name === 'AbortError'
);
assert.ok(container);
assert.ok(observedRunning, '必须先观察到真正运行中的容器');
await assert.rejects(execute('docker', ['inspect', container]));
console.log('✓ 取消实际容器执行并确认清理；没有降级为宿主机执行');

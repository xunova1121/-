/** P2虚构项目真实Git+Docker：测试红→精确改代码→绿；不使用真实仓库隐藏答案。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { codeRepoFixture } from '../tests/helpers/codeRepoFixture.mjs';
import { createCodeSandbox } from '../server/codeSandbox.mjs';
import { localCodeDocker } from '../server/codeDocker.mjs';
import { createCodeTools } from '../server/codeTools.mjs';
const image = process.env.JARVIS_CODE_SANDBOX_IMAGE;
assert(image, '必须指定已安装的隔离镜像');
const out = process.argv[2] || '/tmp/weiyang-code-agent-p2';
await fs.mkdir(out, { recursive: true });
const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'virtual-dependency-'));
let fixture;
try {
  const packed = path.join(staging, 'package');
  await fs.mkdir(packed);
  await fs.writeFile(
    path.join(packed, 'package.json'),
    JSON.stringify({ name: 'fixture-check', version: '1.0.0', main: 'index.js', scripts: { postinstall: 'node -e "process.exit(88)"' } })
  );
  await fs.writeFile(path.join(packed, 'index.js'), 'module.exports=value=>typeof value === "number";');
  await fs.chmod(packed, 0o755);
  for (const file of await fs.readdir(packed)) await fs.chmod(path.join(packed, file), 0o644);
  const tar = path.join(staging, 'dependency.tgz');
  execFileSync('tar', ['-czf', tar, '-C', staging, 'package']);
  const body = await fs.readFile(tar),
    integrity = 'sha512-' + createHash('sha512').update(body).digest('base64');
  const pkg = {
    name: 'fictional-focus',
    version: '1.0.0',
    type: 'module',
    scripts: {
      preinstall: 'node -e "process.exit(89)"',
      pretest: 'node -e "process.exit(90)"',
      lint: 'node --check src/focus.mjs',
      test: 'node --test test/focus.test.mjs'
    },
    dependencies: { 'fixture-check': '1.0.0' }
  };
  const lock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    packages: {
      '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
      'node_modules/fixture-check': { version: '1.0.0', resolved: 'https://registry.npmjs.org/fixture-check/-/fixture-check-1.0.0.tgz', integrity }
    }
  };
  const tests = `import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import isNumber from'fixture-check';import{weeklyMinutes}from'../src/focus.mjs';
 test('每周专注分钟',()=>assert.equal(weeklyMinutes(3,25),75));
 test('锁定依赖已真正安装',()=>assert.equal(isNumber(75),true));
 test('输入挂载只读、无凭据或Git元数据',()=>{assert.equal(process.getuid(),65534);assert.equal(process.env.GITHUB_TOKEN,undefined);assert.equal(process.env.JARVIS_TEST_SECRET,undefined);assert.equal(fs.existsSync('/source/.git'),false);assert.equal(fs.existsSync('/source/.env'),false);assert.equal(fs.existsSync('/var/run/docker.sock'),false);assert.throws(()=>fs.writeFileSync('/source/forbidden','x'));assert.throws(()=>fs.writeFileSync('/etc/forbidden','x'));});
 test('外网不可达',async()=>{await assert.rejects(fetch('https://example.com',{signal:AbortSignal.timeout(300)}));});`;
  const files = {
    'package.json': JSON.stringify(pkg),
    'package-lock.json': JSON.stringify(lock),
    'src/focus.mjs': 'export const weeklyMinutes=(days,minutes)=>days+minutes;\n',
    'test/focus.test.mjs': tests,
    '.env': 'PRIVATE=never-mount'
  };
  const requests = [],
    sandbox = createCodeSandbox({
      image,
      baseDir: path.join(out, 'code-jobs'),
      fetchImpl: async (url, init) => {
        requests.push(url);
        assert.equal(init.redirect, 'manual');
        assert.equal(url, 'https://registry.npmmirror.com/fixture-check/-/fixture-check-1.0.0.tgz');
        assert.equal(init.headers.Authorization, undefined);
        return new Response(body);
      }
    });
  fixture = await codeRepoFixture(files, { sandbox });
  const scope = { sessionId: 'e2e-code-session', taskId: 'e2e-code-task' },
    a = await fixture.repos.clone({}, scope);
  const tools = createCodeTools({ repos: fixture.repos, ...scope, editing: true }),
    tool = (name) => tools.find((t) => t.name === name);
  const start = Date.now();
  let initial;
  await assert.rejects(tool('code_run').run({ workspace_id: a.workspace_id, command: 'test' }), (error) => {
    initial = error.result;
    return error.code === 'CODE_TEST_FAILED' && initial.exitCode === 1 && /每周专注分钟/.test(initial.stdout);
  });
  assert.equal(initial.install.exitCode, 0);
  await tool('code_read').run({ workspace_id: a.workspace_id, path: 'src/focus.mjs' });
  await tool('code_edit').run({ workspace_id: a.workspace_id, path: 'src/focus.mjs', old: 'days+minutes', new: 'days*minutes' });
  const lint = JSON.parse(await tool('code_run').run({ workspace_id: a.workspace_id, command: 'lint' }));
  assert(lint.ok);
  const green = JSON.parse(await tool('code_run').run({ workspace_id: a.workspace_id, command: 'test' }));
  assert(green.ok);
  assert.match(green.stdout, /# pass 4/);
  const tree = fixture.cwd(a.workspace_id);
  assert.equal(await fs.readFile(path.join(tree, 'test/focus.test.mjs'), 'utf8'), tests);
  assert.equal(await fs.readFile(path.join(tree, 'package-lock.json'), 'utf8'), files['package-lock.json']);
  assert.deepEqual(
    (await fixture.repos.status(a.workspace_id, scope.sessionId)).changes.map((v) => v.path),
    ['src/focus.mjs']
  );
  assert.equal(fixture.command(fixture.source, 'rev-parse', 'HEAD'), fixture.original);
  assert.equal(fixture.command(fixture.source, 'status', '--porcelain'), '');
  assert.notEqual(initial.sourceDigest, green.sourceDigest);
  assert.equal(lint.sourceDigest, green.sourceDigest);
  assert.equal(requests.length, 3);
  await fs.writeFile(
    path.join(out, 'report.json'),
    JSON.stringify(
      {
        fictional: true,
        imageId: green.imageId,
        initialExit: initial.exitCode,
        lintExit: lint.exitCode,
        testExit: green.exitCode,
        testsUnchanged: true,
        lockUnchanged: true,
        upstreamUnchanged: true,
        dependencyScriptsDisabled: true,
        network: 'none',
        sourceDigest: green.sourceDigest,
        elapsedMs: Date.now() - start
      },
      null,
      2
    )
  );
  console.log('✓ 真实Git/Docker：测试1失败→只改业务代码→lint通过→4项测试通过，原测试/锁文件/上游main保持不变');
  console.log('✓ 实际第三方包离线安装；根/依赖安装脚本及隐含pretest未执行，非root、只读挂载、无凭据、无外网');
} finally {
  if (fixture) await fixture.close();
  await fs.rm(staging, { recursive: true, force: true });
}

// 停止必须发生在实际测试进程已运行后，不能拿启动前取消冒充。
const ctrl = new AbortController();
let observed = false,
  containerName,
  polling;
const controlledDocker = async (args, options) => {
  if (args[0] === 'run' && args.at(-2) === 'run') {
    containerName = args[args.indexOf('--name') + 1];
    polling = (async () => {
      for (let i = 0; i < 100; i++) {
        const state = await localCodeDocker(['logs', containerName], { timeout: 5000 });
        if (state.exitCode === 0 && state.stdout.includes('P2_LOOP_READY')) {
          observed = true;
          ctrl.abort(new DOMException('已停止', 'AbortError'));
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      ctrl.abort(new Error('未观察到测试进程'));
    })();
  }
  return localCodeDocker(args, options);
};
const loop = await codeRepoFixture(
  {
    'package.json': JSON.stringify({ name: 'loop-fixture', version: '1.0.0', scripts: { test: 'node loop.mjs' } }),
    'loop.mjs': 'console.log("P2_LOOP_READY");while(true){}'
  },
  { sandbox: createCodeSandbox({ image, baseDir: path.join(out, 'code-jobs'), runDocker: controlledDocker }) }
);
try {
  const scope = { sessionId: 'loop-session', taskId: 'loop-task' },
    a = await loop.repos.clone({}, scope);
  await assert.rejects(loop.repos.run(a.workspace_id, scope.sessionId, 'test', { signal: ctrl.signal }), (e) => e.name === 'AbortError');
  await polling;
  assert(observed, '必须真正看到测试进程');
  assert.notEqual((await localCodeDocker(['inspect', containerName], { timeout: 5000 })).exitCode, 0);
  assert.deepEqual((await loop.repos.status(a.workspace_id, scope.sessionId)).changes, []);
  console.log('✓ 运行中停止：真正观察到node测试进程后取消，容器消失，宿主工作副本未变');
} finally {
  await loop.close();
}

const noisy = await codeRepoFixture(
  {
    'package.json': JSON.stringify({ name: 'output-fixture', version: '1.0.0', scripts: { test: 'node noisy.mjs' } }),
    'noisy.mjs': 'for(let i=0;i<2000;i++)console.log("x".repeat(1000));'
  },
  { sandbox: createCodeSandbox({ image, baseDir: path.join(out, 'code-jobs') }) }
);
try {
  const scope = { sessionId: 'noisy-session', taskId: 'noisy-task' },
    a = await noisy.repos.clone({}, scope);
  await assert.rejects(noisy.repos.run(a.workspace_id, scope.sessionId, 'test'), (e) => e.code === 'CODE_RUN_OUTPUT');
  console.log('✓ 输出超过128KB立即停止并清理；没有截成绿色成功');
} finally {
  await noisy.close();
}

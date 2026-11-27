/** 真实Archify构建→finalize→HTML/浏览器验收，仅公开Apache-2.0示例；不调用模型、不读客户材料。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createSkillRunner, skillRunnerTool } from '../server/skillRunner.mjs';
import { parseFrontmatter } from '../src/agent/skillPacks.js';

const execute = promisify(execFile);
const root = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3] || '/tmp/weiyang-skill-build-e2e');
const image = process.env.JARVIS_SKILL_RUNNER_IMAGE;
assert(image, '先指定已安装的带Node/npm/Chromium的隔离镜像');
const source = path.join(root, 'archify');
assert.match(await fs.readFile(path.join(root, 'LICENSE'), 'utf8'), /Apache License/);
await fs.mkdir(out, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-skill-build-'));
const calls = [];
let buildStarted;
const dockerEnv = { ...process.env };
dockerEnv.WEIYANG_SKILL_TEST_SECRET = 'fixture-not-forwarded';
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[key];
const dockerRun = async (args, options = {}) => {
  calls.push(args);
  let actual = args;
  // 仅云端测试挂载会话公共CA；代理沿用Docker平台配置，TLS校验始终开启。
  if (args[0] === 'run' && process.env.CODEX_PROXY_CERT)
    actual = [
      args[0],
      '--mount',
      `type=bind,src=${process.env.CODEX_PROXY_CERT},dst=/run/proxy-ca.pem,readonly`,
      '-e',
      'NODE_EXTRA_CA_CERTS=/run/proxy-ca.pem',
      ...args.slice(1)
    ];
  if (args.some((arg) => arg.startsWith('JARVIS_BUILD_STEPS='))) buildStarted?.(args);
  return execute('docker', ['--host=unix:///var/run/docker.sock', ...actual], {
    env: dockerEnv,
    timeout: options.timeout,
    signal: options.signal,
    maxBuffer: 4 * 1024 * 1024
  });
};
const runner = createSkillRunner({ image, baseDir: temporary, runDocker: dockerRun });
const files = {};
async function readFiles(relative = '') {
  for (const entry of await fs.readdir(path.join(source, relative), { withFileTypes: true })) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) await readFiles(name);
    else if (entry.isFile() && name !== 'SKILL.md') files[name] = await fs.readFile(path.join(source, name), 'utf8');
  }
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let browser;
try {
  await readFiles();
  const original = digest(await fs.readFile(path.join(source, 'renderers/shared/generated-validators.mjs')));
  const { body, meta } = parseFrontmatter(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'));
  // 上游虚构web-app示例仅用作脚本兼容验收，不代表用户真实业务/模型生成水平。
  const candidate = JSON.parse(files['examples/web-app.architecture.json']);
  candidate.meta.title = '晨光协作平台 · 虚构验收';
  files['fixture.json'] = JSON.stringify(candidate);
  const pack = { name: meta.name, body, files, enabled: true };
  const tool = skillRunnerTool({
    runner,
    getPack: async () => pack,
    saveFile: async (name, data) => {
      const target = path.join(out, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, data);
    }
  });
  const command = 'node bin/archify.mjs finalize architecture fixture.json diagram.html --quality showcase --json';
  const response = await tool.run(
    { skill: 'archify', command, timeout_seconds: 120 },
    { rawRequestText: '用Archify画这个虚构平台的架构图', progress: (message) => console.log(message) }
  );
  await fs.writeFile(path.join(out, 'run.txt'), response);
  assert.match(response, /退出码：0/);
  const artifacts = path.join(out, 'skills-output/archify');
  const html = path.join(artifacts, 'diagram.html');
  assert((await fs.stat(html)).size > 100000);
  assert((await fs.readFile(html, 'utf8')).includes(candidate.meta.title));
  const summaries = (await fs.readdir(artifacts)).filter((name) => /finalize-summary\.json$/.test(name));
  assert(summaries.length, '必须保留真实finalize回执');
  const summary = JSON.parse(await fs.readFile(path.join(artifacts, summaries[0]), 'utf8'));
  assert.equal(summary.ok, true, 'validate/deliver/check/browser-check必须实际通过');
  console.log('✓ 真实Archify：隔离构建、校验、交付、严格检查和真实浏览器门禁通过；HTML真实保存到工作区');
  const builds = () => calls.filter((args) => args.some((arg) => arg.startsWith('JARVIS_BUILD_STEPS='))).length;
  assert.equal(builds(), 1);
  assert.equal((await runner.run(pack, 'node bin/archify.mjs doctor')).exitCode, 0);
  assert.equal(builds(), 1, '同稿复用');
  assert.equal((await runner.run({ ...pack, files: { ...files, 'fixture-note.txt': '新版本' } }, 'node bin/archify.mjs doctor')).exitCode, 0);
  assert.equal(builds(), 2, '内容变化须重建');
  assert.equal(digest(await fs.readFile(path.join(source, 'renderers/shared/generated-validators.mjs'))), original, '原安装源保持');
  const ordinary = await runner.run(
    {
      name: 'plain-node',
      body: '执行简单脚本',
      files: {
        'entry.mjs':
          'import fs from "node:fs"; if(process.env.WEIYANG_SKILL_TEST_SECRET) throw Error("secret"); fs.writeFileSync("plain.txt","ordinary skill works"); console.log(process.getuid());'
      }
    },
    'node entry.mjs'
  );
  assert.equal(ordinary.exitCode, 0);
  assert.equal(ordinary.stdout.trim(), '65534');
  assert.equal(ordinary.files.find((file) => file.path === 'plain.txt').data.toString(), 'ordinary skill works');
  assert.equal(builds(), 2);
  console.log('✓ 同稿复用、内容变化重建、源文件保持；无需构建技能仍以非root实际出文件');

  // 真正观察到构建脚本写出的标记后再停止，不把“还没启动就取消”当运行中停止。
  const ctrl = new AbortController();
  let stage;
  buildStarted = (args) => {
    stage = args.find((arg) => arg.includes('dst=/build,')).match(/src=([^,]+)/)[1];
  };
  const waiting = runner.run(
    {
      name: 'cancel-builder',
      body: 'fixture',
      files: {
        'package.json': '{"scripts":{"prepare":"node build.mjs"}}',
        'build.mjs': 'import fs from "node:fs";fs.writeFileSync("build-live","started");setInterval(()=>{},1000);'
      }
    },
    'node entry.mjs',
    { signal: ctrl.signal }
  );
  let early;
  const stopped = waiting.then(
    () => {
      early = Error('取消构建不应成功');
      return early;
    },
    (error) => {
      early = error;
      return error;
    }
  );
  try {
    // 允许带Chromium镜像在慢磁盘上完成容器创建；仍必须看到脚本实写的标记，不能用等待时间代替。
    const end = Date.now() + 60000;
    while (!stage || !(await fs.stat(path.join(stage, 'build-live')).catch(() => null))) {
      if (early) throw early;
      assert(Date.now() < end, '必须观察到真实构建开始');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    ctrl.abort();
    assert.equal((await stopped).name, 'AbortError');
  } finally {
    ctrl.abort();
    await stopped; // 测试自身失败也先确认构建停止，再删除隔离目录。
  }
  assert.equal((await fs.readdir(path.join(temporary, 'cancel-builder/builds'))).filter((name) => name.startsWith('.building-')).length, 0);
  const leftover = await dockerRun(['ps', '--all', '--quiet', '--filter', 'name=^/jarvis-skill-build-']);
  assert.equal(leftover.stdout.trim(), '');
  console.log('✓ 构建运行中取消：容器确认消失，失败副本清理，没有缓存成功或进入实际执行');

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(pathToFileURL(html).href);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, 'archify-preview.png'), fullPage: true });
  await fs.writeFile(
    path.join(out, 'acceptance.json'),
    JSON.stringify(
      {
        state: 'passed',
        modelRequested: false,
        builds: builds(),
        upstream: 'tt-a1i/archify',
        license: 'Apache-2.0',
        artifact: path.relative(out, html),
        htmlSha256: digest(await fs.readFile(html)),
        finalize: summary
      },
      null,
      2
    )
  );
} finally {
  await browser?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}

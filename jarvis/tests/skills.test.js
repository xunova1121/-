import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import * as packs from '../src/agent/skillPacks.js';
import { BUILTIN_SKILLS, GITHUB_SKILLS } from '../src/agent/skillCatalog.js';
import { createTools, pickPythonFiles } from '../src/agent/tools.js';
import { buildContext } from '../src/agent/agent.js';

const SKILL = `---
name: weekly-report
description: >
  把工作记录整理成周报。
  用户说写周报时使用。
license: MIT
---

# 周报
## 步骤
1. 收集素材
`;

beforeEach(async () => { for (const p of await packs.list()) await packs.remove(p.name); });

describe('SKILL.md 解析', () => {
  it('读取 YAML 头（含折叠多行）与正文', () => {
    const { meta, body } = packs.parseFrontmatter(SKILL);
    expect(meta).toMatchObject({ name: 'weekly-report', description: '把工作记录整理成周报。 用户说写周报时使用。', license: 'MIT' });
    expect(body.startsWith('# 周报')).toBe(true);
  });
  it('内置推荐技能都能解析出 name 和 description', () => {
    for (const s of BUILTIN_SKILLS) {
      const { meta, body } = packs.parseFrontmatter(s.text);
      expect(meta.name).toMatch(/^[a-z0-9-]+$/);
      expect(meta.description.length).toBeGreaterThan(10);
      expect(body.length).toBeGreaterThan(50);
    }
    for (const s of GITHUB_SKILLS) expect(packs.parseGitHubUrl(s.url).dir).toBe(`skills/${s.name}`);
  });
});

describe('安装与管理', () => {
  it('从 SKILL.md 安装、停用、卸载；同名重装保留启用状态', async () => {
    const p = await packs.installFromText(SKILL);
    expect(p).toMatchObject({ name: 'weekly-report', enabled: true });
    await packs.setEnabled('weekly-report', false);
    expect((await packs.enabled()).length).toBe(0);
    await packs.installFromText(SKILL);
    expect((await packs.get('weekly-report')).enabled).toBe(false);
    await packs.remove('weekly-report');
    expect(await packs.list()).toEqual([]);
  });

  it('从 zip 安装：SKILL.md 在子文件夹里，附带文本文件和模板 / 图片 / 字体（二进制），跳过可执行文件和系统垃圾', async () => {
    const zip = new JSZip();
    zip.file('my-skill/SKILL.md', SKILL);
    zip.file('my-skill/templates/report.md', '# 模板');
    zip.file('my-skill/scripts/count.py', 'print(1)');
    zip.file('my-skill/logo.png', new Uint8Array([137, 80, 78, 71]));
    zip.file('my-skill/fonts/思源黑体.otf2', new Uint8Array([1, 2]));
    zip.file('my-skill/tool.exe', new Uint8Array([77, 90]));
    zip.file('my-skill/node_modules/x/index.js', 'x');
    zip.file('__MACOSX/my-skill/._SKILL.md', 'x');
    const p = await packs.installFromZip(await zip.generateAsync({ type: 'uint8array' }));
    expect(Object.keys(p.files).sort()).toEqual(['fonts/思源黑体.otf2', 'logo.png', 'scripts/count.py', 'templates/report.md']);
    expect(packs.isBinaryFile(p.files['logo.png'])).toBe(true);
    expect(packs.isBinaryFile(p.files['fonts/思源黑体.otf2'])).toBe(true);
    expect(p.skipped).toEqual([]);
  });

  it('没有 SKILL.md 时给出明确错误', async () => {
    await expect(packs.installFromFiles({ 'README.md': 'x' })).rejects.toThrow(/SKILL\.md/);
  });

  it('解析各种 GitHub 地址', () => {
    expect(packs.parseGitHubUrl('https://github.com/anthropics/skills/tree/main/skills/pdf')).toMatchObject({ owner: 'anthropics', repo: 'skills', ref: 'main', dir: 'skills/pdf' });
    expect(packs.parseGitHubUrl('github.com/o/r/blob/dev/a/b/SKILL.md')).toMatchObject({ owner: 'o', repo: 'r', ref: 'dev', dir: 'a/b' });
    expect(packs.parseGitHubUrl('https://raw.githubusercontent.com/o/r/main/x/SKILL.md')).toEqual({ owner: 'o', repo: 'r', ref: 'main', dir: 'x' });
    expect(packs.parseGitHubUrl('https://github.com/o/r')).toMatchObject({ owner: 'o', repo: 'r', ref: null, dir: '' });
    expect(() => packs.parseGitHubUrl('https://gitlab.com/o/r')).toThrow(/GitHub/);
  });

  it('从 GitHub 安装：一次列出文件树，再下载技能文件夹里的文本文件', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.includes('/git/trees/main')) {
        return { ok: true, status: 200, json: async () => ({ tree: [
          { type: 'blob', path: 'skills/demo/SKILL.md', size: 100 },
          { type: 'blob', path: 'skills/demo/ref/guide.md', size: 10 },
          { type: 'blob', path: 'skills/demo/font.ttf', size: 10 },
          { type: 'blob', path: 'skills/other/SKILL.md', size: 10 }
        ] }) };
      }
      if (url.endsWith('skills/demo/SKILL.md')) return { ok: true, text: async () => SKILL.replace('weekly-report', 'demo') };
      if (url.endsWith('ref/guide.md')) return { ok: true, text: async () => '指南' };
      return { ok: false, status: 404 };
    };
    const p = await packs.installFromGitHub('https://github.com/o/r/tree/main/skills/demo', { fetchImpl });
    expect(p).toMatchObject({ name: 'demo', source: 'github.com/o/r/skills/demo', files: { 'ref/guide.md': '指南' } });
    expect(p.skipped).toEqual(['font.ttf（下载失败：HTTP 404）']);
    expect(urls.filter((u) => u.includes('api.github.com')).length).toBe(1);
  });

  it('分支名带斜杠（feature/x）：先按第一段试，找不到再按仓库真实分支确定', async () => {
    expect(packs.parseGitHubUrl('https://github.com/o/r/tree/feature/x/skills/demo').candidates.map((c) => c.ref)).toEqual(['feature', 'feature/x', 'feature/x/skills', 'feature/x/skills/demo']);
    expect(packs.pickRef(packs.parseGitHubUrl('github.com/o/r/tree/feature/x/skills/demo').candidates, ['main', 'feature/x'])).toEqual({ ref: 'feature/x', dir: 'skills/demo' });
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.includes('/git/trees/feature?')) return { ok: false, status: 404 };
      if (url.endsWith('/branches?per_page=100')) return { ok: true, json: async () => [{ name: 'main' }, { name: 'feature/x' }] };
      if (url.includes('/git/trees/feature%2Fx?')) return { ok: true, json: async () => ({ tree: [{ type: 'blob', path: 'skills/demo/SKILL.md', size: 100 }] }) };
      if (url === 'https://raw.githubusercontent.com/o/r/feature/x/skills/demo/SKILL.md') return { ok: true, text: async () => SKILL.replace('weekly-report', 'demo') };
      return { ok: false, status: 404 };
    };
    const p = await packs.installFromGitHub('https://github.com/o/r/tree/feature/x/skills/demo', { fetchImpl });
    expect(p).toMatchObject({ name: 'demo', source: 'github.com/o/r/skills/demo' });
  });

  it('分支名带斜杠且 GitHub 接口限流：逐个切分试 SKILL.md', async () => {
    const fetchImpl = async (url) => url.includes('api.github.com')
      ? { ok: false, status: 403 }
      : url === 'https://raw.githubusercontent.com/o/r/feature/x/skills/demo/SKILL.md' ? { ok: true, text: async () => SKILL } : { ok: false, status: 404 };
    const p = await packs.installFromGitHub('https://github.com/o/r/tree/feature/x/skills/demo', { fetchImpl });
    expect(p.name).toBe('weekly-report');
    expect(p.source).toBe('github.com/o/r/tree/feature/x/skills/demo');
  });

  it('GitHub 接口不可用时退回只安装 SKILL.md', async () => {
    const fetchImpl = async (url) => url.includes('api.github.com')
      ? { ok: false, status: 403 }
      : url.endsWith('/main/skills/demo/SKILL.md') ? { ok: true, text: async () => SKILL } : { ok: false, status: 404 };
    const p = await packs.installFromGitHub('https://github.com/o/r/tree/main/skills/demo', { fetchImpl });
    expect(p.name).toBe('weekly-report');
    expect(p.skipped[0]).toMatch(/接口暂不可用/);
  });

  // 像 github.com/chuspeeism/dashi-ppt-skill 这样：仓库根目录没有 SKILL.md，技能在 skills/<名字>/ 里
  const repoWith = (paths) => async (url) => {
    if (url.endsWith('/repos/o/r')) return { ok: true, json: async () => ({ default_branch: 'main' }) };
    if (url.includes('/git/trees/')) return { ok: true, json: async () => ({ tree: paths.map((path) => ({ type: 'blob', path, size: 10 })) }) };
    const path = decodeURIComponent(url.split('/main/')[1]);
    const name = path.split('/').at(-2);
    return { ok: true, text: async () => (path.endsWith('SKILL.md') ? `---\nname: ${name}\ndescription: ${name} 技能\n---\n做法 ${name}` : `文件 ${path}`) };
  };

  it('仓库根目录只有一个技能（在子文件夹里）：直接安装', async () => {
    const progress = [];
    const p = await packs.installFromGitHub('https://github.com/o/r', { fetchImpl: repoWith(['README.md', 'skills/dashi-ppt/SKILL.md', 'skills/dashi-ppt/template.md']), onProgress: (m) => progress.push(m) });
    expect(p.name).toBe('dashi-ppt');
    expect(p.files).toEqual({ 'template.md': '文件 skills/dashi-ppt/template.md' });
    expect(p.source).toBe('github.com/o/r/skills/dashi-ppt');
    expect(p.also).toBeUndefined();
    expect(progress).toContain('找到技能：skills/dashi-ppt');
  });

  it('仓库里有多个技能：全部安装；技能里嵌套的示例 SKILL.md 不单独算', async () => {
    const p = await packs.installFromGitHub('github.com/o/r', { fetchImpl: repoWith(['a/SKILL.md', 'b/SKILL.md', 'b/examples/x/SKILL.md']) });
    expect([p.name, ...p.also.map((x) => x.name)]).toEqual(['a', 'b']);
    expect(Object.keys((await packs.get('b')).files)).toEqual(['examples/x/SKILL.md']);
  });

  it('没有技能 / 太多技能时说清楚', async () => {
    await expect(packs.installFromGitHub('github.com/o/r', { fetchImpl: repoWith(['README.md']) })).rejects.toThrow('没有 SKILL.md');
    const many = Array.from({ length: 31 }, (_, i) => `s${i}/SKILL.md`);
    await expect(packs.installFromGitHub('github.com/o/r', { fetchImpl: repoWith(many) })).rejects.toThrow(/31 个技能.*tree\/main\/s0/);
  });

  it('安装、启停、卸载都会通知界面刷新', async () => {
    let n = 0;
    globalThis.dispatchEvent = (e) => { if (e.type === 'jarvis:skills-changed') n++; };
    await packs.installFromFiles({ 'SKILL.md': SKILL });
    await packs.setEnabled('weekly-report', false);
    await packs.remove('weekly-report');
    delete globalThis.dispatchEvent;
    expect(n).toBe(3);
  });
});

describe('智能体使用技能', () => {
  it('系统提示只列名字与描述；use_skill 读全文，read_skill_file 读附带文件', async () => {
    await packs.installFromFiles({ 'SKILL.md': SKILL, 'tpl.md': '模板内容' });
    const ctx = await buildContext('写周报');
    expect(ctx.dynamic).toMatch(/已安装的技能[\s\S]*weekly-report：把工作记录整理成周报/);
    expect(ctx.dynamic).not.toMatch(/收集素材/);
    const tools = Object.fromEntries(createTools({ metrics: async () => ({}) }).map((t) => [t.name, t]));
    const out = await tools.use_skill.run({ name: 'weekly-report' });
    expect(out).toMatch(/# 技能：weekly-report[\s\S]*收集素材[\s\S]*- tpl\.md/);
    expect(await tools.read_skill_file.run({ name: 'weekly-report', path: 'tpl.md' })).toBe('模板内容');
    await packs.setEnabled('weekly-report', false);
    expect(await tools.use_skill.run({ name: 'weekly-report' })).toMatch(/停用/);
    expect((await buildContext('写周报')).dynamic).not.toMatch(/已安装的技能/);
  });

  it('“/技能名”点名', () => {
    expect(packs.matchSlash('/Weekly-Report 本周做了 A', ['weekly-report'])).toEqual({ name: 'weekly-report', rest: '本周做了 A' });
    expect(packs.matchSlash('/nope x', ['weekly-report'])).toBeNull();
    expect(packs.matchSlash('不是命令', ['weekly-report'])).toBeNull();
  });
});

describe('技能附带的二进制模板', () => {
  it('从 GitHub 安装时下载 .pptx 模板；copy_skill_file 放进工作区；read_skill_file 提示用法', async () => {
    const tpl = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);
    const fetchImpl = async (url) => {
      if (url.endsWith('/repos/o/r')) return { ok: true, json: async () => ({ default_branch: 'main' }) };
      if (url.includes('/git/trees/')) return { ok: true, json: async () => ({ tree: [{ type: 'blob', path: 'SKILL.md', size: 50 }, { type: 'blob', path: 'templates/cute/template.pptx', size: tpl.length }, { type: 'blob', path: 'big.pptx', size: 40 * 1024 * 1024 }] }) };
      if (url.endsWith('SKILL.md')) return { ok: true, text: async () => '---\nname: ppt-maker\ndescription: 做 PPT\n---\n用模板 templates/cute/template.pptx' };
      return { ok: true, arrayBuffer: async () => tpl.buffer.slice(0) };
    };
    const p = await packs.installFromGitHub('github.com/o/r', { fetchImpl });
    expect(packs.isBinaryFile(p.files['templates/cute/template.pptx'])).toBe(true);
    expect(p.files['templates/cute/template.pptx'].size).toBe(7);
    expect(p.skipped).toEqual(['big.pptx（40.0 MB，太大）']);
    expect(packs.render(p)).toMatch(/template\.pptx（二进制，0 KB）[\s\S]*|copy_skill_file/);
    const tools = Object.fromEntries(createTools({ metrics: async () => ({}) }).map((t) => [t.name, t]));
    expect(await tools.read_skill_file.run({ name: 'ppt-maker', path: 'templates/cute/template.pptx' })).toMatch('copy_skill_file');
    const out = await tools.copy_skill_file.run({ name: 'ppt-maker', path: 'templates/cute/template.pptx' });
    expect(out).toMatch('/workspace/skills/ppt-maker/templates/cute/template.pptx');
    const ws = await import('../src/agent/workspace.js');
    const blob = await ws.readBlob('skills/ppt-maker/templates/cute/template.pptx');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([...tpl]);
  });
});


describe('大技能（几十上百个文件）', () => {
  it('GitHub 上 150 个文件（模板、图片、脚本、不认识的格式）全部装上', async () => {
    const tree = [{ type: 'blob', path: 'SKILL.md', size: 50 }, { type: 'blob', path: '.github/workflows/ci.yml', size: 5 }];
    for (let i = 0; i < 50; i++) tree.push({ type: 'blob', path: `templates/t${i}.pptx`, size: 3 }, { type: 'blob', path: `assets/img${i}.png`, size: 3 }, { type: 'blob', path: `scripts/s${i}.jsx`, size: 3 });
    let busy = 0; let peak = 0;
    const fetchImpl = async (url) => {
      if (url.endsWith('/repos/o/big')) return { ok: true, json: async () => ({ default_branch: 'main' }) };
      if (url.includes('/git/trees/')) return { ok: true, json: async () => ({ tree }) };
      busy++; peak = Math.max(peak, busy);
      await new Promise((r) => setTimeout(r, 1));
      busy--;
      if (url.endsWith('SKILL.md')) return { ok: true, text: async () => '---\nname: big-ppt\ndescription: 做 PPT\n---\n用 templates 里的模板' };
      return { ok: true, status: 200, text: async () => 'x', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };
    const p = await packs.installFromGitHub('github.com/o/big', { fetchImpl });
    expect(Object.keys(p.files).length).toBe(150);
    expect(p.skipped).toEqual([]);
    expect(packs.isBinaryFile(p.files['templates/t7.pptx'])).toBe(true);
    expect(p.files['scripts/s3.jsx']).toBe('x');
    expect(peak).toBeGreaterThan(1); // 并发下载
  });
  it('同步只传附件占位，写回时保留本机已有的附件内容', async () => {
    const full = { id: 'k', files: { 'a.md': 'x', 't.pptx': { binary: true, b64: 'QUJD', size: 3 } } };
    const stub = packs.stubForSync(full);
    expect(stub.files['t.pptx']).toEqual({ binary: true, stub: true, size: 3 });
    expect(stub.files['a.md']).toBe('x');
    expect(packs.keepLocalBinaries(stub, full).files['t.pptx'].b64).toBe('QUJD');
    expect(packs.keepLocalBinaries(stub, null).files['t.pptx'].stub).toBe(true);
    await expect(packs.fileBlob(stub.files['t.pptx'])).rejects.toThrow(/重新安装/);
  });
});


describe('大模板库：模板用到时再下载', () => {
  const big = (n) => ({ ok: true, status: 200, text: async () => 'x'.repeat(n), arrayBuffer: async () => new Uint8Array(n).buffer, blob: async () => new Blob(['x'.repeat(n)]) });
  const tree = [
    { type: 'blob', path: 'SKILL.md', size: 60 },
    { type: 'blob', path: 'scripts/build_pptx.py', size: 13000 },
    { type: 'blob', path: 'templates/INDEX.md', size: 7000 },
    { type: 'blob', path: 'templates/mck/intro.md', size: 2700 },
    { type: 'blob', path: 'templates/mck/detail.json', size: 1027947 },
    { type: 'blob', path: 'templates/mck/preview.png', size: 761958 },
    { type: 'blob', path: 'templates/mck/template.pptx', size: 14e6 }
  ];
  let fetched;
  const fetchImpl = async (url) => {
    fetched.push(url);
    if (url.endsWith('/repos/G/ppt')) return { ok: true, json: async () => ({ default_branch: 'main' }) };
    if (url.includes('/git/trees/')) return { ok: true, json: async () => ({ tree }) };
    if (url.endsWith('SKILL.md')) return { ok: true, text: async () => '---\nname: gorden-ppt\ndescription: 做 PPT\n---\n运行 python3 scripts/build_pptx.py' };
    const t = tree.find((x) => url.endsWith(x.path.split('/').map(encodeURIComponent).join('/')));
    return big(t ? Math.min(t.size, 2000) : 1);
  };
  it('安装时只下说明、脚本和小文件；大模板记下地址，一个都不算“没装上”', async () => {
    fetched = [];
    const p = await packs.installFromGitHub('github.com/G/ppt', { fetchImpl });
    expect(p.skipped).toEqual([]);
    expect(typeof p.files['scripts/build_pptx.py']).toBe('string');
    expect(packs.isRemoteFile(p.files['templates/mck/template.pptx'])).toBe(true);
    expect(packs.isRemoteFile(p.files['templates/mck/detail.json'])).toBe(true);
    expect(fetched.some((u) => u.endsWith('template.pptx'))).toBe(false);
    const doc = packs.render(p);
    expect(doc).toMatch(/template\.pptx（在线，13\.4 MB，复制时下载）/);
    expect(doc).toMatch(/runpy\.run_path/);
    expect(doc).toMatch(/直接跳过/);
  });
  it('复制整个模板文件夹：在线附件现下载；大 json 用 read_skill_file 只给开头', async () => {
    fetched = [];
    await packs.installFromGitHub('github.com/G/ppt', { fetchImpl });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const tools = Object.fromEntries(createTools({ metrics: async () => ({}) }).map((t) => [t.name, t]));
      const steps = [];
      const out = await tools.copy_skill_file.run({ name: 'gorden-ppt', path: 'templates/mck' }, { progress: (t) => steps.push(t) });
      expect(out).toMatch('已复制 4 个文件');
      expect(out).toMatch('/workspace/skills/gorden-ppt/templates/mck/template.pptx');
      expect(steps.some((t) => t.includes('template.pptx'))).toBe(true);
      expect(fetched.some((u) => u.endsWith('template.pptx'))).toBe(true);
      expect(await tools.read_skill_file.run({ name: 'gorden-ppt', path: 'templates/mck/detail.json' })).toMatch(/^x+$/);
    } finally { globalThis.fetch = orig; }
  });
  it('run_python 优先带上代码里提到的文件夹', () => {
    const list = [{ path: 'a.txt', size: 10, mtime: 9 }, { path: 'skills/g/t.pptx', size: 100, mtime: 1 }, { path: 'big.bin', size: 2e6, mtime: 5 }];
    expect(pickPythonFiles(list, 'os.chdir("/workspace/skills/g")', { maxFiles: 1 }).map((f) => f.path)).toEqual(['skills/g/t.pptx']);
    expect(pickPythonFiles(list, '', { maxBytes: 1000 }).map((f) => f.path)).toEqual(['a.txt', 'skills/g/t.pptx']);
  });
});

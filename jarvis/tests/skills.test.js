import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import * as packs from '../src/agent/skillPacks.js';
import { BUILTIN_SKILLS, GITHUB_SKILLS } from '../src/agent/skillCatalog.js';
import { createTools } from '../src/agent/tools.js';
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

  it('从 zip 安装：SKILL.md 在子文件夹里，附带文本文件，跳过二进制', async () => {
    const zip = new JSZip();
    zip.file('my-skill/SKILL.md', SKILL);
    zip.file('my-skill/templates/report.md', '# 模板');
    zip.file('my-skill/scripts/count.py', 'print(1)');
    zip.file('my-skill/logo.png', new Uint8Array([137, 80, 78, 71]));
    zip.file('__MACOSX/my-skill/._SKILL.md', 'x');
    const p = await packs.installFromZip(await zip.generateAsync({ type: 'uint8array' }));
    expect(Object.keys(p.files).sort()).toEqual(['scripts/count.py', 'templates/report.md']);
    expect(p.skipped).toContain('my-skill/logo.png');
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
    expect(p.skipped).toEqual(['font.ttf']);
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

  it('仓库里有多个技能时提示选一个', async () => {
    const fetchImpl = async (url) => url.endsWith('/repos/o/r')
      ? { ok: true, json: async () => ({ default_branch: 'main' }) }
      : { ok: true, json: async () => ({ tree: [{ type: 'blob', path: 'a/SKILL.md' }, { type: 'blob', path: 'b/SKILL.md' }] }) };
    await expect(packs.installFromGitHub('github.com/o/r', { fetchImpl })).rejects.toThrow(/2 个技能.*tree\/main\/a/);
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

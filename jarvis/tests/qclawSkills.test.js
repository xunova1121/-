/** 按 QClaw 默认启用技能的用途补上的内置技能（见 docs/skills-from-qclaw.md）、install_skill、内置技能自动升级 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as packs from '../src/agent/skillPacks.js';
import * as ws from '../src/agent/workspace.js';
import { BUILTIN_SKILLS, MORE_BUILTIN_SKILLS, GITHUB_SKILLS } from '../src/agent/skillCatalog.js';
import { createTools } from '../src/agent/tools.js';
import { createDesktopTools } from '../src/agent/desktopTools.js';
import { collection } from '../src/agent/store.js';

const ALL = [...BUILTIN_SKILLS, ...MORE_BUILTIN_SKILLS];
const byName = Object.fromEntries(ALL.map((s) => [packs.parseFrontmatter(s.text).meta.name, s]));
const tools = () => Object.fromEntries(createTools({ metrics: async () => ({}) }).map((t) => [t.name, t]));
// 联网搜索要有搜索通道才会出现：给一个假的网关
const TOOL_NAMES = new Set([...createTools({ metrics: async () => ({}), fetchViaGateway: async () => ({}) }).map((t) => t.name), ...createDesktopTools({}).map((t) => t.name)]);

// 技能名 → 显示名、说明里必须提到的工具（这些工具必须真实存在）
const NEW = {
  'word-document': { title: 'Word 文档', uses: ['create_document', 'write_long_document', 'edit_office_document', 'computer_edit_office_document', 'read_file'] },
  'pdf-tools': { title: 'PDF 处理', uses: ['read_file', 'run_python', 'create_document'] },
  'find-skills': { title: '找技能', uses: ['use_skill', 'web_search', 'fetch_url', 'install_skill'] },
  'skill-creator': { title: '技能创建器', uses: ['write_file', 'read_file', 'install_skill', 'use_skill'] },
  'persona-creator': { title: '另一个 TA（人物视角）', uses: ['web_search', 'fetch_url', 'deep_research', 'install_skill', 'core_memory_update', 'read_file'] },
  'scheduled-tasks': { title: '定时任务', uses: ['schedule_task', 'list_schedules', 'cancel_schedule'] },
  'image-creator': { title: '生成图片', uses: ['generate_image', 'write_file', 'preview', 'create_document'] },
  'web-automation': { title: '网页操作', uses: ['fetch_url', 'web_search', 'computer_open', 'computer_look', 'computer_click', 'computer_screenshot', 'show_image'] },
  'excel-helper': { title: 'Excel 表格', uses: ['read_file', 'run_python', 'create_document'] }
};

beforeEach(async () => {
  for (const p of await packs.list()) await packs.remove(p.name);
  await collection('kv').delete('packs-seeded');
});

describe('新内置技能', () => {
  it('名字、显示名、描述正确，技能名不重复', () => {
    const names = ALL.map((s) => packs.parseFrontmatter(s.text).meta.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [name, { title }] of Object.entries(NEW)) {
      const s = byName[name];
      expect(s, name).toBeTruthy();
      expect(s.title).toBe(title);
      const { meta, body } = packs.parseFrontmatter(s.text);
      expect(meta.name).toMatch(/^[a-z0-9-]+$/);
      expect(meta.description).toMatch(/时使用。$/); // 描述写明什么时候用
      expect(body.length).toBeGreaterThan(300);
    }
  });

  it('说明里提到的工具都真实存在', () => {
    for (const [name, { uses }] of Object.entries(NEW)) {
      const body = packs.parseFrontmatter(byName[name].text).body;
      for (const t of uses) {
        expect(body, `${name} 应提到 ${t}`).toContain(t);
        expect(TOOL_NAMES.has(t), `工具 ${t} 不存在`).toBe(true);
      }
    }
  });

  it('只按用途重写：不含 QClaw 专用的路径和命令', () => {
    for (const name of Object.keys(NEW)) {
      const t = byName[name].text;
      expect(t).not.toMatch(/qclaw|openclaw|prosearch|~\/\.|python3 |init_skill\.py|mcporter/i);
    }
  });

  it('首次启动全部预置；能被“/技能名”点名并用 use_skill 读到说明', async () => {
    const added = await packs.seedBuiltins();
    for (const name of Object.keys(NEW)) expect(added).toContain(name);
    const names = (await packs.enabled()).map((p) => p.name);
    expect(packs.matchSlash('/word-document 写个放假通知', names)).toEqual({ name: 'word-document', rest: '写个放假通知' });
    expect(packs.matchSlash('/PDF-Tools 合并这两个文件', names)).toEqual({ name: 'pdf-tools', rest: '合并这两个文件' });
    const t = tools();
    for (const name of Object.keys(NEW)) {
      const out = await t.use_skill.run({ name });
      expect(out).toContain(`# 技能：${name}`);
      expect(out).toContain(packs.parseFrontmatter(byName[name].text).body.slice(0, 40));
    }
    expect(packs.catalog(await packs.enabled())).toMatch(/- persona-creator：/);
  });

  it('GitHub 推荐里不再重复列技能创建器', () => {
    expect(GITHUB_SKILLS.some((s) => s.name === 'skill-creator')).toBe(false);
  });
});

describe('内置技能自动升级', () => {
  it('还是内置来源的跟着升级，保留停用状态；用户自己装的同名技能不动', async () => {
    await packs.seedBuiltins();
    const old = '---\nname: excel-helper\ndescription: 旧版说明，用户问 Excel 时使用。\n---\n\n# 旧版\n只会写公式';
    await packs.installFromText(old, '内置');
    await packs.setEnabled('excel-helper', false);
    await packs.seedBuiltins();
    const p = await packs.get('excel-helper');
    expect(p.body).toContain('## 新建表格');
    expect(p.enabled).toBe(false);

    await packs.installFromText(old.replace('旧版说明', '我自己的版本'), '本地');
    await packs.seedBuiltins();
    expect((await packs.get('excel-helper')).description).toContain('我自己的版本');
  });

  it('用户卸载过的内置技能不会被装回来', async () => {
    await packs.seedBuiltins();
    await packs.remove('image-creator');
    await packs.seedBuiltins();
    expect(await packs.get('image-creator')).toBeFalsy();
  });
});

describe('install_skill', () => {
  it('从工作区文件夹安装（含附件），需要用户确认，同名覆盖升级', async () => {
    await ws.write('skills-draft/sales-report/SKILL.md', '---\nname: sales-report\ndescription: 写销售周报。用户说写销售周报时使用。\n---\n\n# 销售周报\n读 references/口径.md 再写');
    await ws.write('skills-draft/sales-report/references/口径.md', '销售额按含税口径');
    await ws.write('skills-draft/sales-report/assets/logo.png', new Blob([new Uint8Array([137, 80, 78, 71])]));
    const t = tools();
    expect(t.install_skill.approval({ path: 'skills-draft/sales-report' })).toMatchObject({ key: 'skill-install', title: '安装技能：skills-draft/sales-report' });
    const out = await t.install_skill.run({ path: '/workspace/skills-draft/sales-report/' });
    expect(out).toContain('已安装技能「sales-report」（带 2 个附件）');
    const p = await packs.get('sales-report');
    expect(p).toMatchObject({ source: '工作区', enabled: true });
    expect(p.files['references/口径.md']).toBe('销售额按含税口径');
    expect(packs.isBinaryFile(p.files['assets/logo.png'])).toBe(true);
    expect(packs.matchSlash('/sales-report 本周', [p.name])).toEqual({ name: 'sales-report', rest: '本周' });

    await ws.write('skills-draft/sales-report/SKILL.md', '---\nname: sales-report\ndescription: 新版。用户说写销售周报时使用。\n---\n\n# 销售周报 v2');
    await t.install_skill.run({ path: 'skills-draft/sales-report' });
    expect((await packs.get('sales-report')).body).toBe('# 销售周报 v2');
  });

  it('文件夹里没有 SKILL.md 时报错', async () => {
    await ws.write('skills-draft/empty/readme.md', 'x');
    await expect(tools().install_skill.run({ path: 'skills-draft/empty' })).rejects.toThrow('没有 SKILL.md');
    await expect(tools().install_skill.run({ path: '/workspace/' })).rejects.toThrow('不能是整个工作区');
  });
});

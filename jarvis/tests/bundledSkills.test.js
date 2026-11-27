import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { collection, useBackend } from '../src/agent/store.js';
import * as packs from '../src/agent/skillPacks.js';
import { needsRunner, skillDeps } from '../src/agent/skillDeps.js';
import { BUNDLED_DIR, BUNDLED_SKILLS, seedBundledSkills, withDescription } from '../server/bundledSkills.mjs';
import { producedFiles, readSkillInputs, skillRunnerTool } from '../server/skillRunner.mjs';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-skills-'));
  useBackend(createFileStore(root));
});
afterEach(() => {
  useBackend(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('随服务器带的 Anthropic docx / pptx / xlsx 技能', () => {
  it('原样带着 Apache 2.0 许可和来源说明', () => {
    for (const s of Object.keys(BUNDLED_SKILLS)) {
      expect(fs.readFileSync(path.join(BUNDLED_DIR, s, 'LICENSE.txt'), 'utf8')).toMatch(/Apache License\s+Version 2\.0/);
      expect(fs.readFileSync(path.join(BUNDLED_DIR, s, 'SKILL.md'), 'utf8')).toMatch(new RegExp(`^---\\nname: ${s}\\n`));
    }
    expect(fs.readFileSync(path.join(BUNDLED_DIR, 'NOTICE.md'), 'utf8')).toMatch(/github\.com\/anthropics\/skills[\s\S]*Apache License 2\.0/);
  });

  it('首次启动装成内置技能：说明换成中文“只在改已有文件时用”，正文和附带脚本原样，要用运行器', async () => {
    expect((await seedBundledSkills()).sort()).toEqual(['docx', 'pptx', 'xlsx']);
    for (const name of ['docx', 'pptx', 'xlsx']) {
      const p = await packs.get(name);
      expect(p.source).toBe('内置');
      expect(p.description).toBe(BUNDLED_SKILLS[name]);
      expect(p.description).toMatch(/不要用它，用 create_document/);
      expect(p.description).toMatch(/input_files/);
      const original = packs.parseFrontmatter(fs.readFileSync(path.join(BUNDLED_DIR, name, 'SKILL.md'), 'utf8'));
      expect(p.body).toBe(original.body);
      expect(Object.keys(p.files).length).toBeGreaterThan(40);
      expect(p.files['LICENSE.txt']).toMatch(/Apache License/);
      expect(Object.keys(p.files).some((f) => f.startsWith('scripts/') && f.endsWith('.py'))).toBe(true);
      expect(needsRunner(p)).toBe(true);
      // 说明里写的 npm install docx / pptxgenjs 是 JS 新建文档用的：不自动装
      expect(skillDeps(p)).toMatchObject({ python: [], node: [] });
      expect(p.skipped).toEqual([]);
    }
  });

  it('再启动不重装；用户卸载了不装回来；用户自己装的同名技能不覆盖', async () => {
    await seedBundledSkills();
    const first = (await packs.get('docx')).installationId;
    expect(await seedBundledSkills()).toEqual([]);
    expect((await packs.get('docx')).installationId).toBe(first);
    await packs.remove('pptx');
    expect(await seedBundledSkills()).toEqual([]);
    expect(await packs.get('pptx')).toBeFalsy();
  });

  it('用户先装了同名技能：不覆盖', async () => {
    await packs.installFromFiles({ 'SKILL.md': '---\nname: xlsx\ndescription: 我自己的表格技能\n---\n\n自己的做法' }, { source: 'GitHub' });
    await seedBundledSkills();
    expect((await packs.get('xlsx')).description).toBe('我自己的表格技能');
    expect((await packs.get('docx')).source).toBe('内置');
  });

  it('新版本带了改过的技能文件：跟着升级，启停状态不变', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-copy-'));
    fs.cpSync(path.join(BUNDLED_DIR, 'docx'), path.join(dir, 'docx'), { recursive: true });
    await seedBundledSkills({ dir });
    await packs.setEnabled('docx', false);
    fs.appendFileSync(path.join(dir, 'docx', 'SKILL.md'), '\n新版本补充的一句\n');
    expect(await seedBundledSkills({ dir })).toEqual(['docx']);
    const p = await packs.get('docx');
    expect(p.body).toMatch(/新版本补充的一句/);
    expect(p.enabled).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('换说明只改开头的 description，其他字段和正文不动', () => {
    const out = withDescription('---\nname: demo\ndescription: old\nlicense: Complete terms in LICENSE.txt\n---\n\n# 正文\n说明', '新的说明：#REF!/#DIV/0!');
    const { meta, body } = packs.parseFrontmatter(out);
    expect(meta).toEqual({ name: 'demo', description: '新的说明：#REF!/#DIV/0!', license: 'Complete terms in LICENSE.txt' });
    expect(body).toBe('# 正文\n说明');
  });
});

describe('运行技能命令：把工作区文件带进隔离环境（input_files）', () => {
  const files = { '报告/合同.docx': 'DOCX', '表.xlsx': 'XLSX', '其他/合同.docx': 'DOCX2' };
  const readFile = async (p) => (p in files ? new Blob([files[p]]) : null);

  it('只认工作区里的相对路径；重名加序号；不存在、跳出工作区、太多都拒绝', async () => {
    const got = await readSkillInputs(['/workspace/报告/合同.docx', '表.xlsx', '其他/合同.docx'], readFile);
    expect(got.map((f) => [f.name, f.data.toString()])).toEqual([['合同.docx', 'DOCX'], ['表.xlsx', 'XLSX'], ['合同(2).docx', 'DOCX2']]);
    expect(await readSkillInputs(undefined, readFile)).toEqual([]);
    await expect(readSkillInputs(['../etc/passwd'], readFile)).rejects.toMatchObject({ code: 'SKILL_INPUT_INVALID' });
    await expect(readSkillInputs(['没有.docx'], readFile)).rejects.toMatchObject({ code: 'SKILL_INPUT_MISSING' });
    await expect(readSkillInputs(Array(11).fill('表.xlsx'), readFile)).rejects.toMatchObject({ code: 'SKILL_INPUT_INVALID' });
  });

  it('工具把读出的文件交给运行器；没有读工作区的能力时说清楚', async () => {
    const runner = { run: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, files: [] })) };
    const getPack = async () => ({ name: 'docx', enabled: true, body: 'x', files: {} });
    const tool = skillRunnerTool({ runner, getPack, saveFile: vi.fn(), readFile });
    await tool.run({ skill: 'docx', command: 'python3 scripts/merge_runs.py input/合同.docx -o 合并.docx', input_files: ['报告/合同.docx'] });
    expect(runner.run.mock.calls[0][2].inputs.map((f) => f.name)).toEqual(['合同.docx']);
    expect(tool.input_schema.properties.input_files.type).toBe('array');
    const without = skillRunnerTool({ runner, getPack, saveFile: vi.fn() });
    await expect(without.run({ skill: 'docx', command: 'x', input_files: ['表.xlsx'] })).rejects.toMatchObject({ code: 'SKILL_INPUT_UNSUPPORTED' });
  });

  it('带进来的文件在容器里能改（umask 不能吃掉写权限）', async () => {
    const old = process.umask(0o022);
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-base-'));
    let mode = null;
    const runDocker = vi.fn(async (args) => {
      const m = args.find((a) => String(a).startsWith('type=bind') && String(a).endsWith('dst=/work'));
      if (m && args.includes('timeout') && mode === null) mode = fs.statSync(path.join(m.split(',')[1].slice(4), 'input', '表.xlsx')).mode & 0o777;
      return { stdout: '', stderr: '' };
    });
    try {
      const { createSkillRunner } = await import('../server/skillRunner.mjs');
      const runner = createSkillRunner({ baseDir, runDocker });
      await runner.run({ name: 'xlsx', enabled: true, body: 'x', files: { 'scripts/a.py': 'print(1)' } }, 'python3 scripts/a.py', { inputs: [{ name: '表.xlsx', data: Buffer.from('X') }] });
      expect(mode).toBe(0o666);
    } finally {
      process.umask(old);
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('带进来的文件没改的不算成果；改过的、新做出的算', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-work-'));
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-src-'));
    fs.mkdirSync(path.join(work, 'input'));
    fs.writeFileSync(path.join(work, 'input', '原表.xlsx'), 'ORIGINAL');
    fs.writeFileSync(path.join(work, 'input', '直接改.docx'), 'CHANGED');
    fs.writeFileSync(path.join(work, '新文件.docx'), 'NEW');
    const out = await producedFiles(work, src, new Map([['input/原表.xlsx', Buffer.from('ORIGINAL')], ['input/直接改.docx', Buffer.from('BEFORE')]]));
    expect(out.map((f) => f.path).sort()).toEqual(['input/直接改.docx', '新文件.docx']);
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  });
});

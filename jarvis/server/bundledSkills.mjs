/**
 * 随服务器带的技能（server/bundled-skills/，来源和许可见那里的 NOTICE.md）：服务器启动时作为“内置”技能装上。
 * 现在是 Anthropic 的 docx / pptx / xlsx 三个（Apache 2.0），给未央自己的文档工具做补充：
 * 改用户已有的 Word / PPT / Excel（保留原格式改字、修订痕迹、批注、增删页）、复杂 Excel 公式和重算。
 *
 * - 只在服务器上装：技能脚本要在服务器的技能运行器（Docker）里跑，手机 / 电脑本机装了也用不了
 * - 装的时候把说明（description）换成中文的“什么时候用”：原文写的是“凡是 Word 都用这个”，
 *   照原文模型会拿它新建文档，绕开未央排版更好的 create_document。技能文件本身不改。
 * - 说明里 npm install 的包不自动装（jarvis-auto-install: false）：改已有文件只用 Python 脚本
 * - 用户卸载过的不再装回来；技能文件变了（新版本带了新技能文件）就跟着升级，启停状态不变
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as packs from '../src/agent/skillPacks.js';
import { collection } from '../src/agent/store.js';

export const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundled-skills');
const SOURCE = '内置';

/** 安装时用的中文说明：写清只在什么时候用，新建文档交给 create_document */
export const BUNDLED_SKILLS = {
  docx: '改用户已有的 Word 文件时用：在原文件上改字并保留原格式、加修订痕迹（tracked changes）、加批注、接受修订、按用户给的 Word 模板填写。新建 Word 文档不要用它，用 create_document。脚本用 run_skill_command 运行，把要改的文件填进 input_files。',
  pptx: '改用户已有的 PPT 时用：增删页、复制某页、改某页文字、按用户给的 PPT 模板套内容、读出 PPT 里的文字和备注。新建 PPT 不要用它，用 create_document。脚本用 run_skill_command 运行，把原 PPT 填进 input_files。',
  xlsx: '处理用户已有的 Excel 时用：在原表上加列或改公式并保留格式、复杂公式检查、用 LibreOffice 重算并找出 #REF!/#DIV/0! 等公式错误。新建 Excel 表格不要用它，用 create_document。脚本用 run_skill_command 运行，把原表填进 input_files。'
};

async function readTree(dir) {
  const files = {};
  async function walk(rel) {
    for (const ent of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { if (ent.name !== '__pycache__') await walk(r); continue; }
      if (!ent.isFile()) continue;
      const buf = await fs.readFile(path.join(dir, r));
      files[r] = packs.isText(r) ? buf.toString('utf8') : packs.binaryFile(buf);
    }
  }
  await walk('');
  return files;
}

/** 把 SKILL.md 开头的 description 换成中文说明，可另加开头字段（正文不动） */
export function withDescription(skillMd, description, extra = {}) {
  const { meta, body } = packs.parseFrontmatter(skillMd);
  const head = Object.entries({ ...meta, description, ...extra })
    .map(([k, v]) => `${k}: ${JSON.stringify(String(v))}`)
    .join('\n');
  return `---\n${head}\n---\n\n${body}\n`;
}

const fingerprint = (files) => {
  const h = createHash('sha256');
  for (const k of Object.keys(files).sort()) h.update(k).update('\0').update(typeof files[k] === 'string' ? files[k] : files[k].b64).update('\0');
  return h.digest('hex');
};

/**
 * @param {{ dir?: string, kv?: object }} o
 * @returns {Promise<string[]>} 这次新装或升级的技能名
 */
export async function seedBundledSkills({ dir = BUNDLED_DIR, kv = collection('kv') } = {}) {
  const state = (await kv.get('bundled-skills'))?.skills ?? {}; // 名字 → 装过的指纹（卸载了也留着，不再装回来）
  const changed = [];
  for (const [name, description] of Object.entries(BUNDLED_SKILLS)) {
    const src = path.join(dir, name);
    const files = await readTree(src).catch(() => null);
    if (!files?.['SKILL.md']) continue;
    // 说明里的 npm install docx / pptxgenjs 等是用 JS 新建文档用的，不自动装（第一次用要等很久、断网还会卡住改文件）
    files['SKILL.md'] = withDescription(files['SKILL.md'], description, { 'jarvis-auto-install': 'false' });
    const print = fingerprint(files);
    const old = await packs.get(name);
    if (name in state) {
      // 装过：用户卸载了就不装回来；自己装的同名技能不动；内置的内容变了才升级
      if (!old || old.source !== SOURCE || state[name] === print) continue;
    } else if (old && old.source !== SOURCE) {
      state[name] = print; // 用户自己已经装了同名的：不覆盖
      continue;
    }
    await packs.installFromFiles(files, { source: SOURCE });
    state[name] = print;
    changed.push(name);
  }
  await kv.put({ id: 'bundled-skills', skills: state });
  return changed;
}

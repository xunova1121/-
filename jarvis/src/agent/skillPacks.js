/**
 * 可安装的技能（Agent Skills 格式）：一个文件夹，里面有 SKILL.md（YAML 头写 name / description，正文是做法说明），
 * 可以附带模板、参考资料和脚本。与 anthropics/skills 等开源技能仓库的格式一致。
 *
 * 渐进加载：系统提示里只放每个技能的名称和一句话描述；需要时模型调用 use_skill 读完整说明，
 * 再按需用 read_skill_file 读附带文件。用户也可以输入“/技能名 …”直接点名使用。
 *
 * 与“学会的技能”（memory.saveSkill，模型自己总结的做法）不同，这里是用户安装的、可启用 / 停用 / 卸载的技能包。
 */
import { collection } from './store.js';
import { BUILTIN_SKILLS, MORE_BUILTIN_SKILLS } from './skillCatalog.js';

const packs = collection('packs');
const kv = collection('kv');

const MAX_FILE = 256 * 1024;
const MAX_TOTAL = 3 * 1024 * 1024;
const MAX_FILES = 80;
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|toml|csv|tsv|xml|html?|css|js|mjs|cjs|ts|py|sh|bat|ps1|sql|ini|cfg|conf|tex|rst|svg)$/i;

// ---------------------------------------------------------------- SKILL.md 解析

/** 解析 YAML 头（只支持技能文件里常见的写法：key: value、引号、| 和 > 多行块） */
export function parseFrontmatter(text) {
  const src = String(text).replace(/^﻿/, '');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: src.trim() };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let [, key, value] = kv;
    if (/^[|>][+-]?$/.test(value.trim())) {
      const folded = value.trim().startsWith('>');
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      value = block.join(folded ? ' ' : '\n').trim();
    } else {
      value = value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    }
    meta[key] = value;
  }
  return { meta, body: src.slice(m[0].length).trim() };
}

/** 技能名：小写字母 / 数字 / 连字符（与开源格式一致）；中文名也接受，原样保留 */
export function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, '-').replace(/[\\/:*?"<>|#]/g, '').slice(0, 64);
}

// ---------------------------------------------------------------- 安装

/**
 * 从一组文件安装（文件夹、zip、GitHub 都归结到这里）。
 * @param {Record<string, string>} files 相对路径 → 文本内容（二进制文件不收）
 * @param {{ source?: string, skipped?: string[] }} o
 */
export async function installFromFiles(files, { source = '本地', skipped = [] } = {}) {
  const paths = Object.keys(files);
  // SKILL.md 可能在根目录，也可能在唯一的子文件夹里（zip 常见）；取路径最短的那个
  const skillPath = paths.filter((p) => /(^|\/)SKILL\.md$/i.test(p)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (!skillPath) throw new Error('没有找到 SKILL.md（技能文件夹里必须有这个文件）');
  const base = skillPath.slice(0, skillPath.length - 'SKILL.md'.length);
  const { meta, body } = parseFrontmatter(files[skillPath]);
  const name = normalizeName(meta.name || base.split('/').filter(Boolean).pop());
  if (!name) throw new Error('SKILL.md 缺少 name');
  if (!body) throw new Error('SKILL.md 正文为空');

  const own = {};
  let total = 0;
  for (const p of paths) {
    if (p === skillPath || !p.startsWith(base)) continue;
    const rel = p.slice(base.length);
    const text = files[p];
    if (Object.keys(own).length >= MAX_FILES || total + text.length > MAX_TOTAL) { skipped.push(rel); continue; }
    own[rel] = text;
    total += text.length;
  }
  const old = await packs.get(name);
  const pack = {
    id: name,
    name,
    description: String(meta.description || '').slice(0, 1024),
    body,
    meta,
    files: own,
    skipped,
    source,
    enabled: old ? old.enabled : true,
    installedAt: Date.now(),
    updatedFrom: old ? old.installedAt : null
  };
  await packs.put(pack);
  return pack;
}

/** 单个 SKILL.md 文本 */
export const installFromText = (text, source = '本地') => installFromFiles({ 'SKILL.md': text }, { source });

/** .zip（技能文件夹打包） */
export async function installFromZip(data, source = 'zip') {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);
  const files = {};
  const skipped = [];
  for (const [p, entry] of Object.entries(zip.files)) {
    if (entry.dir || /(^|\/)(__MACOSX|\.git)\//.test(p) || /(^|\/)\.DS_Store$/.test(p)) continue;
    if (!TEXT_EXT.test(p) && !/SKILL\.md$/i.test(p)) { skipped.push(p); continue; }
    const text = await entry.async('string');
    if (text.length > MAX_FILE) { skipped.push(p); continue; }
    files[p] = text;
  }
  return installFromFiles(files, { source, skipped });
}

/**
 * 解析 GitHub 地址：
 *   github.com/o/r                       → 仓库根目录
 *   github.com/o/r/tree/<ref>/<dir>      → 某个技能文件夹
 *   github.com/o/r/blob/<ref>/<dir>/SKILL.md
 *   raw.githubusercontent.com/o/r/<ref>/<dir>/SKILL.md
 */
export function parseGitHubUrl(url) {
  const u = new URL(String(url).trim().replace(/^(?!https?:\/\/)/, 'https://'));
  const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (u.hostname === 'raw.githubusercontent.com') {
    const [owner, repo, ref, ...rest] = seg;
    if (!rest.length) throw new Error('地址不完整');
    const dir = /SKILL\.md$/i.test(rest.at(-1)) ? rest.slice(0, -1) : rest;
    return { owner, repo, ref, dir: dir.join('/') };
  }
  if (!/(^|\.)github\.com$/.test(u.hostname)) throw new Error('目前只支持 GitHub 地址');
  const [owner, repo, kind, ref, ...rest] = seg;
  if (!owner || !repo) throw new Error('地址不完整，应为 github.com/用户/仓库/tree/分支/技能文件夹');
  const dir = kind === 'blob' && /SKILL\.md$/i.test(rest.at(-1) || '') ? rest.slice(0, -1) : rest;
  return { owner, repo: repo.replace(/\.git$/, ''), ref: kind ? ref : null, dir: dir.join('/') };
}

/**
 * 从 GitHub 安装：1 次 API 请求列出文件树，文件从 raw.githubusercontent.com 下载（两者都允许网页直接访问）。
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, onProgress?: (msg: string) => void }} o
 */
export async function installFromGitHub(url, { fetchImpl = globalThis.fetch, onProgress } = {}) {
  const { owner, repo, ref: ref0, dir } = parseGitHubUrl(url);
  const api = (p) => fetchImpl(`https://api.github.com/repos/${owner}/${repo}${p}`, { headers: { accept: 'application/vnd.github+json' } }).then(async (r) => {
    if (r.status === 403 || r.status === 429) throw new Error('GitHub 接口访问太频繁（未登录每小时 60 次），请稍后再试，或下载 zip 后上传安装');
    if (r.status === 404) throw new Error('找不到这个仓库或分支（私有仓库需下载 zip 后上传安装）');
    if (!r.ok) throw new Error(`GitHub 返回 ${r.status}`);
    return r.json();
  });
  const raw = (ref, path) => fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`);
  let ref = ref0;
  let tree;
  try {
    ref ||= (await api('')).default_branch || 'main';
    onProgress?.('正在读取文件列表…');
    tree = await api(`/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  } catch (err) {
    // GitHub 接口用不了（限流、网络策略）：退而只下载 SKILL.md 本身
    if (/找不到/.test(err.message) && ref0) throw err;
    for (const r of ref ? [ref] : ['main', 'master']) {
      const res = await raw(r, `${dir ? `${dir.replace(/\/$/, '')}/` : ''}SKILL.md`).catch(() => null);
      if (res?.ok) {
        onProgress?.('GitHub 接口暂不可用，只安装了 SKILL.md');
        return installFromFiles({ 'SKILL.md': await res.text() }, { source: `github.com/${owner}/${repo}${dir ? `/${dir}` : ''}`, skipped: ['（附带文件未下载：GitHub 接口暂不可用）'] });
      }
    }
    throw err;
  }
  const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
  const blobs = (tree.tree || []).filter((t) => t.type === 'blob' && t.path.startsWith(prefix));
  if (!blobs.some((b) => b.path === `${prefix}SKILL.md`)) {
    // 仓库根目录下有多个技能：提示用户选一个
    const found = (tree.tree || []).filter((t) => /(^|\/)SKILL\.md$/.test(t.path) && t.path.startsWith(prefix)).map((t) => t.path.replace(/\/?SKILL\.md$/, '') || '(根目录)');
    throw new Error(found.length
      ? `这里有 ${found.length} 个技能，请打开其中一个文件夹的地址安装，例如：github.com/${owner}/${repo}/tree/${ref}/${found[0]}`
      : '这个位置没有 SKILL.md');
  }
  const files = {};
  const skipped = [];
  let total = 0;
  const wanted = blobs.filter((b) => {
    const rel = b.path.slice(prefix.length);
    const ok = (TEXT_EXT.test(rel) || rel === 'SKILL.md') && (b.size ?? 0) <= MAX_FILE;
    if (!ok) skipped.push(rel);
    return ok;
  }).slice(0, MAX_FILES + 1);
  let done = 0;
  for (const b of wanted) {
    const rel = b.path.slice(prefix.length);
    if (total > MAX_TOTAL) { skipped.push(rel); continue; }
    const r = await raw(ref, b.path);
    if (!r.ok) { skipped.push(rel); continue; }
    files[rel] = await r.text();
    total += files[rel].length;
    onProgress?.(`正在下载 ${++done}/${wanted.length}`);
  }
  return installFromFiles(files, { source: `github.com/${owner}/${repo}${dir ? `/${dir}` : ''}`, skipped });
}

// ---------------------------------------------------------------- 管理与使用

export async function list() {
  return (await packs.all()).sort((a, b) => a.name.localeCompare(b.name));
}
export const get = (name) => packs.get(normalizeName(name));
export async function setEnabled(name, enabled) {
  const p = await get(name);
  if (p) await packs.put({ ...p, enabled });
}
export const remove = (name) => packs.delete(normalizeName(name));
export async function enabled() {
  return (await list()).filter((p) => p.enabled);
}

/** 系统提示里的技能目录（只列名字和描述） */
export function catalog(list) {
  if (!list.length) return '';
  return `## 已安装的技能\n需要时先调用 use_skill 读取完整说明再照做；用户用“/技能名”点名时必须使用。\n${list.map((p) => `- ${p.name}：${p.description || '（无描述）'}`).join('\n')}`;
}

/** use_skill 的返回内容 */
export function render(pack) {
  const files = Object.keys(pack.files);
  return [
    `# 技能：${pack.name}`,
    pack.body,
    files.length ? `\n---\n附带文件（用 read_skill_file 读取；脚本可写入工作区后用 run_python / run_javascript 运行）：\n${files.map((f) => `- ${f}`).join('\n')}` : ''
  ].join('\n');
}

/** 输入框里的“/技能名 其余内容” */
export function matchSlash(text, names) {
  const m = String(text).match(/^\/([^\s/]+)\s*([\s\S]*)$/);
  if (!m) return null;
  const name = names.find((n) => n.toLowerCase() === m[1].toLowerCase());
  return name ? { name, rest: m[2].trim() } : null;
}

/**
 * 预置常用技能：首次启动时自动安装全部内置技能；以后新增的内置技能也会自动装上。
 * 用户卸载过的不会再被装回来（记录在 kv 里）。
 * @returns {Promise<string[]>} 这次新装的技能名
 */
export async function seedBuiltins() {
  const seen = new Set((await kv.get('packs-seeded'))?.names ?? []);
  const added = [];
  for (const s of [...BUILTIN_SKILLS, ...MORE_BUILTIN_SKILLS]) {
    const name = parseFrontmatter(s.text).meta.name;
    if (seen.has(name)) continue;
    seen.add(name);
    if (!(await packs.get(name))) {
      await installFromText(s.text, '内置');
      added.push(name);
    }
  }
  await kv.put({ id: 'packs-seeded', names: [...seen] });
  return added;
}

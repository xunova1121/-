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
const MAX_MULTI = 30; // 一个仓库里一次最多装几个技能

/** 技能有变化（安装、卸载、启停、同步）：通知界面刷新列表 */
export function changed() {
  try { globalThis.dispatchEvent?.(new Event('jarvis:skills-changed')); } catch { /* 非浏览器环境 */ }
}
const kv = collection('kv');

// 一个技能最多装多少：PPT / 设计类技能常带几十上百个模板、图片、字体、脚本
const MAX_FILE = 2 * 1024 * 1024; // 单个文本文件
const MAX_TOTAL = 20 * 1024 * 1024; // 文本合计
const MAX_FILES = 600;
const TEXT_EXT = /\.(md|markdown|txt|json|jsonc|ya?ml|toml|csv|tsv|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|py|ipynb|r|rb|go|java|kt|swift|c|h|cpp|hpp|cs|lua|php|pl|sh|bash|zsh|bat|cmd|ps1|sql|ini|cfg|conf|env|properties|tex|bib|rst|svg|log|gitignore|editorconfig)$/i;
// 其余文件（模板 .pptx、图片、字体、音视频等）都当二进制附件：存成 Base64，用 copy_skill_file 放进工作区再用
const MAX_BIN = 30 * 1024 * 1024;
const MAX_BIN_TOTAL = 100 * 1024 * 1024;
// 仓库里和技能无关的东西
const IGNORE = /(^|\/)(\.git|\.github|node_modules|__pycache__|\.venv|venv|\.idea|\.vscode|__MACOSX|\.pytest_cache|dist-info)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db)$|\.(pyc|pyo|exe|dll|so|dylib|msi|dmg|apk)$/i;
const isText = (p) => TEXT_EXT.test(p) || /(^|\/)(SKILL\.md|LICENSE|README|Makefile|Dockerfile|requirements\.txt)$/i.test(p);
const mb = (n) => `${(n / 1048576).toFixed(n < 1048576 ? 2 : 1)} MB`;

/** 技能附件是不是二进制（{ binary, b64, size }） */
export const isBinaryFile = (f) => Boolean(f && typeof f === 'object' && f.binary);
const sizeOf = (f) => (isBinaryFile(f) ? f.size : String(f ?? '').length);
const b64 = (buf) => { const u8 = new Uint8Array(buf); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
/** ArrayBuffer → 技能里保存的二进制附件 */
export const binaryFile = (buf) => ({ binary: true, b64: b64(buf), size: buf.byteLength });
/** 技能附件 → Blob（写进工作区用） */
export const fileBlob = (f) => {
  if (f?.stub) throw new Error('这个附件没有同步到本设备（同步时不传大附件）：请在“技能”里重新安装这个技能，或在原设备上使用');
  return isBinaryFile(f) ? new Blob([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))]) : new Blob([String(f)]);
};

/** 同步用：二进制附件只传“占位”（名字和大小），不传内容（PPT 模板等动辄几十 MB） */
export const stubForSync = (pack) => ({
  ...pack,
  files: Object.fromEntries(Object.entries(pack.files || {}).map(([k, f]) => [k, isBinaryFile(f) ? { binary: true, stub: true, size: f.size } : f]))
});
/** 同步写回：远端传来的占位，本机有同名附件就保留本机的内容 */
export const keepLocalBinaries = (incoming, local) => ({
  ...incoming,
  files: Object.fromEntries(Object.entries(incoming.files || {}).map(([k, f]) => [k, f?.stub && isBinaryFile(local?.files?.[k]) && !local.files[k].stub ? local.files[k] : f]))
});

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
 * @param {Record<string, string | { binary: true, b64: string, size: number }>} files 相对路径 → 文本内容或二进制附件
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
  let binTotal = 0;
  for (const p of paths) {
    if (p === skillPath || !p.startsWith(base)) continue;
    const rel = p.slice(base.length);
    const f = files[p];
    const n = sizeOf(f);
    const bin = isBinaryFile(f);
    if (Object.keys(own).length >= MAX_FILES) { skipped.push(`${rel}（超过 ${MAX_FILES} 个文件）`); continue; }
    if (bin ? binTotal + n > MAX_BIN_TOTAL : total + n > MAX_TOTAL) { skipped.push(`${rel}（技能总大小超过 ${mb(bin ? MAX_BIN_TOTAL : MAX_TOTAL)}）`); continue; }
    own[rel] = f;
    if (bin) binTotal += n; else total += n;
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
  changed();
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
    if (entry.dir || IGNORE.test(p)) continue;
    if (isText(p)) {
      const text = await entry.async('string');
      if (text.length > MAX_FILE) { skipped.push(`${p}（${mb(text.length)}，太大）`); continue; }
      files[p] = text;
      continue;
    }
    const buf = await entry.async('arraybuffer');
    if (buf.byteLength > MAX_BIN) { skipped.push(`${p}（${mb(buf.byteLength)}，太大）`); continue; }
    files[p] = binaryFile(buf);
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
  const [owner, repo, kind, ...after] = seg;
  if (!owner || !repo) throw new Error('地址不完整，应为 github.com/用户/仓库/tree/分支/技能文件夹');
  const parts = kind === 'blob' && /SKILL\.md$/i.test(after.at(-1) || '') ? after.slice(0, -1) : after;
  // 分支名本身可以带斜杠（feature/x），光看地址分不清分支到哪里结束：列出所有可能的切分，安装时按仓库里真实的分支 / 标签确定
  const candidates = kind ? parts.map((_, i) => ({ ref: parts.slice(0, i + 1).join('/'), dir: parts.slice(i + 1).join('/') })) : [];
  return { owner, repo: repo.replace(/\.git$/, ''), ref: candidates[0]?.ref ?? null, dir: candidates[0]?.dir ?? '', candidates };
}

/** 在仓库的分支 / 标签名里找出地址对应的那个（取最长的匹配，如 feature/x 优先于 feature） */
export function pickRef(candidates, names) {
  const set = new Set(names);
  return [...candidates].sort((a, b) => b.ref.length - a.ref.length).find((c) => set.has(c.ref)) ?? null;
}

/**
 * 从 GitHub 安装：1 次 API 请求列出文件树，文件从 raw.githubusercontent.com 下载（两者都允许网页直接访问）。
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, onProgress?: (msg: string) => void }} o
 */
export async function installFromGitHub(url, { fetchImpl = globalThis.fetch, onProgress } = {}) {
  const parsed = parseGitHubUrl(url);
  const { owner, repo, candidates = [] } = parsed;
  let { ref: ref0, dir } = parsed;
  const api = (p) => fetchImpl(`https://api.github.com/repos/${owner}/${repo}${p}`, { headers: { accept: 'application/vnd.github+json' } }).then(async (r) => {
    if (r.status === 403 || r.status === 429) throw new Error('GitHub 接口访问太频繁（未登录每小时 60 次），请稍后再试，或下载 zip 后上传安装');
    if (r.status === 404) throw new Error('找不到这个仓库或分支（私有仓库需下载 zip 后上传安装）');
    if (!r.ok) throw new Error(`GitHub 返回 ${r.status}`);
    return r.json();
  });
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const raw = (ref, path) => fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${enc(ref)}/${enc(path)}`);
  let ref = ref0;
  let tree;
  try {
    ref ||= (await api('')).default_branch || 'main';
    onProgress?.('正在读取文件列表…');
    try {
      tree = await api(`/git/trees/${encodeURIComponent(ref)}?recursive=1`); // 带斜杠的分支名要整体编码
    } catch (e) {
      // 第一段不是分支：分支名本身带斜杠（如 feature/x）。git 里不可能同时有 feature 和 feature/x 两个分支，
      // 所以先按第一段试，找不到再问仓库有哪些分支 / 标签，取最长的匹配
      if (!(/找不到/.test(e.message) && candidates.length > 1)) throw e;
      const hit = pickRef(candidates, (await api('/branches?per_page=100')).map((x) => x.name))
        ?? pickRef(candidates, (await api('/tags?per_page=100')).map((x) => x.name));
      if (!hit) throw e;
      ({ ref, dir } = hit);
      tree = await api(`/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    }
  } catch (err) {
    // GitHub 接口用不了（限流、网络策略）：退而只下载 SKILL.md 本身
    if (/找不到/.test(err.message) && ref0) throw err;
    // raw 地址是“分支/路径”拼在一起的，分支名带斜杠时各种切分得到的是同一个地址（由 GitHub 自己解析），试一次即可
    const tries = candidates.length ? [candidates[0]] : (ref ? [{ ref, dir }] : [{ ref: 'main', dir }, { ref: 'master', dir }]);
    for (const t of tries) {
      const res = await raw(t.ref, `${t.dir ? `${t.dir.replace(/\/$/, '')}/` : ''}SKILL.md`).catch(() => null);
      if (res?.ok) {
        onProgress?.('GitHub 接口暂不可用，只安装了 SKILL.md');
        // 分支名可能带斜杠，分不清文件夹从哪里开始：来源记原始地址
        const source = candidates.length > 1 ? String(url).trim().replace(/^https?:\/\//, '') : `github.com/${owner}/${repo}${t.dir ? `/${t.dir}` : ''}`;
        return installFromFiles({ 'SKILL.md': await res.text() }, { source, skipped: ['（附带文件未下载：GitHub 接口暂不可用）'] });
      }
    }
    throw err;
  }
  const all = tree.tree || [];
  const root = dir ? `${dir.replace(/\/$/, '')}/` : '';
  // 指定位置没有 SKILL.md 时，在它下面找技能文件夹（很多仓库把技能放在 skills/xxx/ 里）：
  // 只有一个就直接装；有多个就全部装上（最多 MAX_MULTI 个）
  let dirs = [root];
  if (!all.some((b) => b.type === 'blob' && b.path === `${root}SKILL.md`)) {
    dirs = all.filter((t) => t.type === 'blob' && t.path.startsWith(root) && /(^|\/)SKILL\.md$/.test(t.path))
      .map((t) => t.path.slice(0, -'SKILL.md'.length))
      .filter((d, _, arr) => !arr.some((o) => o !== d && d.startsWith(o))) // 技能里嵌套的示例 SKILL.md 不算
      .sort();
    if (!dirs.length) throw new Error('这个位置没有 SKILL.md（不是技能仓库，或技能放在别的分支）');
    if (dirs.length > MAX_MULTI) throw new Error(`这里有 ${dirs.length} 个技能，太多了：请打开其中一个文件夹的地址安装，例如：github.com/${owner}/${repo}/tree/${ref}/${dirs[0].replace(/\/$/, '')}`);
    onProgress?.(dirs.length === 1 ? `找到技能：${dirs[0].replace(/\/$/, '')}` : `找到 ${dirs.length} 个技能，全部安装`);
  }
  const installedPacks = [];
  for (const [i, prefix] of dirs.entries()) {
    const blobs = all.filter((t) => t.type === 'blob' && t.path.startsWith(prefix) && !IGNORE.test(t.path.slice(prefix.length)));
    const files = {};
    const skipped = [];
    const wanted = blobs.filter((b) => {
      const rel = b.path.slice(prefix.length);
      const size = b.size ?? 0;
      if (size > (isText(rel) ? MAX_FILE : MAX_BIN)) { skipped.push(`${rel}（${mb(size)}，太大）`); return false; }
      return true;
    });
    for (const b of wanted.slice(MAX_FILES + 1)) skipped.push(`${b.path.slice(prefix.length)}（超过 ${MAX_FILES} 个文件）`);
    // 同时下载 6 个（raw.githubusercontent.com 没有接口次数限制）
    let done = 0;
    const queue = wanted.slice(0, MAX_FILES + 1);
    const worker = async () => {
      for (let b = queue.shift(); b; b = queue.shift()) {
        const rel = b.path.slice(prefix.length);
        let r = null;
        for (let tryNo = 0; tryNo < 2 && !r?.ok; tryNo++) r = await raw(ref, b.path).catch(() => null);
        if (!r?.ok) { skipped.push(`${rel}（下载失败${r ? `：HTTP ${r.status}` : ''}）`); continue; }
        files[rel] = isText(rel) ? await r.text() : binaryFile(await r.arrayBuffer());
        onProgress?.(`${dirs.length > 1 ? `第 ${i + 1}/${dirs.length} 个技能：` : ''}正在下载 ${++done}/${wanted.length}`);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    const sub = prefix.replace(/\/$/, '');
    installedPacks.push(await installFromFiles(files, { source: `github.com/${owner}/${repo}${sub ? `/${sub}` : ''}`, skipped }));
  }
  const [first, ...rest] = installedPacks;
  return rest.length ? { ...first, also: rest } : first;
}

// ---------------------------------------------------------------- 管理与使用

export async function list() {
  return (await packs.all()).sort((a, b) => a.name.localeCompare(b.name));
}
export const get = (name) => packs.get(normalizeName(name));
export async function setEnabled(name, enabled) {
  const p = await get(name);
  if (p) await packs.put({ ...p, enabled });
  changed();
}
export const remove = async (name) => { await packs.delete(normalizeName(name)); changed(); };
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
    pack.skipped?.length ? `\n（注意：安装时有 ${pack.skipped.length} 个文件没装上：${pack.skipped.slice(0, 10).join('、')}。如果做法依赖它们，告诉用户需要用 zip 上传完整技能）` : '',
    files.length ? `\n---\n附带文件（文本用 read_skill_file 读取；模板等二进制文件用 copy_skill_file 复制到工作区，再用 run_python 处理，如 python-pptx 打开 .pptx 模板；脚本可写入工作区后用 run_python / run_javascript 运行）：\n${files.map((f) => `- ${f}${isBinaryFile(pack.files[f]) ? `（二进制，${Math.round(pack.files[f].size / 1024)} KB${pack.files[f].stub ? '，本设备上没有，需要重新安装技能' : ''}）` : ''}`).join('\n')}` : ''
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

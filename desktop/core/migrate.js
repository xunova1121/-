/**
 * 搬家 —— 把一台机器上的全部家当打成一个包，在另一台机器上原样展开。
 *
 * ── 为什么这件事必须提前做好 ──
 *
 * 换服务器不是"哪天可能会发生"，是**一定会发生**：盘太慢了要换、机房换地方、
 * 试用期到了、想换个更近的区。而到了那一天，如果没有这个东西，
 * 唯一的办法是拿 scp 拷一堆目录 —— 拷漏一个就是"项目还在但密钥没了"、
 * "片子还在但设定集空了"这种查半天的怪事。
 *
 * ── 密钥是这件事里唯一真正难的部分 ──
 *
 * 项目文件、设置、成片，拷过去就能用。密钥不行：它加密存着，而解密用的钥匙
 * 要么是这台机器上的一个文件（.vaultkey），要么是环境变量里的口令。
 * 直接把密文拷过去，新机器打不开；把钥匙文件一起拷过去，等于**钥匙和密文
 * 躺在同一个包里** —— 那个包一旦经手别人（网盘、微信、U 盘），密钥就等于明送。
 *
 * 所以这里的做法是：导出时**当场解密、再用你输入的口令重新加密**。
 * 那个口令只在你脑子里，不在包里。导入时要同一个口令。
 * 代价是你得记一次口令；换来的是这个包可以放心地过任何渠道。
 *
 * 不想带密钥也行（`secrets: false`）—— 到新机器上重配一遍，最省心的选择。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PROJECTS_DIR, STYLE_DIR, SETTINGS_FILE, ensureDirs } from './paths.js';
import * as vault from './vault.js';

export const PACKAGE_VERSION = 1;

/** 包里那份密钥用的加密参数。和保险箱本身分开写：它们的威胁模型不一样 */
const KDF = { N: 16384, r: 8, p: 1, keylen: 32 };

/**
 * 哪些**不搬**。
 *
 * 这份名单比"搬什么"更值得写清楚，因为搬错了比漏搬更难查：
 *   .vaultkey       机器专属的钥匙。搬过去等于钥匙和密文同行
 *   credentials.enc 密文本身。密钥走上面那条重新加密的路
 *   accessToken     那串访问口令是**这台服务器**的，新机器该有自己的
 *   cache / logs    中间产物和日志，搬过去只是白占体积
 *   bin             下载下来的 ffmpeg，和平台绑死，新机器要自己那份
 */
const SETTINGS_DROP = ['accessToken', 'lanToken', 'oss'];

function walk(dir, base = dir, out = []) {
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walk(full, base, out);
    else if (it.isFile()) out.push({ file: full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

/** 媒体文件：搬家时可以选择不带（几百 MB 到几 GB，而重出一次就有了） */
const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mp3', '.wav', '.m4a']);
const isMedia = (rel) => MEDIA_EXT.has(path.extname(rel).toLowerCase());

/**
 * 清点要搬的东西。**先看清楚再动手** —— 一个几 GB 的包传到一半断了，
 * 比一开始就知道"这要传 4.2GB，要不要先去掉媒体"糟糕得多。
 */
export function survey({ media = true } = {}) {
  const projects = walk(PROJECTS_DIR).filter((f) => media || !isMedia(f.rel));
  const styles = walk(STYLE_DIR);
  const bytes = [...projects, ...styles].reduce((n, f) => {
    try {
      return n + fs.statSync(f.file).size;
    } catch {
      return n;
    }
  }, 0);
  const mediaBytes = walk(PROJECTS_DIR)
    .filter((f) => isMedia(f.rel))
    .reduce((n, f) => {
      try {
        return n + fs.statSync(f.file).size;
      } catch {
        return n;
      }
    }, 0);
  let projectCount = 0;
  try {
    projectCount = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    /* 还没有项目 */
  }
  return {
    projects: projectCount,
    files: projects.length + styles.length,
    bytes,
    mediaBytes,
    secrets: vault.listMasked().length
  };
}

/** 用口令派生一把钥匙。盐随包走 —— 它不是秘密，只是让同一个口令每次派生出不同的钥匙 */
function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, KDF.keylen, KDF);
}

function sealSecrets(passphrase) {
  const plain = {};
  for (const item of vault.listMasked()) {
    const v = vault.getSecret(item.name);
    if (v) plain[item.name] = v;
  }
  if (!Object.keys(plain).length) return null;

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return {
    algo: 'aes-256-gcm+scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64'),
    count: Object.keys(plain).length
  };
}

function openSecrets(sealed, passphrase) {
  const salt = Buffer.from(sealed.salt, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  // 口令不对时 GCM 校验会失败并抛 —— 这正是我们要的：**宁可打不开，也不给一半错的密钥**
  const out = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

/**
 * 打包。
 *
 * 用 zip 而不是 tar：Windows 上双击就能看里面有什么。搬家包最怕的是
 * "传过去了，但不知道对不对" —— 能打开看一眼，心里就有底。
 */
export async function exportTo(outPath, { passphrase = '', media = true, onEvent } = {}) {
  const zip = await import('./zip.js');
  const entries = [];

  const settingsRaw = (() => {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
      return {};
    }
  })();
  // 这几项是**这台机器**的，跟着搬过去只会让新机器认错自己
  for (const k of SETTINGS_DROP) delete settingsRaw[k];

  const manifest = {
    version: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    withMedia: media,
    settings: settingsRaw,
    secrets: passphrase ? sealSecrets(passphrase) : null
  };

  const tmpManifest = path.join(DATA_DIR, '.migrate-manifest.json');
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2), 'utf8');
  entries.push({ file: tmpManifest, name: 'futuredream.json' });

  for (const f of walk(PROJECTS_DIR)) {
    if (!media && isMedia(f.rel)) continue;
    entries.push({ file: f.file, name: `projects/${f.rel}` });
  }
  for (const f of walk(STYLE_DIR)) entries.push({ file: f.file, name: `style-previews/${f.rel}` });

  onEvent?.({ type: 'note', message: `打包 ${entries.length} 个文件…` });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.createWriteStream(outPath);
  await zip.writeZip(entries, out);
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    out.end();
  });
  fs.unlinkSync(tmpManifest);

  const size = fs.statSync(outPath).size;
  onEvent?.({ type: 'note', message: `打好了：${(size / 1048576).toFixed(1)} MB` });
  return { path: outPath, bytes: size, files: entries.length, secrets: manifest.secrets?.count || 0 };
}

/**
 * 展开。
 *
 * ⚠ **不覆盖同名项目**，重名的一律另起一个 id。
 *
 * 覆盖式导入看着更"干净"，但它有一个不可接受的失败模式：新机器上已经干了几天活，
 * 你为了找回一个旧项目导入一次备份，结果这几天的东西被无声地盖掉了。
 * 多出几个重名项目是可以手动删的，被覆盖掉的东西找不回来。
 */
export async function importFrom(zipPath, { passphrase = '', onEvent } = {}) {
  const { readZip } = await import('./zip.js');
  ensureDirs();
  const files = await readZip(zipPath);

  const manifestEntry = files.find((f) => f.name === 'futuredream.json');
  if (!manifestEntry) throw new Error('这不像是搬家包：里面没有 futuredream.json');
  const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  if (manifest.version > PACKAGE_VERSION) {
    throw new Error(`这个包是更新版本（v${manifest.version}）做的，当前只认到 v${PACKAGE_VERSION}。先把这台机器升级。`);
  }

  // 密钥先解 —— 口令不对的话，趁什么都还没写就停下
  let secrets = null;
  if (manifest.secrets) {
    if (!passphrase) throw new Error('这个包里带着密钥，要口令才能打开');
    try {
      secrets = openSecrets(manifest.secrets, passphrase);
    } catch {
      throw new Error('口令不对，密钥打不开（包里其它东西也没动）');
    }
  }

  const existing = new Set(
    (() => {
      try {
        return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        return [];
      }
    })()
  );

  const renamed = [];
  const idMap = new Map();
  let written = 0;

  for (const f of files) {
    if (f.name === 'futuredream.json') continue;

    if (f.name.startsWith('projects/')) {
      const rel = f.name.slice('projects/'.length);
      const [id, ...rest] = rel.split('/');
      if (!rest.length) continue;
      if (!idMap.has(id)) {
        // 重名就换一个 id —— 盖掉别人几天的活是不可接受的
        const finalId = existing.has(id) ? `${id}-imported-${Date.now().toString(36)}` : id;
        if (finalId !== id) renamed.push({ from: id, to: finalId });
        idMap.set(id, finalId);
      }
      const dest = path.join(PROJECTS_DIR, idMap.get(id), ...rest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.data);
      written += 1;
      continue;
    }

    if (f.name.startsWith('style-previews/')) {
      const dest = path.join(STYLE_DIR, f.name.slice('style-previews/'.length));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.data);
      written += 1;
    }
  }

  /**
   * 改了 id 的项目，**它自己的 project.json 里那个 id 也要跟着改**，
   * 否则读出来的项目和它所在的目录对不上号 —— 表现是"能看到、点进去是空的"。
   */
  for (const { to } of renamed) {
    const file = path.join(PROJECTS_DIR, to, 'project.json');
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      p.id = to;
      p.title = `${p.title}（导入）`;
      fs.writeFileSync(file, JSON.stringify(p, null, 2), 'utf8');
    } catch {
      /* 这个项目没有 project.json，跳过 */
    }
  }

  // 设置：合并进来，但**不碰**这台机器自己的那几项
  if (manifest.settings) {
    const settingsMod = await import('./settings.js');
    const incoming = { ...manifest.settings };
    for (const k of SETTINGS_DROP) delete incoming[k];
    settingsMod.patch(incoming);
  }

  if (secrets) vault.setMany(secrets);

  onEvent?.({ type: 'note', message: `展开了 ${written} 个文件` });
  return {
    files: written,
    projects: idMap.size,
    renamed,
    secrets: secrets ? Object.keys(secrets).length : 0,
    withMedia: manifest.withMedia !== false
  };
}

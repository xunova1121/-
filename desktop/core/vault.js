/**
 * 凭据保险箱。
 *
 * 这个仓库上一版的教训是把 apiKey 明文写死在 HTML 里，谁拿到文件谁就能刷你的账单。
 * 桌面版从一开始就把密钥收在这里：
 *
 *   - 跑在 Electron 里时，用 Windows DPAPI（safeStorage）加密，密钥绑当前用户账户，
 *     文件被拷到别的机器 / 别的用户下解不开；
 *   - 裸 Node 跑时降级成 AES-256-GCM，密钥来自本机随机生成的 key 文件（0600）。
 *     这挡得住"文件被顺手拷走"，挡不住已经拿到你登录态的攻击者 —— 属实,不吹。
 *
 * 无论哪种模式，密钥都不会随接口返回给前端，只回 masked 预览。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VAULT_FILE, DATA_DIR } from './paths.js';

const KEY_FILE = path.join(DATA_DIR, '.vaultkey');

/** Electron 主进程会把 safeStorage 注入进来；纯 Node 下保持 null */
let safeStorage = null;
export function attachSafeStorage(impl) {
  if (impl && typeof impl.isEncryptionAvailable === 'function' && impl.isEncryptionAvailable()) {
    safeStorage = impl;
  }
}

export function backendName() {
  if (safeStorage) return 'dpapi';
  return (process.env.FUTUREDREAM_VAULT_PASS || '').trim() ? 'aes-256-gcm+口令派生' : 'aes-256-gcm';
}

/**
 * 加密用的钥匙。两种来源，差别很大：
 *
 *   钥匙文件（默认）  随机 32 字节存在 DATA_DIR/.vaultkey，权限 0600。
 *                     挡得住"文件被顺手拷走"，挡不住能读这台机器文件的人 ——
 *                     因为钥匙就在密文旁边。
 *   口令派生          给了 FUTUREDREAM_VAULT_PASS 就用 scrypt 从它派生，
 *                     **钥匙不落盘**。放到服务器上时该用这个：
 *                     能 ssh 进去的人拿到的只有密文，没有钥匙。
 *
 * 盐固定成应用名而不是随机存一份：随机盐要存在磁盘上，而这里的全部意义
 * 就是"磁盘上不留任何能解密的东西"。固定盐让同一个口令在任何机器上派生出
 * 同一把钥匙 —— 这正是我们要的（换台机器、拿着密文和口令就能恢复），
 * 代价是挡不住针对这个应用的彩虹表，所以口令本身必须够长。
 */
function localKey() {
  const pass = (process.env.FUTUREDREAM_VAULT_PASS || '').trim();
  if (pass) {
    if (!derivedKey) {
      derivedKey = crypto.scryptSync(pass, 'futuredream.vault.v1', 32);
    }
    return derivedKey;
  }
  try {
    const raw = fs.readFileSync(KEY_FILE);
    if (raw.length === 32) return raw;
  } catch {
    /* 首次运行，往下生成 */
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}

/** scrypt 很慢（那是它的目的），派生一次就够 */
let derivedKey = null;

function encrypt(plain) {
  if (safeStorage) {
    return Buffer.concat([Buffer.from('DPAPI1'), safeStorage.encryptString(plain)]);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', localKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('AESG01'), iv, cipher.getAuthTag(), body]);
}

function decrypt(buf) {
  const tag = buf.subarray(0, 6).toString('latin1');
  if (tag === 'DPAPI1') {
    if (!safeStorage) {
      const err = new Error('凭据由 Windows DPAPI 加密，请在桌面应用里打开（当前是命令行模式）');
      err.code = 'VAULT_BACKEND_MISMATCH';
      throw err;
    }
    return safeStorage.decryptString(buf.subarray(6));
  }
  if (tag !== 'AESG01') throw new Error('凭据文件格式无法识别');
  const iv = buf.subarray(6, 18);
  const authTag = buf.subarray(18, 34);
  const decipher = crypto.createDecipheriv('aes-256-gcm', localKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(buf.subarray(34)), decipher.final()]).toString('utf8');
}

let cache = null;
/** 文件在，但这个模式下解不开时的原因；空字符串表示一切正常 */
let lockedReason = '';

/**
 * 读保险箱。**这个函数不允许抛异常。**
 *
 * 早期版本在"文件是 DPAPI 加密的、但当前是命令行模式"时直接往外抛，
 * 而 /api/catalog 会走到这里 —— 于是整个界面起不来，只剩一句
 * "连不上本地服务"。服务其实好好的，坏的只是一份读不出来的密钥文件，
 * 而用户连进去重填密钥的机会都没有。
 *
 * 现在读不出来就当"没有密钥"，把原因记下来交给界面去说清楚。
 * 能进得去、能重填，才叫可恢复。
 */
function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(decrypt(fs.readFileSync(VAULT_FILE)));
    lockedReason = '';
  } catch (err) {
    lockedReason = err.code === 'VAULT_BACKEND_MISMATCH' ? err.message : '';
    cache = {};
  }
  return cache;
}

/** 丢掉内存里的缓存，下次访问重新读盘。自检要用，也方便手改文件后不重启生效。 */
export function reload() {
  cache = null;
  lockedReason = '';
  return load();
}

/** 给界面看的保险箱状态：用的哪种加密、有没有读不出来的旧文件 */
export function status() {
  load();
  return {
    backend: backendName(),
    locked: Boolean(lockedReason),
    reason: lockedReason,
    // 重填一次就好了，而且新写的这份两种模式都读得出来 —— 这句话得说出去
    fix: lockedReason
      ? '两条路：① 用安装版/免安装版 exe 打开（那边有 DPAPI，能解开这份旧的）；' +
        '② 就在这里把密钥重新填一遍 —— 重填后会改用本机 AES-256-GCM 存，' +
        '这种格式桌面版也读得出来，以后两边都能用。旧文件会自动备份成 credentials.enc.dpapi-backup，不会被直接覆盖掉。'
      : ''
  };
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 旧文件是另一种后端加密的、这次读不出来：覆盖前先留一份。
  // 不然用户在命令行模式下重填一次密钥，桌面版那份就永久没了。
  if (lockedReason) {
    try {
      fs.copyFileSync(VAULT_FILE, `${VAULT_FILE}.dpapi-backup`);
    } catch {
      /* 备份失败不该拦住用户重填密钥，尽力而为 */
    }
  }

  const tmp = `${VAULT_FILE}.tmp`;
  fs.writeFileSync(tmp, encrypt(JSON.stringify(cache ?? {})), { mode: 0o600 });
  fs.renameSync(tmp, VAULT_FILE); // 原子替换，断电不会留半个文件
  // 刚写的这份当前模式一定读得出来，锁解除
  lockedReason = '';
}

/** 取明文密钥 —— 只允许后端适配器调用，绝不出现在 HTTP 响应里 */
export function getSecret(name) {
  const v = load()[name];
  return typeof v === 'string' && v ? v : '';
}

export function setSecret(name, value) {
  load();
  if (value === null || value === undefined || value === '') delete cache[name];
  else cache[name] = String(value);
  persist();
}

export function setMany(entries = {}) {
  load();
  for (const [k, v] of Object.entries(entries)) {
    if (v === null || v === undefined || v === '') delete cache[k];
    else cache[k] = String(v);
  }
  persist();
}

export function hasSecret(name) {
  return Boolean(getSecret(name));
}

/** sk-abcd...wxyz —— 够辨认是哪一把，又拼不回原文 */
export function mask(value) {
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 2)}${'*'.repeat(6)}`;
  return `${value.slice(0, 6)}${'*'.repeat(6)}${value.slice(-4)}`;
}

/** 给前端看的清单：只有名字、是否已配置、掩码预览 */
export function listMasked() {
  const all = load();
  return Object.keys(all)
    .sort()
    .map((name) => ({ name, configured: true, preview: mask(all[name]) }));
}

export function clearAll() {
  cache = {};
  persist();
}

/**
 * 把 {{VAR}} 占位符替换成真实密钥。联调台里用户写 {{DASHSCOPE_API_KEY}}，
 * 请求发出去时才展开，界面和历史记录里始终是占位符。
 */
export function expandSecrets(text) {
  if (typeof text !== 'string' || !text.includes('{{')) return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name) => {
    const secret = getSecret(name);
    return secret || whole;
  });
}

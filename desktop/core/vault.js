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
  return safeStorage ? 'dpapi' : 'aes-256-gcm';
}

function localKey() {
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

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(decrypt(fs.readFileSync(VAULT_FILE)));
  } catch (err) {
    if (err.code === 'VAULT_BACKEND_MISMATCH') throw err;
    cache = {};
  }
  return cache;
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${VAULT_FILE}.tmp`;
  fs.writeFileSync(tmp, encrypt(JSON.stringify(cache ?? {})), { mode: 0o600 });
  fs.renameSync(tmp, VAULT_FILE); // 原子替换，断电不会留半个文件
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

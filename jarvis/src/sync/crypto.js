/**
 * 同步数据的端到端加密：上传前在本机用“同步密码”加密，云端（阿里云 OSS）只看到乱码。
 *   密钥：PBKDF2-SHA256（31 万次迭代，盐随机生成并存在云端）→ AES-GCM 256
 *   每个文件：'JV1' + 12 字节随机 IV + 密文（含 16 字节校验）
 * 密码错误时解密失败，提示“同步密码不对”，不会把乱码当数据用。
 */
const MAGIC = new TextEncoder().encode('JV1');
const ITER = 310_000;
const subtle = () => globalThis.crypto.subtle;

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKey(passphrase, salt) {
  if (!passphrase || String(passphrase).length < 6) throw new Error('同步密码至少 6 位');
  const base = await subtle().importKey('raw', new TextEncoder().encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** 对象 → 加密后的字节 */
export async function seal(key, obj) {
  const iv = randomBytes(12);
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(MAGIC.length + iv.length + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + iv.length);
  return out;
}

/** 加密字节 → 对象；密码不对时抛“同步密码不对” */
export async function open(key, bytes) {
  const b = new Uint8Array(bytes);
  if (b.length < 3 + 12 + 16 || MAGIC.some((v, i) => b[i] !== v)) throw new Error('同步数据格式不对（不是贾维斯的同步文件）');
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b.subarray(3, 15) }, key, b.subarray(15));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new Error('同步密码不对（或云端数据损坏）');
  }
}

// ---------------------------------------------------------------- 同步码：把 OSS 配置带到另一台设备
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** 生成同步码：OSS 配置用同步密码加密后转成一段文字（可以通过微信发给自己） */
export async function makeSyncCode(oss, passphrase) {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  const sealed = await seal(key, { v: 1, oss });
  return `JARVIS-SYNC:${b64(salt)}.${b64(sealed)}`;
}

/** 读同步码（需要同一个同步密码） */
export async function readSyncCode(code, passphrase) {
  const m = String(code || '').trim().match(/^JARVIS-SYNC:([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('同步码格式不对，请完整复制（以 JARVIS-SYNC: 开头）');
  const key = await deriveKey(passphrase, unb64(m[1]));
  const { oss } = await open(key, unb64(m[2]));
  return oss;
}

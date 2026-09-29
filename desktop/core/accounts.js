/**
 * 账号与会话。
 *
 * ── 为什么在"一串 32 位口令"之外还要这个 ──
 *
 * 那串口令能用，但它只回答了"你知不知道那个秘密"，而实际要回答的问题有四个：
 *
 *   谁进来了      口令是共享的，三个人用同一串，出了事查不出是谁
 *   怎么换        换口令等于把所有设备一起踢下线，连自己的都踢
 *   丢了怎么办    手机丢了只想踢掉那一台，不该牵连电脑
 *   记得住吗      32 位随机串没人记得住，于是它一定会被存在某个不该存的地方
 *
 * 所以这里做的是账号 + 每台设备一个会话。踢掉一台不影响别的，
 * 改密码不影响已登录的设备（除非你明确要求全踢）。
 *
 * ── 口令没有废掉 ──
 *
 * 已经部署好的服务不该因为升级一次就进不去。所以那串访问口令继续有效，
 * 而且它多了一个新用途：**第一次建账号时用它证明"你是这台服务器的主人"**。
 * 没有这一条的话，一个刚上线还没建账号的服务，任何人都能抢先建一个管理员。
 *
 * ── 密码怎么存 ──
 *
 * scrypt + 每人一个随机盐。不存明文，也不用 SHA256 直接哈希 ——
 * 后者算得太快，一张显卡一秒能试几十亿个，等于没加密。
 * 比对用 timingSafeEqual：比对耗时不该泄漏"猜对了几个字符"。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const FILE = path.join(DATA_DIR, 'accounts.json');

/** 会话默认 30 天。手机上每次打开都要重登是不能用的 */
const SESSION_DAYS = 30;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { users: raw.users || [], sessions: raw.sessions || [] };
  } catch {
    return { users: [], sessions: [] };
  }
}

function write(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf8');
  // 里面是密码哈希和会话凭证，别人读得到就等于绕过了登录
  try {
    fs.chmodSync(FILE, 0o600);
  } catch {
    /* Windows 上不支持，忽略 */
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  // 长度不同直接判错：timingSafeEqual 要求等长，而长度本来也不是秘密
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 会话凭证只存哈希。数据库被读走时，里面的东西不能直接拿来登录 */
const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function hasAccounts() {
  return read().users.length > 0;
}

export function listUsers() {
  return read().users.map((u) => ({ user: u.user, createdAt: u.createdAt, admin: Boolean(u.admin) }));
}

/**
 * 建账号。
 *
 * 第一个账号是管理员。谁能建第一个？**拿得出那串访问口令的人** ——
 * 校验放在服务端路由里（那里才知道口令是什么），这里只管存。
 */
export function createUser(user, password, { admin = false } = {}) {
  const name = String(user || '').trim();
  if (!/^[\w.@-]{2,32}$/.test(name)) {
    throw new Error('用户名只能用字母、数字、点、下划线、@ 和减号，2~32 位');
  }
  if (String(password || '').length < 8) throw new Error('密码至少 8 位');

  const db = read();
  if (db.users.some((u) => u.user.toLowerCase() === name.toLowerCase())) {
    throw new Error(`「${name}」已经存在`);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.users.push({
    user: name,
    salt,
    hash: hashPassword(password, salt),
    admin: admin || db.users.length === 0,
    createdAt: new Date().toISOString()
  });
  write(db);
  return { user: name, admin: admin || db.users.length === 1 };
}

export function verifyPassword(user, password) {
  const db = read();
  const found = db.users.find((u) => u.user.toLowerCase() === String(user || '').trim().toLowerCase());
  /**
   * 用户不存在时**也要算一次哈希**。
   *
   * 直接返回的话，"这个用户名不存在"会比"密码错了"快上百毫秒 ——
   * 拿这个时间差就能把用户名一个个试出来，而用户名是撞库的一半。
   */
  if (!found) {
    hashPassword(String(password || ''), 'dummy-salt-for-timing');
    return null;
  }
  return sameSecret(hashPassword(password, found.salt), found.hash) ? found : null;
}

export function changePassword(user, oldPassword, newPassword) {
  if (!verifyPassword(user, oldPassword)) throw new Error('原密码不对');
  if (String(newPassword || '').length < 8) throw new Error('新密码至少 8 位');
  const db = read();
  const found = db.users.find((u) => u.user.toLowerCase() === String(user).toLowerCase());
  found.salt = crypto.randomBytes(16).toString('hex');
  found.hash = hashPassword(newPassword, found.salt);
  write(db);
  return true;
}

/**
 * 开一个会话。
 *
 * **一台设备一个会话**，这是这套东西存在的理由：手机丢了只踢那一台，
 * 电脑上正在跑的活不受影响。所以会话上记着是什么设备、什么时候登的，
 * 不然列表里一排看不出区别的条目，没人敢点删除。
 */
export function login(user, password, { device = '' } = {}) {
  const found = verifyPassword(user, password);
  if (!found) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const db = read();
  db.sessions.push({
    id: crypto.randomBytes(6).toString('hex'),
    user: found.user,
    hash: tokenHash(token),
    device: describeDevice(device),
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString()
  });
  write(prune(db));
  return { token, user: found.user, admin: Boolean(found.admin) };
}

/** User-Agent 太长也太杂，只留人能认出来的那部分 */
export function describeDevice(ua = '') {
  const s = String(ua);
  if (/Android/i.test(s)) return '安卓手机';
  if (/iPhone/i.test(s)) return 'iPhone';
  if (/iPad/i.test(s)) return 'iPad';
  if (/Electron/i.test(s)) return '桌面应用';
  if (/Windows/i.test(s)) return 'Windows 电脑';
  if (/Mac OS X|Macintosh/i.test(s)) return 'Mac';
  if (/Linux/i.test(s)) return 'Linux 电脑';
  return s.slice(0, 40) || '未知设备';
}

/** 过期的会话没必要留着，留着只会让"哪些设备登着"这张表越看越糊涂 */
function prune(db) {
  const now = Date.now();
  db.sessions = db.sessions.filter((s) => Date.parse(s.expiresAt) > now);
  return db;
}

/**
 * 这个凭证是谁的。**没找到就是没找到** —— 不要在这里做任何"宽容"处理。
 */
export function whoIs(token) {
  if (!token) return null;
  const db = prune(read());
  const wanted = tokenHash(token);
  const hit = db.sessions.find((s) => sameSecret(s.hash, wanted));
  if (!hit) return null;
  // lastSeen 每次都写盘太费；差过一小时才更新，够用来判断"这台还在不在用"
  if (Date.now() - Date.parse(hit.lastSeen) > 3600000) {
    hit.lastSeen = new Date().toISOString();
    write(db);
  }
  return { user: hit.user, sessionId: hit.id };
}

export function sessionsOf(user) {
  return prune(read())
    .sessions.filter((s) => s.user.toLowerCase() === String(user).toLowerCase())
    .map((s) => ({
      id: s.id,
      device: s.device,
      createdAt: s.createdAt,
      lastSeen: s.lastSeen,
      expiresAt: s.expiresAt
    }));
}

export function revoke(user, sessionId) {
  const db = prune(read());
  const before = db.sessions.length;
  db.sessions = db.sessions.filter(
    (s) => !(s.id === sessionId && s.user.toLowerCase() === String(user).toLowerCase())
  );
  write(db);
  return db.sessions.length < before;
}

/** 手机丢了、密码泄了：一次全踢。当前这台也踢 —— "除了我" 会让人以为安全了，其实没有 */
export function revokeAll(user) {
  const db = prune(read());
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.user.toLowerCase() !== String(user).toLowerCase());
  write(db);
  return before - db.sessions.length;
}

/** 只给自检用：清空，重来 */
export function __reset() {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* 本来就没有 */
  }
}

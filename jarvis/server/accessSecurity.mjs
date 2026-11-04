import { createUserAccounts } from './userAccounts.mjs';
import { PRIMARY_USER } from './userScope.mjs';
/** 独立访问凭证账本：只持久化哈希，不混进模型配置、聊天或日志。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';

const DAY = 86_400_000;
const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const legacyAccessToken = password => hash(`jarvis-server:${password}`);
const error = (status, code, message) => Object.assign(new Error(message), { status, code, kind: 'api' });
const equal = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};
const opaque = () => randomBytes(32).toString('base64url');

/** 仅信本机反代；公网连接自己伪造的转发头没有效力。 */
export function loginAddress(req) {
  const address = String(req.socket?.remoteAddress || 'unknown');
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return address.slice(0, 64);
  const forwarded = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return /^[\da-fA-F:.]{1,64}$/.test(forwarded) ? forwarded : address;
}

const deviceName = req => {
  const ua = String(req.headers['user-agent'] || '未知设备');
  const platform = /Android/i.test(ua) ? '安卓' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Macintosh/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : '浏览器';
  const browser = /Electron/i.test(ua) ? '客户端' : /Firefox/i.test(ua) ? 'Firefox' : /Edg\//i.test(ua) ? 'Edge' : /Chrome/i.test(ua) ? 'Chrome' : /Safari/i.test(ua) ? 'Safari' : '';
  return [platform, browser].filter(Boolean).join(' · ');
};

export function createAccessSecurity({ dataDir, password, now = Date.now }) {
  if (typeof password !== 'string' || password.length < 6) throw error(400, 'PASSWORD_LENGTH', '访问密码至少 6 位');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, 'access-security.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (failure) {
    if (failure.code !== 'ENOENT') throw error(503, 'AUTH_STATE', '登录状态文件无法读取，请检查服务器数据目录');
  }
  const salt = state?.salt || randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32}$/.test(salt)) throw error(503, 'AUTH_STATE', '登录状态文件格式错误');
  // 只在启动时派生代际指纹，避免把6位密码的快速无盐摘要留在磁盘。
  const fingerprint = scryptSync(password, salt, 32).toString('hex');
  // 用户自己改环境密码后，旧会话、评测授权及迁移凭据一起失效。
  if (!state || state.fingerprint !== fingerprint) state = { version: 1, salt, fingerprint, createdAt: now(), sessions: [], evaluations: [], migrations: [], failures: [], lockUntil: 0, notices: [], users: state?.users || [] };
  if (state.version !== 1 || !['sessions', 'evaluations', 'migrations', 'failures', 'notices'].every(key => Array.isArray(state[key]))) throw error(503, 'AUTH_STATE', '登录状态文件格式错误');
  let savedAt = 0;
  function save(force = false) {
    if (!force && now() - savedAt < 60_000) return;
    const temp = filename + '.tmp';
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
    savedAt = now();
  }
  save(true);
  const tickets = new Map(); // 最多200份、60秒，重启失效；不存原始票据。
  const ipFailures = new Map(); // 最多2000个地址，10分钟；总量账本另有20次/小时限制。
  const requestAuth = new WeakMap();
  const revokedListeners = new Set();
  const users = createUserAccounts({ state, save, now, revoke: id => { for (const callback of revokedListeners) callback(id); } });
  const active = row => users.active(row.userId || PRIMARY_USER) && !row.revoked && now() < row.createdAt + 90 * DAY && now() < row.lastUsedAt + 30 * DAY;
  const publicDevice = (row, current) => ({ id: row.id, device: row.device, ip: row.ip, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, current: row.id === current });
  const publicEvaluation = row => ({ id: row.id, name: row.name, createdAt: row.createdAt, expiresAt: row.expiresAt, dailyLimit: row.dailyLimit, used: row.used, lastUsedAt: row.lastUsedAt, revoked: Boolean(row.revoked), today: row.day === day() ? row.today : 0 });
  const day = () => new Date(now() + 8 * 3600_000).toISOString().slice(0, 10);
  const legacy = () => !state.legacyRevoked && now() < state.createdAt + 14 * DAY;
  const owner = principal => { if (principal?.role !== 'owner') throw error(403, 'OWNER_ONLY', '仅主人可以管理访问授权'); };
  function evaluationRow(id) {
    const row = state.evaluations.find(item => item.id === id);
    if (!row || row.revoked || now() >= row.expiresAt) throw error(401, 'EVAL_EXPIRED', '评测授权失效');
    if (row.day !== day()) { row.day = day(); row.today = 0; }
    return row;
  }

  function issueSession(req, migration = false, userId = PRIMARY_USER) {
    state.sessions = state.sessions.filter(active);
    if (state.sessions.length >= 500) throw error(429, 'DEVICE_LIMIT', '已登录设备过多，请先退出旧设备');
    const token = opaque();
    const row = { userId, id: randomBytes(12).toString('hex'), hash: hash(token), device: deviceName(req), ip: loginAddress(req), createdAt: now(), lastUsedAt: now() };
    if (state.sessions.length) {
      state.notices.push({ id: randomBytes(12).toString('hex'), at: now(), sessionId: row.id, userId, device: row.device, ip: row.ip, migration });
      state.notices = state.notices.slice(-100);
    }
    state.sessions.push(row);
    save(true);
    return { token, id: row.id, userId, role: userId === PRIMARY_USER ? 'owner' : 'member' };
  }

  function login(req, supplied) {
    const ip = loginAddress(req);
    const recent = (ipFailures.get(ip) || []).filter(at => now() - at < 600_000);
    state.failures = state.failures.filter(at => now() - at < 3600_000);
    if (state.lockUntil > now()) throw error(429, 'LOGIN_GLOBAL_LOCK', '有人在尝试密码，登录已暂锁1小时');
    if (recent.length >= 5) throw error(429, 'LOGIN_IP_LOCK', '密码错误次数太多，10 分钟后再试');
    if (typeof supplied === 'string' && equal(legacyAccessToken(supplied), legacyAccessToken(password))) {
      ipFailures.delete(ip);
      return issueSession(req);
    }
    const memberId = users.identify(supplied);
    if (memberId) { ipFailures.delete(ip); return issueSession(req, false, memberId); }
    if (ipFailures.size >= 2000 && !ipFailures.has(ip)) ipFailures.delete(ipFailures.keys().next().value);
    ipFailures.set(ip, [...recent, now()]);
    state.failures.push(now());
    if (state.failures.length >= 20) state.lockUntil = now() + 3600_000;
    save(true);
    throw error(401, 'LOGIN_PASSWORD', '密码不对');
  }

  function authenticate(req) {
    if (requestAuth.has(req)) return requestAuth.get(req);
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.has('token')) return null;
    const raw = String(req.headers.authorization || '').match(/^Bearer\s+([^\s]{1,512})$/i)?.[1];
    let principal = null;
    if (raw) {
      const digest = hash(raw);
      const session = state.sessions.find(row => equal(row.hash, digest) && active(row));
      const evaluation = state.evaluations.find(row => equal(row.hash, digest) && !row.revoked && now() < row.expiresAt);
      if (session) {
        session.lastUsedAt = now();
        save();
        principal = { role: (session.userId || PRIMARY_USER) === PRIMARY_USER ? 'owner' : 'member', id: session.id, userId: session.userId || PRIMARY_USER };
      } else if (evaluation) {
        evaluation.lastUsedAt = now();
        save();
        principal = { role: 'evaluation', userId: PRIMARY_USER, id: evaluation.id, scopePrefix: `ev_${evaluation.id}_` };
      } else if (legacy() && equal(raw, legacyAccessToken(password))) principal = { role: 'owner', userId: PRIMARY_USER, id: 'legacy', legacy: true };
    } else if (url.searchParams.has('ticket')) {
      const digest = hash(url.searchParams.get('ticket'));
      const ticket = tickets.get(digest);
      url.searchParams.delete('ticket');
      if (ticket && ticket.until > now() && ticket.resource === req.method + ' ' + url.pathname + (url.searchParams.size ? '?' + url.searchParams.toString() : '') && state.sessions.some(row => row.id === ticket.owner && active(row))) {
        tickets.delete(digest);
        const session = state.sessions.find(row => row.id === ticket.owner);
        const userId = session.userId || PRIMARY_USER;
        principal = { role: userId === PRIMARY_USER ? 'owner' : 'member', userId, id: ticket.owner, ticket: true };
      }
    }
    if (principal) requestAuth.set(req, principal);
    return principal;
  }

  return {
    authenticate,
    login,
    users,
    migrate(req) {
      const principal = authenticate(req);
      owner(principal);
      if (!principal.legacy) throw error(409, 'ALREADY_MIGRATED', '当前设备已经使用新会话');
      const device = String(req.headers['x-jarvis-device'] || '');
      if (!/^[\w-]{16,100}$/.test(device)) throw error(400, 'DEVICE_ID', '设备编号格式错误');
      const deviceHash = hash(device);
      if (state.migrations.some(row => row.device === deviceHash)) throw error(401, 'MIGRATION_USED', '此设备旧凭证已换发，请使用新会话登录');
      if (state.migrations.length >= 500) throw error(429, 'DEVICE_LIMIT', '旧设备迁移数量已达上限');
      const session = issueSession(req, true);
      state.migrations.push({ device: deviceHash, sessionId: session.id, at: now() });
      save(true);
      // 日志仅记迁移事件，不带设备地址、令牌或密码。
      console.info('[访问安全] 旧设备登录已迁移');
      return session;
    },
    overview(principal) {
      if (!['owner', 'member'].includes(principal?.role)) owner(principal);
      return { minimumLength: 6, weakPassword: principal.role === 'owner' && (password.length < 12 || /^(.)\1+$/.test(password) || /^(?:123456|password|qwerty)/i.test(password)), loginLockedUntil: state.lockUntil > now() ? state.lockUntil : 0, identity: users.identity(principal), devices: state.sessions.filter(row => active(row) && (row.userId || PRIMARY_USER) === (principal.userId || PRIMARY_USER)).map(row => publicDevice(row, principal.id)), notices: state.notices.filter(row => (row.userId || PRIMARY_USER) === (principal.userId || PRIMARY_USER) && row.sessionId !== principal.id && now() - row.at < 7 * DAY).map(row => ({ ...row })), evaluations: principal.role === 'owner' ? state.evaluations.map(publicEvaluation) : [], legacyUntil: state.createdAt + 14 * DAY };
    },
    revokeSession(principal, id) {
      if (!['owner', 'member'].includes(principal?.role)) owner(principal);
      if (id === 'others' && principal.legacy) throw error(409, 'MIGRATION_REQUIRED', '请先升级当前设备登录，再退出其他设备');
      const removed = [];
      for (const row of state.sessions) if ((row.userId || PRIMARY_USER) === (principal.userId || PRIMARY_USER) && (id === 'others' ? row.id !== principal.id : row.id === id)) { row.revoked = true; removed.push(row.id); }
      // 用户明确退出其他设备后，旧的共享凭证也不能再换个设备编号重新进入。
      if (id === 'others' && principal.role === 'owner') { state.legacyRevoked = true; removed.push('legacy'); }
      save(true);
      for (const removedId of removed) for (const callback of revokedListeners) callback(removedId);
    },
    issueEvaluation(principal, { name = '自动评测', days = 7, dailyLimit = 200 } = {}) {
      owner(principal);
      if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000) throw error(400, 'EVAL_OPTIONS', '有效期应为1至30天，每日次数为1至10000');
      state.evaluations = state.evaluations.filter(row => !row.revoked && row.expiresAt > now());
      if (state.evaluations.length >= 100) throw error(429, 'EVAL_TOKEN_LIMIT', '评测令牌已达100份，请先作废旧授权');
      const token = opaque();
      const row = { id: randomBytes(12).toString('hex'), hash: hash(token), name: String(name).replace(/[\x00-\x1f<>]/g, '').slice(0, 80), createdAt: now(), expiresAt: now() + days * DAY, dailyLimit, used: 0, day: day(), today: 0, lastUsedAt: null };
      state.evaluations.push(row);
      save(true);
      return { ...publicEvaluation(row), token };
    },
    revokeEvaluation(principal, id) {
      owner(principal);
      const row = state.evaluations.find(item => item.id === id);
      if (row) row.revoked = true;
      save(true);
      if (row) for (const callback of revokedListeners) callback(row.id);
    },
    onRevoke(callback) { revokedListeners.add(callback); return () => revokedListeners.delete(callback); },
    evaluationScope(principal, requested) {
      return principal.scopePrefix + hash(String(requested || 'default')).slice(0, 20);
    },
    remaining(id) {
      const row = evaluationRow(id);
      return Math.max(0, row.dailyLimit - row.today);
    },
    consume(id, kind, quantity = 1) {
      if (!['model', 'search'].includes(kind)) throw error(400, 'EVAL_USAGE_KIND', '评测计数类型错误');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) throw error(400, 'EVAL_USAGE_COUNT', '评测次数无效');
      const row = evaluationRow(id);
      if (row.today + quantity > row.dailyLimit) throw error(429, 'EVAL_QUOTA', '评测令牌今日模型与搜索调用次数已达上限');
      row.today += quantity;
      row.used += quantity;
      row.lastUsedAt = now();
      save(true); // 外部请求前落账，失败与重试也计数，不靠完成事件补扣。
      return { id, day: row.day, quantity };
    },
    settleReservation(receipt, used) {
      if (receipt.settled) return;
      const row = state.evaluations.find(item => item.id === receipt.id);
      if (!row || !Number.isInteger(used) || used < 0 || used > receipt.quantity) return;
      receipt.settled = true;
      const unused = receipt.quantity - used;
      row.used = Math.max(0, row.used - unused);
      if (row.day === receipt.day) row.today = Math.max(0, row.today - unused);
      receipt.quantity = used; // 一次结算对象，重复调用不会重复退还。
      save(true);
    },
    ticket(principal, resource) {
      if (!['owner', 'member'].includes(principal?.role)) owner(principal);
      if (principal.legacy) throw error(409, 'MIGRATION_REQUIRED', '请先升级此设备登录');
      const url = new URL(String(resource), 'http://x');
      if (url.origin !== 'http://x' || url.hash || url.searchParams.has('token') || url.searchParams.has('ticket') || !(/^\/api\/tasks\/[\w-]+\/events$/.test(url.pathname) || url.pathname === '/api/files/raw')) throw error(400, 'TICKET_RESOURCE', '票据仅用于任务事件或文件下载');
      for (const [key, row] of tickets) if (row.until <= now()) tickets.delete(key);
      if (tickets.size >= 200) throw error(429, 'TICKET_LIMIT', '短期票据过多，请稍后重试');
      const ticket = opaque();
      tickets.set(hash(ticket), { owner: principal.id, resource: 'GET ' + url.pathname + (url.searchParams.size ? '?' + url.searchParams.toString() : ''), until: now() + 60_000 });
      return { ticket, expiresIn: 60 };
    }
  };
}

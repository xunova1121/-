/** 最小账户绑定：随机访问码登录，设备会话绑定稳定ID；访问码只保存摘要。 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { PRIMARY_USER } from './userScope.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const denied = () => Object.assign(new Error('仅管理员可以管理用户'), { status: 403, code: 'USER_ADMIN_ONLY' });
export function createUserAccounts({ state, save, revoke, now }) {
  state.users ??= [];
  if (!Array.isArray(state.users) || state.users.length > 50 || state.users.some(u => !/^u_[a-f0-9]{24}$/.test(u.id) || !/^[a-f0-9]{64}$/.test(u.hash))) throw new Error('用户绑定记录格式错误');
  const publicRow = u => ({ id: u.id, name: u.name, disabled: Boolean(u.disabled), createdAt: u.createdAt });
  const admin = principal => { if (principal?.role !== 'owner') throw denied(); };
  const active = id => id === PRIMARY_USER || state.users.some(u => u.id === id && !u.disabled);
  const credential = () => 'wyu_' + randomBytes(32).toString('base64url');
  function invalidate(id) {
    for (const session of state.sessions) if (session.userId === id) { session.revoked = true; revoke(session.id); }
  }
  return {
    active,
    ids: () => [PRIMARY_USER, ...state.users.filter(u => !u.disabled).map(u => u.id)],
    identify(value) {
      if (typeof value !== 'string' || !/^wyu_[A-Za-z0-9_-]{43}$/.test(value)) return null;
      const hash = Buffer.from(digest(value));
      return state.users.find(u => !u.disabled && timingSafeEqual(hash, Buffer.from(u.hash)))?.id || null;
    },
    list(principal) { admin(principal); return state.users.map(publicRow); },
    create(principal, { name } = {}) {
      admin(principal);
      name = typeof name === 'string' ? name.trim() : '';
      if (!name || name.length > 40 || /[\x00-\x1f<>]/.test(name)) throw Object.assign(new Error('请填写1至40字的用户名称'), { status: 400 });
      if (state.users.length >= 50) throw Object.assign(new Error('最多绑定50个用户'), { status: 429 });
      const accessCode = credential();
      const row = { id: 'u_' + randomBytes(12).toString('hex'), name, hash: digest(accessCode), createdAt: now(), disabled: false };
      state.users.push(row); save(true);
      return { ...publicRow(row), accessCode };
    },
    update(principal, id, action) {
      admin(principal);
      const row = state.users.find(u => u.id === id);
      if (!row) throw Object.assign(new Error('用户不存在'), { status: 404 });
      if (!['disable', 'enable', 'reset'].includes(action)) throw Object.assign(new Error('用户操作无效'), { status: 400 });
      let accessCode;
      if (action === 'reset') { accessCode = credential(); row.hash = digest(accessCode); }
      else row.disabled = action === 'disable';
      if (action !== 'enable') invalidate(id);
      save(true);
      return { ...publicRow(row), ...(accessCode && { accessCode }) };
    },
    identity(principal) {
      const userId = principal.userId || PRIMARY_USER;
      return { userId, role: principal.role, name: userId === PRIMARY_USER ? '主人' : state.users.find(u => u.id === userId)?.name || '用户' };
    }
  };
}

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccessSecurity, legacyAccessToken, loginAddress } from '../server/accessSecurity.mjs';

const DAY = 86_400_000;
const folders = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function setup(password = 'six123') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-auth-ledger-'));
  folders.push(dataDir);
  let clock = Date.UTC(2026, 10, 2);
  const now = () => clock;
  const auth = createAccessSecurity({ dataDir, password, now });
  return { auth, dataDir, password, now, advance: duration => { clock += duration; } };
}
const request = (token = '', url = '/api/sessions', headers = {}, ip = '203.0.113.7') => ({ url, method: 'GET', headers: { ...(token && { authorization: 'Bearer ' + token }), ...headers }, socket: { remoteAddress: ip } });
const signIn = (s, headers) => s.auth.login(request('', '/api/server/login', headers), s.password);
const owner = (s, token) => s.auth.authenticate(request(token));

describe('随机设备会话与旧客户端迁移', () => {
  it('相同密码每设备签发不同32字节凭证，账本只存哈希并可重启恢复', () => {
    const s = setup();
    const a = signIn(s, { 'user-agent': 'Android Chrome' });
    const b = signIn(s, { 'user-agent': 'Windows Electron' });
    expect(a.token).not.toBe(b.token);
    expect(Buffer.from(a.token, 'base64url').length).toBeGreaterThanOrEqual(32);
    const principal = owner(s, a.token);
    expect(s.auth.overview(principal).devices).toEqual(expect.arrayContaining([expect.objectContaining({ id: a.id, device: '安卓 · Chrome', current: true }), expect.objectContaining({ id: b.id, device: 'Windows · 客户端', current: false })]));
    const file = path.join(s.dataDir, 'access-security.json');
    const persisted = fs.readFileSync(file, 'utf8');
    for (const secret of [a.token, b.token, s.password, legacyAccessToken(s.password)]) expect(persisted).not.toContain(secret);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(createAccessSecurity({ dataDir: s.dataDir, password: s.password, now: s.now }).authenticate(request(a.token))).toMatchObject({ role: 'owner', id: a.id });
  });
  it('30天闲置失效，使用顺延但绝对90天到期', () => {
    const s = setup();
    const idle = signIn(s);
    const busy = signIn(s);
    s.advance(29 * DAY);
    expect(owner(s, busy.token)).toBeTruthy();
    s.advance(2 * DAY);
    expect(owner(s, idle.token)).toBeNull();
    for (const days of [27, 28]) { s.advance(days * DAY); expect(owner(s, busy.token)).toBeTruthy(); }
    s.advance(4 * DAY);
    expect(owner(s, busy.token)).toBeNull();
  });
  it('单台撤销与退出其他设备不误伤当前设备；用户改密码使全部失效', () => {
    const s = setup();
    const a = signIn(s), b = signIn(s), c = signIn(s);
    const principal = owner(s, a.token);
    s.auth.revokeSession(principal, b.id);
    expect(owner(s, b.token)).toBeNull();
    s.auth.revokeSession(principal, 'others');
    expect(owner(s, c.token)).toBeNull();
    expect(owner(s, legacyAccessToken(s.password))).toBeNull();
    expect(owner(s, a.token)).toBeTruthy();
    const changed = createAccessSecurity({ dataDir: s.dataDir, password: 'new-six-fixture', now: s.now });
    expect(changed.authenticate(request(a.token))).toBeNull();
    expect(changed.authenticate(request(legacyAccessToken(s.password)))).toBeNull();
  });
  it('安卓与电脑旧凭据各自免输密码换发一次，14天后连重启也拒绝旧凭据', () => {
    const s = setup();
    const old = legacyAccessToken(s.password);
    const tokens = [];
    for (const device of ['android-fixture-device', 'desktop-fixture-device']) {
      const req = () => request(old, '/api/server/auth/migrate', { 'x-jarvis-device': device });
      const migrated = s.auth.migrate(req());
      expect(owner(s, migrated.token)).toBeTruthy();
      expect(() => s.auth.migrate(req())).toThrow(/已换发/);
      tokens.push(migrated.token);
    }
    expect(tokens[0]).not.toBe(tokens[1]);
    s.advance(14 * DAY);
    const restarted = createAccessSecurity({ dataDir: s.dataDir, password: s.password, now: s.now });
    expect(restarted.authenticate(request(old))).toBeNull();
    expect(restarted.authenticate(request(tokens[0]))).toBeTruthy();
  });
  it('网址会话凭据拒绝；资源票据60秒、单次、绑定资源与设备撤销', () => {
    const s = setup(), a = signIn(s);
    const principal = owner(s, a.token);
    expect(s.auth.authenticate(request('', '/api/sessions?token=' + a.token))).toBeNull();
    expect(s.auth.authenticate(request(a.token, '/api/sessions?token=' + a.token))).toBeNull();
    const resource = '/api/tasks/task-one/events?after=3';
    const ticket = s.auth.ticket(principal, resource).ticket;
    expect(s.auth.authenticate(request('', '/api/tasks/task-other/events?after=3&ticket=' + ticket))).toBeNull();
    const valid = request('', resource + '&ticket=' + ticket);
    expect(s.auth.authenticate(valid)).toMatchObject({ id: a.id, ticket: true });
    expect(s.auth.authenticate(valid)).toBeTruthy(); // 同一HTTP请求内外两层鉴权不重复消费。
    expect(s.auth.authenticate(request('', resource + '&ticket=' + ticket))).toBeNull();
    const expired = s.auth.ticket(principal, resource).ticket;
    s.advance(60_000);
    expect(s.auth.authenticate(request('', resource + '&ticket=' + expired))).toBeNull();
    const revoked = s.auth.ticket(principal, resource).ticket;
    s.auth.revokeSession(principal, a.id);
    expect(s.auth.authenticate(request('', resource + '&ticket=' + revoked))).toBeNull();
    expect(() => s.auth.ticket(principal, '/api/server/config')).toThrow(/仅用于/);
  });
});

describe('猜密码限流与评测授权账本', () => {
  it('只有本机反代的IP头被信任，公网换头绕不过5次限制', () => {
    const s = setup();
    expect(loginAddress(request('', '/', { 'x-real-ip': '198.51.100.4' }))).toBe('203.0.113.7');
    expect(loginAddress(request('', '/', { 'x-forwarded-for': '198.51.100.4, 127.0.0.1' }, '127.0.0.1'))).toBe('198.51.100.4');
    for (let i = 0; i < 5; i++) expect(() => s.auth.login(request('', '/', { 'x-real-ip': `198.51.100.${i}` }), 'wrong')).toThrow(/密码不对/);
    expect(() => s.auth.login(request(), s.password)).toThrow(/10 分钟/);
    s.advance(600_000);
    expect(signIn(s).token).toBeTruthy();
  });
  it('20次不同IP失败触发全局锁，重启继续锁住，1小时后恢复', () => {
    const s = setup();
    for (let i = 0; i < 20; i++) expect(() => s.auth.login(request('', '/', {}, `203.0.113.${i}`), 'wrong')).toThrow(/密码不对/);
    const restarted = createAccessSecurity({ dataDir: s.dataDir, password: s.password, now: s.now });
    expect(() => restarted.login(request(), s.password)).toThrow(/暂锁/);
    s.advance(3600_000);
    expect(restarted.login(request(), s.password).token).toBeTruthy();
  });
  it('评测令牌只显示一次，默认7天/200次，次数跨重启按北京时间每天重置', () => {
    const s = setup(), a = signIn(s), principal = owner(s, a.token);
    const issued = s.auth.issueEvaluation(principal, { name: '夹具评测', dailyLimit: 2 });
    const evaluation = s.auth.authenticate(request(issued.token));
    expect(evaluation).toMatchObject({ role: 'evaluation', id: issued.id });
    expect(issued.expiresAt - issued.createdAt).toBe(7 * DAY);
    expect(() => s.auth.overview(evaluation)).toThrow(/仅主人/);
    expect(() => s.auth.issueEvaluation(evaluation)).toThrow(/仅主人/);
    expect(() => s.auth.ticket(evaluation, '/api/files/raw?path=x')).toThrow(/仅主人/);
    s.auth.consume(issued.id, 'model');
    s.auth.consume(issued.id, 'search');
    expect(() => s.auth.consume(issued.id, 'model')).toThrow(/今日/);
    const restarted = createAccessSecurity({ dataDir: s.dataDir, password: s.password, now: s.now });
    expect(() => restarted.consume(issued.id, 'search')).toThrow(/今日/);
    expect(JSON.stringify(s.auth.overview(principal))).not.toContain(issued.token);
    expect(fs.readFileSync(path.join(s.dataDir, 'access-security.json'), 'utf8')).not.toContain(issued.token);
    s.advance(DAY);
    expect(() => restarted.consume(issued.id, 'model')).not.toThrow();
    expect(restarted.overview(principal).evaluations[0]).toMatchObject({ used: 3, today: 1 });
    restarted.revokeEvaluation(principal, issued.id);
    expect(restarted.authenticate(request(issued.token))).toBeNull();
  });
  it('评测过期、有效期范围、仅主人撤销与弱密码告警不强制改密', () => {
    const s = setup(), a = signIn(s), principal = owner(s, a.token);
    expect(s.auth.overview(principal)).toMatchObject({ minimumLength: 6, weakPassword: true });
    expect(() => s.auth.issueEvaluation(principal, { days: 31 })).toThrow(/1至30/);
    const issued = s.auth.issueEvaluation(principal, { days: 1 });
    const evaluation = s.auth.authenticate(request(issued.token));
    expect(() => s.auth.revokeSession(evaluation, a.id)).toThrow(/仅主人/);
    s.advance(DAY);
    expect(s.auth.authenticate(request(issued.token))).toBeNull();
    expect(() => s.auth.consume(issued.id, 'model')).toThrow(/失效/);
  });
});

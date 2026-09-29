/**
 * 鉴权头生成。
 *
 * 每家的写法都不太一样，踩过的坑就摆在这里当注释：
 *   - DashScope / MuleRun: 标准 Authorization: Bearer
 *   - Vidu:  Authorization: Token xxx —— 写成 Bearer 会 401，但报错信息不提这茬
 *   - Kling: 不收静态密钥，要用 AK/SK 本地签一个 HS256 JWT，默认 30 分钟过期
 */
import crypto from 'node:crypto';
import { getSecret } from '../vault.js';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 签发可灵要的 JWT。故意在 nbf 上往前挪 5 秒 ——
 * 本机时钟比服务端快哪怕一两秒，都会被判成"令牌尚未生效"。
 */
export function signKlingJWT(accessKey, secretKey, ttlSeconds = 1800) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: accessKey, exp: now + ttlSeconds, nbf: now - 5 })
  );
  const signingInput = `${header}.${payload}`;
  const sig = b64url(crypto.createHmac('sha256', secretKey).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

export class AuthError extends Error {
  constructor(message, missing = []) {
    super(message);
    this.name = 'AuthError';
    this.missing = missing;
  }
}

/**
 * 生成该服务商的鉴权头。
 * @param {object} provider catalog 里的条目
 * @param {object} [opts]
 * @param {boolean} [opts.placeholder] true 时返回 {{SECRET_NAME}} 占位符而非明文，
 *                                     用于把请求"回显"给联调台界面
 */
export function buildAuthHeaders(provider, { placeholder = false } = {}) {
  const auth = provider?.auth || { type: 'none' };

  if (auth.type === 'none') return {};

  if (auth.type === 'kling-jwt') {
    if (placeholder) return { Authorization: 'Bearer <本地签发的 JWT，发送时自动生成>' };
    const ak = getSecret(auth.secret);
    const sk = getSecret(auth.secret2);
    const missing = [];
    if (!ak) missing.push(auth.secret);
    if (!sk) missing.push(auth.secret2);
    if (missing.length) {
      throw new AuthError(`${provider.name} 缺少凭据：${missing.join('、')}`, missing);
    }
    return { Authorization: `Bearer ${signKlingJWT(ak, sk)}` };
  }

  /**
   * 密钥根本不放在 Authorization 里的那些家。
   *
   * ElevenLabs 用的是 `xi-api-key: <key>`。不认这一种的话，代码会走到下面
   * 那条默认分支，发出一个 `Authorization: Bearer <key>` —— 对方回 401，
   * 而 401 的第一反应永远是"密钥不对"，人会去控制台反复重建密钥，
   * 白折腾一圈。Vidu 那条 `Token` 而不是 `Bearer` 的注释就是同一个教训。
   */
  if (auth.type === 'header') {
    const name = auth.header || 'X-API-Key';
    if (placeholder) return { [name]: `{{${auth.secret}}}` };
    const value = getSecret(auth.secret);
    if (!value) {
      if (auth.optional) return {};
      throw new AuthError(`${provider.name} 缺少凭据：${auth.secret}`, [auth.secret]);
    }
    return { [name]: value };
  }

  const scheme = auth.type === 'token' ? 'Token' : 'Bearer';
  if (placeholder) return { Authorization: `${scheme} {{${auth.secret}}}` };

  const key = getSecret(auth.secret);
  if (!key) {
    if (auth.optional) return {};
    throw new AuthError(`${provider.name} 缺少凭据：${auth.secret}`, [auth.secret]);
  }
  return { Authorization: `${scheme} ${key}` };
}

/** 配齐了没？用于服务商列表上那个绿点 */
export function credentialStatus(provider) {
  const required = (provider.secrets || []).filter((s) => s.required);
  const missing = required.filter((s) => !getSecret(s.name)).map((s) => s.name);
  return { ready: missing.length === 0, missing };
}

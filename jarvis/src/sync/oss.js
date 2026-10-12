/**
 * 阿里云 OSS 最小客户端：GET / PUT / HEAD 一个对象（签名版本 V1：HMAC-SHA1）。
 *
 * 浏览器里不能自己设置 Date 请求头、而且 OSS 默认不允许网页跨域，所以：
 *   桌面版 / 完整版：经本机网关转发（/api/oss/…，只转发到 *.aliyuncs.com）
 *   安卓 App：系统原生网络请求（Capacitor），没有跨域限制
 *
 * 建议给贾维斯单独建一个 RAM 子账号，只授权这一个存储空间（Bucket）的读写。
 * 对象内容存成 Base64 文本（加密后的字节），各种网络通道都能原样收发。
 */

/** 用户填的地域 / 地址 → 统一成 oss-cn-hangzhou.aliyuncs.com 这样的主机名 */
export function normalizeEndpoint(input) {
  let e = String(input || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!e) throw new Error('请填写 OSS 地域，如 oss-cn-hangzhou');
  if (/^cn-|^ap-|^us-|^eu-|^me-/.test(e)) e = `oss-${e}`;
  if (!/\.aliyuncs\.com$/.test(e)) e = `${e}.aliyuncs.com`;
  if (!/^oss-[a-z0-9-]+(\.internal)?\.aliyuncs\.com$/.test(e)) throw new Error(`OSS 地址不对：${input}（应为 oss-cn-hangzhou 这样的地域）`);
  return e;
}

export function validBucket(b) {
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(String(b || ''));
}

const enc = new TextEncoder();
async function hmacSha1Base64(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  return btoa(String.fromCharCode(...sig));
}

/** V1 签名：VERB \n Content-MD5 \n Content-Type \n Date \n CanonicalizedOSSHeaders CanonicalizedResource */
export async function signV1({ method, contentMd5 = '', contentType = '', date, bucket, key, ossHeaders = {}, accessKeyId, accessKeySecret }) {
  const canonHeaders = Object.keys(ossHeaders).map((k) => k.toLowerCase()).sort().map((k) => `${k}:${ossHeaders[k]}\n`).join('');
  const resource = `/${bucket}/${key}`;
  const toSign = `${method}\n${contentMd5}\n${contentType}\n${date}\n${canonHeaders}${resource}`;
  return `OSS ${accessKeyId}:${await hmacSha1Base64(accessKeySecret, toSign)}`;
}

/**
 * @param {{ endpoint: string, bucket: string, accessKeyId: string, accessKeySecret: string, prefix?: string }} cfg
 * @param {{ transport: (req: { method, url, headers, body?: string }) => Promise<{ status: number, text: string, headers: object }> }} o
 */
export const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function createOss(cfg, { transport, now = () => new Date() }) {
  const host = `${cfg.bucket}.${normalizeEndpoint(cfg.endpoint)}`;
  if (!validBucket(cfg.bucket)) throw new Error('Bucket 名称不对（小写字母、数字、短横线，3–63 位）');
  if (!cfg.accessKeyId || !cfg.accessKeySecret) throw new Error('请填写 AccessKey ID 和 Secret');
  const prefix = String(cfg.prefix ?? 'jarvis-sync/').replace(/^\/+/, '');
  const keyOf = (name) => `${prefix}${name}`;

  async function call(method, name, body = null, contentType = '') {
    const key = keyOf(name);
    const date = now().toUTCString();
    // 同时带 x-oss-date（与官方 SDK 一致）：某些网络通道会丢掉 Date 头，OSS 优先认 x-oss-date
    const ossHeaders = { 'x-oss-date': date };
    const headers = { date, ...ossHeaders, authorization: await signV1({ method, contentType, date, bucket: cfg.bucket, key, ossHeaders, accessKeyId: cfg.accessKeyId, accessKeySecret: cfg.accessKeySecret }) };
    if (contentType) headers['content-type'] = contentType;
    const res = await transport({ method, url: `https://${host}/${key.split('/').map(encodeURIComponent).join('/')}`, headers, body });
    if (res.status === 403) throw new Error('OSS 拒绝访问：请检查 AccessKey 是否正确、RAM 子账号是否有这个 Bucket 的读写和列表权限（见使用说明）');
    if (res.status === 404 && method !== 'GET' && method !== 'HEAD') throw new Error('找不到这个 Bucket，请检查名称和地域');
    return res;
  }

  return {
    host,
    /** 读对象（字节）；不存在返回 null */
    async get(name) {
      const r = await call('GET', name);
      if (r.status === 404) {
        if (/NoSuchBucket/.test(r.text || '')) throw new Error('找不到这个 Bucket，请检查名称和地域');
        return null;
      }
      if (r.status !== 200) throw new Error(`OSS 返回 ${r.status}${/<Code>(\w+)/.exec(r.text || '')?.[1] ? `（${/<Code>(\w+)/.exec(r.text)[1]}）` : ''}`);
      let body;
      try { body = fromB64(String(r.text || '').trim()); } catch { throw new Error('云端同步文件损坏'); }
      return { body, etag: r.headers?.etag ?? '' };
    },
    async put(name, bytes) {
      const r = await call('PUT', name, toB64(bytes), 'text/plain');
      if (r.status !== 200) throw new Error(`上传失败：OSS 返回 ${r.status}`);
      return { etag: r.headers?.etag ?? '' };
    }
  };
}


// ---------------------------------------------------------------- 传输方式
/** 经本机网关转发（桌面版 / 完整版） */
export function gatewayTransport(origin, fetchImpl = globalThis.fetch) {
  return async ({ method, url, headers, body }) => {
    const r = await fetchImpl(`${origin}/api/oss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-client': '1' },
      body: JSON.stringify({ method, url, headers, body: body ?? null })
    });
    const text = await r.text();
    if (!r.headers.get('x-oss-status')) throw new Error(r.status === 403 ? '本机网关拒绝了同步请求' : `本机网关出错（${r.status}）：${text.slice(0, 120)}`);
    return { status: Number(r.headers.get('x-oss-status')), headers: { etag: r.headers.get('x-oss-etag') || '' }, text };
  };
}

/** 直接请求（安卓 App：系统原生网络，没有跨域限制，也能设置 Date 头） */
export function directTransport(fetchImpl = globalThis.fetch) {
  return async ({ method, url, headers, body }) => {
    const r = await fetchImpl(url, { method, headers, body: body ?? undefined });
    return { status: r.status, headers: { etag: r.headers.get('etag') || '' }, text: await r.text() };
  };
}

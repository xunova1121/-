/**
 * 阿里云 OSS —— 把出好的图和片子放到对象存储上。
 *
 * ── 为什么要它 ──
 *
 * ① **参考图必须是公网 URL。**
 *    这是最实际的一条。万相、即梦这些厂商的"图生图 / 参考图"通道只收
 *    `https://...` 的地址，不收本地文件、也不收 base64（见 adapters.js
 *    requirePublicUrl）。角色设定图躺在自己硬盘上，就永远发不出去 ——
 *    整条一致性链路里最关键的那一环因此断掉。有了 OSS，本地文件传上去
 *    就有了公网地址，这条路才通。
 *
 * ② 服务器那块盘很快就满。一部 20 镜的片子连中间产物几百 MB，
 *    轻量服务器 50G 盘跑十几部就见底。
 *
 * ③ 手机上下载素材走 OSS 直连，不再从应用服务器往外倒腾几百 MB。
 *
 * ── 为什么自己写而不是装 SDK ──
 *
 * 这个项目**一个 npm 依赖都没有**（除了打包用的 electron），运行时只用
 * node: 内置模块。ali-oss 会拖进来几十个传递依赖，为了一个 PUT 不值当。
 * 签名本身就是几十行 HMAC。
 *
 * ── 签名版本 ──
 *
 * 默认 V4（阿里云现在推荐的那版），失败时自动退回 V1 再试一次。
 * 这个退回不是"以防万一"式的防御性代码，是有具体原因的：不同年代建的
 * bucket、不同 region、STS 临时凭证，对签名版本的接受程度不一样，
 * 而用户拿到「SignatureDoesNotMatch」这六个字是完全没法自己往下查的。
 * 试第二种花一个来回，换来的是"能用"和"不能用"的差别。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as settings from './settings.js';
import * as vault from './vault.js';

export const AK_NAME = 'ALIYUN_OSS_KEY_ID';
export const SK_NAME = 'ALIYUN_OSS_KEY_SECRET';

/** 常用地域。列出来是为了让人在下拉里选，而不是照着文档抄一串 endpoint */
export const REGIONS = [
  { id: 'oss-cn-hangzhou', name: '杭州' },
  { id: 'oss-cn-shanghai', name: '上海' },
  { id: 'oss-cn-beijing', name: '北京' },
  { id: 'oss-cn-shenzhen', name: '深圳' },
  { id: 'oss-cn-guangzhou', name: '广州' },
  { id: 'oss-cn-hongkong', name: '香港' },
  { id: 'oss-ap-southeast-1', name: '新加坡' },
  { id: 'oss-ap-northeast-1', name: '东京' },
  { id: 'oss-us-west-1', name: '硅谷' }
];

export function config() {
  const c = settings.get('oss') || {};
  return {
    enabled: Boolean(c.enabled),
    region: (c.region || 'oss-cn-hangzhou').trim(),
    bucket: (c.bucket || '').trim(),
    // 前缀让同一个 bucket 能被别的东西共用，也方便按项目清理
    prefix: (c.prefix || 'futuredream').replace(/^\/+|\/+$/g, ''),
    // 绑了 CNAME 就用自己的域名回链，否则用 bucket 的默认域名
    customDomain: (c.customDomain || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    /**
     * 公共读的桶直接给永久地址；私有桶给限时签名地址。
     *
     * 默认按**私有**办。公共读意味着任何人猜到路径就能看你的片子，
     * 而这是一个默认值 —— 默认值必须是安全的那一个，想公开是主动的选择。
     */
    publicRead: c.publicRead === true,
    signedTtl: Number(c.signedTtl) || 3600,
    signVersion: c.signVersion === 'v1' ? 'v1' : 'v4'
  };
}

export function credentials() {
  return {
    accessKeyId: (vault.getSecret(AK_NAME) || '').trim(),
    accessKeySecret: (vault.getSecret(SK_NAME) || '').trim()
  };
}

/** 配齐了没有。**没配齐就当没开** —— 半开着的状态是最难查的那种 */
export function ready() {
  const c = config();
  const k = credentials();
  return Boolean(c.enabled && c.bucket && c.region && k.accessKeyId && k.accessKeySecret);
}

export function host(c = config()) {
  return c.customDomain || `${c.bucket}.${c.region}.aliyuncs.com`;
}

/** 签名走的那个 host 永远是 bucket 的原始域名，即使回链用的是 CNAME */
function signHost(c) {
  return `${c.bucket}.${c.region}.aliyuncs.com`;
}

/** region 在签名 scope 里不带 `oss-` 前缀：oss-cn-hangzhou → cn-hangzhou */
function scopeRegion(c) {
  return c.region.replace(/^oss-/, '');
}

/**
 * 路径里每一段都要 percent-encode，但 `/` 本身不能编。
 * encodeURIComponent 还漏了 ! ' ( ) *，OSS 认的是严格 RFC3986。
 */
function encodePath(key) {
  return key
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    )
    .join('/');
}

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// ═══════════════════════ 签名 ═══════════════════════

/**
 * V4 签名（阿里云现在推荐的那一版，和 AWS SigV4 同构）。
 *
 * 负载一律按 UNSIGNED-PAYLOAD 算 —— 我们传的是几百 MB 的视频，
 * 为了签名先把整个文件读进内存算一遍 sha256，纯属自找麻烦。
 */
function signV4({ method, key, headers, c, ak, sk }) {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = stamp.slice(0, 8);
  const region = scopeRegion(c);

  const signed = { ...headers, 'x-oss-date': stamp, 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD' };

  // 参与签名的头：content-type / content-md5 / 所有 x-oss-*，按名字排序
  const names = Object.keys(signed)
    .map((n) => n.toLowerCase())
    .filter((n) => n === 'content-type' || n === 'content-md5' || n.startsWith('x-oss-'))
    .sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${String(signed[Object.keys(signed).find((k2) => k2.toLowerCase() === n)]).trim()}\n`)
    .join('');

  const canonicalRequest = [
    method,
    `/${c.bucket}/${encodePath(key)}`,
    '', // 查询串：我们这几个操作都不带
    canonicalHeaders,
    '', // AdditionalHeaders：不额外指定
    'UNSIGNED-PAYLOAD'
  ].join('\n');

  const scope = `${date}/${region}/oss/aliyun_v4_request`;
  const stringToSign = ['OSS4-HMAC-SHA256', stamp, scope, sha256hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`aliyun_v4${sk}`, date), region), 'oss'), 'aliyun_v4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    ...signed,
    Authorization: `OSS4-HMAC-SHA256 Credential=${ak}/${scope},Signature=${signature}`
  };
}

/**
 * V1 签名（HMAC-SHA1）。老，但十几年来一直能用。
 * 留着它是因为 V4 报「SignatureDoesNotMatch」时，用户没有任何办法自己往下查。
 */
function signV1({ method, key, headers, c, ak, sk }) {
  const date = new Date().toUTCString();
  const signed = { ...headers, Date: date };

  const ossHeaders = Object.keys(signed)
    .filter((n) => n.toLowerCase().startsWith('x-oss-'))
    .map((n) => `${n.toLowerCase()}:${String(signed[n]).trim()}`)
    .sort()
    .map((line) => `${line}\n`)
    .join('');

  const stringToSign = [
    method,
    signed['Content-MD5'] || '',
    signed['Content-Type'] || '',
    date,
    `${ossHeaders}/${c.bucket}/${key}`
  ].join('\n');

  const signature = crypto.createHmac('sha1', sk).update(stringToSign).digest('base64');
  return { ...signed, Authorization: `OSS ${ak}:${signature}` };
}

// ═══════════════════════ 请求 ═══════════════════════

/** OSS 的错误是一段 XML，把里面的 Code / Message 抠出来才有人话可说 */
function explain(status, body) {
  const code = (body.match(/<Code>([^<]+)<\/Code>/) || [])[1] || '';
  const msg = (body.match(/<Message>([^<]+)<\/Message>/) || [])[1] || '';
  const known = {
    NoSuchBucket: 'Bucket 名字不对，或者它不在你填的这个地域',
    AccessDenied: '这把 AccessKey 没有操作这个 Bucket 的权限（去 RAM 里给它挂上 AliyunOSSFullAccess，或者只给这个 Bucket 的读写）',
    InvalidAccessKeyId: 'AccessKey ID 不对（注意别把 ID 和 Secret 填反）',
    SignatureDoesNotMatch: 'AccessKey Secret 不对，或者签名版本不匹配',
    RequestTimeTooSkewed: '这台机器的时间和阿里云差太多，先把系统时间对准（服务器上装个 ntp）'
  };
  const extra = known[code] ? ` —— ${known[code]}` : '';
  return `OSS ${status} ${code || ''}${extra}${msg && !known[code] ? `：${msg}` : ''}`.trim();
}

async function send(method, key, body, extraHeaders = {}, { version } = {}) {
  const c = config();
  const { accessKeyId: ak, accessKeySecret: sk } = credentials();
  if (!ak || !sk) throw new Error('还没填 OSS 的 AccessKey');
  if (!c.bucket) throw new Error('还没填 Bucket 名字');

  const base = {
    ...extraHeaders,
    Host: signHost(c),
    'Content-Length': String(body ? Buffer.byteLength(body) : 0)
  };
  const use = version || c.signVersion;
  const headers = use === 'v1'
    ? signV1({ method, key, headers: base, c, ak, sk })
    : signV4({ method, key, headers: base, c, ak, sk });

  const url = `https://${signHost(c)}/${encodePath(key)}`;
  const res = await fetch(url, { method, headers, body: body || undefined });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(explain(res.status, text));
    err.status = res.status;
    err.ossCode = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || '';
    throw err;
  }
  return res;
}

/**
 * 发一次；签名不对就换一版再发一次。
 *
 * 只在**签名类**的错误上重试。权限不足、桶不存在换个签名版本一样失败，
 * 白白多一个来回，还会把真正的原因盖掉。
 */
async function sendWithFallback(method, key, body, headers = {}) {
  const c = config();
  try {
    return await send(method, key, body, headers);
  } catch (err) {
    const signIssue = err.ossCode === 'SignatureDoesNotMatch' || err.ossCode === 'InvalidArgument';
    if (!signIssue) throw err;
    const other = c.signVersion === 'v1' ? 'v4' : 'v1';
    const res = await send(method, key, body, headers, { version: other });
    // 成了就把它记下来，别每次都白跑一个来回
    settings.patch({ oss: { ...(settings.get('oss') || {}), signVersion: other } });
    return res;
  }
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.srt': 'application/x-subrip',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8'
};

export function contentTypeOf(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

/** 传一段内容上去，回它的公网地址 */
export async function putBuffer(key, buf, contentType) {
  const c = config();
  const full = c.prefix ? `${c.prefix}/${key}` : key;
  await sendWithFallback('PUT', full, buf, {
    'Content-Type': contentType || contentTypeOf(key),
    // 桶的默认 ACL 说了算；只有明确要公共读时才逐个对象放开
    ...(c.publicRead ? { 'x-oss-object-acl': 'public-read' } : {})
  });
  return { key: full, url: urlFor(full) };
}

/** 传一个本地文件上去 */
export async function putFile(localPath, key) {
  const buf = fs.readFileSync(localPath);
  return putBuffer(key || path.basename(localPath), buf, contentTypeOf(localPath));
}

export async function remove(key) {
  await sendWithFallback('DELETE', key, null);
  return true;
}

/**
 * 对象的访问地址。
 *
 * 公共读 → 永久地址；私有 → 限时签名地址。
 * 私有桶给的这个地址过期就打不开了，所以**不能存进项目文件里**当长期引用 ——
 * 存的是 key，要用的时候现签。
 */
export function urlFor(key) {
  const c = config();
  if (c.publicRead) return `https://${host(c)}/${encodePath(key)}`;
  return signedUrl(key, c.signedTtl);
}

/** 限时地址（V1 query 签名，各版本 OSS 都认，浏览器直接能打开） */
export function signedUrl(key, ttl = 3600) {
  const c = config();
  const { accessKeyId: ak, accessKeySecret: sk } = credentials();
  const expires = Math.floor(Date.now() / 1000) + Math.max(60, ttl);
  const stringToSign = ['GET', '', '', String(expires), `/${c.bucket}/${key}`].join('\n');
  const sig = crypto.createHmac('sha1', sk).update(stringToSign).digest('base64');
  const q = new URLSearchParams({ OSSAccessKeyId: ak, Expires: String(expires), Signature: sig });
  return `https://${host(c)}/${encodePath(key)}?${q}`;
}

/**
 * 连通性自检 —— 传一个探针上去，读回来，再删掉。
 *
 * 只"看看能不能连上"是不够的：真正会卡住人的是**写权限**。
 * 一把只读的 AccessKey 在任何"测试连接"里都表现正常，直到第一次出图完
 * 才报错，那时候钱已经花了。所以这里必须真写一次、真删一次。
 */
export async function probe() {
  const c = config();
  const steps = [];
  if (!c.bucket) return { ok: false, steps, error: '还没填 Bucket 名字' };
  const { accessKeyId: ak, accessKeySecret: sk } = credentials();
  if (!ak || !sk) return { ok: false, steps, error: '还没填 AccessKey（在上面的密钥那一栏）' };

  const key = `${c.prefix ? `${c.prefix}/` : ''}.probe/${Date.now()}.txt`;
  const body = Buffer.from(`futuredream probe ${new Date().toISOString()}`);
  try {
    await sendWithFallback('PUT', key, body, { 'Content-Type': 'text/plain' });
    steps.push({ step: '写入', ok: true });
  } catch (err) {
    steps.push({ step: '写入', ok: false, message: err.message });
    return { ok: false, steps, error: err.message };
  }

  try {
    const res = await fetch(urlFor(key));
    const got = await res.text();
    const same = res.ok && got === body.toString();
    steps.push({
      step: '读回',
      ok: same,
      message: same ? '' : `HTTP ${res.status}${c.publicRead ? '（桶不是公共读？把下面那个开关关掉试试）' : ''}`
    });
    if (!same) {
      await remove(key).catch(() => {});
      return { ok: false, steps, error: `传上去了，但取不回来（HTTP ${res.status}）` };
    }
  } catch (err) {
    steps.push({ step: '读回', ok: false, message: err.message });
    return { ok: false, steps, error: err.message };
  }

  try {
    await remove(key);
    steps.push({ step: '删除', ok: true });
  } catch (err) {
    // 删不掉不算失败：写和读都通了，功能是可用的，只是探针留了个小文件
    steps.push({ step: '删除', ok: false, message: `${err.message}（探针文件留在了 ${key}）` });
  }

  return { ok: true, steps, signVersion: config().signVersion, host: host(c) };
}

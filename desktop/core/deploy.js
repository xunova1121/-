/**
 * 部署形态。
 *
 * 这个应用有三种跑法，规矩**完全不同**，混在一起写迟早出事：
 *
 *   desktop  跑在你自己电脑上，只监听 127.0.0.1。
 *            "能打开这个端口的人本来就坐在这台机器前" —— 所以不要密码。
 *   lan      多开一个端口给同一个 Wi-Fi 下的手机。8 位配对码 + 只认私网 IP。
 *            局域网里的人是"半可信"：能扫到端口，但进不来。
 *   server   放在一台公网服务器上，24 小时开着，手机在哪儿都能用。
 *            **任何人都能打到这个端口**，所以规矩要按公网来定：
 *            长口令、每一条请求都要带、Host 必须是你配的那个域名。
 *
 * ── 上服务器之后，有两件事必须先想清楚 ──
 *
 * ① 密钥不再只在你自己机器里。
 *    它加密存在服务器上，而能 ssh 进那台机器的人就能拿到解密它的东西
 *    （除非用下面那个口令派生模式）。这是把应用放到服务器上的**固有代价**，
 *    不是这个实现的缺陷 —— 但必须让你知道，而不是等出事了才发现。
 *
 * ② 必须走 HTTPS。
 *    明文 HTTP 上跑访问口令，等于在公网上广播它。所以服务器模式默认
 *    要求 Host 和你配的域名一致，并且文档里只给"Caddy 自动签证书"这一条路。
 */
import crypto from 'node:crypto';
import * as settings from './settings.js';

export const MODE = (process.env.FUTUREDREAM_MODE || 'desktop').toLowerCase();
export const SERVER_MODE = MODE === 'server';

/** 公网访问的域名。服务器模式下必须给 —— 见 checkConfig 里为什么不给默认值。 */
export const PUBLIC_HOST = (process.env.FUTUREDREAM_PUBLIC_HOST || '').trim().toLowerCase();

/** 口令用去掉易混字符的字母表；32 位 ≈ 160 bit，公网上够用 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function newAccessToken(len = 32) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * 服务器模式的访问口令。
 *
 * 优先读环境变量（部署时用 compose 的 secret 或 .env 注入，不落到 settings.json）；
 * 没给就自己生成一个存进设置，并**打印到日志里** —— 容器里没人能"打开设置页面看一眼"，
 * 第一次启动那行日志就是你唯一能拿到它的地方。
 */
export function accessToken() {
  const fromEnv = (process.env.FUTUREDREAM_ACCESS_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  let t = settings.get('accessToken');
  if (!t) {
    t = newAccessToken();
    settings.patch({ accessToken: t });
    // eslint-disable-next-line no-console
    console.log(
      `\n══════════════════════════════════════════\n` +
        `  访问口令（第一次启动生成，请立刻记下来）：\n\n    ${t}\n\n` +
        `  手机 / 浏览器打开时要填它。想换一个：删掉设置里的 accessToken 重启，\n` +
        `  或者用 FUTUREDREAM_ACCESS_TOKEN 环境变量固定一个。\n` +
        `══════════════════════════════════════════\n`
    );
  }
  return t;
}

/**
 * 启动前的配置体检。**配错了就不启动**，而不是带着一个敞开的口子跑起来。
 *
 * 这一条是有意的：一个"少配了一项、于是谁都能进"的服务，比起不起来危险得多，
 * 而且没人会发现 —— 它看起来一切正常。
 */
export function checkConfig() {
  if (!SERVER_MODE) return { ok: true, notes: [] };
  const problems = [];
  const notes = [];

  if (!PUBLIC_HOST) {
    problems.push(
      '没给 FUTUREDREAM_PUBLIC_HOST。服务器模式必须写死你的域名（例：FUTUREDREAM_PUBLIC_HOST=fd.example.com）——' +
        '不写的话，任何解析到这台机器的域名都能打进来。'
    );
  }
  const token = accessToken();
  if (token.length < 20) {
    problems.push(`访问口令只有 ${token.length} 位，公网上太短了。至少 20 位。`);
  }
  if ((process.env.FUTUREDREAM_VAULT_PASS || '').trim()) {
    notes.push('密钥用口令派生的钥匙加密，服务器磁盘上没有可直接解密的钥匙文件。');
  } else {
    notes.push(
      '⚠ 密钥用的是磁盘上的钥匙文件（.vaultkey）。能读到这台机器文件的人就能解开它 —— ' +
        '想更严一档，用 FUTUREDREAM_VAULT_PASS 传一个口令，钥匙就不落盘了。'
    );
  }
  return { ok: problems.length === 0, problems, notes };
}

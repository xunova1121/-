import { providerById } from './providers.js';
import { abilityLines, cfgForLine } from '../src/llm/abilities.js';
import { routeFor, visionRoute } from '../src/llm/router.js';
import { imageModelOf, modelKind } from '../src/llm/images.js';
import { qweatherConfig } from '../src/core/qweather.js';

export const READINESS_ITEMS = {
  chat: ['对话模型', '模型中心 → 能力 / 服务商'],
  vision: ['看图模型', '模型中心 → 能力 → 看图'],
  image: ['画图模型', '模型中心 → 能力 → 画图'],
  weather: ['天气来源', '模型中心 → 服务商 → 其他服务的 Key'],
  pexels: ['Pexels 图库（可选）', '其他服务的 Key → 检测 pexels'],
  pixabay: ['Pixabay 图库（可选）', '其他服务的 Key → 检测 pixabay'],
  unsplash: ['Unsplash 图库（可选）', '其他服务的 Key → 检测 unsplash'],
  openverse: ['Openverse 图库（可选）', '其他服务的 Key → 检测 openverse'],
  office: ['Office 文档渲染', '运行任务的电脑 / 服务器安装 LibreOffice'],
  pdf: ['PDF 截图', '运行任务的电脑 / 服务器安装 Poppler'],
  fonts: ['中文字体', '运行任务的电脑 / 服务器安装中文字体'],
  ffmpeg: ['SVG 与音频处理', '运行任务的电脑 / 服务器安装 ffmpeg'],
  git: ['Git', '运行任务的电脑 / 服务器安装 Git'],
  sandbox: ['代码测试容器', '服务器部署设置 JARVIS_CODE_SANDBOX_IMAGE'],
  browser: ['网页检查容器', '服务器部署设置 JARVIS_CODE_BROWSER_IMAGE'],
  skills: ['技能运行容器', '服务器部署设置 JARVIS_SKILL_RUNNER_IMAGE']
};
export const READINESS_CODES = {
  configured: ['configured', '配置已填写；尚未验证实际请求'],
  missing: ['missing', '缺少有效配置，请按处理位置补齐'],
  demo: ['demo', '当前为内置演示，不是真实模型'],
  free_weather: ['configured', '将使用免费基础天气；本次没有测试联网取数'],
  stock_unverified: ['configured', '尚未通过图库连接检测，暂不启用'],
  stock_verified: ['verified', '上次图库 API 与图片下载检测通过；不代表本次制作已通过'],
  executable: ['ready', '程序可运行；实际文件处理仍需任务验收'],
  font_ready: ['ready', '发现支持中文的字体；实际版式仍需渲染验收'],
  font_missing: ['unavailable', '未发现支持中文的字体，请安装中文字体；实际版式仍需渲染验收'],
  command_missing: ['unavailable', '程序缺失、不可执行或检查超时'],
  image_present: ['configured', '本地镜像存在；容器中的实际执行尚未验证'],
  image_missing: ['unavailable', '本地镜像或 Docker 不可用；没有自动拉取镜像'],
  sandbox_ready: ['ready', '已在断网只读容器中验证 Node、npm 和超时命令；不是项目测试通过'],
  sandbox_failed: ['unavailable', '镜像无法完成 Node、npm 或超时命令检查，请核对镜像兼容性'],
  cleanup_failed: ['unavailable', '不能确认检查容器已清理，请管理员核查'],
  server_only: ['unknown', '本机本轮未检查云端容器，请切到云服务器自检'],
  unknown: ['unknown', '尚未检查或当前环境无法检查']
};

/** 报告只承载受控编号与时间，不装入配置、URL、Key、命令输出或异常原文。 */
export function readinessItem(id, code, checkedAt) {
  if (typeof id !== 'string' || !Object.hasOwn(READINESS_ITEMS, id)) return null;
  if (typeof code !== 'string' || !Object.hasOwn(READINESS_CODES, code)) code = 'unknown';
  const allowed =
    id === 'chat'
      ? ['configured', 'missing', 'demo', 'unknown']
      : ['vision', 'image'].includes(id)
        ? ['configured', 'missing', 'unknown']
        : id === 'weather'
          ? ['configured', 'missing', 'free_weather', 'unknown']
          : ['pexels', 'pixabay', 'unsplash', 'openverse'].includes(id)
            ? ['missing', 'stock_verified', 'stock_unverified', 'unknown']
            : id === 'fonts'
              ? ['font_ready', 'font_missing', 'command_missing', 'unknown']
              : ['sandbox', 'browser', 'skills'].includes(id)
                ? [
                    'missing',
                    'image_present',
                    'image_missing',
                    'server_only',
                    'unknown',
                    ...(id === 'sandbox' ? ['sandbox_ready', 'sandbox_failed', 'cleanup_failed'] : [])
                  ]
                : ['executable', 'command_missing', 'unknown'];
  if (!allowed.includes(code)) code = 'unknown';
  return { id, code, status: READINESS_CODES[code][0], ...(Number.isFinite(checkedAt) && checkedAt > 0 && checkedAt <= 8640000000000000 && { checkedAt }) };
}
function modelCheck(cfg, kind, gatewayKeys) {
  if (!cfg) return readinessItem(kind, 'unknown');
  try {
    const line =
      kind === 'vision'
        ? visionRoute(cfg)
        : kind === 'image'
          ? abilityLines(cfg, 'image').main || { provider: cfg.provider, model: imageModelOf(cfg) }
          : routeFor(cfg, 'chat');
    const provider = line && providerById(line.provider);
    if (!provider) return readinessItem(kind, 'missing');
    if (provider.kind === 'mock') return readinessItem(kind, kind === 'chat' ? 'demo' : 'missing');
    if (kind === 'image' && !['openai', 'multi'].includes(provider.kind)) return readinessItem(kind, 'missing');
    const selected = cfgForLine(cfg, line);
    const rawKey = selected.keys?.[line.provider];
    const key =
      (typeof rawKey === 'string' && Boolean(rawKey.trim()) && !rawKey.startsWith('••')) || (Array.isArray(gatewayKeys) && gatewayKeys.includes(line.provider));
    let endpoint = !provider.custom;
    if (provider.custom) {
      try {
        const url = new URL(selected.baseURLs?.[line.provider]);
        endpoint = ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
      } catch {
        endpoint = false;
      }
    }
    const expectedKind = kind === 'image' ? 'image' : 'chat';
    const valid =
      typeof line.model === 'string' && line.model.trim() && modelKind(line.model) === expectedKind && (provider.needsKey === false || key) && endpoint;
    return readinessItem(kind, valid ? 'configured' : 'missing');
  } catch {
    return readinessItem(kind, 'missing');
  }
}
export function configurationReadiness(cfg, { gatewayKeys = [], now = Date.now() } = {}) {
  const checks = ['chat', 'vision', 'image'].map((kind) => modelCheck(cfg, kind, gatewayKeys));
  checks.push(
    readinessItem('weather', !cfg ? 'unknown' : qweatherConfig(cfg) ? 'configured' : cfg.qweatherKey || cfg.qweatherHost ? 'missing' : 'free_weather')
  );
  for (const provider of ['pexels', 'pixabay', 'unsplash', 'openverse']) {
    const checked = cfg?.stockVerified?.[provider];
    const at = checked?.at;
    const configured = provider === 'openverse' || Boolean(cfg?.[provider + 'Key']);
    const verified = configured && checked?.ok === true && Number.isFinite(at) && at > 0 && at <= now + 60000;
    checks.push(
      readinessItem(provider, !cfg ? 'unknown' : !configured ? 'missing' : verified ? 'stock_verified' : 'stock_unverified', verified ? at : undefined)
    );
  }
  return checks;
}
/** 拷贝/显示都走同一白名单；旧服务器或未知字段不伪装成检查通过。 */
export function normalizeReadiness(raw, expectedScope) {
  if (
    raw?.schemaVersion !== 1 ||
    raw.scope !== expectedScope ||
    !['local', 'server'].includes(expectedScope) ||
    raw.modelRequested === true ||
    raw.configurationChanged === true
  )
    throw Object.assign(new Error('能力自检响应不兼容'), { code: 'READINESS_PROTOCOL' });
  const ids = new Set();
  const checks = (Array.isArray(raw.checks) ? raw.checks : []).slice(0, 24).flatMap((row) => {
    if (!row || ids.has(row.id)) return [];
    const item = readinessItem(row.id, row.code, row.checkedAt);
    if (!item) return [];
    ids.add(row.id);
    return [item];
  });
  const summary = { ready: 0, verified: 0, configured: 0, missing: 0, unavailable: 0, unknown: 0, demo: 0 };
  if (checks.length !== Object.keys(READINESS_ITEMS).length) throw Object.assign(new Error('能力自检报告缺项'), { code: 'READINESS_PROTOCOL' });
  for (const row of checks) summary[row.status]++;
  return {
    schemaVersion: 1,
    scope: expectedScope,
    version: typeof raw.version === 'string' && raw.version.length <= 30 && /^(?:\d+\.\d+\.\d+|development)$/.test(raw.version) ? raw.version : 'unknown',
    checkedAt: Number.isFinite(raw.checkedAt) && raw.checkedAt > 0 && raw.checkedAt <= 8640000000000000 ? raw.checkedAt : null,
    modelRequested: false,
    configurationChanged: false,
    checks,
    summary
  };
}
export function readinessReport({ scope, cfg, gatewayKeys, runtime = {}, now = Date.now() }) {
  const configuration = configurationReadiness(cfg, { gatewayKeys, now });
  const configIds = new Set(configuration.map((row) => row.id));
  const observations = new Map(
    [...configuration, ...(runtime.checks || []).filter((row) => row && !configIds.has(row.id))].filter(Boolean).map((row) => [row.id, row])
  );
  return normalizeReadiness(
    {
      schemaVersion: 1,
      scope,
      version: runtime.version,
      checkedAt: runtime.checkedAt || now,
      checks: Object.keys(READINESS_ITEMS).map((id) => observations.get(id) || readinessItem(id, 'unknown'))
    },
    scope
  );
}

/**
 * 三端能力清单 —— 谁该有什么功能，这里是唯一的事实来源。
 *
 * ── 为什么需要它 ──
 *
 * 这个应用有三张脸：电脑版（ui/）、手机版（ui/m/）、安卓壳（android/，
 * 里面装的就是手机版那张网页）。加一个功能时，很自然只在自己正在改的那一端加完
 * 就算完事 —— 于是手机版慢慢落后成一个"只能看不能改"的残废，而且**没人会发现**，
 * 因为两端的测试各自都是绿的。
 *
 * 这件事靠"记得同步"是管不住的。所以把它变成一条会报错的规矩：
 * 每加一个功能，就在这里登记一行，并在两端的代码里留一个标记。
 * 哪一端漏了，自检当场红给你看，而不是等三个月后用户在手机上找不到那个按钮。
 *
 * ── 标记怎么写 ──
 *
 * 在实现处写一行注释：`// cap:<id>`。用显式标记而不是猜函数名，是因为
 * 猜出来的规则迟早会因为改名而失灵，而失灵的方式是**悄悄放行**——
 * 那比没有这条规矩更糟。
 *
 * ── mobile 为空是什么意思 ──
 *
 * 不是"还没做"，是**故意不做**：服务商、密钥、请求记录、路由体检这些属于
 * 配置和排错，坐在电脑前做才合适，塞进手机只会让两边都难用。
 * 每一条都写清楚原因，免得后来的人（包括我自己）又"补齐"一遍。
 */

export const CAPABILITIES = [
  // ── 内容编辑：手机上必须都能做，出门在外改一行字比什么都急 ──
  {
    id: 'script-edit',
    name: '写 / 改剧本',
    api: 'PATCH /projects/:id { script }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'shot-text',
    name: '改分镜画面描述',
    api: 'PATCH /projects/:id/shots/:sid { description }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'shot-dialogue',
    name: '改台词和说话人',
    api: 'PATCH /projects/:id/shots/:sid { dialogue, speaker }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'shot-camera',
    name: '改景别、运镜、时长',
    api: 'PATCH /projects/:id/shots/:sid { camera, motion, duration }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'shot-sound',
    name: '写画外音效（不进画面）',
    api: 'PATCH /projects/:id/shots/:sid { sound }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'shot-transition',
    name: '改转场形式（硬切/黑场/叠化）',
    api: 'PATCH /projects/:id/shots/:sid { transition }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'shot-segment',
    name: '改这一镜属于第几场',
    api: 'PATCH /projects/:id/shots/:sid { segment }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'bible-edit',
    name: '改设定集里的外貌描述',
    api: 'PATCH /projects/:id { bible }',
    pc: 'ui/views/bible.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'sheet-regen',
    name: '单独重出一张参考图',
    api: 'POST /projects/:id/bible/:kind/:name/sheet',
    pc: 'ui/views/bible.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'style-pick',
    name: '选画风 / 写自定义风格描述',
    api: 'PATCH /projects/:id { styleId, style }',
    pc: 'ui/views/projects.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'style-sync',
    name: '把画风同步进设定集',
    api: 'POST /projects/:id/style/sync',
    pc: 'ui/views/bible.js',
    mobile: 'ui/m/m.js'
  },

  // ── 跑流水线：手机上要能发起，不然"看到第 3 镜失败了"也只能干等 ──
  {
    id: 'run-stage',
    name: '跑某一步',
    api: 'POST /projects/:id/stage/:stage',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'run-from',
    name: '从这一步往后全跑',
    api: 'POST /projects/:id/stage/all { from }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'shot-regen',
    name: '单独重出一镜的图 / 视频',
    api: 'POST /projects/:id/shots/:sid/image|video',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },

  // ── 成片 ──
  {
    id: 'film-view',
    name: '看成片',
    api: 'GET /media',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'image-zoom',
    name: '点开看大图',
    api: '（纯前端）',
    pc: 'ui/lightbox.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'asset-pack',
    name: '素材打包下载',
    api: 'GET /projects/:id/export.zip',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'project-switch',
    name: '切换项目',
    api: 'GET /projects',
    pc: 'ui/views/projects.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'project-new',
    name: '新建项目',
    api: 'POST /projects',
    pc: 'ui/views/projects.js',
    mobile: 'ui/m/m.js'
  },

  {
    id: 'link-batch',
    name: '一段镜头一起标衔接关系',
    api: 'POST /projects/:id/shots/link',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'tier-routing',
    name: '按镜头分级挑模型（省钱）',
    api: 'PATCH /projects/:id/shots/:sid { tier } + PATCH /settings { videoTiers }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'job-cancel',
    name: '把正在跑的任务停下来',
    api: 'POST /projects/:id/cancel',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'account-login',
    name: '用账号密码登录',
    api: 'POST /account/login',
    pc: 'ui/app.js',
    mobile: 'ui/m/m.js'
  },

  // ── 只在电脑上做的事 ──
  {
    id: 'providers',
    name: '服务商与密钥',
    api: 'POST /providers/:id/keys',
    pc: 'ui/views/providers.js',
    mobile: null,
    why: '密钥只该在跑引擎的那台机器上。手机丢了不等于密钥丢了 —— 这是这套架构的一条底线。'
  },
  {
    id: 'routing',
    name: '模型路由与体检',
    api: 'GET /routing',
    pc: 'ui/views/settings.js',
    mobile: null,
    why: '选模型要对着价格、能力、延迟一起看，手机屏幕上摆不下，也不是出门在外会做的事。'
  },
  {
    id: 'debug-console',
    name: '第三方 API 联调台',
    api: 'POST /debug/request',
    pc: 'ui/views/debug.js',
    mobile: null,
    why: '排错工具。要贴 JSON、看原始响应、改请求头，手机上做这些是自找麻烦。'
  },
  {
    id: 'logs',
    name: '请求记录',
    api: 'GET /logs',
    pc: 'ui/views/logs.js',
    mobile: null,
    why: '同上，排错用。手机上看一屏截断的 JSON 没有意义。'
  },
  {
    id: 'account-devices',
    name: '改密码 / 踢设备下线',
    api: 'GET+DELETE /account/sessions',
    pc: 'ui/views/settings.js',
    mobile: null,
    why: '手机丢了要在**别的设备**上踢它 —— 在丢了的那台上操作没有意义。放电脑上正合适。'
  },
  {
    id: 'remote-engine',
    name: '电脑版连服务器（三端共用一份数据）',
    api: '（Electron 壳）',
    pc: 'electron/main.js',
    mobile: null,
    why: '手机本来就是连服务器的，没有"要不要连"这个选择。'
  },
  {
    id: 'oss-config',
    name: '对象存储配置',
    api: 'PATCH /settings { oss }',
    pc: 'ui/views/settings.js',
    mobile: null,
    why: 'AccessKey 和密钥同理，只在电脑上配。'
  }
];

/** 手机端该有的那些 */
export function mobileCaps() {
  return CAPABILITIES.filter((c) => c.mobile);
}

/** 标记长什么样。两端都按这个找 */
export function marker(id) {
  return `cap:${id}`;
}

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
    api: 'POST /projects/:id/bible/:kind/:name/regenerate',
    pc: 'ui/views/bible.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'sheet-angles',
    name: '补出侧面 / 背面 / 俯视等角度',
    api: 'POST /projects/:id/bible/:kind/:name/angles',
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
    api: 'POST /projects/:id/shots/:sid/regenerate { kind }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },

  // ── 成片 ──
  {
    id: 'film-view',
    name: '看成片',
    api: 'GET /media?p= （不在 /api 前缀下）',
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
    id: 'shot-stage',
    name: '预演台：排机位、看景别、查越轴',
    api: 'PATCH /projects/:id/shots/:sid { stage }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'line-kind',
    name: '台词类型（对白 / 心里话 / 旁白 / 画外音）',
    api: 'PATCH /projects/:id/shots/:sid { lineKind }',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'quality-report',
    name: '成片体检（现在能不能发）',
    api: 'GET /projects/:id/quality',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'shot-versions',
    name: '看历史版本 / 回到某一版',
    api: 'GET+POST /projects/:id/shots/:sid/versions',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'link-auto',
    name: '自动标出哪几镜是连续动作',
    api: 'POST /projects/:id/shots/link/auto',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  {
    id: 'tier-routing',
    name: '按镜头分级挑模型（省钱）',
    api: 'PATCH /projects/:id/shots/:sid { tier } + POST /settings { videoTiers }',
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
  /**
   * 待认领：提交成功了、钱花了、片子在厂商那边，我们没取回来。
   *
   * 这一条原来**只有电脑版有**，而且没在这份清单里登记过 ——
   * 所以三端对齐那条自检一直是绿的，漏得毫无声息。
   * 代价是实打实的钱：手机上看到"有图没视频"，唯一能做的动作就是重出，
   * 而重出等于第二次付钱，第一次那份还好好地在厂商那儿放着。
   */
  {
    id: 'task-reclaim',
    name: '把已经付过钱的任务捞回来（不花钱）',
    api: 'GET /projects/:id/tasks + POST /projects/:id/tasks/recheck',
    pc: 'ui/views/studio.js',
    mobile: 'ui/m/m.js'
  },
  /**
   * 出片规格（画幅 + 视频分辨率），记在**项目**上。
   *
   * 用户的原话："有的时候是在手机新建项目，不默认他们的设置"。
   * 全局设置是坐在电脑前为上一部片子调的 —— 手机上新建一部竖屏短剧，
   * 却继承了上一部横屏纪录片的比例，而这两样一旦跑起来就改不动了：
   * 分镜图按那个比例出完，视频跟着图走，发现不对时钱已经花掉了。
   */
  {
    id: 'project-format',
    name: '这部片子的画幅和分辨率',
    api: 'PATCH /projects/:id { aspectRatio, videoResolution }',
    pc: 'ui/views/projects.js',
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
    api: 'POST /secrets { secrets }',
    pc: 'ui/views/providers.js',
    mobile: null,
    why: '密钥只该在跑引擎的那台机器上。手机丢了不等于密钥丢了 —— 这是这套架构的一条底线。'
  },
  {
    id: 'routing',
    name: '模型路由与体检',
    api: 'POST /routing/check',
    pc: 'ui/views/settings.js',
    mobile: null,
    why: '选模型要对着价格、能力、延迟一起看，手机屏幕上摆不下，也不是出门在外会做的事。'
  },
  {
    id: 'debug-console',
    name: '第三方 API 联调台',
    api: 'POST /debug/send',
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
    id: 'film-cut',
    name: '剪辑台：拖拽排序 / 设入出点 / 跳过某镜 / 转场 / 画面效果 / 静音',
    api: 'PATCH /projects/:id { edit }',
    pc: 'ui/views/studio.js',
    mobile: null,
    why: '一屏要同时看十几条片段的缩略图、时长和入出点，还要来回拖顺序 —— '
      + '390px 宽摆不下，拖拽在拇指上也很难精确。手机上该做的是"看到不对、当场改一句、重出"，'
      + '而剪辑是坐下来一次做完的事。⚠ 这一条是有意为之，不是漏做：等手机上真的需要时再单独设计，'
      + '而不是把电脑那套缩小塞进去。'
  },
  {
    id: 'film-music',
    name: '给成片配背景音乐（自动避让台词）',
    api: 'POST /projects/:id/music',
    pc: 'ui/views/studio.js',
    mobile: null,
    why: '和剪辑台是同一块面板：调音量、开关避让都要一边听成片一边试，'
      + '而这件事在手机上做不了（改一次要重新合成，手机上等不起，也听不准）。'
      + '⚠ 有意为之：等手机上真的需要时单独设计一个"换一首就好"的极简版，'
      + '而不是把这一整排滑块塞进 390px。'
  },
  {
    id: 'oss-config',
    name: '对象存储配置',
    api: 'POST /settings { oss }',
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

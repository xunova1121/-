/**
 * 应用设置（非机密）。机密一律走 vault.js，两者分家是刻意的：
 * settings.json 明文可读、可以直接手改、可以贴给同事复现问题；
 * credentials.enc 加密、不外传。
 */
import fs from 'node:fs';
import { SETTINGS_FILE, DATA_DIR } from './paths.js';

const DEFAULTS = {
  /** 各服务商的 baseUrl 覆盖：{ dashscope: 'https://…' } —— 走内网网关时改这里 */
  baseUrls: {},
  /**
   * 单个接口地址的覆盖，键是 `<服务商>.<接口名>`，例如
   * `{ 'metaso.videoQuery': 'https://metaso.cn/api/minimax/v2/query/xxx' }`。
   *
   * 为什么需要这个：中转平台常常只公开"提交"那一步的地址，查任务的路径要靠猜。
   * 猜错了就会出现"厂商那边早就出片了，这边还在轮询"。
   * 与其等我改目录，不如让你在界面上把查到的地址直接填进来 —— 填完立刻生效。
   */
  endpointOverrides: {},
  /**
   * 能力路由：每种能力单独选厂商 + 模型。
   * 拆开而不是"选一家全包"，是因为各家强项差别很大 ——
   * 剧本用 DeepSeek/Qwen 便宜好用，出图火山 Seedream 稳，
   * 视频看谁家额度多，一致性复核必须挑带视觉的。
   */
  chatProvider: 'volcengine',
  chatModel: 'doubao-1-5-pro-32k-250115',
  /**
   * 调度模型：挑技法、绑说话人、给长篇分章。
   *
   * 和"剧本模型"分开，是因为这两件事要的能力**不是一回事**：
   *   写剧本、拆分镜 → 生成能力，写得顺就行，便宜的模型完全够用；
   *   调度           → 判断能力。它要同时端着二十镜的上下文，
   *                    判断"这两镜是不是同一场戏"、"这句话是谁说的"、
   *                    "这里该不该用荷兰角"。便宜模型在这类题上会稳定地犯同一种错：
   *                    每镜孤立地看，答得都像那么回事，连起来全是矛盾。
   *
   * 留空 = 跟随剧本模型（不想多配一个的人什么都不用做）。
   * 推荐 doubao-seed-1-6-thinking-250615：方舟托管的思考型模型，
   * 这类"读一遍全片再做判断"的活儿比 1.5 Pro 强一档，而且调用次数很少 ——
   * 全片挑技法、绑说话人各一次，贵一点也贵不到哪儿去。
   */
  directorProvider: '',
  directorModel: '',
  visionProvider: 'volcengine',
  visionModel: 'doubao-seed-1-6-250615',
  imageProvider: 'volcengine',
  imageModel: 'doubao-seedream-3-0-t2i-250415',
  /**
   * 图生图模型。**默认不用它出分镜图**（见下面那个开关）。
   *
   * 留着是因为「设定集」页单独重出一张设定图、以及以后需要图生图时用得上。
   */
  imageEditModel: 'doubao-seededit-3-0-i2i-250628',
  /**
   * 本地出图（ComfyUI）用的工作流，API 格式的 JSON 原文。
   *
   * ⚠ 为什么是**用户自己的工作流**而不是我们内置一份：
   * 有人用 SDXL、有人用 Flux，有人挂三个 LoRA 加 ControlNet。
   * 内置一份等于把 ComfyUI 最值钱的部分（可定制）扔掉 ——
   * 那还不如直接调厂商接口。
   *
   * 他在 ComfyUI 里给要我们填的节点改个标题（FD_PROMPT / FD_SEED /
   * FD_SIZE / FD_REF / FD_NEGATIVE），导出「API 格式」贴进来。
   * 具体规矩见 providers/comfy.js。
   */
  comfyWorkflow: '',
  /**
   * 分镜图要不要改用图生图模型（把设定图当参考图喂进去）。
   *
   * 默认**关**。道理上"带着角色设定图去出这一镜"应该更一致，实际不是：
   * SeedEdit 这类模型是**编辑**模型 —— 它拿到一张图之后是在那张图上改，
   * 而不是照着它另画一个场景。于是出来的分镜图会长得像"被改过的角色设定图"
   * （人物居中、纯色背景还在），根本不是你要的那一镜。
   *
   * 关掉之后走的是文生图 + 冻结描述 + 稳定种子这条路，也就是这个应用
   * 早期版本的做法 —— 实测下来分镜图的一致性反而更高、构图也正常。
   * 参考图那一层仍然在**出视频**时发挥作用（首帧图 + r2v 通道）。
   */
  useEditModelForShots: false,
  /**
   * 视频提示词的详略。
   *
   *   precise（默认）  只说首帧图回答不了的部分：演什么动作、镜头怎么动、
   *                    谁在说什么、和上一镜怎么接。八十来字。
   *   full             再加上角色外貌锚、场景、景别、氛围、完整衔接约束。
   *
   * 默认精准，是因为带首帧时图已经回答了一大半问题（人、衣服、场景、光线、景别）。
   * 用文字把这些复述一遍，模型就得在"照着图"和"照着字"之间选边 —— 而它经常选错，
   * 表现就是"出来的视频和分镜图不像"。没有首帧的纯文生视频会自动按 full 走。
   */
  videoPromptMode: 'precise',
  videoProvider: 'volcengine',
  videoModel: 'doubao-seedance-1-0-pro-250528',
  ttsProvider: 'dashscope',
  ttsModel: 'qwen3-tts-flash',

  /**
   * 音效。**默认空 = 不做音效**，而不是回退到配音模型。
   *
   * 回退是这里最容易犯的错：音效和配音是两种模型，拿配音模型去做
   * "敲门声"，出来的是一个人**念这三个字**，而且会被当成成片的一部分交付。
   * 宁可没有音效，也不要一段说着"敲门声"的人声。
   */
  sfxProvider: '',
  sfxModel: '',

  /**
   * 「连续动作」的两镜之间，怎么让接缝真的连上。
   *
   *   lock   首尾帧：本镜的图当首帧、**下一镜的图当末帧**。默认。
   *          要厂商收末帧（catalog 里的 videoDefaults.endFrame 说了算）。
   *   tail   把上一段视频的**真实末帧**抠出来，当这一镜的首帧。
   *          每一家 i2v 都收首帧图，所以不依赖厂商任何支持；
   *          代价是只钉住起点，结尾由模型发挥，误差沿链累积。
   *   off    什么都不做，只靠提示词衔接。
   *
   * ⚠ 两种模式**看起来完全不一样**，这一点最容易被当成故障：
   *   lock 下每一段视频**仍然是从自己那张图开始的** —— 接缝是靠
   *        逼上一段"结束在你这张图上"做出来的，做在**上一镜**身上。
   *   tail 下这一段的第一帧才真的是上一段的最后一帧。
   * 所以选了 lock 又去看"本段首帧是不是上段尾帧"，答案永远是否 ——
   * 而那不是没生效。
   *
   * ⚠ 无论哪一种，**都只在标着「连续动作」的两镜之间发生**。
   * link 不会被自动推断出 continuous（deriveLink 只给 new-scene / cut），
   * 所以一个都没标的项目上，接缝一处也不会做 —— 这是最常见的"没生效"。
   *
   * 默认之所以敢是 lock：videoContextFor 里兜了一层 —— 碰上不收末帧的厂商
   * 会自动退回接住真实末帧，并说清楚退了。没有那一层的话，这个默认值
   * 在那几家上会**一处接缝都不做**，比原来的默认还差。
   */
  seamMode: 'lock',
  /**
   * 自动剪辑：合成时给每段挑入点，跳掉开头那几帧不动的。
   *
   * 默认开。它只丢掉**本来就没有内容**的那几帧（模型起势时首帧的复制），
   * 而留着它们的代价是二十镜连起来整片发黏 —— 那种黏滞感逐段看是发现不了的。
   * 有安全带：最多砍 1 秒，整段都不动时（静止空镜）一帧都不剪。
   */
  autoCut: true,
  /**
   * 音效在成片里的音量倍数。
   *
   * 0.35 大约是 −9dB。音效必须**压在台词底下** —— 等响的话，
   * 一声关门就能把一句台词盖掉，而那句台词是观众唯一的信息来源。
   * 这是混音里最基本的一条，也是自己做音频最容易做砸的一处。
   */
  sfxGain: 0.35,
  /**
   * 统一响度：合成时把整条音轨拉到 −16 LUFS。
   *
   * 不做的话，不同厂商的 TTS、不同来源的背景音乐各有各的响度 ——
   * 观众要一集一集去调音量，而这恰恰是"业余"最直接的信号。
   * −16 LUFS 是短视频平台的常见口径（抖音/YouTube 大致在 −14~−16）。
   *
   * 要 FFmpeg 的 loudnorm 滤镜。老版本没有的话这一步会失败，
   * 所以合成那儿必须能退回"不做响度统一"，而不是把整部片子带崩。
   */
  loudness: true,

  // ───── 时长 ─────
  /**
   * 成片时长策略。
   *   keep  保留模型给的完整片段（默认）。运动是完整的，代价是成片比计划长
   *   trim  按分镜时长裁剪，能精确命中目标；代价是可能切在动作中途
   *
   * ── 默认从 trim 改成了 keep ──
   *
   * 用户的原话："有的时候画面还没演示完就拼凑到下一个画面了，
   * 为了硬拼时间，把一些好的画面给截了"。
   *
   * 这不是偶发，是 trim 的**必然结果**，而且和厂商的档位撞在一起放大了：
   * 各家视频模型只出固定档（秘塔 5/10/15，海螺 6/10）。分镜写 4 秒，
   * 厂商给 5 秒，trim 再切回 4 秒 —— 被切掉的那一秒**正好是动作收尾**，
   * 因为模型是按"这一段演完"来编排节奏的，起手慢、收在最后。
   *
   * 也就是说 trim 系统性地砍掉每一镜最好的那一截，去凑一个
   * **本来就不准的计划值**（那个 4 秒是拆分镜时估的，不是量出来的）。
   *
   * 目标时长仍然有用 —— 它决定拆多少镜。但拆完之后，让每一镜演完，
   * 比让总长精确命中一个估算值要紧得多。要卡死总长的人改回 trim。
   */
  durationPolicy: 'keep',
  /** 新项目的默认目标时长（秒） */
  defaultTargetDuration: 60,

  // ───── 画面规格 ─────
  /**
   * 视频分辨率档位。'auto' = 跟随所选服务商的默认档。
   * 存的是"用户选的那个词"而不是每家一份配置：各家拼写不统一（720p / 720P / 2K），
   * 发送前由 catalog.resolveResolution 按大小写不敏感匹配翻译成该家的原样写法，
   * 换服务商也不会因为写法对不上而整条流水线报错。
   */
  videoResolution: 'auto',
  /** 画幅。视频和出图共用一个，免得成片里图和视频比例打架。 */
  aspectRatio: '16:9',
  /**
   * 把字幕烧进画面。默认关。
   *
   * 关着也会生成 .srt（那一步不花钱也不会失败）。烧字幕要 FFmpeg 编进了 libass、
   * 系统里还得有能显示中文的字体 —— 缺哪个都会失败，所以不默认开。
   * 就算开了，烧失败也只丢字幕不丢成片。
   */
  burnSubtitles: false,

  // ───── 一致性引擎 ─────
  /** 关掉就是纯"提示词 + 种子"，省一次视觉调用，但崩了不会自动发现 */
  consistencyVerify: true,
  /** 复核低于这个分数就重试 */
  consistencyThreshold: 75,
  /** 单镜最多重试几次 */
  consistencyMaxRetries: 2,
  /** 出镜头图时是否把角色设定图作为参考图带上（最关键的一层，别关） */
  useReferenceImages: true,
  requestTimeoutMs: 120000,
  pollIntervalMs: 3000,
  pollTimeoutMs: 600000,
  /**
   * 图生视频要求首帧图是公网可达的 URL，本地文件不行。
   * 这里填一个"收 multipart 上传、返回 {url}"的接口即可（OSS 直传网关 / 自建图床）。
   */
  uploadGateway: '',
  /** 留空则自动探测：先看 desktop/bin，再看 PATH */
  ffmpegPath: '',
  /**
   * 走 Windows 的系统代理（只有桌面版有这个能力）。
   *
   * Node 自带的 fetch 不读系统代理，一律直连 —— 公司网络下就是连不上，
   * 报 UND_ERR_CONNECT_TIMEOUT。打开这个开关会改用 Electron 的网络栈，
   * 它跟浏览器一样读系统代理。默认关：换网络栈有风险，不该悄悄替所有人换。
   */
  useSystemProxy: false,
  /**
   * 打开应用时自动探一遍当前路由到的服务商。
   * 只发最便宜的探针（列模型 / max_tokens=1），不出图不出视频。
   * 默认开：配置坏了应该在你下手之前就知道，而不是跑到第 04 步等两分钟才被告知。
   */
  autoCheckOnStart: true,
  /**
   * 顶部那条"服务商连不通"的横幅。**默认关**。
   *
   * 自检本身照旧跑（它很便宜，而且结果会显示在顶部信号链的 ✓/✕ 上），
   * 只是不再往页面顶上压一条红横幅：探针连不通有太多不是真问题的原因 ——
   * 网络慢、厂商抖一下、某家压根没有便宜的探测接口。
   * 一条常驻的红横幅会让人很快学会无视所有横幅，包括真正要紧的那些。
   */
  routeBannerOn: false,
  /**
   * 你自己的单价表。键是 `厂商:模型:口径`，见 core/pricing.js。
   *
   * ⚠ 这里**默认是空的，而且不会由我们预填**。理由写在 pricing.js 头上，
   * 一句话：各家单价我只有个印象，印象写进代码就变成了断言；
   * 而且标价本来就不是你的价（有额度包、有企业协议、走中转的能差一倍）。
   *
   * 空着照样能用 —— 用量（几张图、多少秒、多少字）一直在记、一直在显示，
   * 那部分一个字都不是猜的。填了单价，钱才出现，而且**过去的账会一起亮起来**
   * （账本存的是用量不是钱，随时能按新单价重算）。
   */
  rates: {},
  theme: 'dark',
  port: 5178,

  // ───── 手机遥控 ─────
  /**
   * 允许手机从局域网连进来。默认关，而且是**另开一个端口**监听 ——
   * 这条口子后面是 API 密钥和额度，规矩必须和本机那条分开写死。见 core/server.js。
   * 手机端页面在 ui/m/，开关和配对码在「设置 → 手机遥控」。
   */
  lanAccess: false,
  /** 配对码。开启时自动生成，手机连进来必须带上它。 */
  lanToken: ''
};

let cache = null;

export function all() {
  if (cache) return cache;
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    disk = {};
  }
  cache = {
    ...DEFAULTS,
    ...disk,
    baseUrls: { ...DEFAULTS.baseUrls, ...(disk.baseUrls || {}) },
    endpointOverrides: { ...DEFAULTS.endpointOverrides, ...(disk.endpointOverrides || {}) },
    rates: { ...DEFAULTS.rates, ...(disk.rates || {}) }
  };
  return cache;
}

export function get(key) {
  return all()[key];
}

export function patch(changes = {}) {
  /**
   * `undefined` 意思是"这次没提供这一项"，不是"把它清成空"。
   *
   * 不剔掉的话，展开时它会**盖掉已经合好的默认值**：`{...all(), seamMode: undefined}`
   * 得到的 seamMode 是 undefined，而 all() 认缓存、不会再合一次 DEFAULTS ——
   * 于是这一项从此没有值。接缝那个开关就是这么丢的：默认写着 lock，
   * 取出来却是 undefined，靠调用处一路 `|| 'lock'` 兜着，
   * 而漏兜的那一处（比如某个只写 `settings.get('seamMode') === 'lock'` 的判断）
   * 会安静地走到反面。
   *
   * JSON 序列化本来就会丢掉 undefined 的键，所以这里剔掉它也不改变落盘的结果 ——
   * 变的只是**内存里那份不再被打穿**。
   */
  const given = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
  const next = { ...all(), ...given };
  if (given.baseUrls) next.baseUrls = { ...all().baseUrls, ...given.baseUrls };
  if (given.endpointOverrides) {
    next.endpointOverrides = { ...all().endpointOverrides, ...given.endpointOverrides };
    // 填了空字符串等于"清掉这条覆盖，回到自动探测"
    for (const [k, v] of Object.entries(next.endpointOverrides)) if (!v) delete next.endpointOverrides[k];
  }
  if (given.rates) {
    next.rates = { ...all().rates, ...given.rates };
    /**
     * 传 null 等于"把这条单价删掉，回到未定价"。
     *
     * 不给这条路的话，填错了的单价就只能改成别的数，删不掉 ——
     * 而"删不掉"在钱这件事上很要命：一个填错的 0 会让某一项
     * **永远显示成免费**，而且看起来完全正常。
     */
    for (const [k, v] of Object.entries(next.rates)) if (v === null) delete next.rates[k];
  }
  cache = next;

  /**
   * ⚠ 落盘时**只写和默认值不一样的那些**。
   *
   * 原来是把整份合并后的对象写下去 —— 于是用户**第一次保存任何一项设置**
   * 的那一刻，当时那份 DEFAULTS 的全部快照就被固化进了 settings.json。
   *
   * 后果是：**改默认值对任何一台已经用过的机器都不生效**。
   * 我把时长策略的默认从 trim 改成 keep，用户更新完却说"每镜会用完整片段
   * 这个都没看到" —— 因为他盘上那份三个月前保存的快照里写着 trim，
   * 而合并的时候磁盘永远压过默认值。
   *
   * 这个坑最阴的地方在于**它无声无息**：默认值改了、代码是对的、
   * 测试也是绿的（自检那份是空的 settings.json），只有真实用户碰得到。
   *
   * 只存差异之后，settings.json 变成"我改过什么"，没改过的那些
   * 一律跟着默认值走 —— 以后调默认值才真的能到用户手里。
   */
  const persist = {};
  for (const [k, v] of Object.entries(next)) {
    if (JSON.stringify(v) !== JSON.stringify(DEFAULTS[k])) persist[k] = v;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(persist, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
  return next;
}

export function reset() {
  cache = { ...DEFAULTS };
  patch({});
  return cache;
}

export { DEFAULTS };

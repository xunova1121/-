/**
 * Studio 流水线：剧本 → 设定集 → 分镜 → 资产 → 视频 → 合成 → 导出。
 *
 * 比常见实现多出来的是"设定集"这一站。它不产出观众看得见的东西，
 * 却决定了后面几十个镜头里角色是不是同一张脸 —— 详见 consistency.js。
 *
 * 每一阶段都写成"读项目 → 干活 → 落盘 → 回事件"的形状：
 * 这类任务动辄几分钟，用户中途关窗口、断网、改主意都是常态，
 * 只要落了盘，下次打开就能从断点接着跑，不用从头再烧一遍额度。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../store.js';
import * as settings from '../settings.js';
import * as logbus from '../logbus.js';
import * as adapters from '../providers/adapters.js';
import * as catalog from '../providers/catalog.js';
import { authHeadersForUrl, authHeadersFor } from '../providers/index.js';
import * as consistency from './consistency.js';
import * as continuity from './continuity.js';
import * as speakerLib from './speaker.js';
import * as imgsize from '../imgsize.js';
import * as ffmpeg from '../ffmpeg.js';
import * as imghash from '../imghash.js';
import { safeFileName, PROJECTS_DIR } from '../paths.js';
import * as chapters from './chapters.js';
import * as duration from '../duration.js';
import * as versions from '../versions.js';
import * as autocut from '../autocut.js';
import * as quality from './quality.js';
import * as skillsLib from '../skills.js';
import * as variants from './variants.js';
import * as anglesLib from './angles.js';
import * as previz from './previz.js';
import * as oss from '../oss.js';
import * as tiers from '../tiers.js';
import * as shotlint from './shotlint.js';
import * as segments from './segments.js';
import * as transitions from '../transitions.js';
import * as jobs from '../jobs.js';

export const extractJSON = consistency.extractJSON;

const SHOT_PROMPT = `你是动态漫画的分镜导演。把剧本拆成可直接投产的分镜表。

**分两步，顺序不能反**：

  第一步 先划场次 —— 通读剧本，找出**时间跳了**或者**地点换了**的地方，
         那些就是场次的边界。先把边界定下来。
  第二步 再在每个场次内部拆镜头。

为什么是这个顺序：边界决定了哪些镜头之间可以"接得看不出来"、哪些必须断开。
先拆镜再补转场的话，会出现两镜标着「连续动作」而它们之间隔了二十年 ——
那对镜头会去锁末帧、会互相当参考图，出来的东西说不上哪里怪，但就是怪。

严格只输出 JSON，不要解释、不要代码块：

{
  "logline": "一句话梗概",
  "segments": [
    {
      "index": 1,
      "where": "这一场在哪儿（用设定集里已有的场景名）",
      "when": "什么时候（当天下午 / 二十年前 / 三小时后…）",
      "summary": "这一场在演什么，一句话",
      "enter": "怎么进入这一场：cut（硬切，默认）/ fade（黑场，换时间换地点）/ dissolve（叠化，表示时间流逝）。第一场固定 cut",
      "seconds": 18
    }
  ],
  "shots": [
    {
      "index": 1,
      "segment": 1,
      "scene": "所属场景名（必须用设定集里已有的场景名）",
      "characters": ["出场角色名，必须用设定集里已有的名字，空镜给空数组"],
      "description": "这一镜画面里发生的事，只写看得见的画面，不写心理活动、不写声音",
      "camera": "镜头语言：特写 / 中景 / 全景 / 俯拍 / 跟拍 / 推镜 等",
      "motion": "给图生视频的运镜与动态提示，一句话",
      "dialogue": "旁白或台词，没有留空字符串",
      "speaker": "这句台词是谁说的，填角色名；旁白或没有台词就留空字符串",
      "sound": "这一镜听得见但看不见的声音（敲门声、脚步声、雨声、远处汽笛）。没有就留空字符串",
      "transition": "进入这一镜的方式：cut（硬切，默认）/ fade（黑场淡入，换时间换地点用）/ dissolve（叠化，时间流逝或情绪转折用）。绝大多数镜都该是 cut",
      "link": "和上一镜的关系：continuous（动作不能断，比如伸手→握住门把手，会把上一镜的末帧锁成这一镜的首帧）/ cut（同一场戏里换机位）/ new-scene（换场次）。场次的头一镜固定 new-scene",
      "lineKind": "台词类型：speech（对白，他在画面里说出来）/ inner（心里话，他自己的声音但嘴不动）/ voiceover（旁白，画外叙述）/ offscreen（画外音，说话人不在这一镜画面里）。没有台词就不用给",
      "duration": 4
    }
  ]
}

要求：
- shots 数量 {{SHOT_COUNT}} 个左右；
- **全片总时长必须控制在 {{TARGET_SECONDS}} 秒左右（±10%）**，你自己在各镜之间分配：
  紧张、动作、转场用 3 秒短镜；抒情、对话、定场用 5~6 秒长镜。
  不要平均分配 —— 均分看着整齐，剪出来很呆板；
- **叠化会吃掉 0.5 秒**（两段画面重叠着渐变，那半秒是重叠掉的，不是多出来的）。
  用了几处叠化，就在时长里把那几个 0.5 秒补回来，否则成片会比说好的短；
- **不要**在 description 里重复角色外貌 —— 外貌由设定集统一注入，你重复写反而会冲突；
- characters 和 scene 必须严格用下面设定集里给出的名字，不要自创；
- duration 取 3~6 秒。

分镜铁律（违反其中任何一条，这一镜出来的画面都会是错的）：

- **一镜只装一个动作**。「老师听到敲门 → 说请进 → 客人推门进来 → 客人坐下」是**四镜**，
  不是一镜。这一条是所有毛病里最贵的一条：每一镜只会拿到**一张静止的首帧图**，
  一张图画不出一串先后发生的事，模型只能挑一个瞬间画，然后剩下的事全都没了。

- **声音写进 sound，不要写进 description**。description 里出现"敲门声"，
  出图模型没法画一个声音，它会去画那个声音最像的**东西** —— 于是画出一扇**开着的门**。
  而这一镜的前提恰恰是门还关着。一个字放错字段，整场戏的逻辑就反了。

- **description 写"正在发生"，不写"已经发生"**。首帧图是这一镜的**起点**，不是终点。
  写"客人推门进来"，出的图是客人**已经站在屋里**，视频就没得动了；
  写"门把手正在转动，门开了一条缝"，视频才有得演。

- **写清楚可见状态**。门是关着还是开着、灯亮还是暗、人是坐着还是站着 ——
  这些跨镜头会被记住，不写的话每一镜都会重新掷骰子，前一镜关着的门下一镜就开了。

- **相邻两镜的方向要一致**。同一场戏里，角色朝画面左还是右、从哪一侧进画，
  前后镜必须对得上。反了的话观众会觉得"两个人在各说各的"，说不出哪里怪，但就是怪。

- **动作中途切**。要让两镜接得看不出接缝，就在**动作进行到一半时**换镜：
  上一镜"手伸向门把手"，下一镜"手把门把手拧下去"。
  等一个动作彻底做完再切，接缝会很明显 —— 这是业余和专业最容易分辨的一处。

- **动作量要配得上时长**。这是"节奏忽快忽慢"的真正来源：
  每一镜是**独立生成**的，模型只知道"演什么、几秒"，于是自己算速度。
  一个 3 秒的镜头里写"走过整条走廊"，它只能把人加速成小跑；
  下一个 6 秒的镜头写"抬起头"，同一个人又慢得像定格。两镜一接，
  观众立刻觉得莫名其妙 —— 而人对速度突变比对人脸漂移敏感得多。
  所以：**大动作给长时长，小动作给短时长**。
  一个人正常走三五步大约 3 秒，转身抬头大约 1~2 秒，
  跨过一整个空间要 6 秒以上 —— 写不下就拆成两镜，别靠加速硬塞。

- **转场只出现在场次之间**。场次内部的每一镜，transition 一律填 cut。
  一个场次的头一镜，transition 要和这个场次的 enter 一致。
  每镜都叠化是最典型的业余做法：它不会让片子更顺，只会让人看不清发生了什么。

- **跨场次不可能是「连续动作」**。场次的头一镜，link 必须是 new-scene。
  continuous 的含义是"上一帧的下一瞬间"，而跨场次之间隔着时间或地点 ——
  标错了会让系统去锁末帧，强行把二十年后那一镜画成二十年前的样子，而且不报任何错。

- **动作接切只在场次内部做**。同一场戏里可以在动作中途换镜；
  跨场次一律断得干干净净，那正是观众需要的"这里翻篇了"的信号。

已冻结的设定集：
{{BIBLE}}`;

function routing() {
  return adapters.resolvedRouting();
}

/**
 * 本地文件 → 模型能吃到的引用。
 *
 * 三条路，按这个顺序：
 *
 *   ① 自己填的上传网关   —— 明确配过就听他的，别自作主张换掉
 *   ② 阿里云 OSS         —— 配好了就直接当图床用。这一条是后加的：
 *                           以前配了 OSS 还要再去配一个"上传网关"才能让百炼
 *                           拿到参考图，而那两样干的是同一件事，纯属多此一举。
 *   ③ data URI           —— 兜底。Windows 用户不用为了跑通图生图先去开一个桶；
 *                           火山方舟、OpenAI、多数中转网关都收 base64。
 *
 * 只有百炼那几个"只认公网 URL"的接口会卡在第三条上，那时候前两条随便配一个都行。
 */
/**
 * 存下来的那个"模型能吃的引用"还能不能用。
 *
 * ── 这是一个真的把人坑过的 bug ──
 *
 * imageRef 是落盘进项目文件的，后面重出视频时直接拿来当首帧：
 * `shot.imageRef || await toModelRef(...)`。看着很合理 —— 省一次上传。
 *
 * 但对象存储的**私有桶**给的是**限时签名地址**（默认一小时）。存进项目文件
 * 当长期引用，几小时后它就变成一个**看起来完全正常、其实打不开**的 https 链接。
 * 而厂商那边的表现是 `cannot download media URL` —— 报错里没有一个字
 * 提到"过期"，人只会去查网络、查权限、查参数。
 *
 * 重新签一次是**纯本地计算、不发任何请求**，省那一下毫无意义。
 * 所以：带 Expires 的一律不复用，现签。
 *
 * 上传网关给的地址和内联图不受影响 —— 它们本来就不会过期。
 */
function usableRef(ref) {
  if (!ref) return null;
  if (/[?&]Expires=/i.test(String(ref))) return null;
  return ref;
}

/**
 * 设定集参考图：过期的那张，**当场重新签一个**。
 *
 * ── 这个洞是怎么露出来的 ──
 *
 * 用户重出一镜，日志里是：
 *   ※ 想改成内联图绕过去，但第 2 张我们自己也下不下来（HTTP 403）
 *   ✕ 厂商那边下载不到我们给的图
 * 而图明明还好好地在对象存储里。
 *
 * 原因：sheetUrl 存的是**限时**地址，默认活 6 小时。设定集是前一天建的，
 * 于是第二天所有参考图一起 403。而 usableRef() 这个专门用来挡过期地址的
 * 守卫，只加在了分镜自己那张图上，**设定集这条路上一次都没走过**。
 *
 * ── 为什么不能只是"跳过过期的" ──
 *
 * 跳过的话这一镜就少带一张参考图，人设当场松掉，而且不报错 ——
 * 只是"最近出的图不太像"。参考图是一致性最有效的那一层，宁可多花一次上传。
 *
 * 本地文件一直都在（sheetPath），重新签一个是几百毫秒的事，
 * 而且顺手把新地址写回设定集，后面每一镜都省下这一趟。
 */
async function refreshRefs(project, refs, { onEvent } = {}) {
  if (!refs?.images?.length) return refs;

  const images = refs.images.slice();
  const fixed = [];
  const lost = [];

  for (let i = 0; i < images.length; i += 1) {
    if (usableRef(images[i])) continue;
    const local = refs.paths?.[i];
    const label = refs.labels?.[i] || `第 ${i + 1} 张`;
    if (!local || !fs.existsSync(local)) {
      lost.push(label);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      images[i] = await toModelRef(local, { onEvent });
      fixed.push(label);
    } catch (err) {
      lost.push(`${label}（${err.message}）`);
    }
  }

  if (fixed.length) {
    onEvent?.({
      type: 'note',
      message: `设定集里有 ${fixed.length} 张参考图的地址过期了（${fixed.join('、')}），已经重新传了一份 —— 限时地址默认只活 6 小时，设定集是早先建的就会这样`
    });
    persistRefs(project, refs, images);
  }
  if (lost.length) {
    // 少带一张参考图不报错的话，表现就是"最近出的图不太像"，最难查
    onEvent?.({
      type: 'note',
      message: `⚠ ${lost.join('、')} 的地址过期了，而本地那份图也找不到了 —— 这一镜会少带这几张参考图，人设可能不稳。去「设定集」把它们重出一次`
    });
  }

  const keep = images.map((u, i) => [u, i]).filter(([u]) => usableRef(u));
  return {
    ...refs,
    images: keep.map(([u]) => u),
    labels: keep.map(([, i]) => refs.labels?.[i]).filter(Boolean),
    paths: keep.map(([, i]) => refs.paths?.[i] ?? null)
  };
}

/**
 * 把重新签好的地址写回设定集，免得后面每一镜都重传一遍。
 *
 * 按**本地路径**认条目，不按名字 —— 名字会重（"办公室"既是场景名也可能是道具名），
 * 而 sheetPath 是唯一的。
 */
function persistRefs(project, refs, images) {
  const byPath = new Map();
  refs.paths?.forEach((p, i) => {
    if (p && images[i] && images[i] !== refs.images[i]) byPath.set(p, images[i]);
  });
  if (!byPath.size) return;

  let touched = false;
  const bible = project.bible || {};
  for (const group of [bible.characters, bible.scenes, bible.props]) {
    for (const item of group || []) {
      for (const holder of [item, ...(item.variants || [])]) {
        if (holder?.sheetPath && byPath.has(holder.sheetPath)) {
          holder.sheetUrl = byPath.get(holder.sheetPath);
          touched = true;
        }
      }
    }
  }
  if (touched) store.save(project);
}

export async function toModelRef(localPath, { onEvent } = {}) {
  const gateway = settings.get('uploadGateway');
  if (gateway) return uploadVia(gateway, localPath, onEvent);

  if (oss.ready()) {
    try {
      const known = publicUrlFor(localPath);
      if (known) return known;
      const rel = path.relative(PROJECTS_DIR, localPath).split(path.sep).join('/');
      const key = rel.startsWith('..') ? `misc/${path.basename(localPath)}` : rel;
      const put = await oss.putFile(localPath, key);
      OSS_KEYS.set(localPath, put.key);
      const url = put.url;
      onEvent?.({ type: 'note', message: `参考图已上传到对象存储：${path.basename(localPath)}` });
      return url;
    } catch (err) {
      // 传不上去就退回 base64 —— 多数厂商吃得下，总比整步失败强
      onEvent?.({ type: 'note', message: `对象存储没传上去，改用内联图：${err.message}` });
    }
  }

  const buf = fs.readFileSync(localPath);
  const ext = path.extname(localPath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  // 太大的 base64 会把请求体撑爆（有厂商限 10MB），超了就明确报错而不是让服务端回一个看不懂的 400
  if (buf.length > 7 * 1024 * 1024) {
    throw new Error(
      `参考图 ${path.basename(localPath)} 有 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超出 base64 内联上限。请在「设置 → 上传网关」里配一个图床。`
    );
  }
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function uploadVia(gateway, localPath, onEvent) {
  const buf = fs.readFileSync(localPath);
  const boundary = `----futuredream${Date.now().toString(16)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(
      localPath
    )}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const res = await fetch(gateway, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat([head, buf, tail]),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(`上传网关返回 HTTP ${res.status}`);
  const json = await res.json();
  const url = json.url || json.data?.url;
  if (!url) throw new Error('上传网关没有返回 url 字段');
  onEvent?.({ type: 'note', message: `已上传 ${path.basename(localPath)}` });
  return url;
}

/** 把远端产物或 base64 落到本地。二进制不能走 execute()（那条通道是按文本设计的）。 */
export async function saveMedia({ url, base64, downloadHeaders }, destPath, onEvent) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  /**
   * 覆盖之前，把上一版留下来。
   *
   * 放在这儿是因为这里是**所有产物落盘的唯一咽喉** —— 出图、出视频、
   * 设定图、补角度、贴地址，八条路最后都走这一行。在每条路上各加一次，
   * 迟早漏掉一条，而漏掉的表现是"这一镜的历史版本莫名其妙没有"。
   *
   * 每一版都是真金白银出的。丢掉的不是文件，是已经花掉的钱。
   */
  versions.archive(destPath);
  let buf;
  const started = Date.now();
  if (base64 && !url) {
    buf = Buffer.from(base64, 'base64');
  } else {
    /**
     * 下载这一步比看上去麻烦：
     *
     * 多数厂商给的是公网直链，拿着就能下；但有两类不是 ——
     *   · OpenAI 的 /videos/{id}/content 必须带 Authorization；
     *   · 秘塔给的 files.metaso.cn/... 也要带，不带回 {"errCode":401,…}。
     * 而这两种失败都长成"文件下下来了、就是打不开"，最难查。
     *
     * 策略：先按公网直链试（绝大多数情况，也不会把密钥发给不相干的域名）；
     * 只有当它回 401/403、或者回了一段 JSON 时，才按域名匹配到对应的服务商，
     * 带上密钥重试一次。密钥只会发给"和该服务商同一个主域"的地址。
     */
    const attempt = async (headers) => {
      const res = await fetch(url, { headers: headers || undefined, signal: AbortSignal.timeout(300000) });
      const body = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') || '';
      const looksLikeJson = /json|text\/html/i.test(type);
      return { res, body, type, looksLikeJson, ok: res.ok && !looksLikeJson };
    };

    let got = await attempt(downloadHeaders);
    if (!got.ok && !downloadHeaders) {
      const auth = authHeadersForUrl(url);
      if (Object.keys(auth).length) {
        onEvent?.({ type: 'note', message: '这个地址要鉴权，带上密钥重试一次…' });
        const retried = await attempt(auth);
        if (retried.ok) got = retried;
      }
    }

    if (!got.res.ok) {
      throw new Error(
        `下载失败 HTTP ${got.res.status}：${url}\n服务端说：${got.body.toString('utf8').slice(0, 200)}`
      );
    }
    if (got.looksLikeJson) {
      // 说好是视频/图片，回来的却是一段 JSON。存下来只会得到一个打不开的文件。
      throw new Error(
        `下载到的不是媒体文件（Content-Type: ${got.type}）：${got.body.toString('utf8').slice(0, 200)}\n` +
          `如果这是需要登录才能取的地址，先去「服务商与密钥」把对应那家的密钥配好，再补入一次。`
      );
    }
    buf = got.body;
  }
  fs.writeFileSync(destPath, buf);
  logbus.record({
    provider: 'download',
    label: '保存产物',
    method: 'GET',
    url: url || '(base64 内联)',
    status: 200,
    ok: true,
    bytes: buf.length,
    totalMs: Date.now() - started,
    responseBody: `<binary ${buf.length} bytes> → ${destPath}`
  });
  onEvent?.({ type: 'note', message: `已保存 ${path.basename(destPath)}（${(buf.length / 1024).toFixed(0)} KB）` });

  await mirrorToOss(destPath, buf, onEvent);
  return destPath;
}

/**
 * 把产物同步一份到对象存储。
 *
 * 挂在 saveMedia 的出口，是因为这里是**所有产物落盘的唯一咽喉** ——
 * 图、视频、配音、参考图全从这儿过。挂十几个调用点迟早漏一个，
 * 而漏掉的那一个会以"这张图在手机上打不开"的形式出现，极难定位。
 *
 * 两条刻意的规矩：
 *
 * ① **传失败不能让整步失败。** 文件已经在本地了，流水线完全可以继续 ——
 *    为了一个"顺带做的事"把跑了十分钟的一步废掉，是拿主要目标去赌次要目标。
 *    所以只发一条提示，不抛异常。
 *
 * ② **本地那份不删。** 删了之后一旦 OSS 配置改了、桶被清了、AccessKey 过期，
 *    整个项目就成了一堆断链。对象存储在这里的角色是"多一份、并且有公网地址"，
 *    不是"搬走"。真想省盘，该做的是单独一个清理动作，由人明确发起。
 */
async function mirrorToOss(destPath, buf, onEvent) {
  if (!oss.ready()) return null;
  try {
    const rel = path.relative(PROJECTS_DIR, destPath).split(path.sep).join('/');
    // 落在项目目录之外的（比如画风预览图）也传，只是换个前缀，免得和项目产物混在一起
    const key = rel.startsWith('..') ? `misc/${path.basename(destPath)}` : rel;
    const put = await oss.putBuffer(key, buf, oss.contentTypeOf(destPath));
    OSS_KEYS.set(destPath, put.key);
    onEvent?.({ type: 'note', message: `已同步到对象存储：${path.basename(destPath)}` });
    return url;
  } catch (err) {
    onEvent?.({ type: 'note', message: `对象存储没传上去（不影响这一步）：${err.message}` });
    return null;
  }
}

/**
 * 本地路径 → 对象存储里的 **key**。
 *
 * 存 key 而不是存 URL，有两个原因：
 *
 * ① 私有桶给的是**限时**地址，存下来过几个小时就打不开了，
 *    而它看起来是一个正常的 https 链接 —— 又是一种"看着对、其实坏了"。
 *    存 key 就能每次现签。
 * ② 存了 URL 之后想拿回 key 只能去解析它，而解析 URL 拿路径这件事
 *    本身就容易出错（这正是第一版写错的地方）。存源头，别存派生值。
 *
 * 放内存不落盘：它是缓存，不是数据。桶换了、前缀改了，重启一次就干净了。
 */
const OSS_KEYS = new Map();

/**
 * 参考图要发给出图模型时，优先给公网地址。
 *
 * 这是接 OSS 最实际的理由：万相这类厂商的图生图通道**只收 https 地址**，
 * 本地文件和 base64 都不收（adapters.js requirePublicUrl）。
 * 没有对象存储时，角色设定图就永远发不出去 —— 一致性链路里最关键那一环断掉。
 */
export function publicUrlFor(localPath) {
  if (!localPath || !oss.ready()) return null;
  const key = OSS_KEYS.get(localPath);
  // 每次现签：私有桶那个地址是有期限的
  return key ? oss.urlFor(key) : null;
}

// ═══════════════════════ 设定集条目：三类共用的取值与提示词 ═══════════════════════

const SHEET_LABEL = { char: '角色设定图', scene: '场景基准图', prop: '道具参考图' };

export function bibleBucket(bible, kind) {
  if (kind === 'char') return bible.characters || [];
  if (kind === 'scene') return bible.scenes || [];
  return bible.props || [];
}

/**
 * 三类参考图的构图要求不同，分开写：
 * 角色要正面半身好辨认五官，场景要空镜别混进人，道具要单体产品图。
 * 混用一套模板的话，道具图里会莫名其妙站个人。
 */
export function sheetPrompt(kind, bible, item, variant = null) {
  const anchor = bible.style.anchor;
  /**
   * ⚠ 这一行曾经是 `item.sheetPrompt || item.appearance`，而那是个实打实的 bug：
   *
   * sheetPrompt 在生成设定集时就被模型填满了，于是它**永远非空**。
   * 结果是你改了 appearance（描述）、重出图，出来的还是照着**旧描述**画的 ——
   * 因为真正发出去的一直是那份没人动过的 sheetPrompt。
   * 表现就是"我明明改了描述，图还是不符"，而且怎么重出都没用。
   *
   * 现在 sheetPrompt 退回它本来该有的身份：**可选的覆盖**，默认是空的。
   * 描述是唯一的事实来源；只有你明确写了出图提示词，它才顶上。
   * 改描述时会自动把这个覆盖清掉（见 updateBibleEntry）——
   * 一个你看不见、又会悄悄接管一切的字段，是最坏的那种字段。
   */
  /**
   * 变体优先：这一版的出图提示词 = 身份锚 + 这一版变的那部分。
   * 身份锚永远在场，"是不是同一个人"才压得住（见 pipeline/variants.js）。
   */
  const v = variant || variants.defaultVariant(item);
  /**
   * ⚠ 只认**这一版自己**的覆盖，不再回落到 item.sheetPrompt。
   *
   * 同一个坑踩了两次：第一次是模型预填 item.sheetPrompt，改描述不生效；
   * 修完之后加了变体层，迁移时把 item.sheetPrompt 复制进了默认变体，
   * 而清理只清了 item 上那份 —— 变体里那份陈旧的覆盖又活了下来，
   * 于是"改了描述、重出图还是旧的"原样复发。
   *
   * 现在覆盖只存在一个地方（变体上），改描述时连它一起清。
   * 一个值有两个存放处、而只有一处会被更新，迟早出这种事。
   */
  const override = (v?.sheetPrompt || '').trim();
  const own = override || variants.describeWith(item, v) || item.appearance || '';
  if (kind === 'char') return `${anchor}，角色设定图，正面半身，中性表情，纯色浅灰背景，无其他人物。${own}`;
  if (kind === 'scene') return `${anchor}，场景基准图，空镜无人物，广角。${own}`;
  return `${anchor}，道具参考图，单个物体居中，纯色背景，无人物，产品图视角。${own}`;
}

// ═══════════════════════ 阶段一：设定集（冻结人设）═══════════════════════

/**
 * 生成设定集并出角色设定图 / 场景基准图。
 * 这一步是整条流水线的地基，跑完之后人设就锁死了。
 */
export async function buildBible(projectId, { onEvent, regenerate = false, signal = null } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!project.script?.trim()) throw new Error('剧本是空的，先写点东西');

  onEvent?.({ type: 'stage', stage: 'bible', status: 'running', message: '正在冻结人设与场景…' });

  const bible = project.bible && !regenerate ? project.bible : await consistency.buildBible(project, { onEvent });
  // 刚生成的设定集还没有"变体"这一层，补上（老项目在 store.read 里补）
  variants.normalizeBible(bible);
  store.update(projectId, (p) => {
    p.bible = bible;
    return p;
  });

  /**
   * 写描述和出设定图是**同一步**。
   *
   * 曾经拆成过两步（先出文字、人确认、再出图），道理上说得通，实际不好用：
   * 多一次手动确认、多一个"图还没出"的中间态，而设定集本来就是
   * "一口气出齐才有意义"的东西 —— 缺一张角色设定图，后面引用它的每一镜
   * 都少一张参考图，一致性就是从那儿开始塌的。
   *
   * 不满意就在「设定集」页改描述、单独重出那一张 —— 那是随时能做的事，
   * 不需要为它在流水线上专门开一站。
   */
  const dir = store.assetDir(projectId);
  const r = routing();
  // 按**变体**出图，不是按条目：一个角色三套衣服就是三张，
  // 缺一张就少一个基准（见 pipeline/variants.js）
  const targets = variants.sheetTargets(bible).filter(({ variant }) => regenerate || !variant.sheetPath);

  onEvent?.({ type: 'note', message: `待出参考图 ${targets.length} 张` });

  for (const { kind, item, variant } of targets) {
    const label = variants.labelOf(item, variant);
    jobs.checkpoint(signal, `${label} 起往后的参考图`);
    try {
      onEvent?.({ type: 'sheet', name: label, kind, status: 'running', message: `生成${SHEET_LABEL[kind]}：${label}` });

      // 把真正发出去的提示词摊在事件流里 —— "图和描述不符"时，
      // 第一件要确认的事就是"发出去的到底是哪句话"
      const prompt = sheetPrompt(kind, bible, item, variant);
      onEvent?.({ type: 'note', message: `提示词：${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}` });

      const image = await adapters.generateImage({
        providerId: r.image.provider,
        model: r.image.model,
        prompt,
        negative: bible.style.negative,
        aspectRatio: project.aspectRatio || null,
        // 所有变体共用条目的身份种子 —— 换了衣服还是同一张脸
        seed: item.seed,
        label: `参考图·${label}`,
        onEvent
      });

      const dest = path.join(dir, `ref-${kind}-${safeFileName(item.name)}-${safeFileName(variant.id)}.png`);
      await saveMedia(image, dest, onEvent);
      checkRatio(dest, project.aspectRatio || settings.get('aspectRatio'), `${label} 的设定图`, onEvent);
      const modelRef = await toModelRef(dest, { onEvent });

      store.update(projectId, (p) => {
        const target = bibleBucket(p.bible, kind).find((x) => x.name === item.name);
        const tv = target && variants.findVariant(target, variant.id);
        if (tv) {
          tv.sheetPath = dest;
          tv.sheetUrl = modelRef;
          tv.sheetSource = 'model';
          tv.sheetAt = new Date().toISOString();
          tv.sheetPromptUsed = prompt;
          variants.normalizeItem(target, kind); // 条目上的镜像跟着更新
        }
        return p;
      });
      onEvent?.({ type: 'sheet', name: label, status: 'done' });
    } catch (err) {
      if (jobs.isCancel(err)) throw err;
      onEvent?.({ type: 'sheet', name: label, status: 'failed', message: err.message });
    }
  }

  const after = store.read(projectId);
  const all = variants.sheetTargets(after.bible);
  const ready = all.filter((x) => x.variant.sheetPath).length;
  const total = all.length;
  store.update(projectId, (p) => {
    p.stageStatus.bible = ready === total ? 'done' : ready ? 'partial' : 'pending';
    return p;
  });
  onEvent?.({
    type: 'stage',
    stage: 'bible',
    status: 'done',
    message: ready === total
      ? `设定集就绪：${total} 条设定，参考图 ${ready}/${total}`
      : `参考图只出了 ${ready}/${total} 张。缺的那几张会让引用它的镜头少一张参考图，一致性从那儿开始塌 —— 去「设定集」页把缺的补出来再往下走`
  });
  return store.read(projectId);
}

// ═══════════════════════ 阶段二：分镜 ═══════════════════════

/**
 * 设定集齐了没。
 *
 * 「所有设定图出齐再往下走」不是洁癖：缺一张角色设定图，后面引用它的每一镜
 * 都少一张参考图、少一份复核基准，**一致性就是从那儿开始塌的**。
 * 而且那时候你已经在出几十张分镜图了，回头补的代价比现在大得多。
 */
/**
 * 成片体检：把散在四处的结论汇总成"现在能不能发"。
 *
 * 分镜体检在这儿现算（它便宜），其余全从已有字段读 —— 不重新调模型、
 * 不重新跑 FFmpeg。体检本身要免费、要快，慢一点人就不会在导出前点它。
 */
export function qualityReport(projectId) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  return quality.audit(project, {
    lintResults: shotlint.lintShots(project.shots || []),
    threshold: settings.get('consistencyThreshold') ?? 75
  });
}

export function bibleReadiness(project) {
  // 按**变体**算：一个角色三套衣服就是三张图，缺一张就少一个基准
  const targets = variants.sheetTargets(project.bible);
  const missing = targets.filter((t) => !t.variant.sheetPath);
  return {
    total: targets.length,
    ready: targets.length - missing.length,
    missing: missing.map((t) => `${SHEET_LABEL[t.kind]}·${variants.labelOf(t.item, t.variant)}`),
    ok: targets.length > 0 && missing.length === 0
  };
}

export async function analyzeScript(projectId, { shotCount = 8, chapterId = null, force = false, onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!project.bible) throw new Error('请先跑「设定集」—— 没有冻结人设，分镜会自己发挥外貌描述');

  // 设定图要出齐再往下走：缺一张，后面引用它的每一镜都少一张参考图、
  // 少一份复核基准，一致性从那儿开始塌 —— 而那时候你已经在出几十张图了
  const ready = bibleReadiness(project);
  if (!ready.ok && !force) {
    throw new Error(
      `设定图还差 ${ready.missing.length} 张没出：${ready.missing.slice(0, 6).join('、')}` +
        `${ready.missing.length > 6 ? ' 等' : ''}。\n` +
        '缺的那几张会让引用它们的每一镜都少一张参考图，一致性从那儿开始塌。' +
        '去「设定集」页把缺的补出来（或者删掉用不上的条目）再拆分镜。'
    );
  }

  // 分章的项目一次只拆一章。不传章节 ID 时，挑第一个还没拆的，
  // 让"连点几次"这种最自然的操作方式能一章章推进。
  // 变量名不能叫 chapters —— 那是本文件顶部导入的模块名，遮住它会让
  // chapters.shotIdFor 在运行时变成 undefined，而且只在分章路径上才炸
  const chapterList = project.chapters || [];
  let chapter = null;
  if (chapterList.length) {
    chapter = chapterId
      ? chapterList.find((c) => c.id === chapterId)
      : chapterList.find((c) => c.stageStatus?.script !== 'done') || chapterList[0];
    if (!chapter) throw new Error(`没有这一章：${chapterId}`);
  }
  const sourceScript = chapter ? chapter.script : project.script;

  // 时长预算：分章时按本章字数占全片的比例分摊，长章自然分到更多秒数
  const totalTarget = Number(project.targetDuration) || 60;
  const targetSeconds = chapter
    ? Math.max(
        10,
        Math.round(
          (totalTarget * chapter.chars) / (chapterList.reduce((sum, c) => sum + c.chars, 0) || chapter.chars)
        )
      )
    : totalTarget;

  const r = routing();
  onEvent?.({
    type: 'stage',
    stage: 'script',
    status: 'running',
    message: `${chapter ? `${chapter.title}：` : ''}${r.chat.provider} / ${r.chat.model} 拆分镜中…`
  });

  const bibleDigest = JSON.stringify(
    {
      characters: project.bible.characters.map((c) => ({ name: c.name, role: c.role })),
      scenes: project.bible.scenes.map((s) => ({ name: s.name })),
      props: project.bible.props.map((p) => p.name),
      // 有多版的条目要把版本名列给模型，它才挑得出"这一镜穿哪套 / 什么时段"
      变体: Object.fromEntries(
        [...project.bible.characters, ...project.bible.scenes, ...(project.bible.props || [])]
          .filter((x) => variants.variantsOf(x).length > 1)
          .map((x) => [x.name, variants.variantsOf(x).map((v) => v.name)])
      )
    },
    null,
    2
  );

  const { text } = await adapters.chat({
    providerId: r.chat.provider,
    model: r.chat.model,
    system: SHOT_PROMPT.replace('{{SHOT_COUNT}}', String(shotCount))
      .replace('{{TARGET_SECONDS}}', String(targetSeconds))
      .replace('{{BIBLE}}', bibleDigest),
    user: sourceScript,
    temperature: 0.7,
    jsonMode: true,
    label: chapter ? `拆分镜·${chapter.title}` : '拆分镜'
  });

  const parsed = extractJSON(text);
  /**
   * 场次先落地。**先决定在哪儿断，再决定拆成几镜** —— 见 pipeline/segments.js。
   * 模型没给这一段（老模型、输出跑偏）时回空数组，下面会退回按场景名推断，
   * 行为正好等于改这一版之前 —— 少一个字段不该让整步失败。
   */
  const segs = segments.normalizeSegments(parsed.segments);
  const rawShots = (parsed.shots || []).map((s, i) => ({
    id: chapters.shotIdFor(chapter?.id || null, i + 1),
    // 全局镜号：章序 × 1000 + 章内序，3012 一眼看出是第 3 章第 12 镜
    index: chapters.globalShotIndex(chapter?.index || 0, i + 1),
    chapterId: chapter?.id || null,
    scene: s.scene || '',
    characters: Array.isArray(s.characters) ? s.characters : [],
    description: s.description || '',
    camera: s.camera || '中景',
    motion: s.motion || '镜头缓慢推进',
    dialogue: s.dialogue || '',
    // 谁说的。配音时按它取这个角色的音色 —— 空 = 旁白
    speaker: s.speaker || '',
    /**
     * 听得见、看不见的东西。
     *
     * 单开一个字段，是为了让"敲门声"**有地方去** —— 只说"别写进画面描述里"
     * 而不给它一个去处，模型要么还是写进画面（照样画出开着的门），
     * 要么直接把它丢了（那这场戏就没有敲门这回事了）。
     * 现在它落在这里：不进出图提示词，但留在数据里，后面配音效时直接可用。
     */
    sound: s.sound || '',
    // 进入这一镜的方式。只认三种合法值，模型瞎编的一律回退硬切 ——
    // 一个不认识的转场名会在合成时被当成"没写"，而那时候已经看不出是模型编的了
    transition: ['cut', 'fade', 'dissolve'].includes(s.transition) ? s.transition : 'cut',
    /**
     * 和上一镜什么关系 —— **这一条以前是丢的**。
     *
     * 提示词里让模型判断"这两镜是不是一个连续动作"，模型也照着答了，
     * 而解析这一步压根没读它，全靠后面按场景名推断。
     * 后果是「连续动作」几乎永远推断不出来（同场景一律算 cut），
     * 于是锁末帧这条最有效的衔接手段基本没启用过 —— 而且没有任何地方会报错。
     *
     * 认不出的值留空，交给 deriveLink 按老规矩推断，不硬塞一个默认值。
     */
    link: continuity.LINKS.includes(s.link) ? s.link : '',
    duration: Number(s.duration) || 4,
    // 模型回的是**版本名**（它没法知道 id），这里翻成 id。
    // 翻不出来的直接丢掉：指向不存在的变体等于悄悄回退到默认，而界面上还显示着你选的那一版
    variants: Object.fromEntries(
      Object.entries(s.variants && typeof s.variants === 'object' ? s.variants : [])
        .map(([who, vname]) => {
          const item =
            project.bible.characters.find((x) => x.name === who) ||
            project.bible.scenes.find((x) => x.name === who) ||
            (project.bible.props || []).find((x) => x.name === who);
          const v = item && variants.variantsOf(item).find((x) => x.name === String(vname).trim());
          return v ? [who, v.id] : null;
        })
        .filter(Boolean)
    ),
    // 这一镜属于哪个场次。模型标了就用它的，没标就在下面按场景名推断
    segment: Number(s.segment) || null,
    imagePath: null,
    imageRef: null,
    videoPath: null,
    audioPath: null,
    seed: null,
    consistency: null,
    status: 'pending'
  }));

  /**
   * 把场次的规矩**落到**每一镜上。
   *
   * 提示词里已经写清楚了这些规矩，但提示词只是请求，这一步才是保证 ——
   * 模型不是每次都听，而"两镜标着连续动作、中间隔了二十年"这种错
   * 不会报任何错，只会让成片说不上哪里怪。
   */
  const withSeg = segments.assignSegments(rawShots, segs);
  const enforced = segments.enforce(withSeg, segs);
  const shots = enforced.shots;

  // 改了什么必须说出来。悄悄改用户看得见的字段是这类归一化最容易犯的错
  if (enforced.changes.length) {
    const head = enforced.changes.slice(0, 4)
      .map((c) => `第 ${c.index} 镜的${c.what === 'link' ? '衔接' : '转场'} ${c.from} → ${c.to}（${c.why}）`);
    onEvent?.({
      type: 'note',
      message:
        `按场次规矩纠正了 ${enforced.changes.length} 处：${head.join('；')}` +
        `${enforced.changes.length > 4 ? ` 等 ${enforced.changes.length} 处` : ''}`
    });
  }

  /**
   * 台词念不完就把镜头拉长 —— **在这一步拉，不能等到合成**。
   *
   * 原来只有合成那一步会发现"台词比镜头长"，而那时候图和视频的钱已经花完了：
   * 补救要么重出这一镜的视频（拉长），要么重配音（改短台词），两条都是重来一遍。
   *
   * 而这件事在这儿完全算得出来 —— 台词就在手上。12 个字塞进 3 秒念不完是必然的，
   * 不需要等到出片。这一步还没花任何钱，改时长是免费的。
   *
   * ⚠ 只往上调，不往下调。台词短不代表镜头就该短 —— 一个 2 秒台词的镜头
   * 完全可以是 6 秒（说完还有反应、还有留白），那是导演的选择，不该被我们压掉。
   */
  const stretched = [];
  for (const shot of shots) {
    const need = duration.secondsForDialogue(shot);
    if (need > (Number(shot.duration) || 0)) {
      stretched.push({ index: shot.index, from: shot.duration, to: need });
      shot.duration = need;
    }
  }
  if (stretched.length) {
    onEvent?.({
      type: 'note',
      message:
        `${stretched.length} 镜的台词念不完，已经把时长拉长：` +
        stretched.slice(0, 5).map((x) => `#${x.index}（${x.from}s→${x.to}s）`).join('、') +
        `${stretched.length > 5 ? ` 等 ${stretched.length} 处` : ''}` +
        '。现在改是免费的 —— 等出完视频再发现，就得重出那一镜。'
    });
  }

  const segBrief = segments.summarize(segs, shots);
  if (segBrief) onEvent?.({ type: 'note', message: segBrief });

  store.update(projectId, (p) => {
    if (!p.logline) p.logline = parsed.logline || '';
    // 场次表存下来：界面要按它把分镜分组显示，出图那步也要靠它判断场景锚
    if (segs.length) {
      p.segments = chapter
        ? [...(p.segments || []).filter((x) => x.chapterId !== chapter.id),
           ...segs.map((x) => ({ ...x, chapterId: chapter.id }))]
        : segs.map((x) => ({ ...x, chapterId: null }));
    }
    if (chapter) {
      // 只换掉这一章的镜头，别的章已经出好的图不能被误伤
      p.shots = [...p.shots.filter((s) => s.chapterId !== chapter.id), ...shots].sort((a, b) => a.index - b.index);
      const ch = p.chapters.find((c) => c.id === chapter.id);
      if (ch) {
        ch.stageStatus.script = 'done';
        ch.shotCount = shots.length;
      }
      p.stageStatus.script = p.chapters.every((c) => c.stageStatus.script === 'done') ? 'done' : 'partial';
    } else {
      p.shots = shots;
      p.stageStatus.script = 'done';
    }

    // 顺手把台词署名认一遍：模型经常把说话人写在台词里
    //（dialogue = "阿澜：设备正常。" 而 speaker 空着），留着它配音会连"阿澜冒号"一起念。
    // 这一层纯文本判断，不花一次调用，所以拆完就做；
    // 判不出来的那些留给「自动绑说话人」按钮去问模型。
    for (const d of speakerLib.bindAll(p)) {
      const t = p.shots.find((x) => x.id === d.id);
      if (!t || !d.confident) continue;
      t.speaker = d.speaker;
      t.speakerBy = d.by;
      if (d.line && d.line !== String(t.dialogue || '').trim()) t.dialogue = d.line;
    }
    return p;
  });

  onEvent?.({
    type: 'stage',
    stage: 'script',
    status: 'done',
    message: chapter ? `${chapter.title} 拆出 ${shots.length} 镜` : `拆出 ${shots.length} 个分镜`
  });

  /**
   * 拆完立刻体检，**在出图之前**。
   *
   * 这个时机是有意挑的：分镜里的三类硬伤（一镜多事件、声音写进画面、
   * 写成动作终点）看文字就能发现，而它们的后果要等图出来才看得见 ——
   * 那时候一镜的钱已经花了，重出还要再花一次。
   * 提示词里已经写明了铁律，但模型不是每次都听；这一层是**兜底的检查**，
   * 不是替代品。纯本地正则，不花一次调用。
   */
  const lint = shotlint.lintShots(store.read(projectId).shots || []);
  const brief = shotlint.summarize(lint);
  if (brief) onEvent?.({ type: 'note', message: `⚠ 分镜体检：${brief}` });

  /**
   * 时长对账：叠化吃掉的那几个半秒要减掉。
   *
   * 提示词里让模型自己补回来了，但那同样只是请求。真正的成片长度是
   * 「各镜时长之和 − 被叠化重叠掉的部分」，而这个差**没有任何地方会报错** ——
   * 你只会觉得"怎么比说好的短了两秒"，然后去怀疑裁剪、怀疑厂商。
   * 所以在这儿当场对一次账，差得多就说出来。
   */
  const planned = shots.reduce((sum, x) => sum + (Number(x.duration) || 0), 0);
  const eaten = segments.overlapCost(shots);
  const real = planned - eaten;
  if (targetSeconds > 0 && Math.abs(real - targetSeconds) > targetSeconds * 0.15) {
    onEvent?.({
      type: 'note',
      message:
        `⚠ 时长对不上：各镜加起来 ${planned.toFixed(1)} 秒` +
        `${eaten > 0 ? `，叠化重叠掉 ${eaten.toFixed(1)} 秒` : ''}，` +
        `成片约 ${real.toFixed(1)} 秒，而目标是 ${targetSeconds} 秒。` +
        '要卡准的话，去分镜页调几镜的时长 —— 现在改比出完片再改便宜得多。'
    });
  } else if (eaten > 0) {
    onEvent?.({ type: 'note', message: `${eaten.toFixed(1)} 秒会被叠化重叠掉，成片约 ${real.toFixed(1)} 秒（已计入字幕和配音的时间轴）` });
  }

  return store.read(projectId);
}

/**
 * 手改一镜的文案。
 *
 * 为什么值得单开一条接口：**分镜描述是这一镜出图和出视频的唯一输入**。
 * 模型拆分镜时写偏一句 —— 把"雨夜"写成"清晨"、把"特写"写成"全景" ——
 * 后面每一次重出都是在错的基础上重来，重十次也回不到对的画面。
 * 改一行字比重跑十次便宜得多，也快得多。
 *
 * 两个刻意的设计：
 *   ① **只认白名单字段**。整份 shots 数组回传是危险的：界面上那份可能是
 *      十分钟前拉的，中间流水线刚写进去的 imagePath / videoPath 会被整条盖掉。
 *      这里只动文案，产物字段一个都不碰。
 *   ② **不自动重出**。改完立刻烧钱不是好事 —— 一般人会连着改好几镜再统一重出。
 *      所以只落盘、记一个 editedAt，重出由用户自己点。
 */
const SHOT_EDITABLE = [
  'description', 'camera', 'motion', 'dialogue', 'scene', 'characters', 'duration', 'link', 'skills',
  // 画外音效，和转场形式。不放进白名单的话，界面上改了存不下去 ——
  // 而且那种"改了没反应"最难查：接口回 200，值就是没进去
  'sound', 'transition',
  // 这一镜属于哪个场次。场次边界决定了能不能锁末帧、能不能拿邻镜当参考，
  // 所以模型划错的时候人得能改
  'segment',
  // 这一镜走哪一档模型。自动判定会给一个，判错的那几镜由人改
  'tier',
  // 这句台词是谁说的。决定用哪个角色的音色 —— 空字符串 = 旁白
  'speaker',
  /**
   * 台词的类型：对白 / 心里话 / 旁白 / 画外音。
   *
   * 和 speaker **正交**：speaker 决定用谁的声音，lineKind 决定嘴动不动、
   * 声音从哪儿来。漏掉这个字段时，「心里话」根本表达不了 ——
   * 填了说话人画面就要求口型对上（成了自言自语），留空声音又变成旁白音色。
   */
  'lineKind',
  /**
   * 预演台排位：人站哪、朝哪、机位在哪、什么焦段、怎么运镜。
   *
   * 它是 camera 那个文本字段的**上位替代**：排过位之后，
   * 提示词里的机位那句话由几何算出来（见 previz.cameraLine），
   * 而 camera 只在没排位时兜底。两个都留着，因为不是每一镜都值得排位。
   */
  'stage',
  // { '阿澜': 'v-xxx', '码头': 'v-yyy' } —— 这一镜谁穿哪套、场景是什么时段
  'variants'
];

/**
 * 一段镜头一起改衔接关系。
 *
 * 为什么值得单开一条：「这一段是一个连贯动作」是**按段**发生的想法，
 * 不是按镜。推门→进门→环视→停下，四镜是一件事；一镜一镜点四次，
 * 中间还容易漏掉一镜 —— 而漏掉的那一镜恰恰是断点，等出完片才看出来。
 *
 * ⚠ 标成 continuous 是有代价的，界面上必须说清楚：
 *   · 这几镜会**串行**生成（每一镜要等前一镜的末帧），不能并行，慢好几倍
 *   · 机位被锁住了 —— 连续动作意味着不切镜位，标多了整段变成一个长镜头
 * 所以默认永远是 cut，continuous 必须是人主动圈出来的。
 */
export function setLinkRange(projectId, { from, to, link }) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!continuity.LINKS.includes(link)) {
    throw new Error(`不认识的衔接关系：${link}（只能是 ${continuity.LINKS.join(' / ')}）`);
  }
  const lo = Math.min(Number(from), Number(to));
  const hi = Math.max(Number(from), Number(to));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error('镜号不对');

  const changed = [];
  const next = store.update(projectId, (p) => {
    for (const s of p.shots || []) {
      if (s.index < lo || s.index > hi) continue;
      if (s.link === link) continue;
      s.link = link;
      // 记一笔"这是人选的"，免得后面自动推断又把它改回去
      s.linkBy = 'user';
      changed.push(s.index);
    }
    return p;
  });
  return { project: next, changed, link };
}

export function updateShot(projectId, shotId, patch = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const shot = (project.shots || []).find((s) => s.id === shotId);
  if (!shot) throw new Error(`没有这一镜：${shotId}`);

  const changed = [];
  const dropped = [];
  for (const key of SHOT_EDITABLE) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (key === 'duration') {
      value = Number(value);
      if (!Number.isFinite(value) || value <= 0) continue;
      value = Math.min(30, Math.max(0.5, value));
    } else if (key === 'link') {
      // 只认这三种关系。乱值会让"要不要锁末帧"的判断变成掷骰子。
      if (!continuity.LINKS.includes(value)) continue;
    } else if (key === 'variants') {
      // 只留真实存在的条目 + 真实存在的变体：指向不存在的变体等于悄悄回退到默认，
      // 而界面上还显示着你选的那一版
      const next = {};
      for (const [who, vid] of Object.entries(value && typeof value === 'object' ? value : {})) {
        const item =
          (project.bible?.characters || []).find((x) => x.name === who) ||
          (project.bible?.scenes || []).find((x) => x.name === who) ||
          (project.bible?.props || []).find((x) => x.name === who);
        if (!item) continue;
        if (!variants.findVariant(item, vid)) continue;
        next[who] = vid;
      }
      value = next;
    } else if (key === 'skills') {
      // 在**保存时**就把互斥组规整掉。存下一个自相矛盾的组合，
      // 界面会显示两个互斥技法都选中、而实际只有一个生效 ——
      // 界面和事实不一致，比少一个功能糟糕得多。
      const norm = skillsLib.normalize(value);
      dropped.push(...norm.dropped);
      value = norm.ids;
    } else if (key === 'stage') {
      /**
       * 排位是**对象**，不能掉进下面那个 String(value).trim() 里 ——
       * 那会把它存成 "[object Object]"：接口回 200、界面看着像存住了，
       * 下次读出来是一坨没法用的字符串。规整一遍再存。
       */
      value = previz.normalizeStage(value);
    } else if (key === 'characters') {
      // 界面上是一行逗号分隔的文本，中英文逗号和顿号都得认
      value = Array.isArray(value)
        ? value.map((x) => String(x).trim()).filter(Boolean)
        : String(value || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
    } else {
      value = String(value ?? '').trim();
    }
    const same = key === 'characters' || key === 'skills' || key === 'variants' || key === 'stage'
      ? JSON.stringify(value) === JSON.stringify(shot[key] ?? (key === 'variants' ? {} : key === 'stage' ? null : []))
      : value === shot[key];
    if (same) continue;
    shot[key] = value;
    changed.push(key);
  }

  if (changed.length) {
    shot.editedAt = new Date().toISOString();
    // 手选过说话人就记一笔。没这一笔的话，"手动选了旁白"和"还没绑过"
    // 在数据上长得一模一样（都是空字符串），自动绑定会把你选的旁白改掉
    if (changed.includes('speaker')) shot.speakerBy = 'manual';
    // 手改过的镜头，上一次的一致性分数是对**旧描述**打的，留着会误导。
    // 产物本身不删 —— 用户可能只是修个错别字，没必要把已经出好的图弄没。
    // 时长和衔接关系改的不是画面内容，出好的图还是那张图，分数依然作数
    if (changed.some((k) => k !== 'duration' && k !== 'link') && shot.consistency) {
      shot.consistency = { ...shot.consistency, stale: true };
    }
    store.save(project);
  }
  // 被规整掉的选择要如实回报，界面才能说清楚"为什么我选的那个没了"
  return { project: store.read(projectId), changed, dropped };
}

export const SKILL_PROMPT = `你是分镜师。下面给你一份分镜表和一份**技法卡清单**，
为每一镜挑出最合适的技法。

判断依据：
- 情绪张力大、要压迫感 → 仰拍 / 荷兰角 / 顶光
- 交代环境、定场       → 全景机位 / 拉镜 / 黄金时刻
- 对话戏               → 过肩 / 平视 / 实用光源
- 打斗、追逐           → 手持微晃 / 跟拍 / 低角度
- 情绪特写             → 大特写 / 伦勃朗光 / 推镜

连贯（这一段比"单镜挑得准"更要紧 —— 逐镜都对、连起来不成立，是最常见的失败）：
- 每镜给了 link，说明它和**上一镜**的关系：
  new-scene = 换场景；cut = 同场景换机位；continuous = 连续动作（推门→进门）
- link 是 cut 的镜头，和上一镜**必须用同一张光线卡**。同一场戏里不能上一镜黄金时刻、
  下一镜月光冷调 —— 那是一场戏拍了两个时段。除非画面描述里光线真的变了（开灯、天亮、进隧道）
- link 是 continuous 的两镜，运镜要顺下去：推镜接推镜或固定镜头，**不要推镜接拉镜**
- 不要连着三镜用同一张机位卡，景别要有起伏
- 机位卡要和这一镜的 camera（景别）对得上：camera 是全景/远景就别选大特写
- 荷兰角、希区柯克变焦、纯剪影这类强风格卡，全片最多两三次，而且要用在情绪顶点上

规矩（必须遵守）：
- 只能用清单里给出的 id，**不要自创**；
- 标了「单选」的分类，每镜最多挑一个；
- **宁缺毋滥**：这一镜没有明显该用的技法就少给或不给。
  每镜都堆五个技法，等于每镜都没有重点，反而不如不选；
- 每镜 0~4 个；
- 分镜表里 pick 为 false 的镜头**只是给你看上下文的**，不要为它们输出结果，
  但你挑的技法要和它们已有的（skills 字段）接得上。

严格只输出 JSON，不要解释、不要代码块：

{"shots":[{"id":"分镜的 id，原样照抄","skills":["技法 id"],"why":"一句话说明为什么这么选"}]}

技法卡清单：
{{SKILLS}}`;

/**
 * 让模型按画面描述**自动挑技法**。
 *
 * 手选的问题不在于麻烦，在于**你未必记得住**：伦勃朗光、荷兰角、希区柯克变焦
 * 这些术语，不是天天用就想不起来 —— 于是四十七张卡里你永远只用那三张。
 * 模型读一遍描述就能把该用的挑出来，这是它真正擅长的事。
 *
 * 三个刻意的设计：
 *   ① **一次调用管全片**。逐镜问一次，二十镜就是二十次调用，又慢又贵，
 *      而且模型看不到上下文，容易每镜都挑同一套。
 *   ② **让它给理由**。理由不进提示词，只显示给你看 ——
 *      你要判断的是"它为什么这么挑"，而不是盯着一串 id 猜。
 *   ③ **宁缺毋滥写进提示词**。不写这句，模型会给每一镜都堆满技法，
 *      每镜都有重点等于每镜都没重点。
 *
 * ── "挑的对不上前面也对不上后面" ──
 *
 * "一次调用管全片"只是让模型**能**看到上下文，不等于它真的用了。
 * 它实际上在做 N 道互相独立的分类题，不会回头看第 6 镜挑了什么。
 * 所以这里做了三件事，缺一不可：
 *
 *   发过去的每镜带上 link（和上一镜的关系）、camera（景别）、duration，
 *     不然它连"这两镜是同一场戏"都不知道；
 *   提示词里明写连贯规矩（同场戏光线统一、连续动作运镜不掉头、机位别连着三镜重复）；
 *   收回来之后再用 skills.harmonize() **确定性地**捋一遍。
 *     只靠提示词是不够的 —— 模型会答应你，然后照样犯。
 *
 * 只重挑一部分（only）时，其余镜头照样发过去，标 pick:false 当上下文，
 * 否则重挑的那几镜必然和没重挑的那几镜对不上 —— 它压根没看见它们。
 */
export const LINK_PROMPT = `你是剪辑师。下面给你一份分镜表，判断**每一镜和上一镜之间是不是"连续动作"**。

"连续动作"的定义很窄：**这一镜是上一镜那个动作的下一瞬间**，中间没有时间流逝、机位也没有跳。
典型的是把一个动作拆成两镜：
  伸手去够门把手 → 把门把手拧下去        ✅ 连续
  转身面向门口   → 迈步走出门            ✅ 连续
  举起杯子       → 杯子送到嘴边          ✅ 连续

不是连续动作的（这些占绝大多数）：
  他在办公桌前批改作业 → 特写他的钢笔      ❌ 同一场戏换机位而已
  两人对话，A 说完 → 切到 B 的反应        ❌ 反打，是剪辑
  他走出办公室   → 走廊尽头的安全灯        ❌ 换了拍摄对象
  白天在教室     → 夜里在家               ❌ 换场次

⚠ **判错的代价不对称，所以默认永远是 cut**：
- 该切的地方标成连续 → 这一段失去剪辑感、机位被锁死，整段只能重出；而且这几镜必须串行生成，慢好几倍
- 该连的地方标成切   → 顶多硬切一下，还能看

拿不准就给 cut。宁可漏掉几处，也不要多标一处。

严格只输出 JSON，不要解释、不要代码块：
{ "shots": [ { "index": 2, "link": "continuous", "why": "上一镜伸手，这一镜是同一只手拧下把手" } ] }

只列你判定为 continuous 的那些镜，其余不用出现。why 写一句话，说清楚"哪个动作在延续"。`;

/**
 * 让调度模型通读全片，把「连续动作」标出来。
 *
 * ── 为什么必须是模型，不是规则 ──
 *
 * 规则能判的只有"换没换场景"（比场景名），而那正是 deriveLink 已经在做的。
 * "这一镜是不是上一镜那个动作的下一瞬间"要读懂两句中文描述之间的**动作关系**：
 * 「伸手去够门把手」和「把门把手拧下去」是同一只手的同一个动作，
 * 而「他在批改作业」和「特写他的钢笔」不是 —— 字面上都发生在同一场戏、
 * 同一批词，规则区分不了，硬写关键词只会得到一个不断误判的东西。
 *
 * ── 而判错的代价是不对称的 ──
 *
 * 标多了：那一段失去剪辑感、机位锁死，整段只能重出；而且连续镜必须**串行**
 * 生成（每镜要等上一镜的末帧），慢好几倍。
 * 标少了：顶多硬切一下，还能看。
 *
 * 所以提示词里反复说"拿不准就给 cut"，而且下面还有一层确定性的收口 ——
 * 提示词只是请求，这个项目里已经栽过不止一次。
 */
export async function suggestLinks(projectId, { only = null, onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const all = continuity.withLinks(project.shots || []);
  if (!all.length) throw new Error('还没有分镜');

  const r = routing();
  onEvent?.({
    type: 'stage',
    stage: 'script',
    status: 'running',
    message: `让调度模型 ${r.director.model}（${r.director.provider}）通读 ${all.length} 镜，找出哪些是连续动作…`
  });

  const payload = all.map((s) => ({
    index: s.index,
    segment: s.segment || 1,
    scene: s.scene,
    description: s.description,
    camera: s.camera,
    dialogue: s.dialogue
  }));

  const { text } = await adapters.chat({
    providerId: r.director.provider,
    model: r.director.model,
    system: LINK_PROMPT,
    user: JSON.stringify(payload),
    temperature: 0.2,
    jsonMode: true,
    label: '标衔接关系'
  });

  const parsed = consistency.extractJSON(text);
  const picks = new Map(
    (Array.isArray(parsed.shots) ? parsed.shots : [])
      .filter((x) => x && x.link === 'continuous' && Number.isFinite(Number(x.index)))
      .map((x) => [Number(x.index), String(x.why || '').trim()])
  );

  const changed = [];
  const refused = [];
  store.update(projectId, (p) => {
    const sorted = (p.shots || []).slice().sort((a, b) => a.index - b.index);
    let run = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      const shot = sorted[i];
      const prev = i ? sorted[i - 1] : null;
      const want = picks.has(shot.index);

      /**
       * ── 确定性收口。提示词只是请求，这几条必须由代码保证 ──
       */
      // ① 人手选过的不动。悄悄改用户选的东西，会让他看着一个自己没选过的结果
      if (shot.linkBy === 'user') {
        if (want) refused.push({ index: shot.index, why: '你手动标过这一镜，没有覆盖' });
        continue;
      }
      if (!want) {
        // 模型没点名的一律回到默认（cut / new-scene 由 deriveLink 定）
        if (shot.link === 'continuous') {
          changed.push({ index: shot.index, to: 'cut', why: '这一轮没判成连续动作' });
          shot.link = 'cut';
          shot.linkWhy = '';
        }
        run = 0;
        continue;
      }
      // ② 第一镜没有上一镜可连
      if (!prev) {
        refused.push({ index: shot.index, why: '这是第一镜，没有上一镜可接' });
        run = 0;
        continue;
      }
      // ③ 跨场次不可能是连续动作 —— 另一个地方、另一段时间
      if (Number(prev.segment || 1) !== Number(shot.segment || 1)) {
        refused.push({ index: shot.index, why: `和第 ${prev.index} 镜跨了场次` });
        run = 0;
        continue;
      }
      /**
       * ④ 一串连续镜不能太长。
       *
       * 连着四五镜都是「连续动作」，等于整段变成一个没剪过的长镜头 ——
       * 而且它们必须**串行**生成（每镜要等上一镜出片抠末帧），慢好几倍。
       * 三镜是一个动作拆到头的合理上限（伸手→握住→拧开）。
       */
      if (run >= 2) {
        refused.push({ index: shot.index, why: '已经连着三镜了，再连下去整段会变成一个长镜头' });
        run = 0;
        continue;
      }

      if (shot.link !== 'continuous') {
        changed.push({ index: shot.index, to: 'continuous', why: picks.get(shot.index) });
      }
      shot.link = 'continuous';
      shot.linkWhy = picks.get(shot.index);
      run += 1;
    }
    return p;
  });

  for (const c of changed) {
    onEvent?.({ type: 'note', message: `第 ${c.index} 镜 → ${continuity.LINK_LABELS[c.to]}${c.why ? `（${c.why}）` : ''}` });
  }
  // 被规矩拦下来的也要说 —— 不然人看到模型说了却没生效，只会以为功能坏了
  for (const x of refused) {
    onEvent?.({ type: 'note', message: `第 ${x.index} 镜模型想标连续动作，没采纳：${x.why}` });
  }
  onEvent?.({
    type: 'stage',
    stage: 'script',
    status: 'done',
    message: changed.length
      ? `标好了：${changed.filter((c) => c.to === 'continuous').length} 处连续动作`
      : '通读完了，没有哪两镜构成连续动作 —— 这很正常，大部分镜位切换本来就该硬切'
  });
  return { project: store.read(projectId), changed, refused };
}

export async function suggestSkills(projectId, { only = null, onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  // link 要按**全片**推断：只拿要重挑的那几镜去推，"上一镜"就找错人了
  const linked = continuity.withLinks(project.shots || []);
  const shots = linked.filter((s) => (only ? only.includes(s.id) : true));
  if (!shots.length) throw new Error('还没有分镜');

  const catalog = skillsLib.catalogForUI();
  const listing = catalog
    .map((g) => {
      const items = g.skills.map((s) => `    ${s.id} = ${s.name}${s.hint ? `（${s.hint}）` : ''}`).join('\n');
      return `  ${g.name}${g.exclusive ? '【单选】' : '【可多选】'}${g.slot === 'motion' ? '（只影响视频）' : ''}\n${items}`;
    })
    .join('\n');

  const r = routing();
  // 挑技法走的是**剧本模型**（能力路由里的"剧本/文本"那一路），不是出图模型。
  // 把它印出来：出了问题第一件要知道的事就是"这活儿是谁干的"。
  onEvent?.({
    type: 'stage',
    stage: 'script',
    status: 'running',
    message: `让调度模型 ${r.director.model}（${r.director.provider}${r.director.followsChat ? '，跟随剧本模型' : ''}）给 ${shots.length} 镜挑技法…`
  });

  const forModel = (s) => ({
    id: s.id,
    index: s.index,
    scene: s.scene,
    // 和上一镜是什么关系。没有这个字段，模型不知道哪两镜是同一场戏
    link: s.link,
    characters: s.characters,
    description: s.description,
    camera: s.camera,
    duration: s.duration,
    dialogue: s.dialogue
  });
  const wanted = new Set(shots.map((s) => s.id));
  const payload = linked.map((s) =>
    wanted.has(s.id)
      ? { ...forModel(s), pick: true }
      // 上下文镜头：把它已经选好的技法一并给出去，新挑的才有得接
      : { ...forModel(s), pick: false, skills: s.skills || [] }
  );

  const { text } = await adapters.chat({
    providerId: r.director.provider,
    model: r.director.model,
    system: SKILL_PROMPT.replace('{{SKILLS}}', listing),
    user: JSON.stringify(payload),
    temperature: 0.3,
    jsonMode: true,
    label: '挑技法'
  });

  const parsed = consistency.extractJSON(text);
  const picks = Array.isArray(parsed.shots) ? parsed.shots : [];

  const touched = [];
  store.update(projectId, (p) => {
    for (const pick of picks) {
      const target = p.shots.find((s) => s.id === pick.id);
      // 只认这次要重挑的那些镜头：模型有时会顺手把上下文镜头也答一遍，
      // 那等于把你没打算动的镜头改掉了
      if (!target || !wanted.has(target.id)) continue;
      // 和手选走同一条规整逻辑：互斥组只留一个、不认识的 id 丢掉。
      // 模型偶尔会自创 id 或者两个互斥的都给。
      const norm = skillsLib.normalize(pick.skills);
      /**
       * 排过位的镜头，**机位和运镜那几张卡轮不到模型挑**。
       *
       * 那几张卡说的正是排位已经算出来的东西（平视/仰拍/大特写/推镜/固定镜头…）。
       * 两句话会一起进同一条提示词而且挨着，模型只能挑一句听 ——
       * 表现是"排了位好像没生效"，却什么错都不报。
       *
       * 这里过滤而不是在提示词里嘱咐模型别挑：提示词只是**请求**，
       * 而这条规矩不能靠请求（这份文件里已经栽过一次 —— 见 SHOTS_REPLY 那段注释）。
       *
       * ⚠ 只过滤自动挑的。人自己在界面上选的不动 —— 悄悄改用户选的东西，
       * 会让他看着一个自己没选过的结果想不明白哪儿来的。那种冲突走体检报出来。
       */
      const staged = Boolean(target.stage?.cam);
      const kept = staged
        ? norm.ids.filter((id) => !previz.SKILLS_OWNED_BY_STAGE.includes(id))
        : norm.ids;
      if (staged && kept.length < norm.ids.length) {
        const dropped = norm.ids.filter((id) => !kept.includes(id));
        onEvent?.({
          type: 'note',
          message: `第 ${target.index} 镜排过位，机位那几张卡（${dropped.join('、')}）不挑了 —— 机位由排位说了算，两边都说会打架`
        });
      }
      target.skills = kept;
      target.skillWhy = String(pick.why || '').trim();
      touched.push({ id: target.id, index: target.index, dropped: norm.dropped });
    }
    return p;
  });

  // ── 顺场：模型答应了连贯规矩，但照样会犯，所以再确定性地捋一遍 ──
  // 捋的时候看**全片**（含这次没重挑的镜头），写回时只写这次重挑的那些。
  const fixedNotes = [];
  {
    const fresh = store.read(projectId);
    const { shots: harmonized, notes } = skillsLib.harmonize(continuity.withLinks(fresh.shots || []));
    const changes = harmonized.filter((h) => wanted.has(h.id));
    if (changes.length) {
      store.update(projectId, (p) => {
        for (const h of changes) {
          const target = p.shots.find((s) => s.id === h.id);
          if (target) target.skills = h.skills;
        }
        return p;
      });
    }
    for (const n of notes) if (wanted.has(harmonized.find((h) => h.index === n.index)?.id)) fixedNotes.push(n);
  }

  const final = store.read(projectId);
  const applied = touched.map((t) => {
    const s = final.shots.find((x) => x.id === t.id);
    return { index: t.index, names: skillsLib.labelsFor(s?.skills || []), why: s?.skillWhy || '', dropped: t.dropped };
  });

  for (const a of applied.slice(0, 40)) {
    onEvent?.({
      type: 'note',
      message: `第 ${a.index} 镜：${a.names.join('、') || '不用技法'}${a.why ? ` —— ${a.why}` : ''}`
    });
  }
  // 自动改了什么必须说出来 —— 否则你只会看到"和模型说的不一样"，却不知道是谁改的
  for (const n of fixedNotes.slice(0, 20)) {
    onEvent?.({
      type: 'note',
      message: `第 ${n.index} 镜顺场：${n.to ? `「${n.from}」改成「${n.to}」` : `去掉「${n.from}」`} —— ${n.why}`
    });
  }

  const missed = shots.length - applied.length;
  onEvent?.({
    type: 'stage',
    stage: 'script',
    status: 'done',
    message: `${applied.length} 镜已挑好技法${missed > 0 ? `，${missed} 镜模型没给` : ''}。翻一遍，不满意的手改掉再重出图`
  });
  return { project: store.read(projectId), applied };
}

// ═══════════════════════ 章节 ═══════════════════════

/**
 * 把长剧本切成章节。设定集不受影响 —— 它挂在项目上，全片共享。
 * 已经拆过分镜的章节会尽量保留状态（按标题匹配），避免重切一次前功尽弃。
 */
const CHAPTER_PROMPT = `你是小说编辑，正在为一部要改编成影片的作品划分章节。

下面给你一段小说原文。找出其中**适合作为新一章开头**的位置。

判断依据（按重要性排序）：
- 时间跳跃（"三日后"、"次年春"）
- 地点转换（一场戏结束，人物到了另一个地方）
- 视角或叙事线切换
- 一个完整情节单元的结束（冲突解决、悬念抛出）

不要机械地按长度切。一场连续的戏**不能**从中间劈开。
一般每 {{TARGET}} 字左右一章比较合适，但情节说了算，长一点短一点都正常。

严格只输出 JSON，不要解释、不要代码块：

{
  "breaks": [
    {
      "anchor": "新一章的第一句原文，逐字照抄 10~25 个字，必须能在原文里一字不差地找到",
      "title": "这一章的标题（6~14 字，要具体，别写'第二章'）",
      "summary": "一句话梗概"
    }
  ]
}

要点：
- **anchor 必须是原文里一字不差的片段**，不要润色、不要改标点，否则会被丢弃；
- 只报"新一章从这里开始"的位置，不要把整段原文的开头也算进去；
- 这段原文里没有合适的断点时，breaks 给空数组。`;

/**
 * 让模型分章。
 *
 * 按字数切（autoSplit）的好处是免费、瞬间、可复现，坏处是**它不懂剧情** ——
 * 可能把一场戏从中间劈开，于是第一章结尾莫名其妙，第二章开头没头没脑。
 *
 * 两条路并存而不是替换：先用免费那条跑通全流程，觉得切得不好再花一次钱让模型切。
 *
 * 长篇塞不进上下文，所以**滑窗**：每次给模型一段带重叠的文本，
 * 只问"这一段里哪些位置适合断章"，再把各窗口的答案拼起来。
 * 重叠是必须的 —— 断点正好落在窗口边界上时，两边都只看到半截。
 *
 * 关键的一手是**让模型回原文片段而不是字符位置**：模型数不准字数，
 * 报出来的偏移基本是错的；让它引一句原文，我们自己 indexOf 就精确了。
 * 把模型不擅长的事留给代码。
 */
export async function smartSplitChapters(projectId, { targetChars = 3000, onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const script = project.script?.trim();
  if (!script) throw new Error('剧本是空的');

  const r = routing();
  const windows = chapters.windowsOf(script, { size: 8000, overlap: 800 });
  onEvent?.({
    type: 'stage',
    stage: 'script',
    status: 'running',
    message: `全文 ${script.length} 字，分 ${windows.length} 段交给模型判断断章点…`
  });

  const anchors = [];
  for (const [i, win] of windows.entries()) {
    onEvent?.({ type: 'note', message: `第 ${i + 1}/${windows.length} 段（${win.start}~${win.end} 字）…` });
    try {
      const { text } = await adapters.chat({
        // 断章是判断题不是生成题，和挑技法、绑说话人一样走调度模型
        providerId: r.director.provider,
        model: r.director.model,
        system: CHAPTER_PROMPT.replace('{{TARGET}}', String(targetChars)),
        user: win.text,
        temperature: 0.2,
        jsonMode: true,
        label: `分章 ${i + 1}/${windows.length}`
      });
      const parsed = consistency.extractJSON(text);
      const got = Array.isArray(parsed.breaks) ? parsed.breaks : [];
      anchors.push(...got);
      onEvent?.({ type: 'note', message: `这一段给出 ${got.length} 个断点` });
    } catch (err) {
      // 一段失败不该拖垮整篇：少切几刀总比整个功能报错强
      onEvent?.({ type: 'note', message: `第 ${i + 1} 段没判成（${err.message}），跳过` });
    }
  }

  const fresh = chapters.splitAtAnchors(script, anchors, { minChars: Math.floor(targetChars / 3) });
  if (!fresh.length) {
    throw new Error(
      `模型没给出可用的断点（收到 ${anchors.length} 个，但没有一个能在原文里精确定位）。` +
      '多半是它把引文润色过了。可以再试一次，或者用「按字数切」那条路。'
    );
  }

  const saved = applyChapters(projectId, fresh);
  onEvent?.({
    type: 'stage',
    stage: 'script',
    status: 'done',
    message: `切出 ${fresh.length} 章：${fresh.map((c) => c.title).join('、')}`
  });
  return saved;
}

/** 落盘章节，尽量保住已经跑完的那些章的状态（按标题 + 正文匹配） */
function applyChapters(projectId, fresh) {
  return store.update(projectId, (p) => {
    const old = new Map((p.chapters || []).map((c) => [c.title, c]));
    p.chapters = fresh.map((c) => {
      const prev = old.get(c.title);
      // 正文没变才留住状态；改过的章节必须重拆，否则分镜和正文对不上
      return prev && prev.script === c.script ? { ...c, stageStatus: prev.stageStatus, outputs: prev.outputs } : c;
    });
    const keep = new Set(p.chapters.filter((c) => c.stageStatus.script === 'done').map((c) => c.id));
    p.shots = (p.shots || []).filter((s) => !s.chapterId || keep.has(s.chapterId));
    p.stageStatus.script = p.chapters.every((c) => c.stageStatus.script === 'done') ? 'done' : 'pending';
    return p;
  });
}

export function splitChapters(projectId, { targetChars } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!project.script?.trim()) throw new Error('剧本是空的');

  const fresh = chapters.autoSplit(project.script, { targetChars });
  if (!fresh.length) throw new Error('没能切出章节');
  return applyChapters(projectId, fresh);
}

export function clearChapters(projectId) {
  return store.update(projectId, (p) => {
    p.chapters = [];
    p.shots = (p.shots || []).filter((s) => !s.chapterId);
    return p;
  });
}

/** 这段剧本值不值得分章 */
export function chapterAdvice(script) {
  return {
    suggested: chapters.suggestsChapters(script),
    chars: String(script || '').length,
    threshold: chapters.LONG_FORM_THRESHOLD,
    preview: chapters.autoSplit(script).map((c) => ({ id: c.id, title: c.title, chars: c.chars }))
  };
}

// ═══════════════════════ 阶段三：镜头出图（带一致性复核）═══════════════════════

export async function generateAssets(projectId, { only = null, chapterId = null, regenerate = false, onEvent, signal = null } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!project.shots?.length) throw new Error('还没有分镜，先跑「分镜」');
  if (!project.bible) throw new Error('缺少设定集');

  const dir = store.assetDir(projectId);
  const r = routing();
  const maxRetries = settings.get('consistencyMaxRetries') ?? 2;
  const targets = project.shots
    .filter((s) => (chapterId ? s.chapterId === chapterId : true))
    // regenerate 是「整步重跑」：连已经出好的也重来，界面上会先要一次确认
    .filter((s) => (only ? only.includes(s.id) : regenerate || !s.imagePath));

  onEvent?.({ type: 'stage', stage: 'assets', status: 'running', message: `待出图 ${targets.length} 张` });

  /**
   * 出图之前先说一句：这一批里有哪些角色/场景**还没有设定图**。
   *
   * 缺一张不会报错，只是那一镜少一份参考基准和一份复核依据 ——
   * 表现是"别的镜头都挺像，就这几镜的人不对"，而且事后很难想到是这个原因。
   */
  const missingSheets = new Set();
  for (const shot of targets) {
    for (const c of consistency.matchCharacters(project.bible, shot)) {
      if (!c.sheetPath) missingSheets.add(c.name);
    }
    const sc = consistency.matchScene(project.bible, shot);
    if (sc && !sc.sheetPath) missingSheets.add(sc.name);
  }
  if (missingSheets.size) {
    onEvent?.({
      type: 'note',
      message:
        `⚠ 这一批里 ${[...missingSheets].join('、')} 还没有设定图 —— ` +
        '引用到它们的镜头会少一张参考图、也少一份复核基准，出来多半不像。' +
        '建议先回「设定集」那一步把它们补出来。'
    });
  }

  for (const shot of targets) {
    // 停在下一个安全点：还没开始的这一镜一张都不发（不计费）。
    // 已经发出去的那一镜不在这里 —— 它在上一圈，跑完并存下来了
    jobs.checkpoint(signal, `第 ${shot.index} 镜起往后的 ${targets.length - targets.indexOf(shot)} 镜`);
    try {
      const result = await consistency.generateConsistentImage({
        project,
        shot,
        bible: project.bible,
        maxRetries,
        onEvent,
        refresh: (refs) => refreshRefs(project, refs, { onEvent })
      });

      const dest = path.join(dir, `${shot.id}.png`);
      await saveMedia(result, dest, onEvent);
      const size = checkRatio(dest, project.aspectRatio || settings.get('aspectRatio'), `第 ${shot.index} 镜`, onEvent);
      const modelRef = await toModelRef(dest, { onEvent });

      store.update(projectId, (p) => {
        const t = p.shots.find((s) => s.id === shot.id);
        if (t) {
          t.imagePath = dest;
          t.imageRef = modelRef;
          t.seed = result.seed;
          t.prompt = result.prompt;
          // 出图时间。和 editedAt 一比就知道"这张图是不是按现在这版描述出的" ——
          // 改完描述不重出图就去出视频，首帧是旧画面、提示词是新描述，两边必然打架
          t.imageAt = new Date().toISOString();
          // 真实宽高。比例不对时卡片上要挂个警示 —— 这个错会顺着首帧图传到视频
          t.imageSize = size || null;
          // 这一镜是哪家哪个模型出的。中途换过模型是**风格漂移最常见的原因**，
          // 而它不会报任何错 —— 只是第 6 镜起画风变了，你会以为是提示词的问题
          t.modelUsed = `${r.image.provider} / ${r.image.model}`;
          t.bibleRefs = result.refLabels || [];
          t.consistency = {
            score: result.verification?.score ?? null,
            pass: result.verification?.pass ?? null,
            needsReview: Boolean(result.verification?.needsReview),
            issues: result.verification?.issues || [],
            attempts: result.trail?.length || 1
          };
          t.status = result.verification?.needsReview ? 'needs-review' : 'image-ready';
        }
        return p;
      });
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'done', score: result.verification?.score ?? null });
    } catch (err) {
      // 取消不是失败：不该把这一镜标成 failed，那会让人以为它出错了
      if (jobs.isCancel(err)) throw err;
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'failed', message: err.message });
      store.update(projectId, (p) => {
        const t = p.shots.find((s) => s.id === shot.id);
        if (t) t.status = 'failed';
        return p;
      });
    }
  }

  const after = store.read(projectId);
  const done = after.shots.filter((s) => s.imagePath).length;
  const flagged = after.shots.filter((s) => s.consistency?.needsReview).length;
  /**
   * 全片是不是用同一个模型出的。
   *
   * 换模型不会报任何错，只是从某一镜起画风变了 —— 而这是"风格不一致"里
   * 最难自己想到的一种原因（大多数人会先去怀疑提示词）。所以跑完点一句。
   */
  {
    const used = new Set((store.read(projectId).shots || []).filter((s) => s.modelUsed).map((s) => s.modelUsed));
    if (used.size > 1) {
      onEvent?.({
        type: 'note',
        message:
          `⚠ 全片的图不是同一个模型出的（${[...used].join(' / ')}）。不同模型的画风对不上，` +
          '连起来会看出"从某一镜开始变了"。要统一的话，用同一个模型把这些镜头重出一遍。'
      });
    }
  }

  store.update(projectId, (p) => {
    p.stageStatus.assets = done === p.shots.length ? 'done' : done ? 'partial' : 'pending';
    return p;
  });
  onEvent?.({
    type: 'stage',
    stage: 'assets',
    status: 'done',
    message: `${done}/${after.shots.length} 张就绪${flagged ? `，${flagged} 张待人工确认` : ''}`
  });
  return store.read(projectId);
}

// ═══════════════════════ 单项重出 ═══════════════════════

/**
 * 重出某一镜的图。
 *
 * 批量出图必然有零星失败或不满意的 —— 为了三张图重跑整个阶段，
 * 既慢又要重烧已经出好的那些。所以单独开一个入口，并且允许临时换模型：
 * 有些镜头就是某家画不好，换一家往往比反复重试有效。
 *
 * @param {object} opts
 * @param {string} [opts.provider] 临时换服务商，不传用全局路由
 * @param {string} [opts.model]    临时换模型
 * @param {string} [opts.prompt]   手写提示词，完全覆盖自动装配的那套
 * @param {number} [opts.seed]     指定种子；不传则在原种子上偏移，避开上次那个坑
 */
export async function regenerateShot(projectId, shotId, opts = {}, onEvent) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const shot = project.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error(`没有这一镜：${shotId}`);
  if (!project.bible) throw new Error('缺少设定集');

  const r = routing();
  const providerId = opts.provider || r.image.provider;
  const model = opts.model || r.image.model;
  const assembled = consistency.assemblePrompt(project.bible, shot);
  // 不指定种子时换一颗：同种子重采样大概率复现同一个错误
  const seed = Number.isFinite(opts.seed) ? opts.seed : assembled.seed + Math.floor(Math.random() * 9973) + 1;

  // 单独重出同样要带设定集：提示词从冻结设定装配，参考图带上场景 + 角色 + 道具。
  // 少带一样，重出的这一镜就会成为全片里唯一对不上的那一张。
  // 和批量出图保持一致：分镜图默认不走图生图（编辑模型会把这一镜画成
  // "被改过的角色设定图"）。开关在「设置 → 画面规格」。
  const useEdit = settings.get('useEditModelForShots') === true;
  // 过期的限时地址在这儿换掉，否则厂商只会回一句"下载不到你给的图"
  const freshRefs =
    !useEdit || settings.get('useReferenceImages') === false
      ? { images: [], labels: [] }
      : await refreshRefs(
        project,
        { images: assembled.refImages, labels: assembled.refLabels, paths: assembled.refPaths },
        { onEvent }
      );
  const refImages = freshRefs.images;
  onEvent?.({ type: 'shot', shotId, status: 'running', message: `第 ${shot.index} 镜重出（${providerId} / ${model}）…` });
  if (refImages.length) {
    onEvent?.({ type: 'note', message: `参考设定集：${freshRefs.labels.join('、')}` });
  }

  const image = await adapters.generateImage({
    providerId,
    model,
    /**
     * 只有**没指定模型**时才自动切图生图模型。
     * 用户在卡片上专门挑了一个模型，那就照他挑的发 ——
     * 界面上写着一个模型、实际发的是另一个，比参考图不生效更糟。
     */
    editModel: opts.model || !useEdit ? null : undefined,
    prompt: opts.prompt?.trim() || assembled.prompt,
    negative: assembled.negative,
    aspectRatio: project.aspectRatio || null,
    seed,
    refImages,
    label: `重出 #${shot.index}`,
    onEvent
  });

  const dest = path.join(store.assetDir(projectId), `${shot.id}.png`);
  await saveMedia(image, dest, onEvent);
  const size = checkRatio(dest, project.aspectRatio || settings.get('aspectRatio'), `第 ${shot.index} 镜`, onEvent);
  const modelRef = await toModelRef(dest, { onEvent });

  // 复核这一镜，让分数跟着更新 —— 否则卡片上还挂着上一版的分数，会误导
  let verification = { skipped: true };
  const cast = consistency.matchCharacters(project.bible, shot);
  if (settings.get('consistencyVerify') !== false && cast.length && image.url) {
    // 和批量出图同一套规矩：拿这一镜用的那个变体当基准，
    // 退回默认那版时告诉复核模型忽略服装差异
    const cv = variants.pickVariant(cast[0], shot);
    verification = await consistency.verifyShot({
      shotImageUrl: image.url,
      character: cv?.sheetUrl ? { ...cast[0], sheetUrl: cv.sheetUrl } : cast[0],
      threshold: settings.get('consistencyThreshold') ?? 75,
      ignoreOutfit: !cv?.sheetUrl && Boolean(cv && cv.id !== variants.DEFAULT_VARIANT_ID),
      onEvent
    });
  }

  store.update(projectId, (p) => {
    const t = p.shots.find((s) => s.id === shotId);
    if (t) {
      t.imagePath = dest;
      t.imageRef = modelRef;
      t.seed = seed;
      t.prompt = opts.prompt?.trim() || assembled.prompt;
      t.imageAt = new Date().toISOString();
      t.imageSize = size || null;
      t.modelUsed = `${providerId} / ${model}`;
      t.bibleRefs = refImages.length ? assembled.refLabels : [];
      t.consistency = {
        score: verification.score ?? null,
        pass: verification.pass ?? null,
        needsReview: false, // 人工点的重出，就当人已经在看着了
        issues: verification.issues || [],
        attempts: 1
      };
      t.status = 'image-ready';
      // 图换了，旧视频就对不上了，清掉免得合成时用了错的
      if (t.videoPath) {
        t.videoPath = null;
        t.status = 'image-ready';
      }
    }
    p.stageStatus.video = p.shots.some((s) => s.videoPath) ? 'partial' : 'pending';
    return p;
  });

  onEvent?.({ type: 'shot', shotId, status: 'done', score: verification.score ?? null });
  return store.read(projectId);
}

/** 重出某一镜的视频（图不动，只重跑视频那步） */
/** 这一镜的产物落在哪儿。版本号是按这两个路径算的 */
function shotAssetPath(projectId, shot, kind) {
  return path.join(store.assetDir(projectId), `${shot.id}.${kind === 'video' ? 'mp4' : 'png'}`);
}

/**
 * 这一镜出过几版，每版什么时候出的。
 *
 * 直接扫盘，不读记录 —— 记录会和盘上的东西对不上（清过盘、写到一半崩了），
 * 而界面照着记录画出五个缩略图、点第四个是空的，比没有这个功能更糟。
 */
export function shotVersions(projectId, shotId) {
  const project = store.read(projectId);
  const shot = project?.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error(`没有这一镜：${shotId}`);
  const of = (kind) => {
    const dest = shotAssetPath(projectId, shot, kind);
    return {
      current: fs.existsSync(dest) ? dest : null,
      versions: versions.list(dest).map((v) => ({ n: v.n, at: v.at, path: v.path }))
    };
  };
  return { image: of('image'), video: of('video') };
}

/**
 * 回到某一版。
 *
 * ⚠ 只收**版本号**，不收路径。
 *
 * 收路径的话，界面传什么服务端就读什么 —— 一个 `../../../etc/passwd` 就能
 * 把任意文件拷进项目里。路径由服务端自己按 id 和版本号拼出来，
 * 这条路从根上就不存在。
 */
export function restoreShotVersion(projectId, shotId, { kind = 'image', n } = {}) {
  const project = store.read(projectId);
  const shot = project?.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error(`没有这一镜：${shotId}`);
  if (kind !== 'image' && kind !== 'video') throw new Error(`不认识的产物类型：${kind}`);

  const dest = shotAssetPath(projectId, shot, kind);
  const hit = versions.list(dest).find((v) => v.n === Number(n));
  if (!hit) throw new Error(`第 ${shot.index} 镜没有第 ${n} 版了（可能已经被更早的版本挤掉）`);

  versions.restore(dest, hit.path);

  store.update(projectId, (p) => {
    const t = p.shots.find((x) => x.id === shotId);
    if (!t) return p;
    if (kind === 'video') {
      t.videoPath = dest;
      /**
       * 回退视频时，接缝那几笔要**跟着作废**。
       *
       * headFromTail 记的是"这一段是从第 N 镜的末帧长出来的"，
       * 而回到的这一版可能根本不是那么出的。留着的话界面会显示
       * 一个像素级连着的接缝，而实际上并没有 —— 界面和事实不一致，
       * 比少一个功能糟糕得多。
       */
      t.headFromTail = null;
      t.endFrameChained = false;
      t.headMatch = null;
      /**
       * ⚠ 字段叫 tailAlign，不是 seamCheck。
       *
       * 第一版这里写的是 `t.seamCheck = null` —— 清了一个**根本不存在**的字段，
       * 而真正记着接缝比对结论的 tailAlign 原封不动留着了。
       * 后果是回退视频之后，界面还挂着上一版那次"接缝比对通过"，
       * 而这一版根本不是那么出的。赋值给不存在的字段不会报任何错，
       * 这类错只能靠对着写入处核一遍字段名来发现。
       */
      t.tailAlign = null;
    } else {
      t.imagePath = dest;
      // 地址指向的是旧那一版的字节，重出后必须重新上传才对得上
      t.imageRef = null;
      // 一致性分数是给被换掉那一版打的，留着会冒充现在这版的结论
      if (t.consistency) t.consistency = { ...t.consistency, stale: true };
    }
    t.restoredAt = new Date().toISOString();
    return p;
  });

  return { project: store.read(projectId), restored: n, kind };
}

export async function regenerateShotVideo(projectId, shotId, opts = {}, onEvent) {
  const project = store.read(projectId);
  const shot = project?.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error(`没有这一镜：${shotId}`);
  if (!shot.imagePath) throw new Error('这一镜还没有图，先出图再出视频');

  const r = routing();
  /**
   * 单镜重出也走同一套分级。
   *
   * 两条路各挑各的模型，会出现"整批出的和单独重出的画质不一样"——
   * 而这种差别不报任何错，只是那一镜看着不对，查起来毫无头绪。
   * 手动指定（opts.provider）永远最优先。
   */
  const tier = tiers.tierOf(shot);
  const tierRoute = tiers.routeFor(tier, settings.get('videoTiers'));
  const providerId = opts.provider || tierRoute?.provider || r.video.provider;
  const model = opts.model || tierRoute?.model || r.video.model;

  onEvent?.({ type: 'shot', shotId, status: 'running', message: `第 ${shot.index} 镜重出视频（${providerId} / ${model}）…` });

  // 单独重出同样要吃上下文 —— 少了它，重出的这一镜会变成全片里唯一"自成一段"的那一镜。
  // 也放在首帧之前：接缝模式下首帧可能来自上一段视频的真实末帧
  const ctx = await videoContextFor(project, shot, { onEvent, providerId, explain: true });
  const firstFrame =
    ctx.headFromTail?.url
    || usableRef(shot.imageRef)
    || (await toModelRef(shot.imagePath, { onEvent }));
  // 首帧只定住第一格，后面几秒全靠提示词和参考图撑着。
  // 所以这里和批量出视频走完全一样的一套：设定集提示词 + 场景/角色/道具参考图。
  const bibleRefs =
    settings.get('useReferenceImages') === false
      ? { images: [], labels: [] }
      // 过期的限时地址在这儿当场换掉，不然厂商只会回一句"下载不到你给的图"
      : await refreshRefs(project, consistency.collectReferences(project.bible, shot), { onEvent });
  const videoPrompt = opts.prompt?.trim() || ctx.videoPrompt;
  if (bibleRefs.labels.length) {
    onEvent?.({ type: 'note', message: `参考设定集：${bibleRefs.labels.join('、')}` });
  }
  let video;
  try {
    video = await adapters.generateVideo({
      providerId,
      model,
      prompt: videoPrompt,
      firstFrameUrl: firstFrame,
      lastFrameUrl: ctx.lastFrameUrl,
      refImages: bibleRefs.images,
      duration: shot.duration,
      resolution: opts.resolution || null,
      aspectRatio: project.aspectRatio || null,
      label: `重出视频 #${shot.index}`,
      onEvent: (ev) => onEvent?.({ ...ev, shotId })
    });
  } catch (err) {
    // 和批量那条路一样：提交成功但取不回来时，把 task_id 记住。
    // 钱已经花了，任务在厂商那边，不能让它变成黑洞。
    const taskId = err.taskId || (err.message.match(/task_id\s+(\S+)/) || [])[1];
    if (taskId) {
      store.update(projectId, (p) => {
        const t = p.shots.find((s) => s.id === shotId);
        if (t) t.pendingTask = { taskId, provider: providerId, at: new Date().toISOString() };
        return p;
      });
    }
    throw err;
  }

  const dest = path.join(store.assetDir(projectId), `${shot.id}.mp4`);
  await saveMedia(video, dest, onEvent);
  store.update(projectId, (p) => {
    const t = p.shots.find((s) => s.id === shotId);
    if (t) {
      t.videoPath = dest;
      t.videoPrompt = videoPrompt;
      t.videoAt = new Date().toISOString();
      t.videoModelUsed = `${providerId} / ${model}`;
      t.videoResolution = video.resolution || null;
      t.videoRefs = bibleRefs.labels;
      t.link = ctx.link;
      t.endFrameChained = Boolean(ctx.lastFrameUrl);
      // 这一镜的首帧是不是接住了上一段的真实末帧。界面上要能一眼看出
      // 哪几处接缝是"像素级连着的"，哪几处只是文字上接了一下
      t.headFromTail = ctx.headFromTail ? { fromIndex: ctx.headFromTail.fromIndex, at: new Date().toISOString() } : null;
      t.actualDuration = video.actualDuration || shot.duration;
      t.status = 'video-ready';
    }
    return p;
  });

  const head = await verifyVideoHead(shot, dest, { onEvent, headRef: ctx.headFromTail });
  const tail = await verifyVideoTail(projectId, shot, dest, { onEvent });
  const { next: nextShot } = continuity.neighbors(store.read(projectId).shots || [], shotId);
  const seam = await verifyTailAlign(shot, dest, nextShot, { onEvent });
  if (head || tail || seam) {
    store.update(projectId, (p) => {
      const t = p.shots.find((s) => s.id === shotId);
      if (t) {
        if (head) t.headMatch = head;
        if (tail) t.videoConsistency = tail;
        if (seam) t.tailAlign = seam;
      }
      return p;
    });
  }
  onEvent?.({ type: 'shot', shotId, status: 'done' });
  return store.read(projectId);
}

/**
 * 重出设定集里的某一条（角色 / 场景 / 道具），可顺带改描述。
 *
 * 改完描述立刻能看到新图，这比"改完描述、重跑整个设定集、等五分钟"顺手得多，
 * 而调设定本来就是个反复试的过程。
 */
export async function regenerateSheet(projectId, kind, name, opts = {}, onEvent) {
  // opts.variantId 指定重出哪一版；不给就是默认那版
  const project = store.read(projectId);
  if (!project?.bible) throw new Error('还没有设定集');

  const bucket = bibleBucket(project.bible, kind);
  const item = bucket.find((x) => x.name === name);
  if (!item) throw new Error(`设定集里没有「${name}」`);

  // 顺手改描述：先落盘再出图，这样即使出图失败，改的字也留住了
  if (opts.appearance !== undefined || opts.sheetPrompt !== undefined) {
    store.update(projectId, (p) => {
      const t = bibleBucket(p.bible, kind).find((x) => x.name === name);
      if (!t) return p;
      if (opts.appearance !== undefined && opts.appearance !== t.appearance) {
        t.appearance = opts.appearance;
        // 描述改了，各版缓存的出图提示词全过时 —— 不清的话这次重出画的还是旧描述
        t.sheetPrompt = '';
        for (const v of variants.variantsOf(t)) v.sheetPrompt = '';
      }
      if (opts.sheetPrompt !== undefined) {
        const target = variants.findVariant(t, opts.variantId) || variants.defaultVariant(t);
        if (target) target.sheetPrompt = opts.sheetPrompt;
      }
      return p;
    });
  }

  const fresh = store.read(projectId);
  const target = bibleBucket(fresh.bible, kind).find((x) => x.name === name);
  const variant = variants.findVariant(target, opts.variantId) || variants.defaultVariant(target);
  const label = variants.labelOf(target, variant);
  const r = routing();
  const providerId = opts.provider || r.image.provider;
  const model = opts.model || r.image.model;
  const seed = Number.isFinite(opts.seed) ? opts.seed : target.seed + Math.floor(Math.random() * 9973) + 1;

  onEvent?.({ type: 'sheet', name: label, kind, status: 'running', message: `重出${SHEET_LABEL[kind]}：${label}` });

  const prompt = opts.prompt?.trim() || sheetPrompt(kind, fresh.bible, target, variant);
  onEvent?.({ type: 'note', message: `提示词：${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}` });

  const image = await adapters.generateImage({
    providerId,
    model,
    prompt,
    negative: fresh.bible.style.negative,
    seed,
    label: `重出参考图·${label}`,
    onEvent
  });

  const dest = path.join(
    store.assetDir(projectId),
    `ref-${kind}-${safeFileName(name)}-${safeFileName(variant.id)}.png`
  );
  await saveMedia(image, dest, onEvent);
  checkRatio(dest, project.aspectRatio || settings.get('aspectRatio'), `${name} 的设定图`, onEvent);
  const modelRef = await toModelRef(dest, { onEvent });

  store.update(projectId, (p) => {
    const t = bibleBucket(p.bible, kind).find((x) => x.name === name);
    const tv = t && variants.findVariant(t, variant.id);
    if (tv) {
      tv.sheetPath = dest;
      tv.sheetUrl = modelRef;
      // 之前可能是传上来的图，这次是模型出的 —— 标记得跟着换，否则界面会一直说"你传的"
      tv.sheetSource = 'model';
      tv.sheetFileName = '';
      // 这张图是"按哪一版文字"出的。界面拿它和 textAt 比，
      // 就能指出"文字改过、图没跟上"这种提示词和参考图打架的情况
      tv.sheetAt = new Date().toISOString();
      tv.sheetPromptUsed = prompt;
      // 种子挂在**条目**上：所有变体共用它，换了衣服还是同一张脸
      t.seed = seed;
      variants.normalizeItem(t, kind);
    }
    return p;
  });

  onEvent?.({ type: 'sheet', name: label, kind, status: 'done' });
  return store.read(projectId);
}

/**
 * 补出正面之外的角度：角色的侧面 / 背面，场景的左右 / 俯视平面。
 *
 * ── 为什么必须拿主图当参考图 ──
 *
 * 光靠文字说"同一个人的背面"，模型会很乐意给你**另一个人的背面** ——
 * 而那比没有这张图更糟：它会被当成同一个人的参考图发给视频模型，
 * 于是这个角色一转身就真的变成了另一个人，而且是我们亲手教的。
 *
 * 所以这里走的是图生图：把主图当参考图发过去。这也意味着
 * **主图必须先有**，没有就直接说清楚，别出一张来路不明的图。
 *
 * ── 为什么不做成"出设定集时自动全出" ──
 *
 * 一个角色从 1 张变 3 张，一个场景从 1 张变 4 张。十个条目就是三四十张图，
 * 而多数片子里大部分角色从头到尾都是正面。默认不出，谁需要谁补 ——
 * 让用户自己决定在哪儿花这个钱。
 */
export async function generateAngles(projectId, kind, name, opts = {}, onEvent) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  // 没有这一句的话，下面那行会抛一个原始的 TypeError，
  // 而它会被原样发到界面上（"Cannot read properties of null"）—— 谁也看不懂
  if (!project.bible) throw new Error('这个项目还没有设定集，先跑第 01 步');

  const target = bibleBucket(project.bible, kind).find((x) => x.name === name);
  if (!target) throw new Error(`设定集里没有「${name}」`);
  const variant = variants.findVariant(target, opts.variantId) || variants.defaultVariant(target);
  const label = variants.labelOf(target, variant);

  if (!variant?.sheetPath || !fs.existsSync(variant.sheetPath)) {
    throw new Error(`「${label}」还没有主图。补角度是拿主图当参考画出来的 —— 先把正面那张出了再来`);
  }

  const wanted = (opts.angles?.length ? opts.angles : anglesLib.extraAngles(kind).map((a) => a.id))
    .filter((id) => id !== anglesLib.PRIMARY)
    .filter((id) => anglesLib.extraAngles(kind).some((a) => a.id === id));
  if (!wanted.length) throw new Error(`${SHEET_LABEL[kind]}没有可补的角度`);

  const r = routing();
  const providerId = opts.provider || r.image.provider;
  const model = opts.model || r.image.model;
  const baseRef = usableRef(variant.sheetUrl) || (await toModelRef(variant.sheetPath, { onEvent }));

  for (const angleId of wanted) {
    jobs.checkpoint(opts.signal, `补角度：${label}`);
    const angleLabel = anglesLib.labelOf(kind, angleId);
    onEvent?.({ type: 'sheet', name: label, kind, status: 'running', message: `补角度：${label} · ${angleLabel}` });

    // 身份锚 + 这一版的描述 + 角度要求。前两段和主图完全一致 ——
    // 少了它们，这张图只是"一个侧面"，不是"这个人的侧面"
    const base = sheetPrompt(kind, project.bible, target, variant);
    const prompt = `${base}\n${anglesLib.promptFor(kind, angleId)}`;

    let image;
    try {
      // eslint-disable-next-line no-await-in-loop
      image = await adapters.generateImage({
        providerId,
        model,
        // 这一步**必须**走图生图：参考图才是锁住"还是同一个人"的东西
        editModel: undefined,
        prompt,
        negative: project.bible.style.negative,
        // 和主图同一颗种子：采样起点一致，两张图更像同一个人
        seed: target.seed,
        refImages: [baseRef],
        aspectRatio: project.aspectRatio || null,
        label: `补角度·${label}·${angleLabel}`,
        onEvent
      });
    } catch (err) {
      // 一个角度失败不该拖垮其余的 —— 说清楚哪个没成，接着补下一个
      onEvent?.({ type: 'note', message: `${label} 的${angleLabel}没出成（${err.message}）—— 其余角度继续` });
      continue;
    }

    const dest = path.join(
      store.assetDir(projectId),
      `ref-${kind}-${safeFileName(name)}-${safeFileName(variant.id)}-${angleId}.png`
    );
    // eslint-disable-next-line no-await-in-loop
    await saveMedia(image, dest, onEvent);
    // eslint-disable-next-line no-await-in-loop
    const modelRef = await toModelRef(dest, { onEvent });

    store.update(projectId, (p) => {
      const t = bibleBucket(p.bible, kind).find((x) => x.name === name);
      const tv = t && variants.findVariant(t, variant.id);
      if (!tv) return p;
      anglesLib.normalizeVariant(tv);
      const row = {
        id: angleId,
        sheetPath: dest,
        sheetUrl: modelRef,
        sheetAt: new Date().toISOString(),
        sheetSource: 'model',
        sheetPromptUsed: prompt
      };
      const at = tv.angles.findIndex((a) => a.id === angleId);
      if (at >= 0) tv.angles[at] = row;
      else tv.angles.push(row);
      return p;
    });

    onEvent?.({ type: 'sheet', name: label, kind, status: 'done', message: `${label} · ${angleLabel} 出好了` });
  }

  return store.read(projectId);
}

/**
 * 往设定集里加一条（衍生品、后加的道具、中途出场的配角都走这里）。
 * 加完不自动出图 —— 让用户先把描述写好，再点重出，省一次无效开销。
 */
/**
 * 改设定集条目的**文字**部分（不出图、不花钱）。
 *
 * 之前这里是个坑：设定集条目唯一能保存的路径是「改完重出」——
 * 也就是说，**想改一句描述就必须重出一张图**。
 * 于是"我明明改了，怎么没生效"变成了很自然的困惑：
 * 改完没点那个按钮，字就丢了；点了，又白烧一次额度。
 *
 * 现在文字和图分开：
 *   · 存文字   —— 免费、立刻生效（下一批出图就按新描述走）
 *   · 重出图   —— 花钱，什么时候想让图跟上文字，什么时候点
 *
 * 「冻结」也从"生成完就锁死"改成**你自己说了算**：
 * locked=true 时界面不让改（防手滑），点「解冻」就能改，改完再「确认冻结」。
 * 这一层不是技术需要，是心理需要 —— 设定集是全片的地基，
 * 地基应该有一个明确的"我认可了"的动作，而不是模型写完就算数。
 */
const BIBLE_EDITABLE = ['name', 'appearance', 'sheetPrompt', 'role', 'voice'];

export function updateBibleEntry(projectId, kind, name, patch = {}) {
  const project = store.read(projectId);
  if (!project?.bible) throw new Error('还没有设定集');
  const bucket = bibleBucket(project.bible, kind);
  const item = bucket.find((x) => x.name === name);
  if (!item) throw new Error(`设定集里没有「${name}」`);

  const changed = [];
  let renamedTo = null;

  for (const key of BIBLE_EDITABLE) {
    if (!(key in patch)) continue;
    let value = patch[key];
    {
      value = String(value ?? '').trim();
      if (key === 'name') {
        if (!value) continue;
        if (value === item.name) continue;
        if (bucket.some((x) => x.name === value)) throw new Error(`已经有一个叫「${value}」的了`);
        renamedTo = value;
      }
    }
    if (value === item[key]) continue;
    item[key] = value;
    changed.push(key);
  }

  if (!changed.length) return { project, changed: [], renamed: 0 };

  // 文字改了、图还是按旧描述出的 —— 记一个时间戳，界面据此提醒"图没跟上"
  if (changed.some((k) => k === 'appearance' || k === 'sheetPrompt')) {
    item.textAt = new Date().toISOString();
  }
  /**
   * 改了描述、又没同时明确写出图提示词 → 把那个覆盖清掉。
   *
   * 不清的话就会出现这个应用里最难查的一种现象：
   * 你改了描述、重出图，出来的还是照着**旧描述**画的，怎么重出都没用 ——
   * 因为真正发出去的是那份你看不见、也没动过的 sheetPrompt。
   * 一个隐形的、又会悄悄接管一切的字段，是最坏的那种字段。
   */
  if (changed.includes('appearance') && !changed.includes('sheetPrompt')) {
    if (item.sheetPrompt) {
      item.sheetPrompt = '';
      changed.push('sheetPrompt');
    }
    // 身份锚变了，每一版缓存的出图提示词都过时了 —— 一起清掉。
    // 只清 item 上那份的话，变体里那份会继续顶着，改描述照样不生效。
    for (const v of variants.variantsOf(item)) {
      if (v.sheetPrompt) {
        v.sheetPrompt = '';
        if (!changed.includes('sheetPrompt')) changed.push('sheetPrompt');
      }
    }
  }

  /**
   * 改名必须同步分镜。
   *
   * 分镜里的 characters[] 和 scene 存的是**名字**，靠名字去设定集里查外貌和参考图。
   * 只改设定集不改分镜，等于把所有引用一次性打断：
   * 那些镜头会突然查不到人，出图时既不带参考图也不注入外貌 ——
   * 而且不会报错，只是悄悄画成另一个人。这种坏法最难查。
   */
  let renamed = 0;
  if (renamedTo) {
    for (const shot of project.shots || []) {
      if (kind === 'char' && Array.isArray(shot.characters)) {
        const i = shot.characters.indexOf(name);
        if (i !== -1) {
          shot.characters[i] = renamedTo;
          renamed += 1;
        }
      }
      if (kind === 'scene' && shot.scene === name) {
        shot.scene = renamedTo;
        renamed += 1;
      }
    }
  }

  store.save(project);
  return { project: store.read(projectId), changed, renamed, renamedTo };
}

/**
 * 加一个变体（另一套衣服 / 另一个时段）。
 *
 * 不出图 —— 加完去点它的「重出」，或者跑一次设定集把缺的补齐。
 * 加变体是几秒钟的事，出图是花钱的事，两者分开。
 */
export function addVariant(projectId, kind, name, { name: vname, appearance = '' } = {}) {
  const project = store.read(projectId);
  if (!project?.bible) throw new Error('还没有设定集');
  const item = bibleBucket(project.bible, kind).find((x) => x.name === name);
  if (!item) throw new Error(`设定集里没有「${name}」`);
  if (variants.variantsOf(item).some((v) => v.name === String(vname || '').trim())) {
    throw new Error(`「${name}」下已经有一个叫「${vname}」的了`);
  }
  const v = variants.makeVariant({ name: vname, appearance });
  item.variants.push(v);
  store.save(project);
  return { project: store.read(projectId), variant: v };
}

export function updateVariant(projectId, kind, name, variantId, patch = {}) {
  const project = store.read(projectId);
  if (!project?.bible) throw new Error('还没有设定集');
  const item = bibleBucket(project.bible, kind).find((x) => x.name === name);
  if (!item) throw new Error(`设定集里没有「${name}」`);
  const v = variants.findVariant(item, variantId);
  if (!v) throw new Error(`「${name}」没有这一版：${variantId}`);

  const changed = [];
  for (const key of ['name', 'appearance', 'sheetPrompt']) {
    if (!(key in patch)) continue;
    const value = String(patch[key] ?? '').trim();
    if (key === 'name' && !value) continue;
    if (value === v[key]) continue;
    v[key] = value;
    changed.push(key);
  }
  // 和条目一样：改了描述就把出图提示词那个覆盖清掉，
  // 否则又回到"改了描述、重出还是旧的"那条老路
  if (changed.includes('appearance') && !changed.includes('sheetPrompt') && v.sheetPrompt) {
    v.sheetPrompt = '';
    changed.push('sheetPrompt');
  }
  if (changed.length) {
    v.textAt = new Date().toISOString();
    variants.normalizeItem(item, kind);
    store.save(project);
  }
  return { project: store.read(projectId), changed };
}

export function removeVariant(projectId, kind, name, variantId) {
  const project = store.read(projectId);
  if (!project?.bible) throw new Error('还没有设定集');
  const item = bibleBucket(project.bible, kind).find((x) => x.name === name);
  if (!item) throw new Error(`设定集里没有「${name}」`);
  if (variantId === variants.DEFAULT_VARIANT_ID) {
    throw new Error('默认那版删不掉 —— 它是这个条目的身份基准。要整个不要就删条目本身。');
  }
  const before = item.variants.length;
  item.variants = item.variants.filter((v) => v.id !== variantId);
  if (item.variants.length === before) throw new Error(`没有这一版：${variantId}`);

  // 分镜里指着这一版的引用要跟着清掉，否则它们会指向一个不存在的变体
  let cleared = 0;
  for (const shot of project.shots || []) {
    if (shot.variants?.[name] === variantId) {
      delete shot.variants[name];
      cleared += 1;
    }
  }
  variants.normalizeItem(item, kind);
  store.save(project);
  return { project: store.read(projectId), cleared };
}

/** 认得出来的图片格式。除了这几种，别的一律不收 —— 存进去也是打不开的文件。 */
const IMAGE_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp'
};

/**
 * 用本地图片当设定图。
 *
 * 这条路比"再出一张"更重要，因为有些参照是**模型画不出来的**：
 * 真人演员的照片、客户给的产品图、已经定稿的角色三视图 ——
 * 你要的就是这一张，不是"像这一张"。
 *
 * 传进来之后它和模型出的设定图完全同等：一致性引擎拿它当基准去比对，
 * 每一镜的提示词从它派生，出图时作为参考图带上。也就是说
 * **上传一张真人照片，后面所有镜头都会照着这个人画**。
 *
 * 落盘时特意不沿用模型出图那个文件名（ref-<kind>-<name>.png），
 * 而是带上扩展名和 upload 标记：万一以后想知道"这张到底是谁出的"，
 * 光看文件名就够，不用去翻 project.json。
 */
export async function attachBibleSheet(projectId, kind, name, { dataUrl, fileName = '', variantId = null } = {}, onEvent) {
  const project = store.read(projectId);
  if (!project?.bible) throw new Error('还没有设定集');
  const item = bibleBucket(project.bible, kind).find((x) => x.name === name);
  if (!item) throw new Error(`设定集里没有「${name}」`);
  const variant = variants.findVariant(item, variantId) || variants.defaultVariant(item);
  if (!variant) throw new Error(`「${name}」没有可用的变体`);

  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('没读到图片内容（需要 data:image/...;base64, 开头的内容）');
  const ext = IMAGE_MIME[m[1].toLowerCase()];
  if (!ext) throw new Error(`不支持这种图片格式：${m[1]}。用 PNG / JPG / WebP。`);

  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('图片是空的');
  // 内联给模型的上限是 7MB（见 toModelRef），这里卡在同一条线上，
  // 免得存下来了、真要用的时候才报"超出上限"
  if (buf.length > 7 * 1024 * 1024) {
    throw new Error(`这张图 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 7MB 就没法内联发给模型了。先压一下再传。`);
  }

  const dest = path.join(
    store.assetDir(projectId),
    `ref-${kind}-${safeFileName(name)}-${safeFileName(variant.id)}-upload${ext}`
  );
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  onEvent?.({ type: 'note', message: `已存下 ${path.basename(dest)}（${(buf.length / 1024).toFixed(0)} KB）` });

  const modelRef = await toModelRef(dest, { onEvent });

  store.update(projectId, (p) => {
    const t = bibleBucket(p.bible, kind).find((x) => x.name === name);
    const tv = t && variants.findVariant(t, variant.id);
    if (tv) {
      // 旧的那张不删：万一传错了，用户还能自己去 assets 目录里找回来
      tv.sheetPath = dest;
      tv.sheetUrl = modelRef;
      // 如实标明来源。界面要靠它说"这张是你传的"，
      // 不然过两天没人分得清哪张是模型出的、哪张是自己传的
      tv.sheetSource = 'upload';
      tv.sheetFileName = fileName || path.basename(dest);
      tv.sheetAt = new Date().toISOString();
      variants.normalizeItem(t, kind);
    }
    return p;
  });

  onEvent?.({ type: 'sheet', name, kind, status: 'done', message: '已用本地图片作为设定图' });
  return store.read(projectId);
}

export async function addBibleEntry(projectId, kind, { name, appearance = '', role = '' }) {
  if (!name?.trim()) throw new Error('得起个名字');
  const project = store.read(projectId);
  if (!project?.bible) throw new Error('还没有设定集，先跑第 01 步');
  if (bibleBucket(project.bible, kind).some((x) => x.name === name.trim())) {
    throw new Error(`「${name}」已经在设定集里了`);
  }

  return store.update(projectId, (p) => {
    bibleBucket(p.bible, kind).push({
      name: name.trim(),
      role,
      appearance,
      sheetPrompt: '',
      seed: consistency.deriveSeed(p.id, `${kind}:${name.trim()}`),
      sheetPath: null,
      sheetUrl: null,
      locked: true,
      addedManually: true
    });
    return p;
  });
}

export function removeBibleEntry(projectId, kind, name) {
  return store.update(projectId, (p) => {
    const bucket = bibleBucket(p.bible, kind);
    const i = bucket.findIndex((x) => x.name === name);
    if (i !== -1) bucket.splice(i, 1);
    return p;
  });
}

/**
 * 这一镜**现在**会发出去的提示词长什么样。
 *
 * 为什么要有这个：界面上原来只能看到 `shot.videoPrompt` —— 那是**上一次实际发出去的**。
 * 改完描述再去看，显示的还是旧那条，于是很自然会得出"我改了描述，提示词没跟着变"的结论。
 * 其实提示词每次出视频都是现算的，只是没人给你看现算的结果。
 *
 * 顺便把"视频到底是照着什么生成的"说清楚 —— 是**两样东西**：
 *   首帧图  这一镜出图那步的成果，定住第一格画面（人、衣服、场景、构图）
 *   提示词  这里这条，定住之后几秒演什么、镜头怎么动、谁在说话
 * 两样打架时，模型多半跟着图走 —— 所以改完描述只重出视频是不够的，
 * 图也得按新描述重出一张，否则你会看到"画面还是旧的、动作有点新"的四不像。
 */
export function promptsFor(projectId, shotId) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const shot = (project.shots || []).find((s) => s.id === shotId);
  if (!shot) throw new Error('没有这一镜');

  const { prev, next, link } = continuity.neighbors(project.shots || [], shot.id);
  const image = consistency.assemblePrompt(project.bible, shot);
  const video = consistency.assembleVideoPrompt(project.bible, shot, { prev, next, link });

  const edited = Date.parse(shot.editedAt || 0) || 0;
  const imagedAt = Date.parse(shot.imageAt || 0) || 0;

  return {
    now: { image: image.prompt, video },
    used: { image: shot.prompt || '', video: shot.videoPrompt || '' },
    // 改过描述但没重出 → 现算的和上次用的不一样，说清楚哪一条会在重出时生效
    imageStale: Boolean(shot.prompt && shot.prompt !== image.prompt),
    videoStale: Boolean(shot.videoPrompt && shot.videoPrompt !== video),
    // 图比描述旧：出视频时首帧和提示词会互相打架，这个必须显眼
    imageOlderThanEdit: Boolean(shot.imagePath && edited && (!imagedAt || edited > imagedAt)),
    refs: consistency.collectReferences(project.bible, shot).labels,
    // 界面要说清楚这条是按哪种详略算的 —— 不然"怎么这么短"又要问一遍
    videoPromptMode: settings.get('videoPromptMode') || 'precise',
    link
  };
}

/**
 * 出来的图到底是不是你要的画幅。
 *
 * 我们确实把尺寸发出去了，但"发出去了"和"厂商听了"是两回事：有的不认这个字段、
 * 有的只支持几个固定尺寸会就近似、中转平台常常把它整个丢掉。三种情况长得一模一样 ——
 * 任务成功、图也回来了，只是比例不对。而下一步图生视频会**继承首帧图的比例**，
 * 于是这个错一路传到成片，最后你看到的是一条横片，还以为是视频模型的问题。
 *
 * 读文件头几十个字节就能量出来，不花钱。所以每张图都量。
 */
function checkRatio(file, wanted, label, onEvent, asked = null) {
  const size = imgsize.readSize(file);
  if (!size) return null;
  const verdict = imgsize.matchesRatio(size, wanted);
  if (verdict && !verdict.ok) {
    onEvent?.({
      type: 'note',
      message:
        `⚠ ${label} 的画幅不对：要的是 ${wanted}，回来的是 ${verdict.got}` +
        (verdict.flipped ? '（横竖反了）' : `（偏 ${verdict.offPercent}%）`) +
        '。这一家多半没吃尺寸参数 —— 换一家出图，或者去「服务商与密钥」确认这个模型支持的尺寸。' +
        '注意图生视频会继承首帧图的比例，不改的话成片也是这个比例。'
    });
  }
  // asked = 我们**发出去**的尺寸。和回来的一比就知道是"我们算错了"还是"厂商没听"
  return { ...size, wanted, asked, ok: verdict?.ok !== false };
}

// ═══════════════════════ 阶段四：出视频 ═══════════════════════

/**
 * 这一镜的**上下文**：它接在谁后面、要交给谁。
 *
 * 出视频和出图最大的不同就在这儿。出图是一张一张互不相干的静态画面，
 * 出视频却是在做一段**要和前后接得上**的运动。同一份提示词、同一张首帧，
 * 缺了上下文的那一版，模型会把每一镜都当成独立短片来演：各自起势、各自收势，
 * 于是逐镜看都对、连起来却像二十条不相干的素材。
 *
 * 这里一次把三样东西备齐：
 *   ① 提示词里的衔接约束（不越轴、不换天、结尾停在能接上下一镜的状态）；
 *   ② 末帧图 —— 只有标成"连续动作"的下一镜才锁，见 continuity.js 里为什么不全锁；
 *   ③ 给界面看的说明，让"这一镜到底接没接上"是看得见的，而不是玄学。
 */
/**
 * 要不要去抠上一段的真实末帧当首帧。
 *
 * 单拎出来是为了**能被直接断言**。它就一行，但错了的后果是
 * "某几家厂商上接缝整个消失"，而且不报错 —— 这种一行判断最该有测试。
 *
 * 而测试必须调**这一个**函数，不能在测试里照抄一遍逻辑：
 * 抄一遍就成了自己验自己，产线写反了它照样绿。
 */
export function wantsTailChain(seamMode, takesEndFrame) {
  if (seamMode === 'off') return false;
  if (seamMode === 'tail') return true;
  // lock：首尾帧那条路要厂商收末帧。不收就退回来，否则这一镜一处接缝都没有
  return !takesEndFrame;
}

/**
 * 这一镜的接缝为什么没做 —— 一句话说清楚，并指向能改的地方。
 *
 * ⚠ 最容易误解的一条单独点出来：**首尾帧模式下，接缝做在「上一镜」身上**
 *（把这一镜的图锁成上一镜的末帧）。所以只重出后面那一镜，接缝一点变化都不会有 ——
 * 该重出的是前面那一镜。不说的话，人会一遍遍重出后面那镜然后觉得功能是坏的。
 */
function seamWhyNot({ shot, prev, next, link, nextLink, seamMode, takesEndFrame, provider }) {
  if (seamMode === 'off') {
    return '接缝：已在设置里关掉，这一镜只靠提示词衔接';
  }
  if (!prev && !next) {
    return '接缝：全片只有这一镜，没有可接的邻镜';
  }

  const sameSeg = (a, b) => Number(a?.segment || 1) === Number(b?.segment || 1);
  const bits = [];

  // 和上一镜之间
  if (prev && link !== 'continuous') {
    bits.push(`和第 ${prev.index} 镜之间标着「${continuity.LINK_LABELS[link] || link}」，不是「连续动作」—— 接缝只在连续动作上做`);
  } else if (prev && !sameSeg(prev, shot)) {
    bits.push(`和第 ${prev.index} 镜跨了场次，不接（另一个地方、另一段时间）`);
  } else if (prev && !prev.videoPath) {
    bits.push(`第 ${prev.index} 镜还没出视频，抠不到它的末帧 —— 把上一镜一起选上重出`);
  }

  // 和下一镜之间（首尾帧模式下，锁的是**这一镜的末帧**）
  if (next && nextLink !== 'continuous') {
    bits.push(`和第 ${next.index} 镜之间标着「${continuity.LINK_LABELS[nextLink] || nextLink}」，也不是「连续动作」`);
  } else if (next && !takesEndFrame) {
    bits.push(`${provider?.name || '这家'}不收末帧图`);
  }

  const head = `第 ${shot.index} 镜这次没做接缝：${bits.join('；') || '相邻两镜都不是连续动作'}。`;
  const how =
    '「连续动作」不会自动判出来，要在分镜里手选。'
    + (seamMode === 'lock'
      ? '⚠ 首尾帧模式下接缝做在**上一镜**身上（把这一镜的图锁成上一镜的末帧）—— 只重出后面这一镜是看不到变化的，该重出的是前面那一镜。'
      : '');
  return head + how;
}

async function videoContextFor(project, shot, { onEvent, providerId = null, explain = false } = {}) {
  const { prev, next, link, nextLink } = continuity.neighbors(project.shots || [], shot.id);

  const videoPrompt = consistency.assembleVideoPrompt(project.bible, shot, { prev, next, link });

  /**
   * 这家收不收末帧 —— **必须先问，再决定接缝怎么做**。
   *
   * 以前是先许诺"两镜之间会是无缝的"，然后适配器那一层才发现这家不收末帧，
   * 又说一句"会是硬切"。两句话同时躺在日志里，前一句是在还不知道厂商是谁的
   * 时候许下的 —— 用户会以为接缝做上了，直到看成片才发现没有。
   *
   * 收不收由 catalog 里的 videoDefaults.endFrame 说了算，别在这儿写死名单 ——
   * 上一版这里写着"秘塔不收"，而用户的控制台截图上明明白白有首尾帧两栏。
   */
  const provider = providerId ? catalog.getProvider(providerId) : null;
  const takesEndFrame = provider ? Boolean(provider.videoDefaults?.endFrame) : true;

  /**
   * 接缝的两个方向，各有各的前提：
   *
   *   首尾帧（lock）  本镜的图当首帧、下一镜的图当末帧 —— 两头都是审过的图，
   *                   这一镜再怎么演也跑不出去。**要厂商收末帧**
   *   接住末帧（tail）等上一段跑完，用它真实的最后一帧当首帧 ——
   *                   **每一家都能做**（图生视频的定义就是收首帧），
   *                   但只钉住起点，结尾是模型自己发挥的，误差会沿链累积
   *
   * ── 为什么 lock 要能退回 tail ──
   *
   * lock 整条路都架在"厂商收末帧"上。碰上不收的那几家（海螺官方口、百炼、
   * Sora），lock 会**一处接缝都不做** —— 比默认值还差，而且用户是照着
   * "首尾帧更准"这个理由选的它，结果反而更糟。
   *
   * 所以这里兜一层：选了 lock 而这家不收末帧，就退回接住真实末帧，
   * 并且**说清楚退了**。默认值敢改成 lock，靠的就是这一层。
   */
  const seamMode = settings.get('seamMode') || 'lock';
  const wantTail = wantsTailChain(seamMode, takesEndFrame);

  let headFromTail = null;
  if (wantTail && continuity.shouldChainFromTail(shot, prev, link)) {
    if (seamMode === 'lock') {
      onEvent?.({
        type: 'note',
        message: `${provider?.name || '这家'}不收末帧图，「首尾帧」这条路在它上面做不了 —— 本镜改用「接住上一段的真实末帧」兜底，接缝照样是连的`
      });
    }
    headFromTail = await tailFrameOf(project, prev, shot, { onEvent });
  }

  let lastFrameUrl = null;
  if (seamMode !== 'off' && continuity.shouldChainEndFrame(next, nextLink, shot)) {
    if (!takesEndFrame) {
      /**
       * 这家不收末帧。只有一句话可说，而且这句话必须**指向出路**，
       * 不能只是通报一个坏消息。
       */
      onEvent?.({
        type: 'note',
        message: headFromTail
          ? `${provider.name} 不收末帧图，但本镜已经接住了第 ${headFromTail.fromIndex} 镜的真实末帧当首帧 —— 接缝照样是连的`
          : `${provider.name} 不收末帧图，而本镜也没接住上一段的末帧（上一段还没出片，或者跨了场次），第 ${next.index} 镜那儿会硬切。`
            + '要无缝的话：把上一镜一起选上重出，或者换一家收末帧的（可灵、Vidu、方舟、秘塔）。'
      });
    } else {
      try {
        lastFrameUrl = usableRef(next.imageRef) || (await toModelRef(next.imagePath, { onEvent }));
        onEvent?.({
          type: 'note',
          message: `第 ${next.index} 镜标成「连续动作」，把它那张图锁成本镜末帧 —— 两镜之间会是无缝的`
        });
      } catch (err) {
        // 末帧拿不到不该拖垮这一镜：降级成普通图生视频，但要说清楚降级了
        onEvent?.({ type: 'note', message: `取第 ${next.index} 镜的图当末帧失败（${err.message}），本镜按普通图生视频出` });
      }
    }
  }

  /**
   * 单镜重出时，**接缝没做也要说一句为什么**。
   *
   * 批量出视频那条路开跑前会打一行接缝计划（seamPlanOf），
   * 而单镜重出这条路原来是彻底安静的：接缝不触发时一个字都没有。
   * 用户在手机上重出两镜，看到的就是"两段各自用各自的首帧"，
   * 而且**没有任何线索**说明为什么 —— 只能得出"这两个模式都没生效"。
   *
   * 不触发的分支必须出声。这是这个项目里同一个教训的第三次了。
   */
  if (explain && !headFromTail && !lastFrameUrl) {
    onEvent?.({ type: 'note', message: seamWhyNot({ shot, prev, next, link, nextLink, seamMode, takesEndFrame, provider }) });
  }

  return { prev, next, link, nextLink, videoPrompt, lastFrameUrl, headFromTail };
}

/**
 * 抠出上一段视频的最后一帧，交给这一镜当首帧。
 *
 * 拿不到就回 null —— 接缝没接上是遗憾，为它把这一镜整个废掉是不成比例的。
 * 每一种拿不到的情况都要说清楚原因，否则用户只会看到"有时候接得上有时候接不上"。
 */
async function tailFrameOf(project, prev, shot, { onEvent } = {}) {
  if (!ffmpeg.locate().available) {
    onEvent?.({
      type: 'note',
      message: `第 ${shot.index} 镜想接住上一段的末帧，但没装 FFmpeg（抠帧要用它）—— 这一镜改用自己那张分镜图当首帧，接缝会跳一下`
    });
    return null;
  }

  const framePath = path.join(store.assetDir(project.id), `${shot.id}.head.png`);
  try {
    await ffmpeg.grabFrame(prev.videoPath, framePath, { at: 'end' });
  } catch (err) {
    onEvent?.({ type: 'note', message: `抠上一段末帧失败（${err.message}），第 ${shot.index} 镜改用自己那张分镜图当首帧` });
    return null;
  }

  /**
   * 糊的帧不能当首帧。
   *
   * 上一段结尾正好是个快速运动的话，最后一帧带着运动模糊 ——
   * 拿它当首帧等于**把糊传染给下一段**，而且是从第一格就糊。
   * 这种情况宁可退回自己那张干净的分镜图：接缝跳一下，
   * 总好过下一段整段都是糊的。
   */
  try {
    const hash = await imghash.hashImage(framePath);
    if (!imghash.informative(hash)) {
      onEvent?.({
        type: 'note',
        message: `上一段的末帧太平（大片纯色或者糊了），不适合当首帧 —— 第 ${shot.index} 镜改用自己那张分镜图，接缝会跳一下`
      });
      return null;
    }
  } catch {
    // 判不了就照用：判不出来不等于不能用
  }

  try {
    const url = await toModelRef(framePath, { onEvent });
    onEvent?.({
      type: 'note',
      message: `第 ${shot.index} 镜接住第 ${prev.index} 镜的**真实末帧**当首帧 —— 接缝在像素上就是连的，不靠厂商支持末帧`
    });
    return { url, path: framePath, fromIndex: prev.index };
  } catch (err) {
    onEvent?.({ type: 'note', message: `末帧传不上去（${err.message}），第 ${shot.index} 镜改用自己那张分镜图当首帧` });
    return null;
  }
}

/**
 * 末帧复核：这一段片子演到最后，人还是不是那个人。
 *
 * 出图那步的复核只看一张静态图，而视频的漂移**几乎都发生在后半段** ——
 * 首帧是我们给的，当然像；模型自己往后推五到十秒，脸就开始飘。
 * 只验首帧等于没验。所以这里用 FFmpeg 抠出**最后一帧**再送去比对，
 * 抓的就是"开头对、结尾不对"这种逐镜看根本看不出来的问题。
 *
 * 没装 FFmpeg 就跳过（如实说一声），不拦着流水线往下走。
 */
/**
 * 首帧核对：这段视频的第一帧，到底是不是我们给的那张分镜图。
 *
 * 图生视频名义上是"以这张图为第一帧往下演"，实际不总是这样：
 * 有的厂商在提示词和图打架时会自己重画第一帧；有的在参数不对时
 * 悄悄退化成文生视频，只把图当风格参考。两种情况的表现都是
 * **片子和分镜图对不上**，而任务本身是"成功"的 ——
 * 不比一比，你只会觉得"这家模型不行"，不会知道它压根没用你那张图。
 *
 * 这一层是**免费的**：走 FFmpeg 抠帧 + 感知哈希，不调模型、不花钱、
 * 结果可复现。所以它不受「一致性复核」开关控制，只要有 FFmpeg 就做。
 */
async function verifyVideoHead(shot, videoPath, { onEvent, headRef = null } = {}) {
  /**
   * 比的是"视频第一帧"和"我们给的那张首帧图"。
   *
   * ⚠ 接缝模式下给出去的首帧**不是这一镜的分镜图**，而是上一段视频的真实末帧。
   * 还拿分镜图去比的话，每一个接住上一镜的镜头都会被报成"首帧没吃" ——
   * 一个彻头彻尾的假警报，而且恰恰出现在接缝工作得最好的那几镜上。
   * 假警报比没有警报更坏：报几次之后，真的那次也没人看了。
   */
  const target = headRef?.path && fs.existsSync(headRef.path) ? headRef.path : shot.imagePath;
  if (!target || !fs.existsSync(target)) return null;
  try {
    const r = await imghash.compareFirstFrame(videoPath, target);
    if (!r) return null; // 没装 FFmpeg：这是"没检查"，不是"不匹配"
    const from = headRef ? `第 ${headRef.fromIndex} 镜的末帧` : `第 ${shot.index} 镜那张图`;
    const message =
      r.verdict === 'ok'
        ? `首帧核对通过：这段视频确实是从${from}开始的（相似度 ${r.similarity}%）`
        : r.verdict === 'mismatch'
          ? `⚠ 首帧对不上（相似度只有 ${r.similarity}%）—— 这家多半没吃我们给的首帧图，` +
            '要么在提示词和图打架时自己重画了，要么退化成了文生视频。' +
            '换一家、或者把提示词里和画面冲突的话去掉再重出。'
          : '首帧核对：这一镜画面太平（大片纯色），比不出结论 —— 不下判断，免得给个反的答案';
    onEvent?.({ type: 'note', message });
    return r;
  } catch (err) {
    onEvent?.({ type: 'note', message: `首帧核对没跑成：${err.message}` });
    return null;
  }
}

async function verifyVideoTail(projectId, shot, videoPath, { onEvent } = {}) {
  if (settings.get('consistencyVerify') === false) return null;
  const project = store.read(projectId);
  const cast = consistency.matchCharacters(project.bible, shot).filter((c) => c.sheetPath);
  if (!cast.length) return null;
  if (!ffmpeg.locate().available) {
    onEvent?.({ type: 'note', message: '没装 FFmpeg，跳过末帧复核（视频照常保存，装上之后重出这一镜即可复核）' });
    return null;
  }

  const framePath = path.join(store.assetDir(projectId), `${shot.id}.tail.png`);
  try {
    await ffmpeg.grabFrame(videoPath, framePath, { at: 'end' });
  } catch (err) {
    onEvent?.({ type: 'note', message: `抠末帧失败，跳过末帧复核：${err.message}` });
    return null;
  }

  try {
    const target = cast[0];
    const verdict = await consistency.verifyShot({
      shotImageUrl: await toModelRef(framePath, { onEvent }),
      character: { ...target, sheetUrl: await toModelRef(target.sheetPath, { onEvent }) },
      threshold: settings.get('consistencyThreshold') ?? 75,
      onEvent: (ev) => onEvent?.(ev.type === 'verify' ? { ...ev, character: `${ev.character}（末帧）` } : ev)
    });
    if (verdict.skipped) return null;
    return {
      score: verdict.score,
      pass: verdict.pass,
      issues: verdict.issues || [],
      character: target.name,
      framePath,
      at: new Date().toISOString()
    };
  } catch (err) {
    onEvent?.({ type: 'note', message: `末帧复核没跑成：${err.message}` });
    return null;
  }
}

/**
 * 接缝比对 —— 标了「连续动作」的这两镜，**真的接上了吗**。
 *
 * ── 这一层补的是哪个洞 ──
 *
 * 标成「连续动作」时，我们会把下一镜的分镜图当**末帧**发给厂商，
 * 让这段视频结束在那张图上，下一段从同一张图开始 —— 接缝就看不出来。
 *
 * 问题是：**没有一处在检查厂商到底吃没吃这个参数**。
 * 不收末帧的厂商多数不会报错，它只是当没看见，照常出一段普通图生视频，
 * 任务状态是"成功"，视频也能播。于是界面上明明白白标着「无缝衔接」，
 * 而成片放到那个接缝时会**跳一下** —— 要等全片合成完、放出来才发现，
 * 那时候这两镜的钱都已经花过了。
 *
 * 有了 verifyVideoHead（首帧对不对）和 verifyVideoTail（人还像不像），
 * 唯独少了这一条：**末帧是不是下一镜那张图**。三个问题，三层各答一个。
 *
 * ── 为什么用感知哈希而不是问模型 ──
 *
 * "这一帧和这张图是不是同一个画面"是**像素问题**，不需要理解力。
 * 哈希免费、可复现、毫秒级；问视觉模型要花钱，而且同一对图两次能差好几分。
 * 和 verifyVideoHead 同一个理由，所以也同样不受「一致性复核」开关控制。
 */
async function verifyTailAlign(shot, videoPath, nextShot, { onEvent } = {}) {
  // 只有真锁了末帧的镜才需要验。cut 的镜位本来就该跳，验了没意义
  if (!shot.endFrameChained) return null;
  if (!nextShot?.imagePath || !fs.existsSync(nextShot.imagePath)) return null;
  if (!ffmpeg.locate().available) return null;

  try {
    const [tailHash, headHash] = await Promise.all([
      imghash.hashVideoFrame(videoPath, { at: 'end' }),
      imghash.hashImage(nextShot.imagePath)
    ]);
    // 画面太平（大片纯色、全黑淡出）时哈希没有分辨力 —— 这种情况**不下判断**。
    // 把"看不出来"说成"对上了"，比不检查更坏
    if (!imghash.informative(tailHash) || !imghash.informative(headHash)) {
      return { verdict: 'inconclusive', ok: null, at: new Date().toISOString() };
    }

    const distance = imghash.hamming(tailHash, headHash);
    const similarity = imghash.similarity(distance);
    /**
     * 三档而不是两档。中间这一档（"有点漂"）是真实存在的一种结果：
     * 厂商吃了末帧参数，但没完全收住 —— 接缝处会轻微跳一下。
     * 归到"对上了"里会让人相信一个其实不太行的接缝；
     * 归到"没锁上"里又会让人白白去换厂商。它该有自己的名字。
     *
     * 22 这个数：MATCH_THRESHOLD 是 12，64 位哈希完全无关时期望距离是 32。
     * 取两者之间偏低的一侧 —— 宁可多报几个"有点漂"让人自己看一眼。
     */
    const verdict =
      distance <= imghash.MATCH_THRESHOLD ? 'aligned' : distance <= 22 ? 'partial' : 'missed';

    const message =
      verdict === 'aligned'
        ? `接缝比对通过：第 ${shot.index} 镜的末帧确实停在第 ${nextShot.index} 镜那张图上（相似度 ${similarity}%）`
        : verdict === 'partial'
          ? `接缝比对：第 ${shot.index}→${nextShot.index} 镜有轻微漂移（相似度 ${similarity}%）—— ` +
            '厂商吃了末帧参数但没完全收住，成片在这个接缝会轻微跳一下。重出这一镜多半会好，或者把这两镜改成硬切。'
          : `⚠ 接缝没锁上：第 ${shot.index} 镜的末帧和第 ${nextShot.index} 镜那张图对不上（相似度只有 ${similarity}%）—— ` +
            '这家多半**没吃末帧参数**，只是没报错。这两镜标着「连续动作」，但成片放到这里会明显跳一下。' +
            '换一家收末帧的（可灵、Vidu、方舟），或者把这两镜改成硬切，别让界面上写着无缝而实际不是。';
    onEvent?.({ type: 'note', message });

    return { verdict, ok: verdict === 'aligned', distance, similarity, nextIndex: nextShot.index, at: new Date().toISOString() };
  } catch (err) {
    onEvent?.({ type: 'note', message: `接缝比对没跑成：${err.message}` });
    return null;
  }
}

/**
 * 开跑之前先说清楚：这一批里**哪几个接缝会真接上**。
 *
 * ── 为什么必须有这一句 ──
 *
 * 用户按设置里那句"接住真实末帧（所有厂商都管用）"的字面理解，出了一批片子，
 * 然后说"并不是这样啊"。他没看错：那句话说的是**厂商侧没有门槛**
 *（每一家 i2v 都收首帧图），可接缝要真的走这条路，还有一个前提 ——
 * 这两镜之间得标着「连续动作」。而 continuous **从来不会被自动推断出来**
 *（deriveLink 只在 new-scene 和 cut 之间选，见 continuity.js 里为什么），
 * 它只可能是模型拆分镜时自己标的、或者人在界面上圈的。
 *
 * 于是最常见的情形是：一批二十镜，一个 continuous 都没有，接缝这条路
 * 一次都没走，而**日志里一个字都没说** —— 不触发的分支是彻底安静的。
 * 用户只能得出"这功能是假的"这个结论，而且他没法反驳自己。
 *
 * 没做某件事，和做了但没说，在用户那儿是同一回事。所以这里在开跑前
 * 把整批的接缝计划摊开：接哪几处、为什么其余的不接、想改去哪儿改。
 */
function seamPlanOf(allShots, targets, seamMode) {
  if (seamMode === 'off') {
    return '接缝：已关掉（设置 → 一致性引擎 → 接缝），镜与镜之间只靠提示词衔接';
  }

  const sorted = allShots.slice().sort((a, b) => a.index - b.index);
  const inBatch = new Set(targets.map((s) => s.id));
  const pairs = [];
  const orphans = [];

  for (const shot of targets) {
    const { prev, link } = continuity.neighbors(sorted, shot.id);
    if (!prev || link !== 'continuous') continue;
    // 跨场次不接 —— 和 shouldChainFromTail 同一条底线
    if (Number(prev.segment || 1) !== Number(shot.segment || 1)) continue;
    // 上一段得**有片子**才能抠末帧：要么早就出过，要么这一批里排在前面
    if (prev.videoPath || inBatch.has(prev.id)) pairs.push(`${prev.index}→${shot.index}`);
    else orphans.push(`${prev.index}→${shot.index}`);
  }

  /**
   * ⚠ 这句话是在**还不知道厂商是谁**的时候说的 —— 分级路由可能给每一镜
   * 挑不同的厂商，而收不收末帧是按厂商定的。
   *
   * 所以 lock 这条不能只说"会锁成末帧"：碰上不收末帧的那几家，
   * 实际走的是退回接住真实末帧。只说前半句，又会变成一句
   * 兑现不了的许诺 —— 那正是当初那条自相矛盾日志的样子。
   */
  const how =
    seamMode === 'lock'
      ? '把下一镜那张图锁成上一段的末帧（碰上不收末帧的厂商会自动退回「接住上一段的真实末帧」）'
      : '接住上一段的真实末帧当首帧';

  /**
   * 首尾帧模式必须**先说清楚它长什么样**，否则它会被当成没生效。
   *
   * 用户的原话是"在生成视频的时候，完全不是按照首尾来的""还是只用各自首帧生成"。
   * 那个观察是对的 —— 首尾帧模式下每一段确实是从**自己那张图**开始的，
   * 接缝是靠逼上一段"结束在下一镜那张图上"做出来的，做在**上一镜**身上。
   * 会去看"本段首帧是不是上段尾帧"的那个预期，对应的是另一个模式（接住真实末帧）。
   *
   * 这句话不说，功能做得再对也会被判成坏的 —— 而且判得有理有据。
   */
  const shape =
    seamMode === 'lock'
      ? '⚠ 首尾帧模式下，每一段仍然是从**它自己那张图**开始的 —— 接缝做在**上一镜**身上'
        + '（逼上一段结束在下一镜那张图上）。想要"本段第一帧就是上一段最后一帧"，'
        + '那是另一个模式：设置 → 一致性引擎 → 接缝 → 接住真实末帧。'
      : '';

  if (!pairs.length && !orphans.length) {
    return (
      `接缝：这 ${targets.length} 镜里没有一处标着「连续动作」，所以接缝全是硬切 —— ` +
      '这是默认，而且大部分镜位切换本来就该硬切（全都接上的话，整部片子会变成一个没剪过的长镜头）。' +
      '⚠「连续动作」**不会被自动判出来**，不标就一处接缝都不做，首尾帧也好接住末帧也好都不会发生。' +
      '要标：分镜页 →「整段标衔接」，手动圈一段，或者按「自动标」让模型通读全片挑出连贯动作；' +
      '标完再重出这几镜。'
    );
  }

  const lines = [];
  if (pairs.length) {
    lines.push(`接缝：${pairs.length} 处标着「连续动作」会${how} —— 第 ${pairs.join('、')} 镜；其余是硬切（默认）`);
    if (shape) lines.push(shape);
  }
  if (orphans.length) {
    lines.push(
      `第 ${orphans.join('、')} 镜标着「连续动作」，但上一段这次不出、之前也没出过片 —— ` +
      '抠不到末帧，这几处只能按普通图生视频出。要接上的话，把上一镜一起选上重出。'
    );
  }
  return lines.join('\n');
}

export async function generateVideos(projectId, { only = null, chapterId = null, regenerate = false, onEvent, signal = null } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);

  const r = routing();
  const dir = store.assetDir(projectId);
  const targets = project.shots
    .filter((s) => (chapterId ? s.chapterId === chapterId : true))
    .filter((s) => s.imagePath && (only ? only.includes(s.id) : regenerate || !s.videoPath));
  if (!targets.length) throw new Error('没有可出视频的分镜（需要先有镜头图）');

  onEvent?.({ type: 'stage', stage: 'video', status: 'running', message: `待出视频 ${targets.length} 段` });
  onEvent?.({ type: 'note', message: seamPlanOf(project.shots || [], targets, settings.get('seamMode') || 'lock') });

  for (const shot of targets) {
    jobs.checkpoint(signal, `第 ${shot.index} 镜起往后的 ${targets.length - targets.indexOf(shot)} 镜`);
    onEvent?.({ type: 'shot', shotId: shot.id, status: 'running', message: `第 ${shot.index} 镜出视频…` });
    try {
      /**
       * 上下文要**先**算，而且要用**刚读出来的项目**。
       *
       * 两个原因，都不是可有可无的：
       *   ① 接缝模式下这一镜的首帧可能来自上一段视频的真实末帧，
       *      而不是自己那张分镜图 —— 顺序反了会先白传一次图
       *   ② 上一段的 videoPath 是**这一轮刚写进去的**。拿循环开始时那份
       *      快照的话，prev.videoPath 永远是空的，接缝这条路整个不会触发
       */
      /**
       * 分级要在**上下文之前**定。
       *
       * 因为"这家收不收末帧图"决定了接缝那句话该怎么说 ——
       * 而这家是谁，正是分级挑出来的。顺序反了就会出现日志里那种自相矛盾：
       *   第 5 镜标成「连续动作」，把它那张图锁成本镜末帧 —— 两镜之间会是无缝的
       *   秘塔 metaso 这一步不收末帧图，本镜按普通图生视频出 —— 会是硬切
       * 前一句是在还不知道厂商是谁的时候许下的承诺，下一句就把它收回去了。
       */
      const tier = tiers.tierOf(shot);
      const tierRoute = tiers.routeFor(tier, settings.get('videoTiers'));
      const useProvider = tierRoute?.provider || r.video.provider;
      const useModel = tierRoute?.model || r.video.model;
      if (tierRoute) {
        onEvent?.({
          type: 'note',
          shotId: shot.id,
          message: `第 ${shot.index} 镜按「${tiers.TIER_LABELS[tier]}」走 ${useProvider} / ${useModel}（${tiers.reasonFor(shot)}）`
        });
      }

      const ctx = await videoContextFor(store.read(projectId), shot, { onEvent, providerId: useProvider });
      const firstFrame =
        ctx.headFromTail?.url
        || usableRef(shot.imageRef)
        || (await toModelRef(shot.imagePath, { onEvent }));
      // 设定集参考图一并带上（场景 + 角色 + 道具）：
      // 支持 r2v 的厂商（Vidu、H3）能靠它把人和环境一起锁住
      const bibleRefs =
        settings.get('useReferenceImages') === false
          ? { images: [], labels: [] }
          // 过期的限时地址在这儿当场换掉，不然厂商只会回一句"下载不到你给的图"
          : await refreshRefs(project, consistency.collectReferences(project.bible, shot), { onEvent });

      /**
       * 接住末帧时，**这一镜自己那张分镜图改当参考图**。
       *
       * 不这么做的话，那张图就白出了 —— 用户的原话："我生成的分镜图片就没有用了"。
       * 那张图是花钱出的、审过的、构图和内容都是按分镜定的，
       * 只是不再当"第一格画面"而已。
       *
       * 首帧管的是**接缝**（从哪一帧长出来），参考图管的是**内容**（要演成什么样）。
       * 两件事本来就不冲突，之前是被我做成了二选一。
       */
      if (ctx.headFromTail && shot.imagePath) {
        try {
          const own = usableRef(shot.imageRef) || (await toModelRef(shot.imagePath, { onEvent }));
          if (own && !bibleRefs.images.includes(own)) {
            // 放在最前面：它比设定集参考图更贴这一镜要演的东西
            bibleRefs.images.unshift(own);
            bibleRefs.labels.unshift(`本镜分镜图`);
            onEvent?.({
              type: 'note',
              message: `第 ${shot.index} 镜的分镜图改当参考图带上 —— 首帧接住上一段管接缝，这张管"要演成什么样"，两件事不冲突`
            });
          }
        } catch (err) {
          onEvent?.({ type: 'note', message: `本镜分镜图当参考图没带上（${err.message}），只影响构图参照，不影响接缝` });
        }
      }

      // 上下文：接在谁后面、要交给谁。缺了它，每一镜都会被当成独立短片来演。（上面已经算过）
      const videoPrompt = ctx.videoPrompt;
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'running', message: `提交任务：${videoPrompt.slice(0, 60)}…` });

      /**
       * 按镜头分级挑模型：贵的只用在看得出差别的地方。
       * 视频这一步是最大的一笔开销，而且按镜计费；空镜、远景、过渡镜
       * 常占一部片子的三四成，那些地方便宜模型看不出差别。
       *（tier / useProvider / useModel 在上面就算好了 —— 接缝那句话要靠它。）
       */
      const video = await adapters.generateVideo({
        providerId: useProvider,
        model: useModel,
        prompt: videoPrompt,
        firstFrameUrl: firstFrame,
        lastFrameUrl: ctx.lastFrameUrl,
        refImages: bibleRefs.images,
        duration: shot.duration,
        aspectRatio: project.aspectRatio || null,
        label: `视频 #${shot.index}`,
        /**
         * 取消信号也要送到轮询那一层。
         *
         * 这是"取消"里最微妙的一处：任务**已经提交了**，钱已经在花。
         * 单纯不管它，人得干等一两分钟才停得下来；而直接掐掉的话，
         * task_id 就丢了 —— 钱花了，片子在厂商那儿，你却再也找不回来。
         *
         * 所以轮询会带着 task_id 抛出来，下面 catch 里那段现成的
         * 「待认领」逻辑正好接住它：停得快，钱也不白花。
         */
        signal,
        // 轮询事件本身不带镜头信息，补上 shotId，前端才知道这是哪一镜在等
        onEvent: (ev) => onEvent?.({ ...ev, shotId: shot.id })
      });

      const dest = path.join(dir, `${shot.id}.mp4`);
      await saveMedia(video, dest, onEvent);
      store.update(projectId, (p) => {
        const t = p.shots.find((s) => s.id === shot.id);
        if (t) {
          t.videoPath = dest;
          t.videoPrompt = videoPrompt;
          t.videoAt = new Date().toISOString();
          t.videoModelUsed = `${useProvider} / ${useModel}`;
          // 记下走的哪一档：出完之后"这一镜为什么糊"最先该查的就是它
          t.videoTier = tier;
          t.videoResolution = video.resolution || null;
          t.videoRefs = bibleRefs.labels;
          t.link = ctx.link;
          // 末帧锁没锁上要如实记：界面上标着"连续动作"却其实没锁，
          // 用户会一直以为这两镜是无缝的，直到把成片放出来
          t.endFrameChained = Boolean(ctx.lastFrameUrl);
      // 这一镜的首帧是不是接住了上一段的真实末帧。界面上要能一眼看出
      // 哪几处接缝是"像素级连着的"，哪几处只是文字上接了一下
      t.headFromTail = ctx.headFromTail ? { fromIndex: ctx.headFromTail.fromIndex, at: new Date().toISOString() } : null;
          // 厂商档位可能把 4s 顶成 5s。如实记下来，别让界面上的总时长撒谎。
          t.actualDuration = video.actualDuration || shot.duration;
          t.status = 'video-ready';
        }
        return p;
      });

      // 两头都验：首帧看"厂商有没有吃我们那张图"（免费），
      // 末帧看"演到最后人还是不是那个人"（要一次多模态调用）
      const head = await verifyVideoHead(shot, dest, { onEvent, headRef: ctx.headFromTail });
      const tail = await verifyVideoTail(projectId, shot, dest, { onEvent });
      const { next: nextShot } = continuity.neighbors(store.read(projectId).shots || [], shot.id);
      const seam = await verifyTailAlign(shot, dest, nextShot, { onEvent });
      if (head || tail || seam) {
        store.update(projectId, (p) => {
          const t = p.shots.find((s) => s.id === shot.id);
          if (t) {
            if (head) t.headMatch = head;
            if (tail) t.videoConsistency = tail;
            if (seam) t.tailAlign = seam;
          }
          return p;
        });
      }
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'done' });
    } catch (err) {
      // 报错里带了 task_id 的话记下来：任务多半在厂商那边跑完了，
      // 只是我们查不到。留着这个号，用户能去平台上把片子捞回来。
      const taskId = err.taskId || (err.message.match(/task_id\s+(\S+)/) || [])[1];
      if (taskId) {
        store.update(projectId, (p) => {
          const t = p.shots.find((s) => s.id === shot.id);
          if (t) t.pendingTask = { taskId, provider: r.video.provider, at: new Date().toISOString() };
          return p;
        });
      }
      /**
       * 取消不是"这一镜失败了"，不能按失败处理接着跑下一镜。
       *
       * 顺序很要紧：**先**把 task_id 记进「待认领」，**再**抛出去。
       * 反过来的话，正卡在轮询上被取消的那一镜，钱花了、片子在厂商那儿、
       * 而任务号丢了 —— 这正是取消最容易造成的一种损失。
       */
      if (jobs.isCancel(err)) {
        onEvent?.({ type: 'shot', shotId: shot.id, status: 'idle', message: err.message });
        throw err;
      }
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'failed', message: err.message });
    }
  }

  const after = store.read(projectId);
  const done = after.shots.filter((s) => s.videoPath).length;
  store.update(projectId, (p) => {
    p.stageStatus.video = done === p.shots.length ? 'done' : done ? 'partial' : 'pending';
    return p;
  });
  onEvent?.({ type: 'stage', stage: 'video', status: 'done', message: `${done}/${after.shots.length} 段就绪` });
  return store.read(projectId);
}

/**
 * 手动把一段视频 / 一张图补到某一镜上。
 *
 * 为什么需要这个：中转平台只公开"提交"接口的情况是真实存在的（秘塔就是），
 * 任务在人家平台上跑完了、片子也在，我们却查不到状态。
 * 这种时候最要紧的不是继续猜路径，而是**别让已经花钱出好的东西丢掉** ——
 * 从平台上复制地址粘进来，这一镜就补齐了，流水线可以继续往下走。
 */
export async function attachShotMedia(projectId, shotId, { url, kind = 'video' } = {}, onEvent) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const shot = project.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error(`没有这一镜：${shotId}`);
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('请粘一个 http(s) 开头的地址');

  const dir = store.assetDir(projectId);
  const dest = path.join(dir, kind === 'video' ? `${shot.id}.mp4` : `${shot.id}.png`);
  onEvent?.({ type: 'shot', shotId, status: 'running', message: '下载中…' });
  await saveMedia({ url }, dest, onEvent);

  const modelRef = kind === 'video' ? null : await toModelRef(dest, { onEvent });
  store.update(projectId, (p) => {
    const t = p.shots.find((s) => s.id === shotId);
    if (!t) return p;
    if (kind === 'video') {
      t.videoPath = dest;
      t.videoModelUsed = '手动补入';
      t.status = 'video-ready';
    } else {
      t.imagePath = dest;
      t.imageRef = modelRef;
      t.modelUsed = '手动补入';
      t.status = 'image-ready';
    }
    // 补上了就不再是"任务在天上飘着"
    delete t.pendingTask;
    return p;
  });
  onEvent?.({ type: 'shot', shotId, status: 'done', message: '已补入' });
  return store.read(projectId);
}

/**
 * 待认领的任务：提交成功了，但当时没能把片子取回来。
 *
 * 这类任务是流水线里最讨厌的一种状态 —— 钱花了、东西在厂商那边好好地放着，
 * 我们这边却一直缺一块，而且既不算"失败"（重跑要再花一次钱），
 * 也不算"完成"。所以把它单列成一类，给两条出路：重查一次，或者贴地址补入。
 */
export function listPendingTasks(projectId) {
  const project = store.read(projectId);
  if (!project) return [];
  return (project.shots || [])
    .filter((s) => s.pendingTask && !s.videoPath)
    .map((s) => ({ shotId: s.id, index: s.index, ...s.pendingTask }));
}

/**
 * 把待认领的任务重新查一遍。
 *
 * **不重新生成，只是再问一次**，所以不产生生成费用。
 * 用户刚在「接口地址（高级）」里填对路径之后点这一下，
 * 之前所有卡住的镜头能一次性收回来。
 */
export async function recheckPendingTasks(projectId, { onEvent } = {}) {
  const pending = listPendingTasks(projectId);
  if (!pending.length) throw new Error('没有待认领的任务');

  onEvent?.({ type: 'stage', stage: 'video', status: 'running', message: `重查 ${pending.length} 个任务…` });
  const dir = store.assetDir(projectId);
  let claimed = 0;

  for (const task of pending) {
    onEvent?.({ type: 'shot', shotId: task.shotId, status: 'running', message: `查 ${task.taskId}…` });
    try {
      const r = await adapters.queryTaskOnce({
        providerId: task.provider,
        taskId: task.taskId,
        label: `重查 #${task.index}`,
        onEvent: (ev) => onEvent?.({ ...ev, shotId: task.shotId })
      });

      if (r.done && r.url) {
        const dest = path.join(dir, `${task.shotId}.mp4`);
        await saveMedia({ url: r.url }, dest, onEvent);
        store.update(projectId, (p) => {
          const t = p.shots.find((s) => s.id === task.shotId);
          if (t) {
            t.videoPath = dest;
            t.status = 'video-ready';
            delete t.pendingTask;
          }
          return p;
        });
        claimed += 1;
        onEvent?.({ type: 'shot', shotId: task.shotId, status: 'done', message: '已收回' });
      } else if (r.failed) {
        // 厂商那边确实失败了：把它从待认领里摘掉，这一镜该重跑
        store.update(projectId, (p) => {
          const t = p.shots.find((s) => s.id === task.shotId);
          if (t) delete t.pendingTask;
          return p;
        });
        onEvent?.({ type: 'shot', shotId: task.shotId, status: 'failed', message: r.reason });
      } else {
        onEvent?.({
          type: 'shot',
          shotId: task.shotId,
          status: 'failed',
          message: r.reason || `还是查不到（状态 ${r.state || '空'}）`
        });
      }
    } catch (err) {
      onEvent?.({ type: 'shot', shotId: task.shotId, status: 'failed', message: err.message });
    }
  }

  const after = store.read(projectId);
  const done = after.shots.filter((s) => s.videoPath).length;
  store.update(projectId, (p) => {
    p.stageStatus.video = done === p.shots.length ? 'done' : done ? 'partial' : 'pending';
    return p;
  });
  onEvent?.({
    type: 'stage',
    stage: 'video',
    status: 'done',
    message: `收回 ${claimed}/${pending.length} 个`
  });
  return store.read(projectId);
}

// ═══════════════════════ 阶段五：配音 ═══════════════════════

/**
 * 给每个角色分配一个音色。
 *
 * 这和"每个角色一颗固定种子"是同一件事，只是换到声音上：
 * **全片一个音色，两个人对话时观众分不出谁在说话** ——
 * 画面上做了四层一致性，声音上却是同一个人配了所有角色，
 * 这个反差比画面不一致更出戏。
 *
 * 分配方式是按顺序轮着取，尽量不重样；已经手选过的不动
 * （你挑的音色比自动分的准，那是你听过的）。
 */
export function assignVoices(projectId, { force = false } = {}) {
  const project = store.read(projectId);
  if (!project?.bible?.characters?.length) return { assigned: 0, voices: [] };

  const r = routing();
  const pool = catalog.voicesOf(r.tts.provider).map((v) => v.id);
  if (!pool.length) return { assigned: 0, voices: [], reason: `${r.tts.provider} 没有内置音色清单，去设定集里手填` };

  let i = 0;
  const assigned = [];
  const taken = new Set(
    force ? [] : project.bible.characters.map((c) => c.voice).filter(Boolean)
  );
  store.update(projectId, (p) => {
    for (const c of p.bible.characters) {
      if (c.voice && !force) continue;
      // 挑一个还没被占的；都占满了就从头轮
      let pick = pool[i % pool.length];
      for (let n = 0; n < pool.length && taken.has(pick); n++) pick = pool[(i + n + 1) % pool.length];
      i += 1;
      c.voice = pick;
      taken.add(pick);
      assigned.push({ name: c.name, voice: pick });
    }
    // 旁白也要有自己的声音，而且不该和任何角色重
    if (!p.bible.narratorVoice || force) {
      p.bible.narratorVoice = pool.find((v) => !taken.has(v)) || pool[0];
    }
    return p;
  });
  return { assigned: assigned.length, voices: assigned, narrator: store.read(projectId).bible.narratorVoice };
}

const SPEAKER_PROMPT = `你是编剧。下面是一部片子的分镜表，**按顺序**给出。

其中标了 need:true 的镜头有台词，但从台词和描述里看不出是谁说的。判断这几条各是谁说的。

判断依据（按可靠性排序）：
- **对话是轮流的**：上一句甲说完，紧接着这一句通常是乙回；连着两句同一个人说的比较少见
- 台词里的称呼：台词是"周叔，你看那边"，那说话的就**不是**周叔
- 画面描述里谁在做动作、谁在开口、镜头对着谁
- 确实是画外解说、没有具体说话人的，speaker 填"旁白"

规矩：
- 只能用下面给出的角色名或"旁白"，**不要自创**；
- 只回答 need 为 true 的镜头，其余是给你看上下文的（它们的 speaker 已经定了）。

严格只输出 JSON，不要解释、不要代码块：

{"shots":[{"id":"分镜 id，原样照抄","speaker":"角色名或旁白","why":"一句话说明依据"}]}

这部片子里的角色：
{{CAST}}`;

/**
 * 把台词绑到说话人身上。
 *
 * 两层，先便宜的后贵的：
 *
 *   ① **确定性**：台词自带的署名、画面描述里的提示、这一镜只有一个人 ——
 *      这三种线索一分钱不花就能定，而且比模型准（它们是明写在文本里的事实）。
 *      顺手把署名从台词里摘掉：留着它，配音会把"阿澜冒号"一起念出来。
 *   ② **模型**：只有"在场不止一个人、又没有任何线索"的那几条才发给调度模型。
 *      这类题的关键是**上下文**（对话轮流说），所以整条分镜表都发过去，
 *      只标出哪几条要判 —— 单看一条台词，神仙也判不出是谁说的。
 *
 * 不动已经确定的：你手选过的说话人，和台词里白纸黑字写着的署名，都不该被模型改掉。
 */
export async function autoBindSpeakers(projectId, { useModel = true, onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const withLines = (project.shots || []).filter((s) => String(s.dialogue || '').trim());
  if (!withLines.length) {
    onEvent?.({ type: 'stage', stage: 'voice', status: 'done', message: '全片没有台词' });
    return { project, bound: [] };
  }

  // ── 第一层：确定性 ──
  const decided = speakerLib.bindAll(project);
  const bound = [];
  store.update(projectId, (p) => {
    for (const d of decided) {
      const t = p.shots.find((s) => s.id === d.id);
      if (!t) continue;
      if (d.confident) {
        t.speaker = d.speaker;
        t.speakerBy = d.by;
        // 署名摘出来之后，台词字段留净台词 —— 不然界面上会看到
        //「阿澜：阿澜：设备正常」这种重复（说话人已经单独一栏了）
        if (d.line && d.line !== String(t.dialogue || '').trim()) t.dialogue = d.line;
        bound.push({ index: t.index, speaker: t.speaker, by: d.by });
      } else {
        t.speakerBy = d.by;
      }
    }
    return p;
  });

  const unsure = decided.filter((d) => !d.confident);
  onEvent?.({
    type: 'note',
    message: `按台词署名和描述提示定了 ${bound.length} 条${unsure.length ? `，还有 ${unsure.length} 条看不出是谁说的` : ''}`
  });

  // ── 第二层：只把定不下来的交给模型 ──
  if (unsure.length && useModel) {
    const r = routing();
    const fresh = store.read(projectId);
    const cast = (fresh.bible?.characters || []).map((c) => `  ${c.name}${c.role ? `（${c.role}）` : ''}`).join('\n');
    const need = new Set(unsure.map((d) => d.id));
    const payload = withLines.map((s) => {
      const cur = fresh.shots.find((x) => x.id === s.id) || s;
      return {
        id: s.id,
        index: s.index,
        scene: s.scene,
        characters: s.characters,
        description: s.description,
        dialogue: speakerLib.spokenText(cur.dialogue).text,
        speaker: need.has(s.id) ? '' : cur.speaker || '旁白',
        need: need.has(s.id)
      };
    });

    onEvent?.({
      type: 'note',
      message: `把这 ${unsure.length} 条连同上下文交给调度模型 ${r.director.model}（${r.director.provider}）…`
    });
    try {
      const { text } = await adapters.chat({
        providerId: r.director.provider,
        model: r.director.model,
        system: SPEAKER_PROMPT.replace('{{CAST}}', cast || '  （设定集里还没有角色）'),
        user: JSON.stringify(payload),
        temperature: 0.2,
        jsonMode: true,
        label: '绑说话人'
      });
      const picks = consistency.extractJSON(text)?.shots || [];
      store.update(projectId, (p) => {
        for (const pick of picks) {
          if (!need.has(pick.id)) continue; // 只认要判的那几条
          const t = p.shots.find((s) => s.id === pick.id);
          if (!t) continue;
          const hit = speakerLib.matchCharacter(pick.speaker, p.bible?.characters || []);
          // 对不上设定集的名字就当旁白，而不是把一个不存在的名字写进去 ——
          // 那样配音时会静悄悄退回旁白，你还以为绑上了
          t.speaker = hit?.name || '';
          t.speakerBy = 'model';
          t.speakerWhy = String(pick.why || '').trim();
          bound.push({ index: t.index, speaker: t.speaker, by: 'model', why: t.speakerWhy });
        }
        return p;
      });
    } catch (err) {
      onEvent?.({ type: 'note', message: `模型这一层没跑成：${err.message}。定不下来的按旁白算` });
    }
  }

  for (const b of bound.slice(0, 40)) {
    onEvent?.({
      type: 'note',
      message: `第 ${b.index} 镜：${b.speaker || '旁白'}（${speakerLib.BY_LABELS[b.by] || b.by}${b.why ? `：${b.why}` : ''}）`
    });
  }
  onEvent?.({
    type: 'stage',
    stage: 'voice',
    status: 'done',
    message: `${bound.length}/${withLines.length} 条台词已绑好说话人。不对的去分镜里手改，手改过的不会再被覆盖`
  });
  return { project: store.read(projectId), bound };
}

/**
 * 这一镜的台词该用谁的声音、念哪一句。
 *
 * 旧版本的兜底是"没标 speaker 就取出场角色里的第一个" —— 那是错的：
 * 两个人在场时，那就是一半几率挂错人，而且错得毫无提示。
 * 现在按线索一层层找（见 pipeline/speaker.js），找不到就明确算旁白。
 */
export function voiceForShot(project, shot) {
  const chars = project.bible?.characters || [];
  const r = speakerLib.resolve(project, shot);
  const hit = r.speaker ? chars.find((c) => c.name === r.speaker) : null;
  const said = speakerLib.spokenText(shot.dialogue);
  return {
    voice: hit?.voice || project.bible?.narratorVoice || '',
    who: hit?.name || '旁白',
    // 念的是净台词：署名和表演提示都摘掉，否则会念出"阿澜冒号设备正常"
    text: said.text,
    kind: said.kind,
    by: r.by
  };
}

export async function generateVoice(projectId, { onEvent, signal = null } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const r = routing();
  const dir = store.assetDir(projectId);

  // 没分配过音色的话先分一次 —— 不分的话全片一个默认音色，
  // 两个人对话时观众分不出谁在说话
  if ((project.bible?.characters || []).some((c) => !c.voice)) {
    const done = assignVoices(projectId);
    if (done.assigned) {
      onEvent?.({
        type: 'note',
        message: `已给 ${done.assigned} 个角色分配音色：${done.voices.map((v) => `${v.name}→${v.voice}`).join('、')}` +
          `${done.narrator ? `，旁白→${done.narrator}` : ''}。不满意去「设定集」页逐个改`
      });
    } else if (done.reason) {
      onEvent?.({ type: 'note', message: done.reason });
    }
  }

  const fresh = store.read(projectId);
  // 只给**真台词**配音。台词字段里塞的音效提示（"（远处传来汽笛声）"）
  // 要是丢给 TTS，就会出现"画面里没人张嘴，声音里却在念汽笛声"
  const skipped = [];
  const targets = fresh.shots.filter((s) => {
    if (s.audioPath || !s.dialogue?.trim()) return false;
    const said = speakerLib.spokenText(s.dialogue);
    if (said.kind !== 'speech') {
      skipped.push({ index: s.index, why: said.dropped[0] || s.dialogue.trim() });
      return false;
    }
    return true;
  });
  for (const sk of skipped.slice(0, 10)) {
    onEvent?.({ type: 'note', message: `第 ${sk.index} 镜跳过配音：「${sk.why}」是音效/提示，不是台词` });
  }
  if (!targets.length) {
    /**
     * ⚠ 没台词**不等于**没声音。
     *
     * 这里原来直接 return，于是一部"全片没有台词、只有画外音效"的片子
     * 永远出不来音效 —— 而那种片子恰恰最依赖音效（没人说话时，
     * 声音就是全部的氛围）。这个错还特别隐蔽：界面上写着"这一步完成"。
     */
    await generateSfx(projectId, { onEvent, signal });
    onEvent?.({ type: 'stage', stage: 'voice', status: 'done', message: '没有需要配音的台词' });
    store.update(projectId, (p) => {
      p.stageStatus.voice = 'done';
      return p;
    });
    return store.read(projectId);
  }

  onEvent?.({ type: 'stage', stage: 'voice', status: 'running', message: `待配音 ${targets.length} 条` });
  for (const shot of targets) {
    jobs.checkpoint(signal, `第 ${shot.index} 镜起往后的配音`);
    try {
      const { voice, who, text } = voiceForShot(fresh, shot);
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'running', message: `第 ${shot.index} 镜配音（${who}${voice ? `·${voice}` : ''}）…` });
      const speech = await adapters.synthesizeSpeech({
        providerId: r.tts.provider,
        model: r.tts.model,
        // 净台词。带着"阿澜："或者"（低声）"发过去，TTS 会一字不落地念出来
        text,
        // 角色的音色。不传的话全片是同一个声音 —— 这个漏洞以前一直在
        ...(voice ? { voice } : {}),
        label: `配音 #${shot.index}·${who}`
      });
      const dest = path.join(dir, `${shot.id}.mp3`);
      if (speech.url) {
        await saveMedia(speech, dest, onEvent);
      } else if (speech.binaryRequest) {
        /**
         * OpenAI 系的 /audio/speech 直接回二进制流。
         *
         * ⚠ 这里以前**一个鉴权头都不发** —— 于是这条路只会回 401，
         * 而报错只有一句"配音失败 HTTP 401"，看不出是缺了 Authorization。
         * 401 的第一反应永远是"密钥不对"，人会去控制台反复重建密钥。
         *
         * 用 provider id 直接取头，不从地址反推：调用方本来就知道是哪家，
         * 反推在共用网关或中转域名时会认错人。
         */
        const { url, body, provider: pid } = speech.binaryRequest;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeadersFor(pid) },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          // 带上服务端原话。只报状态码等于让人自己去猜
          throw new Error(`配音失败 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
        }
        fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      }
      store.update(projectId, (p) => {
        const t = p.shots.find((s) => s.id === shot.id);
        if (t) {
          t.audioPath = dest;
          // 记下这条是谁、用了哪个音色：换了音色重配时，界面要说得清哪条是旧的
          t.voiceUsed = voice || '';
          t.speakerUsed = who;
        }
        return p;
      });
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'done', message: '配音完成' });
    } catch (err) {
      if (jobs.isCancel(err)) throw err;
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'failed', message: err.message });
    }
  }
  await generateSfx(projectId, { onEvent, signal });

  store.update(projectId, (p) => {
    p.stageStatus.voice = 'done';
    return p;
  });
  return store.read(projectId);
}

/**
 * 画外音效 —— 分镜里那一栏「敲门声、脚步声」变成真的声音。
 *
 * ── 为什么跟着配音那一步跑，而不是单开一步 ──
 *
 * 它和配音是同一件事的两半：都是往这部片子的声音里加东西，
 * 都按同一份时间轴摆，都在合成时混进同一条音轨。
 * 拆成两步只会多一个要点的按钮，而没人会想"只配音不要音效"。
 *
 * ── 没配服务商就跳过，不回退 ──
 *
 * 这一条是**故意的**：音效和配音是两种模型。拿配音模型去生成"敲门声"，
 * 出来的是一个人**念这三个字**，而且会被当成成片的一部分交付出去。
 * 宁可没有音效，也不要那个。
 */
async function generateSfx(projectId, { onEvent, signal } = {}) {
  const project = store.read(projectId);
  /**
   * 要出音效的那些：写了描述，而且**还没出**或者**描述改过了**。
   *
   * 第二个条件不能少。只看 sfxPath 的话，改完描述再跑一遍什么都不会变 ——
   * 界面上标着"音效已过时"，重跑也退不掉，人只会觉得这个标记坏了。
   * 而实际后果更实在：成片里还是那声旧的。
   */
  const targets = (project.shots || []).filter((s) => {
    const want = String(s.sound || '').trim();
    if (!want) return false;
    return !s.sfxPath || s.sfxOf !== want;
  });
  if (!targets.length) return;

  const r = routing();
  if (!r.sfx?.provider) {
    onEvent?.({
      type: 'note',
      message:
        `有 ${targets.length} 镜写了画外音效，但还没配音效服务商，这次跳过。` +
        '（去「设置 → 能力路由 → 音效」配一家。故意不回退到配音模型 —— ' +
        '那出来的是一个人念"敲门声"三个字，比没有音效更糟。）'
    });
    return;
  }

  onEvent?.({ type: 'stage', stage: 'voice', status: 'running', message: `待生成音效 ${targets.length} 条` });
  const dir = store.assetDir(projectId);
  let made = 0;

  for (const shot of targets) {
    jobs.checkpoint(signal, `第 ${shot.index} 镜起往后的音效`);
    try {
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'running', message: `第 ${shot.index} 镜音效：${shot.sound}` });
      const sfx = await adapters.generateSfx({
        providerId: r.sfx.provider,
        model: r.sfx.model,
        text: shot.sound,
        // 卡在镜头长度以内：音效比画面长的话会盖到下一镜上 ——
        // 上一场的敲门声在新场景里还在响，观众立刻就听出不对
        seconds: Math.min(Number(shot.duration) || 3, 10),
        label: `音效 #${shot.index}`
      });
      const dest = path.join(dir, `${shot.id}.sfx.mp3`);
      if (sfx.url) {
        await saveMedia(sfx, dest, onEvent);
      } else if (sfx.binaryRequest) {
        const res = await fetch(sfx.binaryRequest.url, {
          method: sfx.binaryRequest.method,
          headers: { 'Content-Type': 'application/json', ...authHeadersFor(sfx.binaryRequest.provider) },
          body: JSON.stringify(sfx.binaryRequest.body)
        });
        if (!res.ok) throw new Error(`音效失败 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
        fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      }
      store.update(projectId, (p) => {
        const t = p.shots.find((x) => x.id === shot.id);
        // 记下当时那句描述：改了描述之后界面要能说清楚"现在这条音效是旧的"
        if (t) {
          t.sfxPath = dest;
          t.sfxOf = shot.sound;
        }
        return p;
      });
      made += 1;
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'done', message: '音效完成' });
    } catch (err) {
      if (jobs.isCancel(err)) throw err;
      // 音效失败不该拖垮整部片子 —— 它是锦上添花，成片没有它照样能看
      onEvent?.({ type: 'note', message: `第 ${shot.index} 镜音效没出成（${err.message}），成片会少这一声，其余不受影响` });
    }
  }

  if (made) {
    onEvent?.({
      type: 'note',
      message: `音效 ${made}/${targets.length} 条就绪。合成时会压在台词底下（音量 ${settings.get('sfxGain') ?? 0.35} 倍）—— 等响的话一声关门就能盖掉一句台词`
    });
  }
}

// ═══════════════════════ 阶段六：合成 ═══════════════════════

/**
 * 生成 SRT 字幕。
 *
 * 这件事**几乎是免费的** —— 台词、每镜时长、裁剪策略全在手上，
 * 只是把它们按时间轴排一遍。而短剧没字幕基本不能发。
 *
 * 时间轴必须和**合成时真正用的那个时长**一致：
 * trim 策略下用分镜的计划时长，keep 策略下用模型实出的时长。
 * 拿错一个，后面每一条字幕都会累积偏移 —— 越到片尾偏得越离谱。
 */
/**
 * 成片的时间轴：每一镜从第几秒开始、占多长。
 *
 * 字幕、配音、裁剪**必须共用这一份**。各算各的时间轴是错位的根源：
 * 三处只要有一处用了另一种时长口径，音、画、字就会各走各的。
 */
export function timelineOf(project, { policy = 'trim' } = {}) {
  const shots = (project.shots || []).filter((s) => s.videoPath).sort((a, b) => a.index - b.index);
  const rows = [];
  let at = 0;
  for (const shot of shots) {
    /**
     * 叠化会**吃掉**重叠的那半秒 —— 全片因此变短。
     *
     * 这一行必须在这里，不能只写在合成那一层：配音按绝对时间点摆、
     * 字幕也按绝对时间算，两者都来自这个函数。少了它，一处叠化之后
     * 的每一句台词都会晚半秒，而且叠化越多错得越多 ——
     * 表现和"配音顺次拼"那个老 bug 一模一样，只是原因换了一个。
     */
    if (rows.length) at -= transitions.overlapOf(shot);
    const span = policy === 'trim'
      ? Number(shot.duration) || Number(shot.actualDuration) || 0
      : Number(shot.actualDuration) || Number(shot.duration) || 0;
    rows.push({ shot, start: at, span });
    at += span;
  }
  return rows;
}

export function buildSubtitles(project, { policy = 'trim' } = {}) {
  const cues = [];
  for (const { shot, start, span } of timelineOf(project, { policy })) {
    // 字幕显示的也是净台词：署名单独有 speaker 字段，念不出来的括注更不该显示
    const text = speakerLib.spokenText(shot.dialogue).text;
    if (!text) continue;
    // 字幕不占满整镜：结尾留 0.15 秒，避免和下一条贴在一起闪
    cues.push({
      start,
      end: Math.max(start + 0.5, start + span - 0.15),
      text,
      speaker: shot.speakerUsed || shot.speaker || ''
    });
  }
  return cues;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const milli = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${sec},${milli}`;
}

export function toSRT(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join('\n');
}

export async function compose(projectId, { onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);

  const ordered = project.shots.slice().sort((a, b) => a.index - b.index);
  const withVideo = ordered.filter((s) => s.videoPath);
  const segments = withVideo.map((s) => s.videoPath);
  if (!segments.length) throw new Error('没有可合成的视频片段');

  // 缺镜也允许合成 —— 卡在"必须全齐"上，一个取不回来的任务就能让整部片子出不来。
  // 但必须说清楚少了哪几镜，别让人以为这就是完整成片。
  const missing = ordered.filter((s) => !s.videoPath);
  if (missing.length) {
    const pending = missing.filter((s) => s.pendingTask).length;
    onEvent?.({
      type: 'note',
      message:
        `缺 ${missing.length} 镜（${missing.map((s) => `#${s.index}`).join(' ')}），本次先按现有的 ` +
        `${segments.length} 段合成。` +
        (pending ? `其中 ${pending} 镜的任务还在"待认领"里，去把它们收回来再合一次会更完整。` : '')
    });
  }

  // 裁剪是唯一能精确命中目标时长的办法：模型给 5 秒而分镜只要 3.5 秒时切掉多余的。
  // 关掉则保留完整片段 —— 运动更自然，但成片会比计划长。
  const policy = settings.get('durationPolicy') || 'trim';
  const trims = policy === 'trim' ? withVideo.map((s) => Number(s.duration) || null) : null;

  /**
   * 自动剪辑：给每段挑一个入点，别永远从第 0 秒切。
   *
   * 图生视频几乎都有的毛病 —— 开头零点几秒是不动的（模型在"起势"，
   * 前几帧基本是首帧的复制）。一段察觉不到，二十段连起来整片发黏，
   * 而逐段看每一段都没问题，这正是最难自己发现的那类。
   *
   * 要 FFmpeg 才做得了（得把帧采出来）。没装就跳过并说一声 ——
   * 跳过是可以接受的，不知道自己跳过了才不行。
   */
  let cuts = null;
  if (settings.get('autoCut') !== false && ffmpeg.locate().available) {
    cuts = [];
    const tmpRoot = path.join(dir, '.autocut');
    for (const [i, shot] of withVideo.entries()) {
      jobs.checkpoint(signal, '自动剪辑');
      const outDir = path.join(tmpRoot, String(shot.id));
      try {
        // eslint-disable-next-line no-await-in-loop
        const frames = await ffmpeg.sampleFrames(shot.videoPath, outDir, { step: autocut.STEP });
        // eslint-disable-next-line no-await-in-loop
        const hashes = await Promise.all(frames.map((f) => imghash.hashImage(f)));
        // eslint-disable-next-line no-await-in-loop
        const total = (await ffmpeg.probeDuration(shot.videoPath)) || 0;
        const win = autocut.pickWindow(hashes, total, trims?.[i] || 0, { hamming: imghash.hamming });
        cuts.push({ ...win, index: shot.index });
      } catch {
        // 一段分析不了不该拖垮整次合成 —— 那一段照原样切
        cuts.push({ in: 0, out: 0, deadHead: 0, trimmed: false, index: shot.index });
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    const brief = autocut.summarize(cuts);
    if (brief) onEvent?.({ type: 'note', message: brief });
  } else if (settings.get('autoCut') !== false) {
    onEvent?.({
      type: 'note',
      message: '自动剪辑要 FFmpeg 才做得了（得把帧采出来分析），这次跳过 —— 每一镜开头那几帧不动的会留在成片里'
    });
  }

  const bin = ffmpeg.locate({ refresh: true });
  if (!bin.available) throw new Error(bin.hint);

  const out = path.join(store.projectDir(projectId), `${safeFileName(project.title)}.mp4`);
  onEvent?.({ type: 'stage', stage: 'compose', status: 'running', message: `合成 ${segments.length} 段…` });

  /**
   * 配音按**各自该出现的时间点**摆，不是顺次拼。
   *
   * 顺次拼在数学上就是错的：画面长度是分镜时长（4 秒），配音长度是这句话念多久（2.1 秒），
   * 两者不相等，于是从第二镜起就错位，而且越往后错得越多 ——
   * 第 10 镜的台词会配在第 7 镜的画面上。这就是"说的话和画面对不上"，
   * 而且因为是渐进的，前两镜看着还挺正常，很难往这儿想。
   */
  const timeline = timelineOf(store.read(projectId), { policy });
  const audioAt = timeline
    .filter((r) => r.shot.audioPath && fs.existsSync(r.shot.audioPath))
    .map((r) => ({ path: r.shot.audioPath, at: r.start, index: r.shot.index, span: r.span }));

  /**
   * 画外音效走**同一条时间轴**，只是音量压低。
   *
   * 同一条时间轴这一点是关键：音效和台词、字幕如果各算各的起点，
   * 一处叠化或者一处补帧就会让它们互相错开 —— 而"敲门声比开门画面晚半秒"
   * 是观众一秒就能听出来的那种错。
   *
   * gain 压低同样不是可选项：等响的话一声关门就能盖掉一句台词。
   */
  const sfxGain = Number(settings.get('sfxGain'));
  const sfxAt = timeline
    .filter((r) => r.shot.sfxPath && fs.existsSync(r.shot.sfxPath))
    .map((r) => ({
      path: r.shot.sfxPath,
      at: r.start,
      index: r.shot.index,
      span: r.span,
      gain: Number.isFinite(sfxGain) && sfxGain > 0 ? sfxGain : 0.35
    }));
  if (sfxAt.length) {
    onEvent?.({ type: 'note', message: `混入 ${sfxAt.length} 条画外音效，音量压到 ${(sfxAt[0].gain * 100).toFixed(0)}%（台词要压得住它）` });
  }

  // 台词念不完的要当场说出来：这不是能自动修的事 —— 要么把这一镜拉长，
  // 要么把台词改短，两个都是导演的决定。不说的话它只会表现为"后面几句压到了下一镜"。
  const overruns = [];
  for (const a of audioAt) {
    const secs = await ffmpeg.probeDuration(a.path);
    if (secs && a.span && secs > a.span + 0.25) overruns.push({ index: a.index, secs, span: a.span });
  }
  /**
   * 音效比镜头长的话，它会响到下一镜上。
   *
   * 生成时已经按镜头时长卡过一次，但厂商给多了是常有的事（档位、模型自己收尾）。
   * 而这个错的表现特别"说不清"：上一场的敲门声在新场景里还在响，
   * 观众立刻觉得不对，却指不出哪里不对。所以这里直接裁到镜头长度，
   * 并且说一声 —— 裁比让它漏出去好，音效本来就是垫底的。
   */
  for (const a of sfxAt) {
    const secs = await ffmpeg.probeDuration(a.path);
    if (secs && a.span && secs > a.span + 0.2) {
      a.trimTo = a.span;
      onEvent?.({
        type: 'note',
        message: `第 ${a.index} 镜的音效有 ${secs.toFixed(1)} 秒，比镜头长，已裁到 ${a.span} 秒 —— 不裁的话它会响到下一镜上`
      });
    }
  }

  if (overruns.length) {
    onEvent?.({
      type: 'note',
      message:
        `有 ${overruns.length} 镜的台词比镜头长，会压到下一镜的画面上：` +
        overruns.slice(0, 6).map((o) => `#${o.index}（念 ${o.secs.toFixed(1)}s／镜头 ${o.span}s）`).join('、') +
        '。把这几镜的时长拉长，或者把台词改短一点。'
    });
  }

  if (trims) {
    const saved = withVideo.reduce((sum, s) => sum + Math.max(0, duration.shotSeconds(s) - (Number(s.duration) || 0)), 0);
    if (saved > 0.5) onEvent?.({ type: 'note', message: `按分镜时长裁剪，去掉厂商档位多出的 ${saved.toFixed(1)} 秒` });
  }

  // 每一段是"怎么进来的"。第一段没有转场可言，永远硬切
  const transitionKinds = withVideo.map((s, i) => (i === 0 ? 'cut' : transitions.kindOf(s)));
  const effects = transitionKinds.filter((k) => k !== 'cut').length;
  if (effects) {
    const eaten = transitions.totalOverlap(withVideo);
    onEvent?.({
      type: 'note',
      message:
        `${effects} 处转场（黑场/叠化），其余都是硬切` +
        (eaten > 0 ? `。叠化会重叠掉 ${eaten.toFixed(1)} 秒，成片总长相应变短，配音和字幕已按这个算` : '')
    });
  }

  await ffmpeg.concat(segments, out, {
    // 台词在前、音效在后：混音时顺序不影响结果，但报错里的编号跟着这个顺序，
    // 排查"第几条音频有问题"时对得上
    audioAt: [...audioAt, ...sfxAt],
    trims,
    cuts,
    transitions: transitionKinds,
    onNote: (message) => onEvent?.({ type: 'note', message }),
    onProgress: (p) => onEvent?.({ type: 'progress', seconds: p.seconds })
  });

  /**
   * 字幕。数据全在手上，只是排一遍时间轴 —— 而短剧没字幕基本不能发。
   *
   * 默认只出 .srt 不烧进画面：烧字幕要 libass + 一个能显示中文的字体，
   * Windows 上字体路径千奇百怪，烧失败会把**整条合成**带崩。
   * 想烧的话在「设置 → 画面规格」里打开，失败也只丢字幕、不丢成片。
   */
  let srtPath = null;
  const cues = buildSubtitles(store.read(projectId), { policy });
  if (cues.length) {
    srtPath = path.join(store.projectDir(projectId), `${safeFileName(project.title)}.srt`);
    fs.writeFileSync(srtPath, toSRT(cues), 'utf8');
    onEvent?.({ type: 'note', message: `字幕已生成：${cues.length} 条 → ${path.basename(srtPath)}` });

    if (settings.get('burnSubtitles') === true) {
      try {
        const burned = out.replace(/\.mp4$/, '.sub.mp4');
        await ffmpeg.burnSubtitles(out, srtPath, burned, {
          onProgress: (p) => onEvent?.({ type: 'progress', seconds: p.seconds })
        });
        fs.rmSync(out, { force: true });
        fs.renameSync(burned, out);
        onEvent?.({ type: 'note', message: '字幕已烧进画面' });
      } catch (err) {
        // 烧不上只丢字幕，不能丢成片 —— 片子已经在 out 上了
        onEvent?.({
          type: 'note',
          message: `字幕没烧进去（${err.message}）。成片是好的，.srt 也在，播放器里挂上就行`
        });
      }
    }
  }

  store.update(projectId, (p) => {
    p.outputs.video = out;
    p.outputs.subtitle = srtPath;
    p.outputs.durationPolicy = policy;
    p.outputs.seconds = duration.summarize(p, { policy }).final;
    p.stageStatus.compose = 'done';
    p.stageStatus.export = 'done';
    return p;
  });
  onEvent?.({ type: 'stage', stage: 'compose', status: 'done', message: out });
  return store.read(projectId);
}

/** 一键跑完全流程。任一阶段失败就停在那儿，已完成的部分都在盘上。 */
/** 一键跑完时按这个顺序走。名字和 store.STAGES 对齐，界面上说的"从哪一步开始"就是这里的 id */
const RUN_ORDER = [
  { id: 'bible', label: '设定集', run: (id, o) => buildBible(id, o) },
  { id: 'script', label: '分镜', run: (id, o) => analyzeScript(id, o) },
  { id: 'assets', label: '镜头出图', run: (id, o) => generateAssets(id, o) },
  { id: 'video', label: '视频生成', run: (id, o) => generateVideos(id, o) },
  { id: 'voice', label: '配音', run: (id, o) => generateVoice(id, o) },
  { id: 'compose', label: '合成', run: (id, o) => compose(id, o) }
];

/**
 * 一路跑到底。
 *
 * `from` 决定从哪一步起跑：
 *   不给      从头跑完整条（第一次做片子，或者想推翻重来）
 *   给了 id   从那一步往后跑 —— 这才是日常用得最多的：
 *             设定集和分镜早就审过了，重跑一遍不但白花钱，
 *             还会把你改过的分镜文案冲掉。
 *
 * 中间任一步抛错就停下，已经跑完的都在盘上 —— 不做"跳过失败继续跑"：
 * 出图失败还硬着头皮去出视频，只会拿着半张图烧掉更贵的那一步。
 */
export async function runAll(projectId, { shotCount = 8, from = null, onEvent, signal = null } = {}) {
  const start = from ? RUN_ORDER.findIndex((s) => s.id === from) : 0;
  if (from && start === -1) throw new Error(`不认识这一步：${from}`);
  const plan = RUN_ORDER.slice(Math.max(0, start));
  onEvent?.({
    type: 'note',
    message: `这一轮要跑：${plan.map((s) => s.label).join(' → ')}${start > 0 ? `（前面 ${start} 步跳过，保留已有产出）` : ''}`
  });

  let last = null;
  for (const step of plan) {
    // 每一步开始前看一眼。停在步与步之间是最干净的落点：
    // 上一步的产物完整存着，接着跑时从这一步「往后全跑」就行
    jobs.checkpoint(signal, `「${step.label}」及其后各步`);
    // eslint-disable-next-line no-await-in-loop
    last = await step.run(projectId, { shotCount, onEvent, signal });
  }
  return last || store.read(projectId);
}


/** 只给自检用：这条判断错了会以"厂商下不到图"的样子出现，极难查 */
export const __usableRef = usableRef;
export const __seamPlanOf = seamPlanOf;
export const __refreshRefs = refreshRefs;

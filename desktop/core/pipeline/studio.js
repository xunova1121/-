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
import * as consistency from './consistency.js';
import * as ffmpeg from '../ffmpeg.js';
import { safeFileName } from '../paths.js';
import * as chapters from './chapters.js';

export const extractJSON = consistency.extractJSON;

const SHOT_PROMPT = `你是动态漫画的分镜导演。把剧本拆成可直接投产的分镜表。

严格只输出 JSON，不要解释、不要代码块：

{
  "logline": "一句话梗概",
  "shots": [
    {
      "index": 1,
      "scene": "所属场景名（必须用设定集里已有的场景名）",
      "characters": ["出场角色名，必须用设定集里已有的名字，空镜给空数组"],
      "description": "这一镜画面里发生的事，只写画面，不写心理活动",
      "camera": "镜头语言：特写 / 中景 / 全景 / 俯拍 / 跟拍 / 推镜 等",
      "motion": "给图生视频的运镜与动态提示，一句话",
      "dialogue": "旁白或台词，没有留空字符串",
      "duration": 4
    }
  ]
}

要求：
- shots 数量 {{SHOT_COUNT}} 个左右；
- **不要**在 description 里重复角色外貌 —— 外貌由设定集统一注入，你重复写反而会冲突；
- characters 和 scene 必须严格用下面设定集里给出的名字，不要自创；
- duration 取 3~6 秒。

已冻结的设定集：
{{BIBLE}}`;

function routing() {
  return adapters.resolvedRouting();
}

/**
 * 本地文件 → 模型能吃到的引用。
 *
 * 优先 data URI：Windows 用户不用为了跑通图生图先去开一个 OSS 桶。
 * 火山方舟、OpenAI、多数中转网关都收 base64；百炼的部分接口只认公网 URL，
 * 那种情况下在设置里填一个上传网关即可。
 */
export async function toModelRef(localPath, { onEvent } = {}) {
  const gateway = settings.get('uploadGateway');
  if (gateway) return uploadVia(gateway, localPath, onEvent);

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
async function saveMedia({ url, base64 }, destPath, onEvent) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  let buf;
  const started = Date.now();
  if (base64 && !url) {
    buf = Buffer.from(base64, 'base64');
  } else {
    const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url}`);
    buf = Buffer.from(await res.arrayBuffer());
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
  return destPath;
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
function sheetPrompt(kind, bible, item) {
  const anchor = bible.style.anchor;
  const own = item.sheetPrompt || item.appearance || '';
  if (kind === 'char') return `${anchor}，角色设定图，正面半身，中性表情，纯色浅灰背景，无其他人物。${own}`;
  if (kind === 'scene') return `${anchor}，场景基准图，空镜无人物，广角。${own}`;
  return `${anchor}，道具参考图，单个物体居中，纯色背景，无人物，产品图视角。${own}`;
}

// ═══════════════════════ 阶段一：设定集（冻结人设）═══════════════════════

/**
 * 生成设定集并出角色设定图 / 场景基准图。
 * 这一步是整条流水线的地基，跑完之后人设就锁死了。
 */
export async function buildBible(projectId, { onEvent, regenerate = false } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!project.script?.trim()) throw new Error('剧本是空的，先写点东西');

  onEvent?.({ type: 'stage', stage: 'bible', status: 'running', message: '正在冻结人设与场景…' });

  const bible = project.bible && !regenerate ? project.bible : await consistency.buildBible(project, { onEvent });
  store.update(projectId, (p) => {
    p.bible = bible;
    return p;
  });

  // 出参考图：角色最重要排在最前，其次场景，最后道具
  const dir = store.assetDir(projectId);
  const r = routing();
  const targets = [
    ...bible.characters.map((c) => ({ kind: 'char', item: c })),
    ...bible.scenes.map((s) => ({ kind: 'scene', item: s })),
    ...(bible.props || []).map((p) => ({ kind: 'prop', item: p }))
  ].filter(({ item }) => regenerate || !item.sheetPath);

  onEvent?.({ type: 'note', message: `待出参考图 ${targets.length} 张` });

  for (const { kind, item } of targets) {
    try {
      onEvent?.({ type: 'sheet', name: item.name, kind, status: 'running', message: `生成${SHEET_LABEL[kind]}：${item.name}` });

      const image = await adapters.generateImage({
        providerId: r.image.provider,
        model: r.image.model,
        prompt: sheetPrompt(kind, bible, item),
        negative: bible.style.negative,
        seed: item.seed,
        label: `参考图·${item.name}`,
        onEvent
      });

      const dest = path.join(dir, `ref-${kind}-${safeFileName(item.name)}.png`);
      await saveMedia(image, dest, onEvent);
      const modelRef = await toModelRef(dest, { onEvent });

      store.update(projectId, (p) => {
        const target = bibleBucket(p.bible, kind).find((x) => x.name === item.name);
        if (target) {
          target.sheetPath = dest;
          target.sheetUrl = modelRef;
        }
        return p;
      });
      onEvent?.({ type: 'sheet', name: item.name, status: 'done' });
    } catch (err) {
      onEvent?.({ type: 'sheet', name: item.name, status: 'failed', message: err.message });
    }
  }

  const after = store.read(projectId);
  const all = [...after.bible.characters, ...after.bible.scenes, ...(after.bible.props || [])];
  const ready = all.filter((x) => x.sheetPath).length;
  const total = all.length;
  store.update(projectId, (p) => {
    p.stageStatus.bible = ready === total ? 'done' : ready ? 'partial' : 'pending';
    return p;
  });
  onEvent?.({ type: 'stage', stage: 'bible', status: 'done', message: `参考图 ${ready}/${total} 就绪` });
  return store.read(projectId);
}

// ═══════════════════════ 阶段二：分镜 ═══════════════════════

export async function analyzeScript(projectId, { shotCount = 8, chapterId = null, onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!project.bible) throw new Error('请先跑「设定集」—— 没有冻结人设，分镜会自己发挥外貌描述');

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
      props: project.bible.props.map((p) => p.name)
    },
    null,
    2
  );

  const { text } = await adapters.chat({
    providerId: r.chat.provider,
    model: r.chat.model,
    system: SHOT_PROMPT.replace('{{SHOT_COUNT}}', String(shotCount)).replace('{{BIBLE}}', bibleDigest),
    user: sourceScript,
    temperature: 0.7,
    jsonMode: true,
    label: chapter ? `拆分镜·${chapter.title}` : '拆分镜'
  });

  const parsed = extractJSON(text);
  const shots = (parsed.shots || []).map((s, i) => ({
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
    duration: Number(s.duration) || 4,
    imagePath: null,
    imageRef: null,
    videoPath: null,
    audioPath: null,
    seed: null,
    consistency: null,
    status: 'pending'
  }));

  store.update(projectId, (p) => {
    if (!p.logline) p.logline = parsed.logline || '';
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
    return p;
  });

  onEvent?.({
    type: 'stage',
    stage: 'script',
    status: 'done',
    message: chapter ? `${chapter.title} 拆出 ${shots.length} 镜` : `拆出 ${shots.length} 个分镜`
  });
  return store.read(projectId);
}

// ═══════════════════════ 章节 ═══════════════════════

/**
 * 把长剧本切成章节。设定集不受影响 —— 它挂在项目上，全片共享。
 * 已经拆过分镜的章节会尽量保留状态（按标题匹配），避免重切一次前功尽弃。
 */
export function splitChapters(projectId, { targetChars } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!project.script?.trim()) throw new Error('剧本是空的');

  const fresh = chapters.autoSplit(project.script, { targetChars });
  if (!fresh.length) throw new Error('没能切出章节');

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

export async function generateAssets(projectId, { only = null, chapterId = null, regenerate = false, onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!project.shots?.length) throw new Error('还没有分镜，先跑「分镜」');
  if (!project.bible) throw new Error('缺少设定集');

  const dir = store.assetDir(projectId);
  const maxRetries = settings.get('consistencyMaxRetries') ?? 2;
  const targets = project.shots
    .filter((s) => (chapterId ? s.chapterId === chapterId : true))
    // regenerate 是「整步重跑」：连已经出好的也重来，界面上会先要一次确认
    .filter((s) => (only ? only.includes(s.id) : regenerate || !s.imagePath));

  onEvent?.({ type: 'stage', stage: 'assets', status: 'running', message: `待出图 ${targets.length} 张` });

  for (const shot of targets) {
    try {
      const result = await consistency.generateConsistentImage({
        project,
        shot,
        bible: project.bible,
        maxRetries,
        onEvent
      });

      const dest = path.join(dir, `${shot.id}.png`);
      await saveMedia(result, dest, onEvent);
      const modelRef = await toModelRef(dest, { onEvent });

      store.update(projectId, (p) => {
        const t = p.shots.find((s) => s.id === shot.id);
        if (t) {
          t.imagePath = dest;
          t.imageRef = modelRef;
          t.seed = result.seed;
          t.prompt = result.prompt;
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

  onEvent?.({ type: 'shot', shotId, status: 'running', message: `第 ${shot.index} 镜重出（${providerId} / ${model}）…` });

  const image = await adapters.generateImage({
    providerId,
    model,
    prompt: opts.prompt?.trim() || assembled.prompt,
    negative: assembled.negative,
    seed,
    refImages: settings.get('useReferenceImages') === false ? [] : assembled.refImages,
    label: `重出 #${shot.index}`,
    onEvent
  });

  const dest = path.join(store.assetDir(projectId), `${shot.id}.png`);
  await saveMedia(image, dest, onEvent);
  const modelRef = await toModelRef(dest, { onEvent });

  // 复核这一镜，让分数跟着更新 —— 否则卡片上还挂着上一版的分数，会误导
  let verification = { skipped: true };
  const cast = consistency.matchCharacters(project.bible, shot);
  if (settings.get('consistencyVerify') !== false && cast.length && image.url) {
    verification = await consistency.verifyShot({
      shotImageUrl: image.url,
      character: cast[0],
      threshold: settings.get('consistencyThreshold') ?? 75,
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
      t.modelUsed = `${providerId} / ${model}`;
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
export async function regenerateShotVideo(projectId, shotId, opts = {}, onEvent) {
  const project = store.read(projectId);
  const shot = project?.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error(`没有这一镜：${shotId}`);
  if (!shot.imagePath) throw new Error('这一镜还没有图，先出图再出视频');

  const r = routing();
  const providerId = opts.provider || r.video.provider;
  const model = opts.model || r.video.model;

  onEvent?.({ type: 'shot', shotId, status: 'running', message: `第 ${shot.index} 镜重出视频（${providerId} / ${model}）…` });

  const firstFrame = shot.imageRef || (await toModelRef(shot.imagePath, { onEvent }));
  const cast = consistency.matchCharacters(project.bible, shot);
  const videoPrompt = opts.prompt?.trim() || consistency.assembleVideoPrompt(project.bible, shot);
  const video = await adapters.generateVideo({
    providerId,
    model,
    prompt: videoPrompt,
    firstFrameUrl: firstFrame,
    refImages: cast.map((c) => c.sheetUrl).filter(Boolean),
    duration: shot.duration,
    label: `重出视频 #${shot.index}`,
    onEvent: (ev) => onEvent?.({ ...ev, shotId })
  });

  const dest = path.join(store.assetDir(projectId), `${shot.id}.mp4`);
  await saveMedia(video, dest, onEvent);
  store.update(projectId, (p) => {
    const t = p.shots.find((s) => s.id === shotId);
    if (t) {
      t.videoPath = dest;
      t.videoPrompt = videoPrompt;
      t.videoModelUsed = `${providerId} / ${model}`;
      t.status = 'video-ready';
    }
    return p;
  });
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
  const project = store.read(projectId);
  if (!project?.bible) throw new Error('还没有设定集');

  const bucket = bibleBucket(project.bible, kind);
  const item = bucket.find((x) => x.name === name);
  if (!item) throw new Error(`设定集里没有「${name}」`);

  // 顺手改描述：先落盘再出图，这样即使出图失败，改的字也留住了
  if (opts.appearance !== undefined || opts.sheetPrompt !== undefined) {
    store.update(projectId, (p) => {
      const t = bibleBucket(p.bible, kind).find((x) => x.name === name);
      if (t) {
        if (opts.appearance !== undefined) t.appearance = opts.appearance;
        if (opts.sheetPrompt !== undefined) t.sheetPrompt = opts.sheetPrompt;
      }
      return p;
    });
  }

  const fresh = store.read(projectId);
  const target = bibleBucket(fresh.bible, kind).find((x) => x.name === name);
  const r = routing();
  const providerId = opts.provider || r.image.provider;
  const model = opts.model || r.image.model;
  const seed = Number.isFinite(opts.seed) ? opts.seed : target.seed + Math.floor(Math.random() * 9973) + 1;

  onEvent?.({ type: 'sheet', name, kind, status: 'running', message: `重出${SHEET_LABEL[kind]}：${name}` });

  const image = await adapters.generateImage({
    providerId,
    model,
    prompt: opts.prompt?.trim() || sheetPrompt(kind, fresh.bible, target),
    negative: fresh.bible.style.negative,
    seed,
    label: `重出参考图·${name}`,
    onEvent
  });

  const dest = path.join(store.assetDir(projectId), `ref-${kind}-${safeFileName(name)}.png`);
  await saveMedia(image, dest, onEvent);
  const modelRef = await toModelRef(dest, { onEvent });

  store.update(projectId, (p) => {
    const t = bibleBucket(p.bible, kind).find((x) => x.name === name);
    if (t) {
      t.sheetPath = dest;
      t.sheetUrl = modelRef;
      t.seed = seed;
    }
    return p;
  });

  onEvent?.({ type: 'sheet', name, kind, status: 'done' });
  return store.read(projectId);
}

/**
 * 往设定集里加一条（衍生品、后加的道具、中途出场的配角都走这里）。
 * 加完不自动出图 —— 让用户先把描述写好，再点重出，省一次无效开销。
 */
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

// ═══════════════════════ 阶段四：出视频 ═══════════════════════

export async function generateVideos(projectId, { only = null, chapterId = null, regenerate = false, onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);

  const r = routing();
  const dir = store.assetDir(projectId);
  const targets = project.shots
    .filter((s) => (chapterId ? s.chapterId === chapterId : true))
    .filter((s) => s.imagePath && (only ? only.includes(s.id) : regenerate || !s.videoPath));
  if (!targets.length) throw new Error('没有可出视频的分镜（需要先有镜头图）');

  onEvent?.({ type: 'stage', stage: 'video', status: 'running', message: `待出视频 ${targets.length} 段` });

  for (const shot of targets) {
    onEvent?.({ type: 'shot', shotId: shot.id, status: 'running', message: `第 ${shot.index} 镜出视频…` });
    try {
      const firstFrame = shot.imageRef || (await toModelRef(shot.imagePath, { onEvent }));
      // 角色设定图一并带上：支持 r2v 的厂商（Vidu）能靠它把人物锁得更死
      const cast = consistency.matchCharacters(project.bible, shot);
      const refs = cast.map((c) => c.sheetUrl).filter(Boolean);

      const videoPrompt = consistency.assembleVideoPrompt(project.bible, shot);
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'running', message: `提交任务：${videoPrompt.slice(0, 60)}…` });

      const video = await adapters.generateVideo({
        providerId: r.video.provider,
        model: r.video.model,
        prompt: videoPrompt,
        firstFrameUrl: firstFrame,
        refImages: refs,
        duration: shot.duration,
        label: `视频 #${shot.index}`,
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
          t.videoModelUsed = `${r.video.provider} / ${r.video.model}`;
          t.status = 'video-ready';
        }
        return p;
      });
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'done' });
    } catch (err) {
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

// ═══════════════════════ 阶段五：配音 ═══════════════════════

export async function generateVoice(projectId, { onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  const r = routing();
  const dir = store.assetDir(projectId);
  const targets = project.shots.filter((s) => s.dialogue?.trim() && !s.audioPath);
  if (!targets.length) {
    onEvent?.({ type: 'stage', stage: 'voice', status: 'done', message: '没有需要配音的台词' });
    return project;
  }

  onEvent?.({ type: 'stage', stage: 'voice', status: 'running', message: `待配音 ${targets.length} 条` });
  for (const shot of targets) {
    try {
      const speech = await adapters.synthesizeSpeech({
        providerId: r.tts.provider,
        model: r.tts.model,
        text: shot.dialogue,
        label: `配音 #${shot.index}`
      });
      const dest = path.join(dir, `${shot.id}.mp3`);
      if (speech.url) {
        await saveMedia(speech, dest, onEvent);
      } else if (speech.binaryRequest) {
        // OpenAI 系的 /audio/speech 直接回二进制流
        const { url, body } = speech.binaryRequest;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`配音失败 HTTP ${res.status}`);
        fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      }
      store.update(projectId, (p) => {
        const t = p.shots.find((s) => s.id === shot.id);
        if (t) t.audioPath = dest;
        return p;
      });
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'done', message: '配音完成' });
    } catch (err) {
      onEvent?.({ type: 'shot', shotId: shot.id, status: 'failed', message: err.message });
    }
  }
  store.update(projectId, (p) => {
    p.stageStatus.voice = 'done';
    return p;
  });
  return store.read(projectId);
}

// ═══════════════════════ 阶段六：合成 ═══════════════════════

export async function compose(projectId, { onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);

  const ordered = project.shots.slice().sort((a, b) => a.index - b.index);
  const segments = ordered.map((s) => s.videoPath).filter(Boolean);
  if (!segments.length) throw new Error('没有可合成的视频片段');

  const bin = ffmpeg.locate({ refresh: true });
  if (!bin.available) throw new Error(bin.hint);

  const out = path.join(store.projectDir(projectId), `${safeFileName(project.title)}.mp4`);
  onEvent?.({ type: 'stage', stage: 'compose', status: 'running', message: `合成 ${segments.length} 段…` });

  const voiceTracks = ordered.filter((s) => s.audioPath).map((s) => s.audioPath);
  await ffmpeg.concat(segments, out, {
    audioTracks: voiceTracks,
    onProgress: (p) => onEvent?.({ type: 'progress', seconds: p.seconds })
  });

  store.update(projectId, (p) => {
    p.outputs.video = out;
    p.stageStatus.compose = 'done';
    p.stageStatus.export = 'done';
    return p;
  });
  onEvent?.({ type: 'stage', stage: 'compose', status: 'done', message: out });
  return store.read(projectId);
}

/** 一键跑完全流程。任一阶段失败就停在那儿，已完成的部分都在盘上。 */
export async function runAll(projectId, { shotCount = 8, onEvent } = {}) {
  await buildBible(projectId, { onEvent });
  await analyzeScript(projectId, { shotCount, onEvent });
  await generateAssets(projectId, { onEvent });
  await generateVideos(projectId, { onEvent });
  await generateVoice(projectId, { onEvent });
  return compose(projectId, { onEvent });
}

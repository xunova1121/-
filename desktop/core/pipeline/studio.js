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

  // 出参考图：角色在前（更重要），场景在后
  const dir = store.assetDir(projectId);
  const r = routing();
  const targets = [
    ...bible.characters.map((c) => ({ kind: 'char', item: c })),
    ...bible.scenes.map((s) => ({ kind: 'scene', item: s }))
  ].filter(({ item }) => regenerate || !item.sheetPath);

  onEvent?.({ type: 'note', message: `待出参考图 ${targets.length} 张` });

  for (const { kind, item } of targets) {
    try {
      onEvent?.({ type: 'sheet', name: item.name, status: 'running', message: `生成${kind === 'char' ? '角色设定图' : '场景基准图'}：${item.name}` });
      const prompt =
        kind === 'char'
          ? `${bible.style.anchor}，角色设定图，正面半身，中性表情，纯色浅灰背景，无其他人物。${item.sheetPrompt}`
          : `${bible.style.anchor}，场景基准图，空镜无人物，广角。${item.sheetPrompt}`;

      const image = await adapters.generateImage({
        providerId: r.image.provider,
        model: r.image.model,
        prompt,
        negative: bible.style.negative,
        seed: item.seed,
        label: `参考图·${item.name}`,
        onEvent
      });

      const dest = path.join(dir, `ref-${kind}-${safeFileName(item.name)}.png`);
      await saveMedia(image, dest, onEvent);
      const modelRef = await toModelRef(dest, { onEvent });

      store.update(projectId, (p) => {
        const bucket = kind === 'char' ? p.bible.characters : p.bible.scenes;
        const target = bucket.find((x) => x.name === item.name);
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
  const ready = [...after.bible.characters, ...after.bible.scenes].filter((x) => x.sheetPath).length;
  const total = after.bible.characters.length + after.bible.scenes.length;
  store.update(projectId, (p) => {
    p.stageStatus.bible = ready === total ? 'done' : ready ? 'partial' : 'pending';
    return p;
  });
  onEvent?.({ type: 'stage', stage: 'bible', status: 'done', message: `参考图 ${ready}/${total} 就绪` });
  return store.read(projectId);
}

// ═══════════════════════ 阶段二：分镜 ═══════════════════════

export async function analyzeScript(projectId, { shotCount = 8, onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!project.bible) throw new Error('请先跑「设定集」—— 没有冻结人设，分镜会自己发挥外貌描述');

  const r = routing();
  onEvent?.({ type: 'stage', stage: 'script', status: 'running', message: `${r.chat.provider} / ${r.chat.model} 拆分镜中…` });

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
    user: project.script,
    temperature: 0.7,
    jsonMode: true,
    label: '拆分镜'
  });

  const parsed = extractJSON(text);
  const shots = (parsed.shots || []).map((s, i) => ({
    id: `shot-${String(i + 1).padStart(3, '0')}`,
    index: s.index ?? i + 1,
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
    p.logline = parsed.logline || '';
    p.shots = shots;
    p.stageStatus.script = 'done';
    return p;
  });

  onEvent?.({ type: 'stage', stage: 'script', status: 'done', message: `拆出 ${shots.length} 个分镜` });
  return store.read(projectId);
}

// ═══════════════════════ 阶段三：镜头出图（带一致性复核）═══════════════════════

export async function generateAssets(projectId, { only = null, onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);
  if (!project.shots?.length) throw new Error('还没有分镜，先跑「分镜」');
  if (!project.bible) throw new Error('缺少设定集');

  const dir = store.assetDir(projectId);
  const maxRetries = settings.get('consistencyMaxRetries') ?? 2;
  const targets = project.shots.filter((s) => (only ? only.includes(s.id) : !s.imagePath));

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

// ═══════════════════════ 阶段四：出视频 ═══════════════════════

export async function generateVideos(projectId, { only = null, onEvent } = {}) {
  const project = store.read(projectId);
  if (!project) throw new Error(`项目不存在：${projectId}`);

  const r = routing();
  const dir = store.assetDir(projectId);
  const targets = project.shots.filter((s) => s.imagePath && (only ? only.includes(s.id) : !s.videoPath));
  if (!targets.length) throw new Error('没有可出视频的分镜（需要先有镜头图）');

  onEvent?.({ type: 'stage', stage: 'video', status: 'running', message: `待出视频 ${targets.length} 段` });

  for (const shot of targets) {
    onEvent?.({ type: 'shot', shotId: shot.id, status: 'running', message: `第 ${shot.index} 镜出视频…` });
    try {
      const firstFrame = shot.imageRef || (await toModelRef(shot.imagePath, { onEvent }));
      // 角色设定图一并带上：支持 r2v 的厂商（Vidu）能靠它把人物锁得更死
      const cast = consistency.matchCharacters(project.bible, shot);
      const refs = cast.map((c) => c.sheetUrl).filter(Boolean);

      const video = await adapters.generateVideo({
        providerId: r.video.provider,
        model: r.video.model,
        prompt: `${shot.motion}。${shot.camera}`,
        firstFrameUrl: firstFrame,
        refImages: refs,
        duration: shot.duration,
        label: `视频 #${shot.index}`,
        onEvent
      });

      const dest = path.join(dir, `${shot.id}.mp4`);
      await saveMedia(video, dest, onEvent);
      store.update(projectId, (p) => {
        const t = p.shots.find((s) => s.id === shot.id);
        if (t) {
          t.videoPath = dest;
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

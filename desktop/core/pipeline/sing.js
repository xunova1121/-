/**
 * ══════════ 唱段：这一镜是唱出来的，不是说出来的 ══════════
 *
 * 用户问的是「那些模仿唱歌的剧情怎么生成」。原来的流水线把歌词当台词：
 * 配音是**念**出来的、提示词写的是"开口说"、配乐整片一条和镜头对不上。
 *
 * 唱段的做法是**以歌为准**：
 *
 *   ① 这一镜绑定歌里的一段（from → to 秒），镜头时长就是这一段的长度
 *   ② 出视频时把歌的这一段一起发给万相（input.audio_url），
 *      让画面里的人跟着这段歌声张嘴、换气 —— 唱的就是那首歌
 *   ③ 这一镜不配音（TTS 只会把歌词念一遍）
 *   ④ 合成时这一镜的声音直接用原歌的那一段；背景音乐在这一段里让开，
 *      不然两段音乐叠在一起
 *
 * 歌是用户自己提供的（自己唱的、买了授权的、自己的模型生成的）——
 * 我们不内置、也不去网上找任何歌，和背景音乐是同一个原则。
 *
 * 这个文件只放**纯函数**：不碰盘、不起进程，能被大量而便宜地断言。
 * 音画对不上这类错，在成片里只表现为"嘴和歌对不上"，那是最难自己发现的一类。
 */
import * as speaker from './speaker.js';

/**
 * 一段唱段最长 10 秒：万相一次最多出 10 秒。
 * 更长的一段歌要拆成几镜 —— 拆开反而更好，能换景别。
 */
export const MAX_SPAN = 10;
/** 太短的一段，模型连一个字的口型都做不完整 */
export const MIN_SPAN = 1;

const r2 = (n) => Number(Number(n).toFixed(2));

/**
 * 规整界面上传来的唱段设置。
 *
 * 回 { value, why }：
 *   value === null  → 这一镜不是唱段（关掉）
 *   value 是对象    → { from, to }
 *   why             → 不收的原因（界面要能说清楚"为什么我填的没存上"）
 */
export function normalizeSing(raw) {
  if (raw == null || raw === false) return { value: null };
  if (typeof raw !== 'object') return { value: null, why: '唱段的格式不对' };
  const from = Number(raw.from);
  const to = Number(raw.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { why: '起止秒数要填数字' };
  if (from < 0) return { why: '起点不能是负数' };
  const span = to - from;
  if (span < MIN_SPAN) return { why: `这一段太短（${r2(span)} 秒），至少 ${MIN_SPAN} 秒` };
  if (span > MAX_SPAN + 0.001) {
    return { why: `这一段有 ${r2(span)} 秒，一镜最多 ${MAX_SPAN} 秒（万相一次最多出 10 秒）—— 拆成两镜` };
  }
  return { value: { from: r2(from), to: r2(to) } };
}

/** 这一镜是不是唱段。存进去的值不可信（老数据、手改的 JSON），每次都过一遍规整 */
export function singOf(shot) {
  return normalizeSing(shot?.sing).value || null;
}

export function spanOf(sing) {
  return sing ? r2(sing.to - sing.from) : 0;
}

/**
 * 这一部片子唱段用哪首歌。
 *
 * 优先用专门传的那首（project.song）；没有就退回剪辑台上的背景音乐 ——
 * 很多"模仿唱歌"的片子，背景音乐本来就是要唱的那首。
 */
export function songOf(project) {
  if (project?.song?.path) return { ...project.song, source: 'song' };
  const m = project?.edit?.music;
  if (m?.path) return { path: m.path, name: m.name || '', seconds: m.seconds || null, source: 'music' };
  return null;
}

/**
 * 唱的是哪几个字。
 *
 * 去掉说话人前缀、括注（"（唱）"）、外层引号和 ♪ —— 这些不是要唱的词，
 * 写进提示词里模型会以为那也是歌词。
 */
export function lyricsOf(shot) {
  const said = speaker.spokenText(shot?.dialogue || '').text || '';
  return said
    .replace(/[♪♫]/g, '')
    .trim()
    .replace(/^[「“"『]+|[」”"』]+$/g, '')
    .trim();
}

/**
 * 发给视频模型的那段歌：从 from 开始，长度 = **实际出片的时长**，不是这一段的长度。
 *
 * 模型只出 5 秒或 10 秒。这一段 3.2 秒的话，片子出 5 秒，合成时裁到 3.2 秒 ——
 * 所以发过去的歌也得是 5 秒：片子第 0~3.2 秒对的是歌的 from~to，
 * 后面多出来的 1.8 秒对的是歌接下去的部分，反正会被裁掉。
 * 只发 3.2 秒的话，模型拿到的歌比片子短，后半段就不知道该怎么张嘴了。
 */
export function drivingSegment(sing, genSeconds) {
  return { seek: sing.from, length: Math.max(spanOf(sing), Number(genSeconds) || 0) };
}

/**
 * 切歌的 FFmpeg 参数。
 *
 * - `-ss` 在 `-i` **前面**：从那一秒开始读（放后面变成"输出从第几秒开始"）
 * - `-t` 在 `-i` **后面**、配 apad：输出**恰好**这么长。歌在这之前就完了的话补静音 ——
 *   短了的话模型拿到的音频比片子短，后面那几秒不知道怎么张嘴
 * - 单声道 128k mp3：发给模型的只是口型依据，小一点上传快
 */
export function cutArgs(songPath, { seek, length }, outPath) {
  return [
    '-y', '-ss', Number(seek).toFixed(3), '-i', songPath,
    '-vn', '-af', 'apad', '-t', Number(length).toFixed(3),
    '-ac', '1', '-ar', '44100', '-b:a', '128k', outPath
  ];
}

/**
 * 接着上一段唱：新标成唱段的镜头，起点默认接在**前面最近一个唱段**的终点上。
 *
 * 一首歌通常是连着拆成好几镜的，每一镜都去手算"上一镜唱到第几秒"很容易错 ——
 * 差 0.3 秒，嘴就和歌对不上。
 */
export function suggestSing(shots, shotId, { defaultSpan = 4 } = {}) {
  const list = (shots || []).slice().sort((a, b) => a.index - b.index);
  const at = list.findIndex((s) => s.id === shotId);
  if (at < 0) return null;
  let from = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const prev = singOf(list[i]);
    if (prev) { from = prev.to; break; }
  }
  const want = Number(list[at].duration) > 0 ? Number(list[at].duration) : defaultSpan;
  const span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, want));
  return { from: r2(from), to: r2(from + span) };
}

/**
 * 合成时唱段怎么摆。
 *
 * 每一段（同一镜被剪刀切成两段时两段都算）的声音 = 原歌从
 * `from + 入点` 开始、长 span 秒，摆在这一段在时间轴上的起点。
 * 同时记下这些时间窗 —— 背景音乐在这些窗口里要让开。
 *
 * ⚠ 和配音不一样，**每一段都要摆**，不只是第一段：
 * 配音只有一条，两段都摆会念两遍；而唱段两段唱的是歌的不同位置，
 * 第二段不摆的话那一段就是哑的。
 */
export function composeSing({ timeline = [], project = null, voiceOn = true } = {}) {
  const song = songOf(project);
  const rows = timeline.filter((r) => singOf(r.shot));
  if (!rows.length) return { entries: [], windows: [], ids: new Set(), missingSong: false };
  const ids = new Set(rows.map((r) => r.shot.id));
  /**
   * 歌没摆进去（没有歌、或者台词轨整条关了）时，背景音乐**不**让开 ——
   * 让开的话那几段就是一片死寂，比两段音乐叠着还糟。
   */
  if (!song || !voiceOn) return { entries: [], windows: [], ids, missingSong: !song };
  const windows = rows.filter((r) => !r.muted).map((r) => [r2(r.start), r2(r.start + r.span)]);
  const entries = rows
    .filter((r) => !r.muted)
    .map((r) => {
      const s = singOf(r.shot);
      return {
        id: r.shot.id,
        path: song.path,
        at: r.start,
        seek: r2(s.from + (Number(r.win?.in) || 0)),
        trimTo: r.span,
        index: r.shot.index,
        span: r.span,
        sing: true
      };
    });
  return { entries, windows, ids, missingSong: false };
}

/** 唱段走哪个模型。只有万相 2.5 起能"照着一段声音对口型"，所以固定走百炼 */
export function routeOf(settingsGet) {
  return { provider: 'dashscope', model: String(settingsGet('singModel') || 'wan2.6-i2v').trim() || 'wan2.6-i2v' };
}

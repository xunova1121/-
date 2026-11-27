/**
 * AI 整图出稿 + 逐字核对（2026-11-17 用户：别人做的确实比我们好看）。
 *
 * 宣传类、字不多的海报：画面和文字交给生图模型一次画出（图文天然一体），画完用文字识别把图里的字读回来，
 * 和要求的标题/要点逐条比对。对不上就带着“哪些字写错了”重画一次；仍对不上或没有识别能力，
 * 就如实标为待核对，建议改用程序排字（design），不把错字当成品交付。
 * 信息密集的（赛程、名单、数据表）不走这条路，见 POSTER_GUIDANCE。
 */
import * as ws from './workspace.js';
import { imageFormat } from './imageFormat.js';
import { readImageMetadata } from './imageMetadata.js';
import { imageData } from './imageRegion.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';
import { renderVisualScene } from './visualSceneRaster.js';
import { DESIGN_FONT } from './layeredDesignSvg.js';

export const AI_POSTER_LIMITS = { lines: 5, chars: 90, lineChars: 24, tries: 2 };
const aiError = (message, code = 'POSTER_AI_INPUT') => Object.assign(new Error(message), { code, kind: 'input' });
const field = (v, what, max) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if ([...s].length > max) throw aiError(`${what}超过${max}字；AI整图只适合字少的宣传海报，字多请改用design程序排字`);
  return s;
};

export function aiPosterTexts(raw = {}) {
  const title = field(raw.title, '标题', 16);
  if (!title) throw aiError('AI整图需要标题texts.title');
  const subtitle = field(raw.subtitle, '副标题', 24), footer = field(raw.footer, '底部信息', 30);
  const lines = (Array.isArray(raw.lines) ? raw.lines : []).map((l, i) => field(l, `第${i + 1}条要点`, AI_POSTER_LIMITS.lineChars)).filter(Boolean);
  if (lines.length > AI_POSTER_LIMITS.lines) throw aiError(`要点超过${AI_POSTER_LIMITS.lines}条；信息多的海报请改用design程序排字`);
  const all = [title, subtitle, ...lines, footer].filter(Boolean);
  if (all.join('').length > AI_POSTER_LIMITS.chars) throw aiError(`全部文字超过${AI_POSTER_LIMITS.chars}字；字多的海报请改用design程序排字，保证每个字准确`);
  return { title, subtitle, lines, footer, all };
}

export function aiPosterPrompt(description, texts, fixes = []) {
  const quote = s => `「${s}」`;
  return `${String(description || '').trim()}\n\n这是一张完整的中文海报，画面和文字一起设计，图文融为一体、主次分明、手机上也能看清。` +
    `画面里只出现下面这些文字，逐字照写（简体中文，不改字、不加字、不漏字、不写英文翻译、不加任何其它文字或水印）：\n` +
    `- 主标题（最醒目）：${quote(texts.title)}\n` + (texts.subtitle ? `- 副标题：${quote(texts.subtitle)}\n` : '') +
    texts.lines.map((l, i) => `- 要点${i + 1}：${quote(l)}\n`).join('') + (texts.footer ? `- 底部小字：${quote(texts.footer)}\n` : '') +
    '文字要清晰锐利，笔画完整，不要扭曲、变形或被画面遮挡。' + (fixes.length ? `\n上一次这些字没写对，这次务必逐字写准：${fixes.map(quote).join('、')}。` : '');
}

/** 比对时去掉空白和常见标点差异（全角半角、引号、间隔号），只比文字本身 */
export function normalizeText(text) {
  const compact = String(text).normalize('NFKC').toLowerCase().replace(/\s/g, '').replace(/−/g, '-');
  return compact.replace(/[「」『』“”"'‘’·•・,，。.、:：;；!！?？()（）【】\[\]<>《》\-—–_|/]/g, (mark, index) => {
    const nextDigit = /\d/.test(compact.charAt(index + 1));
    if (nextDigit && (mark === '-' || (/[.:/,]/.test(mark) && /\d/.test(compact.charAt(index - 1))))) return mark;
    return '';
  });
}
export function compareTexts(required, read) {
  const got = normalizeText(read);
  const missing = required.filter(s => {
    const want = normalizeText(s);
    for (let index = got.indexOf(want); index >= 0; index = got.indexOf(want, index + 1)) {
      if (/^\d/.test(want) && /[\d.+-]/.test(got.charAt(index - 1))) continue;
      if (/\d$/.test(want) && /[\d.]/.test(got.charAt(index + want.length))) continue;
      return false;
    }
    return true;
  });
  return { status: missing.length ? 'failed' : 'passed', missing };
}

/** 读回图里的字：优先专用文字识别，没有就让看图模型逐字抄录 */
async function readBack(ctx, blob, mime, signal) {
  if (ctx.ocr) return { text: (await ctx.ocr({ blob, mime }, { signal })).text, method: 'ocr' };
  if (ctx.visionLlm) {
    const image = await imageData(blob, { detail: 'high' });
    const answer = await withWebDeadline(activeSignal => ctx.visionLlm({
      system: '你是文字识别员。逐字抄录图片里出现的全部文字，保持原样（包括错字、繁体、乱码都照抄），不要纠正、不要补全、不要翻译。只输出抄录的文字，每块一行。',
      prompt: '请抄录这张海报里的全部文字。', images: [image], signal: activeSignal,
      allowWebSearch: false, maxWebSearches: 0, maxTransientRetries: 0, maxPartialRetries: 0
    }), { signal, timeoutMs: 30000 });
    return { text: String(answer || ''), method: 'vision' };
  }
  return null;
}

export async function deliverAiPoster(input, ctx, { signal, progress, beginPosterAttempt } = {}) {
  if (!ctx.imageGen) throw aiError('当前环境不能画图，请改用design程序排字', 'POSTER_AI_UNAVAILABLE');
  const spec = input.ai_full || {};
  const texts = aiPosterTexts(spec.texts);
  const size = /^\d{3,4}x\d{3,4}$/.test(spec.size || '') ? spec.size : '1024x1536';
  const path = ws.normalize(input.path || `海报/${texts.title}.png`).replace(/\.(svg|pptx)$/i, '.png');
  beginPosterAttempt?.();
  const tries = [];
  let fixes = [], kept = null;
  for (let n = 0; n < AI_POSTER_LIMITS.tries; n++) {
    throwControl(null, signal);
    progress?.(n ? '有字没写对，带着修正要求重画一次…' : '正在让画图模型整张出稿（画面和文字一起）…');
    const r = await ctx.imageGen({ prompt: aiPosterPrompt(spec.prompt || input.title || texts.title, texts, fixes), size, signal });
    const format = await imageFormat(r.blob);
    if (!format || !['png', 'jpg', 'webp'].includes(format.ext)) throw aiError('画图服务返回的不是图片', 'POSTER_AI_RENDER');
    progress?.('正在把图里的字读回来，逐条核对…');
    let check;
    try {
      const read = await readBack(ctx, r.blob, format.mime, signal);
      check = read ? { ...compareTexts(texts.all, read.text), method: read.method } : { status: 'not_checked', missing: [], method: 'none' };
    } catch (error) {
      throwControl(error, signal);
      check = { status: 'not_checked', missing: [], method: 'failed' };
    }
    tries.push({ status: check.status, missing: check.missing });
    kept = { blob: r.blob, format, check };
    if (check.status !== 'failed') break;
    fixes = check.missing;
  }
  // 交付统一存 PNG（成果索引和续改都按 PNG 认）；画图服务回的是 JPEG/WebP 时，用同一渲染器原尺寸转成 PNG
  let png = kept.blob;
  if (kept.format.ext !== 'png') {
    const info = await readImageMetadata(kept.blob, { signal });
    const bytes = new Uint8Array(await kept.blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}" viewBox="0 0 ${info.width} ${info.height}"><image x="0" y="0" width="${info.width}" height="${info.height}" href="data:${kept.format.mime};base64,${btoa(binary)}"/><g opacity="0"><text x="2" y="20" font-family="${DESIGN_FONT}" font-size="12" fill="#000000">字</text></g></svg>`;
    png = (await (ctx.renderVisualScene || renderVisualScene)(svg, { signal })).blob;
  }
  const saved = await ws.write(path.replace(/\.[^./]+$/, '.png'), png);
  const meta = await readImageMetadata(await ws.readBlob(saved.path), { signal });
  ctx.onFileChanged?.(saved.path);
  const passed = kept.check.status === 'passed';
  if (passed) ctx.onImage?.(URL.createObjectURL(png), saved.path);
  // 图文并茂复核：整图本身就是配图，再看一眼画面是否切题、字是否清楚（有看图模型才做，没有就如实未检查）
  let contentCheck = { status: 'passed', semantic: 'not_checked', basis: '画图模型整图出稿，画面本身即主题配图' };
  if (passed && ctx.visionLlm) {
    try {
      const image = await imageData(png, { detail: 'low' });
      const answer = await withWebDeadline(activeSignal => ctx.visionLlm({
        system: '你是海报审核员。只返回JSON：{"relatedToTopic":true/false,"readable":true/false,"issues":["…"]}。relatedToTopic=画面内容与海报主题明显相关；readable=主要文字在手机上看得清、没有被画面遮挡。',
        prompt: `海报主题：${texts.title}${texts.subtitle ? '，' + texts.subtitle : ''}`, images: [image], signal: activeSignal,
        allowWebSearch: false, maxWebSearches: 0, maxTransientRetries: 0, maxPartialRetries: 0
      }), { signal, timeoutMs: 25000 });
      const v = JSON.parse(String(answer).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      if (typeof v.relatedToTopic === 'boolean' && typeof v.readable === 'boolean')
        contentCheck = { status: 'passed', semantic: v.relatedToTopic && v.readable ? 'passed' : 'failed', basis: '一次实际成品看图：画面是否切题、文字是否清楚', ...(Array.isArray(v.issues) && { issues: v.issues.filter(t => typeof t === 'string').slice(0, 4) }) };
    } catch (error) { throwControl(error, signal); }
  }
  const errors = passed ? [] : [{ code: kept.check.status === 'failed' ? 'POSTER_AI_TEXT_MISMATCH' : 'POSTER_AI_TEXT_UNVERIFIED', phase: 'text',
    message: kept.check.status === 'failed' ? `重画后仍有字没写对：${kept.check.missing.join('、')}` : '没有可用的文字识别，无法确认图里的字是否准确' }];
  return JSON.stringify({
    kind: 'poster', renderer: 'ai_full', status: passed ? 'complete' : 'partial', title: texts.title, width: meta.width, height: meta.height,
    files: [{ format: 'png', path: saved.path, readback: 'passed', structure: 'passed', render: 'passed' }],
    textRendering: 'model', contentCheck, textCheck: { status: kept.check.status, method: kept.check.method, required: texts.all.length, missing: kept.check.missing, tries },
    visual: 'not_checked', errors,
    notes: ['画面和文字由画图模型一次出稿，图文一体；文字已用识别读回逐条比对', passed ? '要求的标题和要点在图中逐字找到' : '文字未通过核对：改用design程序排字（标题与要点照原文），可参考这张的构图和配色',
      '只核对了要求的文字是否出现，没有核对画面里是否多出别的字；不是可编辑文件，改字需要重画或改用design'],
    ...(!passed && { guidance: '不要把这张当成品；用make_poster的design按原文程序排字重做，构图可参考这张。' })
  });
}

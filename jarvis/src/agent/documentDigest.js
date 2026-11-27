/**
 * 通读全文（2026-11-17 用户：大文件模型读不完整）。
 *
 * 以前模型一次只读 2 万字，要一页页翻，一轮对话的步数有限，往往读了开头就回答。
 * 这里由程序把全文按章节切成约 1.2 万字的段，交给辅助模型逐段写笔记（要点、原文数字、条款编号），
 * 再汇总成一份“通读笔记”存进工作区（带每段对应的章节和原文位置）。主模型基于笔记回答，需要原文再按章节去读。
 * 回执如实写“已读 x/n 段”，哪段失败就说哪段，不冒充读完。同一文件同一关注点再次通读直接复用笔记。
 */
import * as ws from './workspace.js';
import { indexDocumentSections } from './documentSections.js';
import { diagramDigest } from './diagramExport.js';
import { throwControl } from '../core/networkRequest.js';

export const DIGEST_LIMITS = { segment: 12000, segments: 120, chars: 1e6, concurrency: 3 };
const digestError = (message, code = 'DIGEST_INPUT') => Object.assign(new Error(message), { code, kind: 'input' });

/** 按章节边界切段：每段不超过 size 字，尽量在章节开头处切；单个章节过长就在换行处切 */
export function splitForDigest(text, sections = [], size = DIGEST_LIMITS.segment) {
  const cuts = [...new Set(sections.map(s => s.start).filter(n => n > 0 && n < text.length))].sort((x, y) => x - y);
  const segments = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= size) { segments.push({ start, end: text.length }); break; }
    const limit = start + size, boundary = cuts.filter(c => c > start + size * 0.3 && c <= limit).at(-1);
    let end = boundary;
    if (!end) { const nl = text.lastIndexOf('\n', limit); end = nl > start + size * 0.5 ? nl + 1 : limit; }
    segments.push({ start, end });
    start = end;
  }
  const titleAt = pos => [...sections].reverse().find(s => s.start <= pos)?.title || '';
  return segments.map((s, i) => ({ ...s, index: i + 1, title: titleAt(s.start) }));
}

async function pool(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await work(items[i], i); }
  }));
  return out;
}

/**
 * readText(path) → { text, hash }；llm({system,prompt,signal}) → 文字。
 * 返回 { notesPath, segments, done, failed, reused, preview }
 */
export async function digestDocument({ path, focus = '', llm, readText, signal, onProgress }) {
  if (!llm) throw digestError('当前没有可用的辅助模型，不能通读全文；请改用 read_file 按章节阅读', 'DIGEST_UNAVAILABLE');
  const { text, hash } = await readText(path);
  if (!text.trim()) throw digestError('没有读到正文（可能是扫描件），请先识别文字');
  if (text.length > DIGEST_LIMITS.chars) throw digestError('正文超过100万字，请先拆分原件');
  const focusText = String(focus || '').trim().slice(0, 200);
  const key = (await diagramDigest(new Blob([hash, '\n', focusText]))).slice(0, 16);
  const notesPath = ws.normalize(path).replace(/\.[^./]+$/, '') + '.通读笔记.md';
  // 同一文件、同一关注点已经通读过：直接复用
  if (await ws.exists(notesPath).catch(() => false)) {
    const old = await ws.readText(notesPath).catch(() => '');
    const m = /<!-- digest:([^ ]+) segments:(\d+) done:(\d+) -->/.exec(old);
    if (m && m[1] === key && m[2] === m[3]) return { notesPath, segments: +m[2], done: +m[3], failed: [], reused: true, preview: old.slice(0, 6000) };
  }
  let sections = [];
  try { sections = await indexDocumentSections({ text }); } catch { sections = []; }
  const segments = splitForDigest(text, sections);
  if (segments.length > DIGEST_LIMITS.segments) throw digestError('文档过长（超过120段），请先拆分原件');
  let finished = 0;
  const notes = await pool(segments, DIGEST_LIMITS.concurrency, async seg => {
    throwControl(null, signal);
    try {
      const answer = await llm({
        system: '你是认真的资料员，正在为同事逐段通读一份长文档并做笔记。只根据给你的这一段原文写，不补充原文没有的内容，不评价。' +
          '用要点列出：这一段讲了什么；所有关键数字、金额、日期、期限、比例、数量（照抄原文）；条款/章节编号；要求、限制、例外、责任与罚则。' + (focusText ? `特别留意与“${focusText}”有关的内容，原文照录。` : '') +
          '没有实质内容就写“本段无实质内容”。不超过500字。',
        prompt: `文档：${path}\n第${seg.index}/${segments.length}段${seg.title ? `（所在章节：${seg.title}）` : ''}，原文第${seg.start}到${seg.end}字：\n\n${text.slice(seg.start, seg.end)}`,
        signal
      });
      finished++;
      onProgress?.(`正在通读：${finished}/${segments.length} 段`);
      return { ok: true, text: String(answer || '').trim().slice(0, 2000) };
    } catch (error) {
      throwControl(error, signal);
      finished++;
      return { ok: false, error: String(error?.message || '失败').slice(0, 120) };
    }
  });
  const failed = segments.filter((_, i) => !notes[i].ok).map(s => s.index);
  const done = segments.length - failed.length;
  const body = segments.map((s, i) => `## 第${s.index}段${s.title ? ` · ${s.title}` : ''}（原文第${s.start}–${s.end}字）\n\n${notes[i].ok ? notes[i].text : `【这一段没读成：${notes[i].error}。需要时用 read_file 读原文 offset=${s.start}】`}`).join('\n\n');
  const header = `<!-- digest:${key} segments:${segments.length} done:${done} -->\n# 通读笔记：${path.split('/').pop()}\n\n共${text.length}字，分${segments.length}段，已读${done}段${failed.length ? `，第${failed.join('、')}段失败` : ''}。${focusText ? `关注点：${focusText}。` : ''}笔记由辅助模型逐段整理，数字以原文为准；引用前可按段后标注的位置读原文核对。\n\n`;
  const saved = await ws.write(notesPath, header + body);
  return { notesPath: saved.path, segments: segments.length, done, failed, reused: false, preview: (header + body).slice(0, 6000) };
}

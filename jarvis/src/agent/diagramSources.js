import { throwControl } from '../core/networkRequest.js';
import * as workspace from './workspace.js';
import { parseFile } from './docs.js';

export async function checkSources(sources, signal) {
  if (!Array.isArray(sources) || sources.length > 4) throw Object.assign(new Error('材料最多4个'), { code: 'DIAGRAM_SOURCE_SIZE', kind: 'input' });
  const checks = [];
  const materials = [];
  for (const source of sources) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let blob;
    try { blob = await workspace.readBlob(source.path); } catch (error) {
      throwControl(error, signal);
      if (error.kind === 'network' || error.kind === 'timeout') throw error;
      throw Object.assign(new Error('图形来源读取失败：' + String(source.path).slice(0,400)), {code:'DIAGRAM_SOURCE_READ',kind:'input',cause:error,diagnostics:[{stage:'material',field:'sources.path',action:'定位并读取明确来源文件；若为旧格式，使用用户指定的可读版本，不借旧稿代替'}]});
    }
    if (blob.size > 10e6) throw Object.assign(new Error('来源文件超过10MB，请先分段提取相关材料'), { code: 'DIAGRAM_SOURCE_SIZE', kind: 'input' });
    if (source.sectionEnd !== undefined && source.sectionStart === undefined)
      throw Object.assign(new Error('章节终点必须同时给出唯一起点'), { code: 'ARCHITECTURE_SOURCE_SCOPE', kind: 'input' });
    const scoped = source.sectionStart !== undefined;
    const parsed = await parseFile(blob, source.path, { limit: scoped ? Infinity : 120000 });
    let text = parsed.text;
    if (scoped) {
      const invalid = (message) => Object.assign(new Error(message), { code: 'ARCHITECTURE_SOURCE_SCOPE', kind: 'input' });
      if (parsed.chars > 1000000) throw invalid('材料超过100万字，请使用原始分卷而非无界读取');
      const start = source.sectionStart,
        end = source.sectionEnd;
      if (
        typeof start !== 'string' ||
        !start.trim() ||
        start.length > 300 ||
        (end !== undefined && (typeof end !== 'string' || !end.trim() || end.length > 300))
      )
        throw invalid('章节边界需为1～300字的原文锚点');
      const first = text.indexOf(start);
      if (first < 0 || text.indexOf(start, first + start.length) >= 0) throw invalid('章节起点不存在或重复，请用正文标题和首句唯一定位，不能把目录当正文');
      let last = text.length;
      if (end !== undefined) {
        last = text.indexOf(end, first + start.length);
        if (last < 0 || text.indexOf(end, last + end.length) >= 0) throw invalid('章节终点不存在或重复，请使用唯一正文边界');
      }
      text = text.slice(first, last);
      if (text.length > 120000) throw invalid('选定章节超过12万字，请明确拆为有原文边界的章节范围');
    }
    const excerpt = String(source.excerpt || '').trim();
    const matched = Boolean(excerpt && text.replace(/\s+/g, '').includes(excerpt.replace(/\s+/g, '')));
    materials.push({ path: source.path, text });
    checks.push({
      path: source.path,
      matched,
      truncated: !scoped && parsed.chars > 120000,
      ...(scoped && { scope: 'section', sectionStart: source.sectionStart, sectionEnd: source.sectionEnd })
    });
  }
  return { checks, materials };
}

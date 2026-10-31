import { orderedSlidePaths } from './officePackage.js';

const attribute = (xml, key) => xml.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
const count = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}\\b`, 'g'))].length;
const boxOf = xml => {
  const off = xml.match(/<a:off\b[^>]*>/)?.[0], ext = xml.match(/<a:ext\b[^>]*>/)?.[0];
  if (!off || !ext) return null;
  const box = ['x', 'y'].map(key => Number(attribute(off, key))).concat(['cx', 'cy'].map(key => Number(attribute(ext, key))));
  return box.every(Number.isFinite) && box[2] > 0 && box[3] > 0 ? box : null;
};
/** 有界网格估算内容包围框覆盖率，不把背景色和装饰矩形算成正文；不是视觉美观评分。 */
function blankRatio(boxes, width, height) {
  if (!(width > 0 && height > 0)) return null;
  let occupied = 0;
  for (let x = 0; x < 40; x++) for (let y = 0; y < 24; y++) {
    const px = (x + 0.5) * width / 40, py = (y + 0.5) * height / 24;
    if (boxes.some(([bx, by, bw, bh]) => px >= bx && px <= bx + bw && py >= by && py <= by + bh)) occupied++;
  }
  return Number((1 - occupied / 960).toFixed(3));
}
function mediaPath(slidePath, target) {
  const parts = target.startsWith('/') ? [] : slidePath.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  const resolved = parts.join('/');
  return /^ppt\/media\/[^/]+$/.test(resolved) ? resolved : null;
}
export const requiresEverySlideImage = request => !/(?:每(?:一)?[页张]|所有页|全部页).{0,5}(?:不要|不用|无需).{0,4}(?:图|配图)/.test(String(request)) && /(?:每(?:一)?[页张]|所有页|全部页|逐页).{0,12}(?:配图|有图|要图|图片|加图|补图)|(?:图片|配图).{0,8}(?:每(?:一)?[页张]|所有页)/.test(String(request));

/** 仅从真正嵌入且被页面引用的媒体计数；孤立rels、图标、外链、缺文件不能冒充内容配图。 */
export async function inspectPresentation(zip, { signal } = {}) {
  const paths = await orderedSlidePaths(zip);
  if (paths.length > 300) throw new Error('PPT逐页检查最多300页');
  const presentation = await zip.file('ppt/presentation.xml').async('string');
  const size = presentation.match(/<p:sldSz\b[^>]*>/)?.[0] || '';
  const width = Number(attribute(size, 'cx')), height = Number(attribute(size, 'cy'));
  const pages = [];
  for (const [index, path] of paths.entries()) {
    signal?.throwIfAborted();
    const xml = await zip.file(path).async('string');
    const relPath = path.replace(/\/([^/]+)$/, '/_rels/$1.rels');
    const rels = await zip.file(relPath)?.async('string') || '';
    const images = new Map();
    for (const [rel] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (attribute(rel, 'TargetMode') === 'External' || !/\/image$/.test(attribute(rel, 'Type') || '')) continue;
      const target = mediaPath(path, attribute(rel, 'Target') || '');
      if (target && zip.file(target)) images.set(attribute(rel, 'Id'), target);
    }
    let pictures = 0, contentImages = 0, icons = 0, decorations = 0;
    const boxes = [];
    for (const [pic] of xml.matchAll(/<p:pic\b[^>]*>[\s\S]*?<\/p:pic>/g)) {
      const id = pic.match(/<a:blip\b[^>]*\br:embed="([^"]+)"/)?.[1];
      if (!images.has(id)) continue;
      pictures++;
      const box = boxOf(pic), role = pic.match(/\bname="(wy-[^"]+)"/)?.[1] || '';
      if (role.startsWith('wy-icon')) icons++;
      else if (role.startsWith('wy-decoration')) decorations++;
      else if (role.startsWith('wy-content') || box && box[2] * box[3] >= width * height * 0.015) contentImages++;
      if (box && !role.startsWith('wy-decoration')) boxes.push(box);
    }
    const shapes = [...xml.matchAll(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)].map(match => match[0]);
    const texts = shapes.filter(shape => /<a:t\b[^>]*>[^<]+<\/a:t>/.test(shape));
    for (const shape of texts) { const box = boxOf(shape); if (box) boxes.push(box); }
    for (const [frame] of xml.matchAll(/<p:graphicFrame\b[^>]*>[\s\S]*?<\/p:graphicFrame>/g)) {
      const box = boxOf(frame); if (box) boxes.push(box);
    }
    const bodyShapes = texts.filter(shape => { const box=boxOf(shape);return box && box[1]>=height*0.19 && box[1]+box[3]<=height*0.90; });
    const sizes = value => [...value.matchAll(/<(?:a:rPr|a:defRPr)\b[^>]*\bsz="(\d+)"/g)].map(match=>Number(match[1])/100).filter(n=>n>0);
    const bodyFonts = bodyShapes.flatMap(sizes);
    const tableFonts = [...xml.matchAll(/<a:tbl\b[^>]*>[\s\S]*?<\/a:tbl>/g)].flatMap(match=>sizes(match[0]));
    const outside = boxes.some(([x,y,w,h])=>x < -9144 || y < -9144 || x+w > width+9144 || y+h > height+9144);
    const minBodyFont = bodyFonts.length ? Math.min(...bodyFonts) : null;
    const minTableFont = tableFonts.length ? Math.min(...tableFonts) : null;
    pages.push({ minBodyFont, minTableFont, outside, page: index + 1, pictures, contentImages, icons, decorations, tables: count(xml, 'a:tbl'), textBoxes: texts.length, estimatedBlankRatio: blankRatio(boxes, width, height) });
  }
  return { pages, imagePages: pages.filter(page => page.contentImages > 0).length, missingImagePages: pages.filter(page => !page.contentImages).map(page => page.page), scope: '真实页面引用的嵌入图片；图标/装饰单列；空白为包围框估算，不是视觉验收' };
}

export function presentationAnswerIssues(request, answer, artifact) {
  if (artifact?.format !== 'pptx') return [];
  const receipt = artifact.presentation;
  const claims = [...String(answer).matchAll(/(\d+)\s*页(?:均|全部|都)?(?:已|已经)?(?:配图|有图|补图|添加(?:了)?图片|配(?:上|好)(?:了)?图)/g)];
  const all = /(?:每(?:一)?页|全部页|所有页).{0,5}(?:均|都|已|已经).{0,5}(?:配图|有图|图片|补图)/.test(String(answer));
  if (!claims.length && !all) return [];
  if (!receipt || artifact.stale) return ['尚无当前PPT逐页配图回执，不能声称已配齐；请核对真实文件'];
  if (claims.some(match => Number(match[1]) !== receipt.imagePages) || all && receipt.missingImagePages.length) {
    return [`实际仅${receipt.imagePages}页有内容配图；缺图页：${receipt.missingImagePages.join('、') || '无'}。按真实回执重写，不以图标或文件大小声称配齐`];
  }
  return [];
}

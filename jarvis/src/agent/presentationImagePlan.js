import * as ws from './workspace.js';
import { parseSlides } from './pptxWriter.js';
import { slideBudget } from './documentPageBudget.js';
import { requiresEverySlideImage } from './presentationReceipt.js';
import { imageInfo } from './imageInfo.js';
import { throwControl } from '../core/networkRequest.js';
const MAX_IMAGES = 24;
/** 独立有界两路队列；停止向上传播，普通单页失败不抹掉已取得图片。 */
export async function imagePool(items, run, signal) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(2, items.length)}, async () => {
    while (cursor < items.length) {
      signal?.throwIfAborted();
      const index = cursor++;
      try { results[index] = { value: await run(items[index], index) }; }
      catch (error) { throwControl(error, signal); results[index] = { error: String(error.message || error).slice(0, 180) }; }
    }
  }));
  return results;
}
const fingerprint = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2,'0')).join('');
/** 只在明确要求配图时发请求；上传图片由正文显式引用，不擅自挑用户其他文件。 */
export async function preparePresentationImages(ctx, content, options, execution = {}) {
  const { title, requirements = '', style = 'business', expectedSlides, requireCover, forbidCover } = options;
  const { signal, retrieval, progress } = execution;
  const every = requiresEverySlideImage(requirements);
  if (!every && !/(?:补|加|配|生成).{0,6}(?:图片|配图)|带图/.test(requirements)) return {content, issues:[], plan:[]};
  let sections = String(content).split(/(?=^#{1,2}\s)/m).filter(section=>section.trim());
  const parsed = parseSlides(title, content);
  const bodyCount = parsed.length - (parsed[0] && !parsed[0].blocks.length ? 1 : 0);
  const budget = slideBudget(bodyCount, expectedSlides, requireCover, forbidCover);
  if (!budget.cover && /^#\s+[^\n]+\s*$/.test(sections[0] || '')) sections.shift();
  if (every && budget.cover && !/^#\s/.test(sections[0] || '')) sections.unshift(`# ${title}\n\n`);
  const plan = sections.map((section,index) => {
    const heading = section.match(/^#{1,2}\s+([^\n]+)/)?.[1] || title;
    const isCover = index === 0 && budget.cover && /^#\s/.test(section);
    const slot = isCover ? 'cover' : /\|.*\|/.test(section) ? 'side' : 'half';
    return {index, title:heading, slot, size:slot === 'cover' ? '1536x864' : slot === 'side' ? '768x1536' : '1024x1280', existing:/!\[[^\]]*\]\([^)]+\)/.test(section), text:section.replace(/^#{1,2}[^\n]*\n/,'').slice(0,500)};
  });
  const pending = plan.filter(page=>!page.existing && (every || page.slot === 'cover' || !/\|.*\|/.test(page.text)));
  const issues = [];
  const selected = pending.slice(0,MAX_IMAGES);
  if (pending.length > MAX_IMAGES) issues.push({level:'error',text:`本次配图最多${MAX_IMAGES}张，其余页未生成；请分批，不声称全配齐`});
  const results = await imagePool(selected, async page => {
    signal?.throwIfAborted();
    const imagePrompt = `为同一套${style}风格PPT制作配图，保持统一配色和视觉语言。主题：${page.title}。内容线索：${page.text}。位置${page.slot}，比例${page.size}。只画通用场景或概念插画，不画文字、数字或假新闻现场，不改变原文事实。`;
    const ownOnly = /只(?:用|使用).{0,8}(?:上传|原图|自有|提供)/.test(requirements);
    const noAI = ownOnly || /不要AI|不用AI|禁止AI|只(?:用|使用).{0,6}图库/i.test(requirements);
    const sourcePolicy = ownOnly ? 'own' : noAI ? 'stock' : /只(?:用|使用).{0,6}AI/i.test(requirements) ? 'ai' : 'auto';
    const key = await fingerprint(imagePrompt + '\n来源策略：' + sourcePolicy);
    const imagePath = `images/ppt/${key}.png`;
    if (await ws.exists(imagePath)) {
      const cached = await ws.readBlob(imagePath);
      if (cached.size <= 8e6 && imageInfo(new Uint8Array(await cached.arrayBuffer()))) return {path:imagePath,source:'cache'};
    }
    if (ownOnly) throw new Error('本页没有引用用户指定图片，请补齐原图路径');
    // 已接入且通过国内探测的图库可在这里提供真实工作区图片；未配置时不伪造来源。
    if (ctx.stockImageForSlide && !/只(?:用|使用).{0,6}AI/i.test(requirements)) {
      try {
        const stock = await ctx.stockImageForSlide({query:page.title,slot:page.slot,signal,retrieval});
        if (stock?.path) return {path:stock.path,source:'stock',credit:stock.credit};
      } catch(error) { throwControl(error,signal); }
    }
    if (noAI) throw new Error('未取得符合指定来源的图片，未用AI替代');
    if (!ctx.imageGen) throw new Error('画图能力未配置，保留本页内容；配图未完成');
    progress?.(`生成配图：${page.title}（最多2路并发）`);
    const result = await ctx.imageGen({prompt:imagePrompt,size:page.size,outputFormat:'png',signal,beforeRequest:()=>retrieval?.consume('model')});
    signal?.throwIfAborted();
    if (!result.blob || result.blob.size > 8e6) throw new Error('配图为空或超过8MB');
    const info = imageInfo(new Uint8Array(await result.blob.arrayBuffer()));
    if (info?.type !== 'png') throw new Error('画图未返回PNG，不伪造扩展名');
    const saved = await ws.write(imagePath,result.blob);
    ctx.onFileChanged?.(saved.path);
    return {path:saved.path,source:'generated'};
  },signal);
  for (const [index,result] of results.entries()) {
    const page=selected[index];
    if (result.error) { issues.push({level:'error',text:`第${page.index+1}段「${page.title}」配图失败：${result.error}`}); continue; }
    Object.assign(page,result.value);
    sections[page.index] += `\n\n![${page.title.replace(/[\]\n]/g,'')}配图](${result.value.path})\n\n`;
    if(result.value.credit) sections[page.index] += `备注：图片来源 ${String(result.value.credit).slice(0,2000)}\n\n`;
  }
  return {content:sections.join('\n'),issues,plan:plan.map(({text,...page})=>page)};
}

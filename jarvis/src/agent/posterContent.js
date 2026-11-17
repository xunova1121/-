/** 排版通过不等于图文并茂；这里只提供结构证据，主题关联须看实际成品。 */
export const wantsIllustratedPoster = text => {
  // 承接短追问时会附加工具提示；其中的“图文海报”不是用户新增的验收要求。
  const request = String(text).split('\n【本轮承接最近的图文海报，')[0].slice(-12000);
  return /图文并茂|图文融合|图文结合|图文海报|配图海报|海报.{0,12}(?:配图|图表)|illustrated poster/i.test(request);
};

export function posterContent(design) {
  const area = design.width * design.height;
  const visuals = design.layers.filter((node, index, layers) => {
    if (node.decorative || !['image', 'chart'].includes(node.type) || node.w * node.h < area * 0.025 || Math.min(node.w, node.h) < Math.min(design.width, design.height) * 0.1) return false;
    if (node.type === 'chart' && (!node.points?.length || !node.points.every(p => p.label.trim() && Number.isFinite(p.value)))) return false;
    // 被后置实色面板/图片完全盖住的素材不能充数。部分遮挡仍交实际PNG复核。
    return !layers.slice(index + 1).some(n => ['shape', 'image'].includes(n.type) && n.x <= node.x && n.y <= node.y && n.x + n.w >= node.x + node.w && n.y + n.h >= node.y + node.h);
  });
  return { status: visuals.length ? 'passed' : 'failed', basis: '结构检查；图标、数字卡片及装饰不算主题配图或数据图表',
    visuals: visuals.map(n => ({ id: n.id, type: n.type, ...(n.type === 'chart' && { chartType: n.chartType || 'line', points: n.points.length }) })),
    semantic: 'not_checked' };
}

/** 明确失败的竖版模式：大头图与至少四个同宽文字卡片脱节；不评价独立大屏或主题相关性。 */
export function posterCompositionIssues(design) {
  if (design.width > design.height) return [];
  const cards = design.layers.filter(n => n.type === 'shape' && /section-\d+-card$/.test(n.id));
  const images = design.layers.filter(n => n.type === 'image' && !n.decorative);
  if (cards.length < 4 || images.length !== 1 || design.layers.some(n => n.type === 'chart')) return [];
  const hero = images[0], firstY = Math.min(...cards.map(n => n.y));
  const sameColumn = cards.every(n => Math.abs(n.x - cards[0].x) < design.width * 0.02 && Math.abs(n.w - cards[0].w) < design.width * 0.05);
  const linked = cards.some(n => n.group === hero.group);
  return sameColumn && !linked && hero.h >= design.height * 0.25 && hero.y + hero.h <= firstY + 4 && firstY >= design.height * 0.34
    ? [{ code: 'DESIGN_DETACHED_ILLUSTRATION', field: hero.id, message: '主图独占上方，下方连续同宽文字卡片；请按栏目关联配图并重排，不能仅凭有图认定图文融合。' }] : [];
}

/**
 * 先想后做（2026-11-17 用户反馈的美国新闻海报：没写构思直接套“上图下面板”；三大指数涨跌这种数据没用图表）。
 *   - requireConcept：新自由稿必须写 design.concept（创意和图文关系）；
 *   - 正文里有3个以上百分比（涨跌幅、占比等）却没有图表图层：要求用 chart 图层由程序画，不只堆数字。
 */
export function designThinkingIssues(design, { requireConcept = false } = {}) {
  const issues = [];
  if (requireConcept && !(design.concept?.idea && design.concept?.relation))
    issues.push({ code: 'DESIGN_CONCEPT_MISSING', field: 'design.concept', message: '先写构思再排图层：design.concept至少给idea（一句话创意）和relation（按内容选的图文关系），不要直接套上图下面板' });
  const text = design.layers.filter(n => n.type === 'text').map(n => n.text).join('\n');
  const percents = text.match(/[+-]?\d+(?:\.\d+)?\s*[%％]/g) || [];
  if (percents.length >= 3 && !design.layers.some(n => n.type === 'chart'))
    issues.push({ code: 'DESIGN_DATA_NEEDS_CHART', field: 'layers', message: `正文有${percents.length}个百分比数据，请至少用一个chart图层（分类对比用chartType=bar并写unit）由程序画出来，数字照原文，不只堆在文字里` });
  return issues;
}

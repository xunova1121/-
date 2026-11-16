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

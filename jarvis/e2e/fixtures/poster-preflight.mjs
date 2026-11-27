/** 来自实际失败类型的复现稿，不是用户原design.json；保留长英文/小标题/数字/页脚四类错误。 */
export function preflightPosterInput(asset = '素材/结构示意.png') {
  const layers = [];
  const text = (id, copy, x, y, w, h, size, extra = {}) => layers.push({ id, type: 'text', text: copy, x, y, w, h,
    fontSize: size, minFontSize: size, color: '#173454', ...extra });
  const shape = (id, x, y, w, h, fill, extra = {}) => layers.push({ id, type: 'shape', x, y, w, h, fill, decorative: true, ...extra });
  text('eyebrow', '未央 · 设计方法观察', 64, 48, 952, 50, 32, { role: 'label', color: '#185BB5' });
  text('title', '让 AI 学会\n把事情做好', 64, 132, 952, 150, 84, { role: 'heading', weight: 700 });
  text('subtitle', '从提示词结构，到可核验的工作流程', 64, 402, 952, 70, 38, { role: 'body' });
  shape('header-rule', 64, 510, 952, 3, '#185BB5');
  text('intro-heading', '借鉴方法\n保留判断', 64, 570, 420, 80, 41, { role: 'heading', weight: 700, group: 'intro' });
  text('intro-body', '把复杂任务拆成清楚的步骤，\n让工具、证据与交付相互配合。\n可靠的助手，要能把结果拿出来。', 64, 756, 440, 180, 34, { role: 'body', group: 'intro' });
  layers.push({ id: 'structure-art', type: 'image', x: 556, y: 548, w: 460, h: 460, fit: 'contain', asset: 'structure', group: 'intro' });
  text('structure-heading', '把一份长规则，读成清楚的结构', 64, 1062, 952, 56, 41, { role: 'heading', weight: 700 });
  const tags = [
    ['身份与表达', 'identity_and_style'], ['工具与交付', 'tools_and_delivery'],
    ['不确定性', 'uncertainty_handling'], ['专业信息边界', 'legal_and_financial_advice']
  ];
  tags.forEach(([label, tag], i) => {
    const x = i % 2 ? 552 : 64, y = i < 2 ? 1178 : 1388, group = 'tag-' + i;
    shape(group + '-panel', x, y, 464, 190, '#EAF0F9', { radius: 18, group });
    text(group + '-name', label, x + 24, y + 18, 416, 50, 36, { weight: 700, group });
    text(group + '-english', tag, x + 24, y + 82, 416, 32, 34, { group, role: 'body', color: '#284967' });
  });
  text('method-heading', '真正有用的是这条工作路径', 64, 1650, 952, 56, 41, { role: 'heading', weight: 700 });
  const methods = [
    ['读懂任务', '先确定要交付什么，以及它给谁使用。'],
    ['调用工具', '工具负责执行，资料保留出处和时间。'],
    ['核验结果', '打开实际成品，核对文字、版式与内容。']
  ];
  methods.forEach(([heading, body], i) => {
    const y = 1764 + i * 158, group = 'step-' + i;
    shape(group + '-badge', 64, y, 70, 80, '#185BB5', { radius: 14 });
    text(group + '-number', String(i + 1).padStart(2, '0'), 70, y + 8, 58, 28, 34, { color: '#FFFFFF', align: 'center', role: 'label', group });
    text(group + '-heading', heading, 166, y, 850, 50, 38, { weight: 700, group });
    text(group + '-body', body, 166, y + 68, 850, 52, 34, { group });
  });
  shape('footer-rule', 64, 2260, 952, 2, '#B3C4D8');
  text('footer', '材料：第三方 Claude Fable 5.1 Markdown，官方来源未核实。\n本页为设计方法示例，标签是结构概括，不作为产品规则。\n文字由程序排版；配图为示意，不能代替原文核查。', 64, 2300, 952, 100, 34, { role: 'caption', color: '#284967' });
  // 故意没有顶层title：真实标题已在title文字层，不能再让模型为重复字段浪费一次调用。
  return { width: 1080, height: 2560, dataMode: 'provided', source: '用户提供的第三方Markdown；本页是设计方法示例，官方来源未核实',
    // 2026-11-17 起新自由稿须写构思（design.concept），夹具补上；断言不变
    design: { layout: 'free', reading: 'phone', concept: { idea: '四层提示词结构一图讲清', relation: 'interleave', focus: '结构示意图' }, palette: { background: '#FAFBFD', ink: '#173454', muted: '#284967', accent: '#185BB5', card: '#EAF0F9' },
      assets: [{ id: 'structure', path: asset }], layers } };
}

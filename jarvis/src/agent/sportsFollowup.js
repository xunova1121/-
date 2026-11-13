/** 追问比分时沿用近邻对阵；只提取名称线索，旧回复/截图的数字绝不当新比分。 */
export function sportsFollowupScope(text, history = []) {
  const request = String(text).trim();
  if (!/比分|赛果|那.{0,5}场|这.{0,5}场/.test(request) || /所有|全部|全天|有哪些|有什么|全部联赛/.test(request) || request.length > 100) return null;
  const recent = history.slice(-12);
  let image = false;
  for (const message of [...recent].reverse()) {
    image ||= Boolean(message.images?.length) || /截图|图片|串关/.test(String(message.content).slice(0, 1000));
    const content = String(message.content || '').slice(0, 12000);
    const pairs = [...content.matchAll(/(?:^|\n)\s*(?:[-*]|\d+[.、])?\s*([^\n:：|]{2,60}?)\s+(?:vs|VS|对阵)\s+([^\n:：|]{2,60})/g)];
    if (pairs.length && pairs.length <= 12) return { required: true, teams: [...new Set(pairs.map(p => p[1].replace(/[*_]/g, '').trim()))], count: pairs.length };
  }
  return image || /(?:我|这|那).{0,6}[场个]/.test(request) ? { required: true, teams: [], count: null } : null;
}

export const SPORTS_FOLLOWUP_NOTE = '用户追问前文/截图选定比赛的比分，只核对那些对阵。先用可见历史识别队名；必要时读原图，不沿用截图半场或旧回答的分数冒充实时。用get_sports_scores的teams逐场筛选，未匹配到的单独注明；不要改查全站赛程。回复用对阵、实时比分、状态的小表格，来源与查询时间只写一次。';

/** 名称匹配保持保守，不凭相似字或翻译猜成同一支球队。 */
export function selectedTeam(name, teams = []) {
  const normalized = String(name).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  return !teams.length || teams.some(team => normalized.includes(String(team).normalize('NFKC').toLowerCase().replace(/\s+/g, '')));
}

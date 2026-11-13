/** 模型未能整理时的可读兜底；绝不把数百行工具回执贴到对话。 */
export function sportsAnswerTable(output, request = '') {
  const value = String(output);
  const rows = value.split('\n').filter(line => /^-\s+(?:\d{4}-\d{2}-\d{2}\s+)?\d{2}:\d{2}\s/.test(line));
  if (!rows.length) return value.split('\n').filter(line => line.trim() && !/赛事编号|用户问的是|用 web_search|球队名是英文/.test(line)).slice(0, 6).join('\n\n');
  const all = /全部|所有|完整|列全/.test(request), cap = all ? 24 : 6;
  const ranked = rows.map((line, index) => ({ line, index })).sort((a, b) => Number(/进行中|中场/.test(b.line)) - Number(/进行中|中场/.test(a.line)) || a.index - b.index);
  const escape = text => text.replace(/\|/g, '／').replace(/[*_]/g, '');
  const table = ranked.slice(0, cap).map(({ line }) => {
    const match = line.match(/^-\s+((?:\d{4}-\d{2}-\d{2}\s+)?\d{2}:\d{2})\s+([^：]+)：(.*)$/);
    return match ? `| ${match[1]} | ${escape(match[3])} | ${escape(match[2])} |` : '';
  }).filter(Boolean);
  const source = value.match(/来源[：:]\s*([^\n]+)/)?.[1] || (/来源直播吧/.test(value) ? '直播吧' : '本次查询回执');
  const time = value.match(/查询于北京时间\s*([\d-]+\s+[\d:]+)/)?.[1];
  const scope = value.split('\n').find(line => line.startsWith('本轮仅核对指定的')) || '';
  return [scope, `本次匹配 ${rows.length} 场${rows.length > cap ? `，先列 ${cap} 场` : ''}：`, '| 时间（北京） | 对阵与比分 | 状态／赛事 |', '| --- | --- | --- |', ...table,
    rows.length > cap ? `其余 ${rows.length - cap} 场未在正文展开，可按球队或联赛缩小范围。` : '',
    /计划赛程/.test(value) ? '赛程页仅提供计划对阵，实时比分与状态未核实。' : '',
    `来源：${source}${time ? `；查询时间：${time}（北京时间）` : ''}`].filter(Boolean).join('\n');
}

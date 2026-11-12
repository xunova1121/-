import { it, expect, vi } from 'vitest';
import { normalizeCompanyReceipt, companySourceURL, companyFollowupDraft, companyResultView } from '../src/ui/businessQueryView.js';

const query = { company: '测试企业有限公司', section: 'basic', source: 'public' };
const el = (tag, props = {}, ...children) => ({ tag, ...props, children, events: {}, append(...nodes) { this.children.push(...nodes); }, addEventListener(type, fn) { this.events[type] = fn; } });
const flatten = node => [node, ...(node.children || []).flatMap(flatten)];

it('只有后端原文证据契约与已读标记同时满足才标记已读取原文', () => {
  const result = normalizeCompanyReceipt({ items: [
    { title: '原文', originalRead: true, evidence: 'original_page' },
    { title: '摘要', originalRead: true, evidence: 'search_snippet' },
    { title: '旧标识', originalRead: true, evidence: 'original' }
  ] });
  expect(result.items.map(item => item.originalRead)).toEqual([true, false, false]);
});

it('企百科继续分析草稿保留更新日未知及股东、实控人、法人不同的说明', () => {
  const receipt = normalizeCompanyReceipt({ source: '企百科', rows: [{ 企业名称: query.company, 股东名称: '测试股东' }] });
  const draft = companyFollowupDraft(receipt, query);
  expect(draft).toContain('企百科数据更新日未知');
  expect(draft).toContain('工商股东、实际控制人和法定代表人须分别核对');
  expect(draft).toContain('测试股东');
});

it('企百科只显示回执的已知字段，不展开额外密钥或对象；数值零仍展示', () => {
  const result = normalizeCompanyReceipt({ source: '企百科', state: 'ok', dataRetrieved: true, rows: [
    { 企业名称: '测试企业有限公司', '注册资本（万元）': 0, 经营范围: '<script>fixture</script>', access_key: 'hidden-secret', debug: { raw: 'hidden' } }
  ] });
  expect(result.rows).toEqual([[['企业名称', '测试企业有限公司'], ['注册资本（万元）', '0'], ['经营范围', '<script>fixture</script>']]]);
  expect(JSON.stringify(result)).not.toContain('hidden-secret');
});

it('公开来源即便附带rows也不能渲染成登记资料，摘要保留待核实状态', () => {
  const tree = companyResultView({ source: '公开资料', state: 'unverified', dataRetrieved: true,
    rows: [{ 企业名称: '不能冒充登记数据' }], items: [{ title: '测试企业介绍', url: 'https://company.example.com/about', snippet: '公开来源简介', registrationVerified: false }] }, query, { el, onFill: vi.fn() });
  const rendered = JSON.stringify(tree);
  expect(rendered).not.toContain('不能冒充登记数据');
  expect(rendered).toContain('公开检索线索 · 未核实原文');
  expect(rendered).toContain('不能直接当作已核实');
});

it('空结果与连接失败各显示实际状态，不能造出工商字段或推断企业不存在', () => {
  for (const state of ['empty', 'failed']) {
    const tree = companyResultView({ state, source: '公开资料', dataRetrieved: false, items: [], leads: [] }, query, { el, onFill: vi.fn() });
    const rendered = JSON.stringify(tree);
    expect(rendered).toContain('暂未取得资料');
    expect(rendered).not.toContain('注册资本');
    expect(flatten(tree).some(node => node.textContent === '继续分析')).toBe(false);
    expect(rendered).toContain(state === 'failed' ? '来源没有成功返回资料' : '不代表企业不存在');
  }
});

it('引文链接单列为待核实，无正文时不伪造摘要', () => {
  const receipt = { source: '公开资料', state: 'unverified', dataRetrieved: false,
    leads: [{ title: '企业来源', url: 'https://company.example.com/', reason: '未读原文' }] };
  const tree = companyResultView(receipt, query, { el, onFill: vi.fn() });
  const nodes = flatten(tree);
  expect(nodes.some(node => node.textContent === '待核实')).toBe(true);
  expect(nodes.find(node => node.tag === 'a')).toMatchObject({ href: 'https://company.example.com/', target: '_blank', rel: 'noopener noreferrer' });
});

it('拒绝脚本、私网、带凭据和带密钥的来源链接，包括编码参数', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'http://127.0.0.1/', 'http://router.internal/', 'https://user:secret@example.com/',
    'https://example.com/?access_key=secret', 'https://example.com/?api%5Fkey=secret', 'https://example.com/#access_token=secret']) expect(companySourceURL(url)).toBe('');
  expect(companySourceURL('https://www.gov.cn/x?id=123')).toBe('https://www.gov.cn/x?id=123');
});

it('继续分析只调用草稿回调，包含来源与核验要求且有长度上限', () => {
  const onFill = vi.fn();
  const raw = { source: '公开资料', company: query.company, items: [{ title: '企业资料', url: 'https://company.example.com/', snippet: '简介'.repeat(1000) }] };
  const tree = companyResultView(raw, query, { el, onFill });
  expect(onFill).not.toHaveBeenCalled();
  flatten(tree).find(node => node.textContent === '继续分析').events.click();
  expect(onFill).toHaveBeenCalledOnce();
  const draft = onFill.mock.calls[0][0];
  expect(draft).toContain('公开摘要须先读原文核实');
  expect(draft).toContain('https://company.example.com/');
  expect(draft.length).toBeLessThanOrEqual(2000);
  expect(companyFollowupDraft(normalizeCompanyReceipt(raw), query)).toBe(draft);
});

it('渲染只写textContent，回执里的HTML和未知错误正文不会被当页面执行', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const tree = companyResultView({ source: '公开资料', items: [{ title: payload, snippet: payload, url: 'https://company.example.com/' }],
    warnings: [{ source: '搜索', code: 'SEARCH_TIMEOUT', message: 'arbitrary secret body' }] }, query, { el, onFill: vi.fn() });
  const nodes = flatten(tree);
  expect(nodes.some(node => node.textContent === payload)).toBe(true);
  expect(nodes.some(node => 'innerHTML' in node)).toBe(false);
  expect(JSON.stringify(tree)).not.toContain('arbitrary secret body');
});

it('条数/内容都有上限，错误格式与超大JSON明确报错，不输出假结果', () => {
  const result = normalizeCompanyReceipt({ source: '企百科', rows: Array.from({ length: 50 }, () => ({ 企业名称: '字'.repeat(1000) })),
    items: Array.from({ length: 50 }, () => ({ title: '标题', snippet: '字'.repeat(2000) })), leads: Array.from({ length: 50 }, () => ({ title: '线索' })) });
  expect(result.rows).toHaveLength(10); expect(result.rows[0][0][1]).toHaveLength(600);
  expect(result.items).toHaveLength(6); expect(result.items[0].snippet).toHaveLength(600); expect(result.leads).toHaveLength(3);
  expect(() => normalizeCompanyReceipt('bad-json')).toThrow('格式无法识别');
  expect(() => normalizeCompanyReceipt(' '.repeat(120001))).toThrow('资料过大');
  expect(() => normalizeCompanyReceipt(null)).toThrow('可用回执');
});

/** 依据用户国内服务器两轮实测截图启用；不含客户内容，不把时区/开发机HTTP200当证明。 */
export const DOMESTIC_PROBE = Object.freeze({
  revision: '5d58c0e', date: '2026-10-31', network: 'cn', evidence: '用户08:12及08:37服务器终端截图',
  scriptSHA256: '5e4deed8159ab568f6d9e7586fa3c0d92480ddd19075d21533f8430d2b6f6c6d',
  classifier: { passed: 45, total: 45 },
  // 仅证明当时连接与解析；不是完成耗时/业务正确率或国际栏目5条的验收。
  results: {
    cn_cnr: [{ ms: 350, count: 1 }, { ms: 328, count: 3 }],
    cn_cnfin: [{ ms: 433, count: 0 }, { ms: 377, count: 1 }],
    cn_cns: [{ ms: 822, count: 33 }, { ms: 861, count: 35 }],
    cn_cns_sports: [{ ms: 331, count: 5 }, { ms: 365, count: 5 }],
    cn_zhibo_sports: [{ ms: 1219, count: 5 }, { ms: 6146, count: 5 }],
    cn_sina_sports: [{ ms: 978, count: 2 }, { ms: 997, count: 2 }]
  }
});
export const DOMESTIC_APPROVALS = Object.freeze(Object.fromEntries(Object.keys(DOMESTIC_PROBE.results).map(id => [id, {
  approved: id !== 'cn_sina_sports', evidence: 'domestic-20261031-two-runs',
  ...(id === 'cn_cnfin' ? { priority: 40 } : {}),
  ...(id === 'cn_sina_sports' ? { reason: '国内可连通，但仅两条有效资讯且队列多为彩票，暂不选用' } : {})
}])));

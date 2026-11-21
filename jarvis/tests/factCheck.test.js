import { describe, it, expect } from 'vitest';
import { factCheck, formatReport, quoteInText, passages, rankHits, norm } from '../src/agent/factCheck.js';

const PAGES = {
  'https://www.ansa.it/a': 'Serie A: Atalanta-Venezia 3-1. Bergamo, 12 ottobre 2026. Kessié al 4\', poi doppietta di Krstovic; per il Venezia Hainaut.',
  'https://www.adnkronos.com/b': 'Serie A, Atalanta-Venezia 3-1: decidono il gol di Kessié e la doppietta di Krstovic. Lunedì 12 ottobre.',
  'https://old.example/c': 'Atalanta-Venezia 0-0 (1 marzo 2025), Gasperini perde terreno.'
};
const fakeSearch = (log) => async (q) => {
  log.push(q);
  if (/Atalanta/i.test(q)) {
    return [
      { title: 'Atalanta Venezia 2025', url: 'https://old.example/c', snippet: '0-0 nel 2025' },
      { title: 'Serie A: Atalanta-Venezia 3-1', url: 'https://www.ansa.it/a', snippet: '12 ottobre 2026' },
      { title: 'Atalanta-Venezia 3-1 Krstovic', url: 'https://www.adnkronos.com/b', snippet: '' }
    ];
  }
  return [];
};
const read = async (url) => PAGES[url] ?? '';

describe('逐项查证', () => {
  it('引用核对：必须真在原文里（不管空格、全半角、大小写、重音），允许 … 省略', () => {
    expect(quoteInText('Atalanta-Venezia  3-1', PAGES['https://www.ansa.it/a'])).toBe(true);
    expect(quoteInText('Kessie al 4', PAGES['https://www.ansa.it/a'])).toBe(true); // 去重音
    expect(quoteInText('Atalanta-Venezia 3-1 … doppietta di Krstovic', PAGES['https://www.ansa.it/a'])).toBe(true);
    expect(quoteInText('Atalanta-Venezia 2-1', PAGES['https://www.ansa.it/a'])).toBe(false);
    expect(quoteInText('', 'x')).toBe(false);
    expect(norm('Ａｔａｌａｎｔａ — 3–1')).toBe('atalanta-3-1');
  });
  it('只截取提到名字的段落', () => {
    const text = `${'无关内容。'.repeat(400)}Malmö FF vann med 1–0 mot Kalmar FF.${'别的。'.repeat(400)}`;
    const p = passages(text, ['Malmo FF', 'Kalmar']);
    expect(p).toMatch(/Malmö FF vann med 1–0 mot Kalmar FF/);
    expect(p.length).toBeLessThan(1200);
  });
  it('排序：名字、日期、权威网站优先', () => {
    const r = rankHits([{ title: 'x', url: 'https://a.com', snippet: '' }, { title: 'Atalanta Venezia 12 ottobre', url: 'https://ansa.it/x', snippet: '' }], { names: ['Atalanta', 'Venezia'], dateHints: ['12 ottobre'], preferSites: ['ansa.it'] });
    expect(r[0].url).toBe('https://ansa.it/x');
  });
  it('完整流程：定名 → 多语言搜索 → 读原文 → 摘答案 → 核对引用 → 两个网站一致才算已核实；编造的引用作废', async () => {
    const log = [];
    const calls = [];
    const llm = async ({ system, prompt }) => {
      calls.push(system.slice(0, 20));
      if (/定名/.test(system)) return JSON.stringify({ names: ['Atalanta', 'Venezia'], dateHints: ['12 ottobre 2026'], queries: ['Atalanta Venezia risultato 12 ottobre 2026', 'Atalanta vs Venezia 12 October 2026'], preferSites: ['ansa.it'] });
      const n = (u) => prompt.match(new RegExp(`\\[(\\d+)\\][^\\n]*\\(${u}\\)|\\[(\\d+)\\][^\\n]*（${u}）`))?.slice(1).find(Boolean);
      return JSON.stringify({ answer: '亚特兰大 3-1 威尼斯', fields: { 全场: '3-1' }, evidence: [
        { source: Number(n('ansa.it')), quote: 'Serie A: Atalanta-Venezia 3-1' },
        { source: Number(n('adnkronos.com')), quote: 'Atalanta-Venezia 3-1: decidono il gol di Kessié' },
        { source: Number(n('ansa.it')), quote: 'Atalanta ha vinto 5-0' } // 编造的
      ], confidence: 'high' });
    };
    const steps = [];
    const r = await factCheck({ question: '全场比分', items: [{ label: '亚特兰大 VS 威尼斯', details: '周一002' }], date: '2026-10-12', llm, search: fakeSearch(log), read, onProgress: (t) => steps.push(t) });
    const x = r.items[0];
    expect(log).toContain('Atalanta Venezia risultato 12 ottobre 2026'); // 用原文搜
    expect(x.status).toBe('confirmed');
    expect(x.answer).toBe('亚特兰大 3-1 威尼斯');
    expect(x.sources.map((s) => s.url)).toEqual(['https://www.ansa.it/a', 'https://www.adnkronos.com/b']);
    expect(x.dropped).toBe(1);
    expect(calls.length).toBe(2); // 一轮就核实，不再多查
    const report = formatReport(r);
    expect(report).toMatch(/✅ 已核实/);
    expect(report).toMatch(/1 条引用在原文里找不到，已作废/);
    expect(steps.at(-1)).toMatch(/已查完 1\/1/);
  });
  it('只有一个来源：换搜索词再查一轮，仍不够就标“单一来源”', async () => {
    const log = [];
    const llm = async ({ system, prompt }) => {
      if (/定名/.test(system)) return JSON.stringify({ names: ['Atalanta'], queries: ['Atalanta Venezia'] });
      const n = prompt.match(/\[(\d+)\][^\n]*（ansa\.it）/)?.[1];
      return JSON.stringify({ answer: '3-1', evidence: [{ source: Number(n), quote: 'Atalanta-Venezia 3-1' }], nextQueries: ['Atalanta Venezia 3-1 Krstovic'] });
    };
    const search = async (q) => { log.push(q); return q === 'Atalanta Venezia' ? [{ title: 'ANSA', url: 'https://www.ansa.it/a', snippet: '' }] : []; };
    const r = await factCheck({ question: '比分', items: [{ label: '亚特兰大 VS 威尼斯' }], llm, search, read });
    expect(log).toContain('Atalanta Venezia 3-1 Krstovic');
    expect(r.items[0].status).toBe('single');
    expect(formatReport(r)).toMatch(/单一来源/);
  });
  it('模型编造全部引用：判为未核实', async () => {
    const llm = async ({ system }) => (/定名/.test(system) ? '{"names":["Atalanta"],"queries":["Atalanta"]}' : '{"answer":"5-0","evidence":[{"source":1,"quote":"Atalanta 5-0 Venezia"}],"nextQueries":[]}');
    const r = await factCheck({ question: '比分', items: [{ label: 'Atalanta' }], llm, search: fakeSearch([]), read, rounds: 1 });
    expect(r.items[0].status).toBe('unverified');
  });
  it('多项并行，结果顺序与输入一致；没有项目时报错', async () => {
    const llm = async ({ system }) => (/定名/.test(system) ? '{}' : '{"answer":null}');
    const r = await factCheck({ question: 'x', items: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }], llm, search: async () => [], read, rounds: 1 });
    expect(r.items.map((i) => i.label)).toEqual(['A', 'B', 'C', 'D']);
    await expect(factCheck({ question: 'x', items: [], llm, search: async () => [], read })).rejects.toThrow(/逐项/);
  });
});

import { it, expect } from 'vitest';
import { createPageReader } from '../src/agent/pageReader.js';
import { createEvidenceStore } from '../src/agent/evidenceStore.js';

// 构造真实、带交叉引用表的单页PDF，走生产PDF解析器，不模拟提取结果。
function pdf(text) {
  const stream = text ? `BT /F1 12 Tf 40 700 Td (${text}) Tj ET` : '';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(out.length); out += `${index+1} 0 obj\n${object}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return out;
}

it('网络PDF真实提取正文；扫描件不能把页码当成正文', async () => {
  const read = createPageReader({ fetchImpl: async url => new Response(pdf(url.includes('blank') ? '' : 'Official policy details'), {headers: {'content-type':'application/pdf'}}) });
  expect(await read('https://a.gov.cn/policy.pdf')).toContain('Official policy details');
  await expect(read('https://a.gov.cn/blank.pdf')).rejects.toHaveProperty('code', 'PDF_NO_TEXT');
});

it('证据存储只保留有界正文和原文标志，重启读回不把旧摘要升级', async () => {
  const records = new Map();
  const store = {get: async key => records.get(key), put: async value => records.set(value.id, structuredClone(value)), delete: async key => records.delete(key)};
  const first = createEvidenceStore({store});
  await first.put('test', {key:'duties',sources:[{url:'https://a.gov.cn/a',text:'正文',original:true},{url:'https://a.gov.cn/b',text:'摘要'}]});
  await first.flush();
  const second = createEvidenceStore({store});
  expect((await second.records('test'))[0].sources.map(x => x.original)).toEqual([true,false]);
});

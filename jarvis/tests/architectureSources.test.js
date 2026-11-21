import { it, expect } from 'vitest';
import * as workspace from '../src/agent/workspace.js';
import { checkSources } from '../src/agent/diagramSources.js';
it('采购正文在12万字之后仍能按唯一原文边界完整读取，不把前文摘要当全文', async () => {
  await workspace.write('长材料.txt', '前'.repeat(130000) + '第四章采购需求正文\n建设统一事件管理\n第五章合同正文');
  const result = await checkSources([{ path: '长材料.txt', excerpt: '统一事件管理', sectionStart: '第四章采购需求正文', sectionEnd: '第五章合同正文' }]);
  expect(result.materials[0].text).toBe('第四章采购需求正文\n建设统一事件管理\n');
  expect(result.checks[0]).toMatchObject({ matched: true, truncated: false, scope: 'section' });
  const old = await checkSources([{ path: '长材料.txt', excerpt: '统一事件管理' }]);
  expect(old.checks[0]).toMatchObject({ matched: false, truncated: true });
});
it('目录与正文重复标题、缺失终点及过大范围拒绝，不猜一个章节', async () => {
  await workspace.write('边界.txt', '第四章目录\n第四章正文\n第五章正文');
  for (const scope of [{ sectionStart: '第四章' }, { sectionStart: '第四章正文', sectionEnd: '不存在' }])
    await expect(checkSources([{ path: '边界.txt', excerpt: '正文', ...scope }])).rejects.toMatchObject({ code: 'ARCHITECTURE_SOURCE_SCOPE' });
  await workspace.write('过长章节.txt', '起点\n' + '文'.repeat(120001) + '终点');
  await expect(checkSources([{ path: '过长章节.txt', excerpt: '文', sectionStart: '起点', sectionEnd: '终点' }])).rejects.toMatchObject({
    code: 'ARCHITECTURE_SOURCE_SCOPE'
  });
});

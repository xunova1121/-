import { it, expect } from 'vitest';
import { catalogGroups, loadCatalog, saveCatalog } from '../src/ui/workspaceCatalog.js';
const files = [
  { path: '项目/方案.docx', size: 10, mtime: 1 },
  { path: '项目/方案.pdf', size: 20, mtime: 2 },
  { path: '文档检查/方案-docx.json', size: 5, mtime: 3 },
  { path: '其他/方案.docx', size: 10, mtime: 4 }
];
it('同目录同名多格式归拢，过程文件默认收起，不误并其他项目', () => {
  const result = catalogGroups(files);
  expect(result).toHaveLength(2);
  expect(result.find((group) => group.files.length === 2).files.map((file) => file.path)).toEqual(['项目/方案.docx', '项目/方案.pdf']);
  expect(catalogGroups(files, { process: true })).toHaveLength(3);
  expect(catalogGroups(files, { query: '方案-docx' })).toHaveLength(1);
});
it('别名/项目可搜索，收藏回收站独立，原始路径不变', async () => {
  const items = { '项目/方案.docx': { title: '客户一稿', project: '养殖项目', favorite: true }, '其他/方案.docx': { trash: true } };
  await saveCatalog('local', items);
  expect(await loadCatalog('local')).toEqual(items);
  expect(await loadCatalog('server:https://other.example')).toEqual({});
  expect(catalogGroups(files, { items, query: '养殖' })).toHaveLength(1);
  expect(catalogGroups(files, { items, view: 'favorites' })).toHaveLength(1);
  expect(catalogGroups(files, { items, view: 'trash' })[0].files[0].path).toBe('其他/方案.docx');
});
it('五千文件可完整查找，管理标记有上限，来源只取真实生成回执', async () => {
  const many = Array.from({ length: 5000 }, (_, index) => ({ path: `文件${index}.docx`, size: 1, mtime: index }));
  expect(catalogGroups(many, { query: '文件4999' })[0].files[0].path).toBe('文件4999.docx');
  await expect(saveCatalog('large', Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [String(index), { favorite: true }])))).rejects.toMatchObject(
    { code: 'CATALOG_LIMIT' }
  );
  expect(
    catalogGroups(files, { records: [{ id: 'g-one', sessionId: 'c-one', files: ['项目/方案.docx'] }] }).find((group) => group.files.length === 2).source.id
  ).toBe('g-one');
});
it('快速并发修改按最新元数据合并，不覆盖另一个成果的标记', async () => {
  const { patchCatalog } = await import('../src/ui/workspaceCatalog.js');
  await saveCatalog('concurrent', {});
  await Promise.all([patchCatalog('concurrent', ['甲.docx'], { favorite: true }), patchCatalog('concurrent', ['乙.docx'], { project: '项目乙' })]);
  expect(await loadCatalog('concurrent')).toMatchObject({ '甲.docx': { favorite: true }, '乙.docx': { project: '项目乙' } });
});

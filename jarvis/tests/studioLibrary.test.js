import { it, expect } from 'vitest';
import { createStudioLibrary } from '../src/agent/studioLibrary.js';
import { cleanStudio, matchesAgent, agentReadiness, revisionRequest } from '../src/core/studioData.js';
import { generate } from '../src/agent/docs.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { digest } from '../src/agent/documentXml.js';
import PptxGenJS from 'pptxgenjs';

function fixture() {
  const values = new Map(),
    data = new Map();
  const storage = {
    get: async (id) => structuredClone(values.get(id)),
    put: async (row) => {
      values.set(row.id, structuredClone(row));
    }
  };
  const files = {
    ext: (p) => p.split('.').pop(),
    readBlob: async (p) => {
      if (!data.has(p)) throw new Error('不存在');
      return data.get(p);
    },
    write: async (p, blob) => {
      data.set(p, blob);
      return { path: p, size: blob.size };
    },
    list: async () => [...data].map(([path, blob]) => ({ path, size: blob.size, mtime: 1 }))
  };
  return { library: createStudioLibrary({ storage, files }), files, values, data };
}
it('并发偏好不丢失，最近和收藏有上限，未知能力不误报已验收', async () => {
  const { library } = fixture();
  await Promise.all(Array.from({ length: 12 }, (_, i) => library.change({ action: 'favorite', id: 'agent-' + i })));
  expect((await library.preferences()).favorites).toHaveLength(12);
  for (let i = 0; i < 20; i++) await library.change({ action: 'recent', id: 'agent-' + i });
  expect((await library.preferences()).recent).toHaveLength(12);
  expect(cleanStudio({ favorites: Array(300).fill('same') }).favorites).toEqual(['same']);
  expect(matchesAgent({ id: 'ppt-maker', name: 'PPT', starters: [] }, '述职')).toBe(true);
  expect(agentReadiness({ id: 'ppt-maker' }).state).toBe('unknown');
  expect(agentReadiness({ id: 'ppt-maker' }, { checks: [{ id: 'chat', status: 'configured' }] }).state).toBe('unknown');
  expect(revisionRequest({ path: 'a.docx', instruction: '只改标题' })).toContain('不覆盖原件');
});
it('Word改字另存且原件字节不变，模板是快照，版本恢复再生副本', async () => {
  const { library, files } = fixture();
  const blob = (await generate('docx', { title: '测试', content: '原始内容要保留。', toc: false })).blob;
  await files.write('文稿.docx', blob);
  const inspection = await library.inspect('文稿.docx');
  const changed = await library.edit({ path: '文稿.docx', sha256: inspection.sha256, replacements: [{ find: '原始内容要保留', replace: '新内容已更新' }] });
  expect(changed.path).not.toBe('文稿.docx');
  expect(await digest(await files.readBlob('文稿.docx'))).toBe(await digest(blob));
  expect(await (await openOfficePackage(await files.readBlob(changed.path))).file('word/document.xml').async('string')).toContain('新内容已更新');
  const tpl = await library.copy({ path: changed.path, template: true });
  const savedHash = await digest(await files.readBlob(tpl.path));
  await files.write(changed.path, new Blob(['later']));
  expect(await digest(await files.readBlob(tpl.path))).toBe(savedHash);
  expect((await library.preferences()).templates[0].path).toBe(tpl.path);
  const restored = await library.copy({ path: '文稿.docx' });
  expect(await digest(await files.readBlob(restored.path))).toBe(await digest(blob));
  expect((await library.versions(restored.path))[0]).toEqual({ path: '文稿.docx', original: true });
});
it('旧摘要和歧义全文替换拒绝，失败不留下声称成功的版本', async () => {
  const { library, files } = fixture();
  await files.write('a.docx', (await generate('docx', { title: '测试', content: '重复内容。\n\n重复内容。', toc: false })).blob);
  const before = await library.inspect('a.docx');
  await expect(library.edit({ path: 'a.docx', sha256: 'bad', replacements: [{ find: '重复', replace: '新' }] })).rejects.toMatchObject({
    code: 'DOCUMENT_CONFLICT'
  });
  await expect(library.edit({ path: 'a.docx', sha256: before.sha256, replacements: [{ find: '重复', replace: '新' }] })).rejects.toThrow();
  expect(await library.list()).toHaveLength(1);
});
it('PPT所选页改字、移动、换图均保留其他页面和共享旧媒体', async () => {
  const { library, files } = fixture();
  const ppt = new PptxGenJS();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  for (let n = 0; n < 2; n++) {
    const slide = ppt.addSlide();
    slide.addText('相同标题', { x: 1, y: 1, w: 4, h: 1 });
    slide.addImage({ data: 'image/png;base64,' + png, x: 1, y: 3, w: 1, h: 1 });
  }
  const blob = new Blob([await ppt.write({ outputType: 'nodebuffer' })]);
  await files.write('两页.pptx', blob);
  const inspection = await library.inspect('两页.pptx');
  const changed = await library.edit({
    path: '两页.pptx',
    sha256: inspection.sha256,
    replacements: [{ find: '相同标题', replace: '第二页更新' }],
    slides: [2]
  });
  const originalZip = await openOfficePackage(blob),
    changedZip = await openOfficePackage(await files.readBlob(changed.path));
  expect(await changedZip.file('ppt/slides/slide1.xml').async('string')).toBe(await originalZip.file('ppt/slides/slide1.xml').async('string'));
  expect(await changedZip.file('ppt/slides/slide2.xml').async('string')).toContain('第二页更新');
  const picture = inspection.objects.find((x) => x.kind === 'pic');
  await files.write('new.png', new Blob([Buffer.from(png, 'base64')]));
  const replaced = await library.edit({ path: '两页.pptx', sha256: inspection.sha256, picture: { target: picture.id, path: 'new.png' } });
  const replacedZip = await openOfficePackage(await files.readBlob(replaced.path));
  for (const file of Object.keys(originalZip.files).filter((p) => !originalZip.files[p].dir && (p.includes('/media/') || p.includes('slide2'))))
    expect(await replacedZip.file(file).async('base64')).toBe(await originalZip.file(file).async('base64'));
  expect(Object.keys(replacedZip.files).some((p) => /media\/studio-/.test(p))).toBe(true);
  const moved = await library.edit({
    path: '两页.pptx',
    sha256: inspection.sha256,
    operations: [{ action: 'move_resize', target: { id: picture.id }, properties: { x: 2, width: 3 } }]
  });
  expect(await (await openOfficePackage(await files.readBlob(moved.path))).file('ppt/slides/slide1.xml').async('string')).toContain('1828800');
  expect(await digest(await files.readBlob('两页.pptx'))).toBe(inspection.sha256);
});
it('图片不可假装PPT媒体，零操作拒绝，格式操作按对象修改', async () => {
  const { library, files } = fixture();
  const blob = (await generate('pptx', { title: '保留', content: '# 标题\n\n正文内容', cover: false })).blob;
  await files.write('a.pptx', blob);
  await files.write('bad.png', new Blob(['not-image']));
  const inspection = await library.inspect('a.pptx');
  await expect(library.edit({ path: 'a.pptx', sha256: inspection.sha256 })).rejects.toThrow('每次请选择');
  await expect(library.edit({ path: 'a.pptx', sha256: inspection.sha256, picture: { target: 'slide1:shape2', path: 'bad.png' } })).rejects.toThrow('真实PNG');
  const object = inspection.objects.find((o) => o.text && o.kind === 'sp');
  const result = await library.edit({
    path: 'a.pptx',
    sha256: inspection.sha256,
    operations: [{ action: 'format', target: { id: object.id }, properties: { font_size: 30 } }]
  });
  expect((await library.inspect(result.path)).objects.map((o) => o.text)).toEqual(inspection.objects.map((o) => o.text));
});

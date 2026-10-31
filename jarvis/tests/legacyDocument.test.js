import { it, expect } from 'vitest';
import { parseFile, generate } from '../src/agent/docs.js';
it('真正旧DOC走显式转换器，读回转换后的实际DOCX；原文件不变', async () => {
  const original = new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]),
    bytes = await original.arrayBuffer();
  const converted = await generate('docx', { title: '转换样例', content: '# 转换样例\n\n保留金额1234元和设备17台。' });
  let calls = 0;
  const result = await parseFile(original, '需求.doc', {
    convertLegacyDoc: async (blob) => {
      calls++;
      expect(blob).toBe(original);
      return converted.blob;
    }
  });
  expect(result.text).toContain('1234元');
  expect(result.text).toContain('17台');
  expect(calls).toBe(1);
  expect(await original.arrayBuffer()).toEqual(bytes);
});
it('DOC后缀的新版Word不调用旧格式转换；未配置旧DOC能力仍照实报错', async () => {
  const doc = await generate('docx', { title: '真实DOCX', content: '# 内容\n\n正常读取。' });
  expect(
    (
      await parseFile(doc.blob, '伪后缀.doc', {
        convertLegacyDoc: () => {
          throw Error('不应调用');
        }
      })
    ).text
  ).toContain('正常读取');
  await expect(parseFile(new Blob([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]), 'old.doc')).rejects.toThrow(/Word 97-2003/);
});
it('停止信号在转换之前生效', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await expect(
    parseFile(new Blob([]), 'old.doc', {
      signal: controller.signal,
      convertLegacyDoc: () => {
        called = true;
      }
    })
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(called).toBe(false);
});

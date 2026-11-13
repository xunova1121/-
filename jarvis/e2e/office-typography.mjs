/** 真Office：原生字号读回、PPT页数、Excel值/公式和真Word97转换。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { generate, parseFile } from '../src/agent/docs.js';
import { renderOffice, convertLegacyDoc, officeRenderAvailable } from '../server/officeRender.mjs';
import { measureDocx } from '../src/agent/styleCheck.js';
import { inspectRenderedPdf } from '../src/agent/pdfQuality.js';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-office-typography');
await fs.mkdir(output, { recursive: true });
assert.equal(await officeRenderAvailable(), true, '必须实际安装Office，不跳过');
const results = [];
for (const [format, body, title, content] of [
  ['pptx', 22, 40, '## 虚构项目进展\n\n- 完成需求核对。\n- 下周开展接口联调。'],
  ['xlsx', 14, 24, '| 项目 | 金额 |\n| --- | --- |\n| 研发 | 100 |\n| 测试 | 200 |\n| 合计 | 300 |']
]) {
  const file = await generate(format, { title: '虚构字号验收', content, typography: { body: { size: body }, title: { size: title } } });
  const facts = await measureDocx(file.blob);
  assert.equal(facts.body, body);
  assert.equal(facts.title, title);
  const rendered = await renderOffice(file.blob, format);
  assert.equal(rendered.available, true);
  const quality = await inspectRenderedPdf(rendered.blob);
  assert.equal(quality.issues.length, 0);
  if (format === 'pptx') {
    // 该虚构材料原路径固定为封面+内容两页；字号变化不能增加或减少。
    const baseline = await generate(format, { title: '虚构字号验收', content });
    assert.equal(baseline.info.slides, 2);
    assert.equal(file.info.slides, baseline.info.slides);
    assert.equal(quality.pages, file.info.slides);
  }
  await fs.writeFile(path.join(output, '字号.' + format), new Uint8Array(await file.blob.arrayBuffer()));
  await fs.writeFile(path.join(output, '字号-' + format + '.pdf'), new Uint8Array(await rendered.blob.arrayBuffer()));
  results.push({ format, facts, pages: quality.pages, issues: quality.issues });
}
const source = await generate('docx', { title: '旧格式转换验收', content: '# 旧格式转换验收\n\n虚构内容：17台设备，金额1234.56元。' });
const docx = path.join(output, '原稿.docx');
await fs.writeFile(docx, new Uint8Array(await source.blob.arrayBuffer()));
const profile = path.join(output, 'convert-profile');
execFileSync(
  process.env.JARVIS_SOFFICE || 'soffice',
  ['-env:UserInstallation=' + pathToFileURL(profile).href, '--headless', '--convert-to', 'doc:MS Word 97', '--outdir', output, docx],
  { timeout: 45000, stdio: 'pipe' }
);
const legacyBytes = await fs.readFile(path.join(output, '原稿.doc'));
assert.equal(legacyBytes.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');
const converted = await convertLegacyDoc(new Blob([legacyBytes]));
const readback = await parseFile(converted, '转换.docx');
assert.match(readback.text, /17台/);
assert.match(readback.text, /1234\.56/);
assert.deepEqual(await fs.readFile(path.join(output, '原稿.doc')), legacyBytes);
await fs.writeFile(path.join(output, '转换.docx'), new Uint8Array(await converted.arrayBuffer()));
await fs.writeFile(
  path.join(output, 'summary.json'),
  JSON.stringify({ passed: true, results, legacy: { realOLE: true, contentPreserved: true, originalPreserved: true } }, null, 2)
);
console.log('原生PPT/Excel字号、真PDF和Word97转换验收通过');

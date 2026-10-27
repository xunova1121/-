/** 虚构架构图的真实Office保存、重开与修改核验，不调用外部模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { renderOffice } from '../server/officeRender.mjs';
import { inspectNativeDiagram } from '../src/agent/diagramPptxStructure.js';
const execFile = promisify(callback);
const output = path.resolve(process.argv[2] || '/tmp/architecture-editable');
await fs.mkdir(output, { recursive: true });
await execFile(process.execPath, ['e2e/architecture-logic.mjs', output], { env: { ...process.env, ARCHITECTURE_NATIVE: '1' }, timeout: 120000 });
const receipt = JSON.parse(await fs.readFile(path.join(output, 'receipt.json')));
assert.equal(receipt.editable.passed, true);
const input = path.join(output, path.basename(receipt.primaryEditablePath));
const original = new Blob([await fs.readFile(input)]);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-editable-'));
try {
  const zip = await JSZip.loadAsync(await original.arrayBuffer());
  const file = 'ppt/slides/slide1.xml';
  let xml = await zip.file(file).async('string');
  assert.ok(xml.includes('预警研判'));
  xml = xml.replace('预警研判', '预警复核');
  let moved = false;
  xml = xml.replace(/(name="节点 alert"[\s\S]*?<p:grpSpPr><a:xfrm><a:off x=")(\d+)(" y="\d+"\/><a:ext)/, (_, before, x, after) => {
    moved = true;
    return before + (Number(x) + 203200) + after; // 16pt，保持组内坐标不变，只移动整个节点。
  });
  assert.ok(moved, '必须实际移动节点组');
  zip.file(file, xml);
  const changed = path.join(dir, 'edited.pptx');
  await fs.writeFile(changed, await zip.generateAsync({ type: 'nodebuffer' }));
  const saved = path.join(dir, 'saved');
  await fs.mkdir(saved);
  await execFile(
    process.env.JARVIS_SOFFICE || 'soffice',
    [
      '-env:UserInstallation=' + pathToFileURL(path.join(dir, 'profile')).href,
      '--headless',
      '--convert-to',
      'pptx:Impress MS PowerPoint 2007 XML',
      '--outdir',
      saved,
      changed
    ],
    { timeout: 45000, maxBuffer: 64000 }
  );
  const reopened = new Blob([await fs.readFile(path.join(saved, 'edited.pptx'))]);
  const info = await inspectNativeDiagram(reopened);
  const reopenedZip = await JSZip.loadAsync(await reopened.arrayBuffer());
  const reopenedXml = await reopenedZip.file(file).async('string');
  const connectorX = (value) => Number(/<p:cxnSp>[\s\S]*?<a:xfrm[^>]*><a:off x="(\d+)"/.exec(value)?.[1]);
  assert.ok(Math.abs(connectorX(reopenedXml) - connectorX(xml) - 203200) < 10000, '节点移动后真实Office必须同步连接线起点');
  assert.ok(info.nodeGroups >= 3 && info.anchoredEnds >= 4, '真实保存后不能扁平化或丢失连接锚点');
  const positions = [];
  for (const [index, blob] of [original, reopened].entries()) {
    const rendered = await renderOffice(blob, 'pptx');
    assert.equal(rendered.available, true);
    const pdf = path.join(dir, index + '.pdf');
    await fs.writeFile(pdf, new Uint8Array(await rendered.blob.arrayBuffer()));
    const { stdout } = await execFile('pdftotext', ['-bbox', pdf, '-'], { timeout: 20000, maxBuffer: 2e6 });
    const word = [...stdout.matchAll(/<word xMin="([\d.]+)"[^>]*>([^<]*)<\/word>/g)].find((match) => match[2].includes(index ? '预警复核' : '预警研判'));
    assert.ok(word, '实际PDF必须含可修改的正文文字');
    positions.push(Number(word[1]));
    if (index) await fs.copyFile(pdf, path.join(output, '编辑后重新打开.pdf'));
  }
  assert.ok(Math.abs(positions[1] - positions[0] - 16) < 1, '节点组移动应反映到真实渲染文字坐标');
  await fs.copyFile(path.join(saved, 'edited.pptx'), path.join(output, '编辑后重新打开.pptx'));
  await fs.writeFile(
    path.join(output, 'edit-check.json'),
    JSON.stringify(
      {
        engine: 'LibreOffice',
        textChanged: true,
        connectorFollows: true,
        movedPoints: positions[1] - positions[0],
        structure: info,
        nativeComparison: receipt.editable
      },
      null,
      2
    )
  );
  console.log('真实Office保存重开：文字修改、节点移动、原生分组、连接锚点保留；非Windows/WPS真机验收');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

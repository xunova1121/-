/** 已生成业务闭环PPT真实保存/重开后仍保持折返点；不调松原像素门槛。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { compareDiagramPpt } from '../server/diagramCompare.mjs';
import { inspectNativeDiagram } from '../src/agent/diagramPptxStructure.js';
const output = path.resolve(process.argv[2]);
const receipt = JSON.parse(await fs.readFile(path.join(output, 'receipt.json')));
const view = receipt.completedViews.find(item => item.view === 'workflow');
assert.ok(view);
const ppt = view.files.find(item => item.path.endsWith('-可编辑.pptx'));
assert.ok(ppt);
const input = path.join(output, 'workflow', path.basename(ppt.path));
const reference = new Blob([await fs.readFile(path.join(output, 'workflow', path.basename(view.previewPath)))]);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-bends-'));
try {
  const saved = path.join(directory, 'saved'); await fs.mkdir(saved);
  await promisify(execFile)(process.env.JARVIS_SOFFICE || 'soffice', ['-env:UserInstallation=' + pathToFileURL(path.join(directory, 'profile')).href, '--headless', '--convert-to', 'pptx:Impress MS PowerPoint 2007 XML', '--outdir', saved, input], { timeout: 45000, maxBuffer: 64000 });
  const reopened = new Blob([await fs.readFile(path.join(saved, path.basename(input)))]);
  const structure = await inspectNativeDiagram(reopened);
  assert.ok(structure.connectors >= 5 && structure.anchoredEnds >= 10);
  const compare = await compareDiagramPpt(reopened, reference);
  await fs.writeFile(path.join(output, 'bend-reopen-check.json'), JSON.stringify({ structure, compare }, null, 2));
  await fs.writeFile(path.join(output, '闭环-保存重开.pptx'), new Uint8Array(await reopened.arrayBuffer()));
  assert.equal(compare.passed, true);
  console.log('通过：业务闭环折返线真实Office保存重开后保留锚点和路径，仍满足原像素对照门槛。');
} finally { await fs.rm(directory, { recursive: true, force: true }); }

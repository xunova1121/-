/** 真实渲染验证；模型决策/视觉为受控协议，真实服务商及设备验收必须另记。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
import { useBackend, collection } from '../src/agent/store.js';
import { createFileStore } from '../server/fileStore.mjs';
import { createPosterTool } from '../src/agent/posterTool.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { runAgent } from '../src/agent/agent.js';
import { planLayerDesign } from '../src/agent/layeredDesignLayout.js';
import { fitDesignText } from '../src/agent/layeredDesignInput.js';
import { preflightPosterInput } from './fixtures/poster-preflight.mjs';
import * as ws from '../src/agent/workspace.js';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-poster-preflight');
await fs.mkdir(output, { recursive: true });
const store = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-preflight-store-'));
useBackend(createFileStore(store));
const check = (label, condition) => { assert.ok(condition, label); console.log('✓ ' + label); checks.push(label); };
const checks = [];
// CI用原创程序结构示意；本机可传真实生成素材。两者必须在报告中分列。
const canvas = createCanvas(700, 700), c = canvas.getContext('2d');
c.fillStyle = '#EAF0F9'; c.fillRect(0, 0, 700, 700);
for (let i = 0; i < 4; i++) { c.fillStyle = ['#CCDDF2', '#A4C4E9', '#6D9AD6', '#185BB5'][i]; c.fillRect(110 + i * 25, 90 + i * 100, 390, 70); }
c.strokeStyle = '#173454'; c.lineWidth = 12; c.beginPath(); c.moveTo(120, 550); c.lineTo(250, 630); c.lineTo(590, 540); c.stroke();
const imageBytes = process.argv[3] ? await fs.readFile(process.argv[3]) : canvas.toBuffer('image/png');
await ws.write('素材/结构示意.png', new Blob([imageBytes], { type: 'image/png' }));
const input = preflightPosterInput();
let before;
try { planLayerDesign(input); } catch (error) { before = { code: error.code, issues: error.issues }; }
check('同题材自由稿在严格旧排版下确实有多个文字框错误', before?.issues.length >= 4);
let visionCalls = 0;
const ctx = { renderVisualScene, visionLlm: async () => {
  visionCalls++;
  return JSON.stringify({ copyMatches: true, readable: true, noOverlap: true, visualsPresent: true, relatedToTopic: true, integrated: true, issues: [] });
} };
const poster = createPosterTool(ctx), demoTool = createVisualDemoTool(ctx), sessionId = 'poster-preflight-e2e';
await collection('sessions').put({ id: sessionId, title: '自由稿失败复现', messages: [] });
let calls = 0, receipt;
const adapter = { async stream({ messages, onText }) {
  if (++calls === 1) return { text: '', stop: 'tool_use', toolCalls: [{ id: 'poster', name: 'make_poster', args: input }] };
  receipt = JSON.parse([...messages].reverse().find(m => m.role === 'tool').content);
  const result = '已生成排版测试成品；视觉服务使用受控回执，未验证实际服务商。';
  onText?.(result); return { text: result, stop: 'end_turn', toolCalls: [] };
} };
await runAgent({ adapter, tools: [poster, demoTool], model: 'controlled-protocol', userText: '做一张图文并茂的提示词结构宣传海报', history: [],
  sessionId, context: { dynamic: '设计验收，来源未经官方核实。', kbHits: [] }, emit() {}, maxSteps: 8 });
check('真实执行链首次调用完成，不耗纠正次数或新增模型重试', receipt.status === 'complete' && receipt.delivery.attempts === 1 && receipt.delivery.corrections === 0 && visionCalls === 1);
const sourcePath = receipt.designPath || receipt.delivery.sourceFiles?.find(p => /design.json$/.test(p));
// 发送预算可能省略路径；源稿从真实交付PNG同目录取，不猜远端文件。
const actualSource = sourcePath || receipt.files.find(f => f.format === 'png').path.replace(/\.png$/, '.design.json');
const source = JSON.parse(await ws.readText(actualSource));
for (const node of source.layers.filter(n => n.type === 'text')) {
  const original = input.design.layers.find(n => n.id === node.id);
  assert.equal(node.text, original.text);
  assert.equal(fitDesignText(node).rows.join(''), original.text.replace(/\n/g, ''));
}
check('长英文/原数字/完整页脚逐字保留，坐标与明确画幅不改', source.width === 1080 && source.height === 2560 && source.layers.every(n => {
  const old = input.design.layers.find(o => o.id === n.id); return n.x === old.x && n.y === old.y && n.w === old.w;
}));
const demo = JSON.parse(await demoTool.run({ source_path: actualSource }, { executionScope: {}, sessionId, rawRequestText: '补个Demo' }));
check('旧源稿原样补Demo与同一作品续接', demo.status === 'complete' && demo.delivery.id === receipt.delivery.id);
for (const file of demo.files) await fs.writeFile(path.join(output, '提示词设计观察.' + file.format), new Uint8Array(await (await ws.readBlob(file.path)).arrayBuffer()));
await fs.writeFile(path.join(output, '手机预览.png'), new Uint8Array(await (await ws.readBlob(demo.phonePreview.path)).arrayBuffer()));
await fs.writeFile(path.join(output, '源稿.design.json'), JSON.stringify(source, null, 2));
execFileSync('soffice', ['-env:UserInstallation=file://' + path.join(output, 'lo'), '--headless', '--convert-to', 'pdf', '--outdir', output, path.join(output, '提示词设计观察.pptx')], { timeout: 60000, stdio: 'pipe' });
const pdf = execFileSync('pdftotext', [path.join(output, '提示词设计观察.pdf'), '-'], { encoding: 'utf8' }).replace(/\s/g, '');
check('实际PPTX转PDF仍含长英文、数字与完整三行来源说明', ['legal_and_financial_advice', '03', '官方来源未核实', '文字由程序排版', '不能代替原文核查'].every(s => pdf.includes(s)));
await fs.writeFile(path.join(output, '验收记录.json'), JSON.stringify({ checks, before, receipt, demo, sourcePath: actualSource,
  input, assetSha256: createHash('sha256').update(imageBytes).digest('hex'), assetKind: process.argv[3] ? 'provided-real-asset' : 'program-illustration-fixture',
  vision: 'controlled-protocol', providerTested: false, deviceTested: false }, null, 2));
console.log(JSON.stringify({ checks: checks.length, output, providerTested: false, deviceTested: false }));

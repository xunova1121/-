/** 实际海报缩图，而不是另排的Demo卡片；受控素材/模型只验证调用链，不冒充真实GPT审美验收。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { chromium } from 'playwright';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { createPosterTool } from '../src/agent/posterTool.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { imageInfo } from '../src/agent/imageInfo.js';
import { runAgent } from '../src/agent/agent.js';
import { createTools } from '../src/agent/tools.js';
import { checkDesignPresentation } from '../src/agent/layeredDesignPresentation.js';
import { fitDesignText } from '../src/agent/layeredDesignInput.js';
import { newsInput } from './fixtures/layered-design.mjs';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-poster-reading');
await fs.mkdir(output, { recursive: true });
await fs.rm(path.join(output, 'failure.json'), { force: true });
const store = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-reading-store-'));
useBackend(createFileStore(store));
const checks = [], products = [];
const check = (label, pass, detail) => { checks.push({ label, pass: Boolean(pass) }); console.log(`${pass ? '✓' : '✗'} ${label}`); assert.ok(pass, label + (detail ? ': ' + JSON.stringify(detail) : '')); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ctx = { renderVisualScene }, poster = createPosterTool(ctx), demo = createVisualDemoTool(ctx);
const copy = { ...newsInput, title: '今日要闻', subtitle: '七个切面，看见城市新变化', footer: '版式验收样张 · 非真实新闻 · 未调用真实生图服务' };
let browser;

async function makeArt() {
  // 原创受控玻璃球与城市插画，专门不画标题、新闻卡片和空占位框。
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200"><defs><radialGradient id="bg"><stop stop-color="#E0F2FF"/><stop offset="1" stop-color="#EEF6FF"/></radialGradient><radialGradient id="orb" cx=".3" cy=".25"><stop stop-color="#FFFFFF"/><stop offset=".48" stop-color="#C8E6FF"/><stop offset="1" stop-color="#80B8F2"/></radialGradient><linearGradient id="wave" x2="1" y2=".5"><stop stop-color="#B1DEFF"/><stop offset="1" stop-color="#126EE1"/></linearGradient></defs><rect width="1200" height="1200" fill="url(#bg)"/><g opacity=".18" fill="#4B94D8">' + Array.from({ length: 16 }, (_, i) => `<rect x="${i * 80}" y="${680 - i % 5 * 36}" width="48" height="${230 + i % 5 * 36}"/>`).join('') + '</g><circle cx="650" cy="510" r="326" fill="url(#orb)" stroke="#FFFFFF" stroke-width="5"/><g fill="none" stroke="#FFFFFF" opacity=".8" stroke-width="3"><ellipse cx="650" cy="510" rx="160" ry="326"/><ellipse cx="650" cy="510" rx="270" ry="326"/><ellipse cx="650" cy="510" rx="326" ry="110"/><ellipse cx="650" cy="510" rx="326" ry="230"/></g><ellipse cx="650" cy="570" rx="470" ry="146" transform="rotate(-22 650 570)" fill="none" stroke="#126EE1" stroke-width="22" opacity=".72"/><path d="M-100 940Q430 690 730 850T1300 820V1200H-100Z" fill="url(#wave)" opacity=".7"/><path d="M-100 1010Q500 790 800 950T1300 930" fill="none" stroke="#FFFFFF" stroke-width="32" opacity=".85"/><g fill="#206FD0"><circle cx="395" cy="310" r="14"/><circle cx="890" cy="590" r="14"/><circle cx="535" cy="720" r="11"/></g></svg>';
  const page = await browser.newPage();
  const data = await page.evaluate(async raw => {
    const image = new Image(); image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(raw); await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    canvas.getContext('2d').drawImage(image, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
  }, svg);
  await page.close();
  const bytes = Buffer.from(data, 'base64');
  await ws.write('阅读验收/art.png', new Blob([bytes], { type: 'image/png' }));
  await fs.writeFile(path.join(output, 'art.png'), bytes);
  return bytes;
}
async function deliver(name, input, tool = poster) {
  const receipt = JSON.parse(await tool.run({ ...input, path: `阅读验收/${name}.png` }));
  check(name + '：实际各格式/原文/字体/对比/阅读尺度全部通过', receipt.status === 'complete' && receipt.copyCheck.status === 'passed' && receipt.fontCheck === 'passed' && receipt.contrast.status === 'passed' && receipt.presentation.status === 'passed', receipt);
  check(name + '：正文按390px整图宽度至少12px', receipt.presentation.previewWidth === 390 && receipt.presentation.minimumBodyPixels >= 12, receipt.presentation);
  const design = JSON.parse(await ws.readText(receipt.designPath));
  for (const section of copy.design.sections) check(name + '：保留原文“' + section.title + '”', design.layers.some(n => n.text === section.title) && design.layers.some(n => n.text === section.body));
  for (const file of receipt.files) await fs.writeFile(path.join(output, `${name}.${file.format}`), Buffer.from(await (await ws.readBlob(file.path)).arrayBuffer()));
  await fs.writeFile(path.join(output, `${name}.design.json`), JSON.stringify(design, null, 2));
  const preview = Buffer.from(await (await ws.readBlob(receipt.phonePreview.path)).arrayBuffer());
  const dimensions = imageInfo(preview);
  check(name + '：真实手机缩图已生成并核对像素', dimensions.width === 390 && dimensions.height === Math.ceil(design.height * 390 / design.width));
  await fs.writeFile(path.join(output, `${name}.phone.png`), preview);
  const zip = await JSZip.loadAsync(await (await ws.readBlob(receipt.files.find(f => f.format === 'pptx').path)).arrayBuffer());
  const xml = await zip.file('ppt/slides/slide1.xml').async('string');
  check(name + '：PPTX独立文字对象，七条标题仍可编辑', (xml.match(/<a:t>/g) || []).length >= 15 && copy.design.sections.every(s => xml.includes(s.title)));
  const item = { name, receipt, design }; products.push(item); return item;
}
async function mobileView(item) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const data = await fs.readFile(path.join(output, item.name + '.png'));
  await page.setContent('<!doctype html><style>*{box-sizing:border-box}body{margin:0;background:#EEF6FF}img{display:block;width:100%;height:auto}</style><img alt="整张海报" src="data:image/png;base64,' + data.toString('base64') + '">');
  await page.locator('img').evaluate(image => image.decode());
  const geometry = await page.locator('img').boundingBox();
  check(item.name + '：浏览器按手机整图宽度显示，没有放大/隐藏正文', geometry.width === 390 && Math.abs(geometry.height - item.design.height * 390 / item.design.width) < 1);
  await page.screenshot({ path: path.join(output, item.name + '-mobile.png'), fullPage: true });
  await page.close();
}
async function tinyReproduction() {
  // 原小字负例走严格模式，继续验证原阅读门禁；另用同稿验证新增自动适配，不能降低字号阈值。
  const args = { title: '今日要闻', width: 1024, height: 1536, design: { layout: 'free', text_fit: 'strict', layers: [
    { id: 'title', type: 'text', x: 60, y: 80, w: 900, h: 120, fontSize: 72, text: '今日要闻' },
    { id: 'news-body', type: 'text', x: 60, y: 860, w: 900, h: 80, fontSize: 16, text: '这段正文不重叠、对比高，但缩到手机上仍然太小。' }
  ] } };
  const receipt = JSON.parse(await poster.run({ ...args, path: '阅读验收/tiny-reproduction.png' }));
  check('复现稿：原字体、原文、几何和像素对比通过', receipt.fontCheck === 'passed' && receipt.copyCheck.status === 'passed' && receipt.layoutCheck.status === 'passed' && receipt.contrast.status === 'passed', receipt);
  check('复现稿：仍被实际阅读尺度拦住，不能标complete', receipt.status === 'partial' && receipt.presentation.status === 'failed' && receipt.errors.some(e => e.code === 'DESIGN_PRESENTATION_UNREADABLE'));
  const before = await ws.readText(receipt.designPath);
  const automatic = JSON.parse(await poster.run({ ...args, design: { ...args.design, text_fit: 'auto' }, path: '阅读验收/tiny-auto-fitted.png' }));
  const automaticDesign = JSON.parse(await ws.readText(automatic.designPath));
  const body = automaticDesign.layers.find(n => n.id === 'news-body');
  check('同一小字稿自动适配后实际字号达标，原阅读门槛不降低', automatic.status === 'complete' && automatic.presentation.status === 'passed' && fitDesignText(body).fontSize * 390 / automaticDesign.width >= 12, automatic);
  check('自动适配保留原文、坐标与画幅，旧严格稿原件不改', body.text === args.design.layers[1].text && body.x === 60 && body.y === 860 && body.w === 900 && automaticDesign.width === 1024 && automaticDesign.height === 1536 && await ws.readText(receipt.designPath) === before);
  const autoPng = Buffer.from(await (await ws.readBlob(automatic.files.find(file => file.format === 'png').path)).arrayBuffer());
  const autoPreview = Buffer.from(await (await ws.readBlob(automatic.phonePreview.path)).arrayBuffer());
  await fs.writeFile(path.join(output, 'tiny-auto-fitted.png'), autoPng);
  await fs.writeFile(path.join(output, 'tiny-auto-fitted.phone.png'), autoPreview);
  check('自动适配交付原画幅PNG与390px实际手机缩图', imageInfo(autoPng).width === 1024 && imageInfo(autoPng).height === 1536 && imageInfo(autoPreview).width === 390);
  const revised = JSON.parse(await poster.run({ source_path: receipt.designPath, changes: [{ id: 'news-body', fontSize: 36, minFontSize: 36, h: 140 }], path: '阅读验收/tiny-repaired.png' }));
  check('只调整文字框字号可修复，不重画；原稿字节不变', revised.status === 'complete' && revised.presentation.status === 'passed' && await ws.readText(receipt.designPath) === before, revised);
  return receipt.presentation;
}
async function actualFollowup(art) {
  let calls = 0, imageCalls = 0, actualPrompt;
  const tools = createTools({ ...ctx, imageGen: async ({ prompt, beforeRequest }) => { imageCalls++; actualPrompt = prompt; beforeRequest?.(); return { blob: new Blob([art], { type: 'image/png' }), model: 'fixture' }; } });
  const adapter = { async stream({ system, tools: active, messages, onText }) {
    calls++;
    check('短追问实际模型请求带自由构图说明与完整layers schema', JSON.stringify(system).includes('当前工具明确支持自由构图') && active.some(t => t.name === 'make_poster' && t.input_schema.properties.design.properties.layers.items.properties.x));
    if (calls === 1) return { text: '', toolCalls: [{ id: 'art', name: 'generate_image', args: { prompt: '浅蓝科技场景和玻璃球，仅视觉主体', size: '1200x1200' } }], stop: 'tool_use' };
    if (calls === 2) {
      const last = messages.filter(m => m.role === 'tool').at(-1);
      check('生图实际回执回传到下一次模型请求，未因包装丢失关联', last?.name === 'generate_image' && JSON.parse(last.content).readback === 'passed');
      return { text: '', toolCalls: [{ id: 'poster', name: 'make_poster', args: { ...copy, design: { ...copy.design, layout: 'timeline' }, path: '阅读验收/followup.png' } }], stop: 'tool_use' };
    }
    if (calls === 3) {
      const last = messages.filter(m => m.role === 'tool').at(-1);
      check('海报完成回执实际回传，模型可读真实格式和检查状态', last?.name === 'make_poster' && JSON.parse(last.content).status === 'complete');
    }
    const text = '已生成同源PNG、SVG和可编辑PPTX；视觉模型未配置，不能称已通过实际模型审美验收。';
    onText(text); return { text, toolCalls: [], stop: 'end_turn' };
  } };
  await runAgent({ adapter, tools, model: 'fixture', userText: '换结构，不动颜色', history: [{ role: 'user', content: '做今日新闻海报' }, { role: 'assistant', content: '上次海报源稿为阅读验收/新闻.design.json。' }], context: { dynamic: '' }, emit() {}, quiet: true });
  check('实际执行层补素材用途：一次生图请求包含禁文字和空框约束', imageCalls === 1 && actualPrompt.includes('不要任何文字') && actualPrompt.includes('空胶囊框'));
  check('短追问实际调用海报链，生成源稿而非只写SVG', await ws.exists('阅读验收/followup.design.json'));
}
async function office(item) {
  const dir = path.join(output, 'office'); await fs.mkdir(dir, { recursive: true });
  execFileSync('soffice', ['-env:UserInstallation=file://' + path.join(output, 'office-profile'), '--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(output, item.name + '.pptx')], { timeout: 60000, stdio: 'pipe' });
  const pdf = path.join(dir, item.name + '.pdf');
  // PDF全页抽字会把双栏的同行交错拼起来；按真实图层区域逐段核对，不因跨栏而误报丢字。
  const regions = item.design.layers.filter(n => n.type === 'text' && /^section-\d+-(?:title|body)$/.test(n.id));
  const retained = regions.every(n => {
    const args = ['-r', '72', '-x', String(Math.max(0, Math.floor(n.x * 0.75) - 2)), '-y', String(Math.max(0, Math.floor(n.y * 0.75) - 2)), '-W', String(Math.ceil(n.w * 0.75) + 4), '-H', String(Math.ceil(n.h * 0.75) + 4), '-layout', pdf, '-'];
    const text = execFileSync('pdftotext', args, { encoding: 'utf8' }).replace(/\s/g, '');
    return text.includes(n.text.replace(/\s/g, ''));
  });
  check('宣传海报实际Office导出保留全部七条标题和正文', regions.length === 14 && retained);
  execFileSync('pdftoppm', ['-scale-to', '1440', '-singlefile', '-png', path.join(dir, item.name + '.pdf'), path.join(dir, item.name)], { timeout: 60000 });
}
try {
  browser = await chromium.launch({ headless: true });
  const art = await makeArt();
  const campaign = await deliver('campaign', { ...copy, design: { ...copy.design, layout: 'campaign', assets: [{ id: 'hero', path: '阅读验收/art.png' }] } });
  const timeline = await deliver('timeline', { ...copy, design: { ...copy.design, layout: 'timeline' } });
  const newspaper = await deliver('newspaper', { ...copy, design: { ...copy.design, layout: 'newspaper' } });
  check('同一配色可真正换结构，非只换色', timeline.design.palette.background === newspaper.design.palette.background && timeline.design.layers.some(n => n.id === 'timeline-spine') && newspaper.design.layers.some(n => n.id === 'newspaper-divider'));
  for (const item of [campaign, timeline, newspaper]) await mobileView(item);
  const scene = await deliver('campaign-demo', { source_path: campaign.receipt.designPath }, demo);
  const originalPng = await fs.readFile(path.join(output, 'campaign.png')), demoPng = await fs.readFile(path.join(output, 'campaign-demo.png'));
  check('同稿Demo复用原海报与素材，无重新生图和改写标题', hash(originalPng) === hash(demoPng) && hash(Buffer.from(await (await ws.readBlob('阅读验收/art.png')).arrayBuffer())) === hash(art));
  check('同稿Demo HTML、ZIP真实生成', scene.receipt.files.some(f => f.format === 'html') && scene.receipt.files.some(f => f.format === 'zip'));
  const tiny = await tinyReproduction();
  await actualFollowup(art);
  await office(campaign);
  check('实际源稿可重读且保留手机阅读声明', checkDesignPresentation(JSON.parse(await ws.readText(campaign.receipt.designPath))).status === 'passed');
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', checks, products: products.map(p => ({ name: p.name, receipt: p.receipt })), reproduction: tiny, limitations: ['生图和主对话为受控替身，未调用真实GPT服务', '浏览器390px整图与真实Office导出，不是用户手机/微信真机', '几何尺度不等于审美合格；未配置视觉模型时不称视觉通过'] }, null, 2));
  console.log('完成 ' + checks.length + ' 项，产物 ' + output);
} catch (error) {
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks }, null, 2));
  throw error;
} finally { await browser?.close(); useBackend(null); await fs.rm(store, { recursive: true, force: true }); }

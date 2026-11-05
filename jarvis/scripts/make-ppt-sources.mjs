/**
 * 离线制作可编辑样板；借鉴 MIT hugohe3/ppt-master 的通用版式比例，未复制品牌/照片。
 * 固定来源、完整许可在 src/assets/ppt-sources/SOURCES.md 与 LICENSE.txt。
 * 只在开发时运行，不替换 App 的文档生成器。所有文字/图形都是原生可编辑元素。
 */
import pptxgen from 'pptxgenjs';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/assets/ppt-sources');
const render = process.argv[2] || '/tmp/weiyang-ppt-sources-render';
await fs.mkdir(out, { recursive: true });
await fs.mkdir(render, { recursive: true });
const license = await fs.readFile(path.join(out, 'LICENSE.txt'), 'utf8');
const source = 'https://github.com/hugohe3/ppt-master/tree/f3633771fe699d327f02ae86393831bbcf5169f7/skills/ppt-master/templates';
const palettes = [
  { id: 'source-teal', name: '墨青 · 战略咨询', title: '把复杂问题\n变成清晰决策', en: 'STRATEGY / INSIGHT / ACTION', accent: '0F766E', ink: '123A39', tint: 'E9F2EE', paper: 'F8FAF8', tag: '战略咨询', motif: 'steps' },
  { id: 'source-cobalt', name: '钴蓝 · 产品发布', title: '下一步创新\n从此刻开始', en: 'DESIGN THE NEXT CHAPTER', accent: '2455EF', ink: '14264D', tint: 'EDF1FF', paper: 'FAFBFF', tag: '产品发布', motif: 'orbit' },
  { id: 'source-gold', name: '曜金 · 项目路演', title: '看见价值\n共赴下一程', en: 'A NEW PERSPECTIVE ON GROWTH', accent: 'C99F5E', ink: '242723', tint: 'EFE9DB', paper: 'FBFAF6', tag: '项目路演', motif: 'arch' },
  { id: 'source-lilac', name: '雾紫 · 品牌提案', title: '让好的想法\n被世界看见', en: 'MAKE IDEAS MEAN SOMETHING', accent: '7557BD', ink: '332949', tint: 'F0EAF8', paper: 'FCFAFE', tag: '品牌提案', motif: 'layers' }
];
const manifest = [];
for (const p of palettes) {
  const ppt = new pptxgen();
  ppt.layout = 'LAYOUT_WIDE';
  ppt.author = '未央 WEIYANG AI'; ppt.subject = `${p.name} / 开源版式适配样板 / 示例内容`;
  ppt.title = p.name; ppt.company = 'WEIYANG AI'; ppt.lang = 'zh-CN';
  ppt.theme = { headFontFace: 'Noto Sans CJK SC', bodyFontFace: 'Noto Sans CJK SC', lang: 'zh-CN' };
  const rect = (s, x, y, w, h, fill, extra = {}) => s.addShape(ppt.ShapeType.rect, { x, y, w, h, line: { color: fill, transparency: 100 }, fill: { color: fill }, ...extra });
  const line = (s, x, y, w, color = p.accent) => s.addShape(ppt.ShapeType.line, { x, y, w, h: 0, line: { color, width: 1 } });
  const txt = (s, text, x, y, w, h, size = 18, color = p.ink, extra = {}) => s.addText(text, { x, y, w, h, fontSize: size, color, margin: 0, breakLine: false, fontFace: 'Noto Sans CJK SC', valign: 'mid', ...extra });
  const page = (dark = false) => {
    const s = ppt.addSlide(); s.background = { color: dark ? p.ink : p.paper };
    txt(s, 'WEIYANG  /  ' + p.tag, .55, .28, 6, .25, 9, dark ? p.tint : p.accent, { charSpacing: 1.5 });
    line(s, .55, 7.04, 12.2, dark ? '58605C' : 'D9DEDE');
    txt(s, '可编辑样板  ·  内容与数据仅作演示', .55, 7.12, 9, .18, 8, dark ? 'C6CCC8' : '737D82');
    txt(s, String(ppt._slides.length).padStart(2, '0'), 12.1, 7.1, .65, .23, 9, dark ? p.tint : p.accent, { align: 'right' });
    s.addNotes(`版式适配：${source}\n未央原创示例文字与图形；无第三方品牌/照片。\n${license}`);
    return s;
  };
  const art = (s, x, y, scale = 1) => {
    if (p.motif === 'orbit') {
      for (let i = 0; i < 5; i++) s.addShape(ppt.ShapeType.ellipse, { x: x + i * .25 * scale, y: y + i * .25 * scale, w: (4 - i * .5) * scale, h: (4 - i * .5) * scale, line: { color: i % 2 ? p.accent : 'B9C8F8', width: 9 * scale }, fill: { color: p.tint, transparency: 100 } });
      s.addShape(ppt.ShapeType.ellipse, { x: x + 2.8 * scale, y: y + .18 * scale, w: .72 * scale, h: .72 * scale, line: { transparency: 100 }, fill: { color: p.accent } });
    } else if (p.motif === 'arch') {
      for (let i = 0; i < 5; i++) {
        const c = ['675B43', '8D7750', 'AF8B54', 'CBA96F', 'E3CAA0'][i];
        rect(s, x + i * .65 * scale, y + (3 - i * .6) * scale, .5 * scale, (1 + i * .6) * scale, c);
      }
    } else if (p.motif === 'layers') {
      for (let i = 0; i < 5; i++) s.addShape(ppt.ShapeType.roundRect, { x: x + i * .32 * scale, y: y + i * .32 * scale, w: 2.65 * scale, h: 2.65 * scale, radius: .2, rotate: 10, rectRadius: .1, line: { color: 'FFFFFF', width: 1.5 }, fill: { color: ['D5C5EE','C3ADE8','AC91DA','9779CF','7557BD'][i] } });
    } else {
      for (let i = 0; i < 5; i++) rect(s, x + i * .65 * scale, y + (2.7 - i * .55) * scale, .55 * scale, (1.2 + i * .55) * scale, ['C6DCD1','A7CBB9','7CAE98','388D74',p.accent][i]);
    }
  };
  // 1: 编辑式左右分栏。标题、图形各自完整，足够留白。
  let s = page(p.id === 'source-gold');
  const dark = p.id === 'source-gold';
  txt(s, '01  /  ' + p.tag.toUpperCase(), .7, 1.52, 5.6, .32, 13, p.accent, { charSpacing: 2 });
  txt(s, p.title, .7, 2.15, 6.7, 2, 39, dark ? 'FAF8F1' : p.ink, { bold: true, lineSpacingMultiple: 1.15 });
  txt(s, p.en, .72, 4.65, 6.2, .38, 13, dark ? 'CABFA8' : '7B818C', { charSpacing: 1.5 });
  txt(s, '项目名称 / 汇报人 / 日期', .72, 5.8, 6.2, .4, 14, dark ? 'D2C5AA' : '677A7A');
  if (!dark) rect(s, 8, 1.3, 4.65, 5.1, p.tint);
  art(s, 8.25, 1.9, 1);
  // 2: 核心结论+三项证据，先看观点再看细节。
  s = page();
  txt(s, '先说结论，再展开证据', .7, 1.04, 11.7, .65, 30, p.ink, { bold: true });
  txt(s, '用一句话说明本次提案最值得关注的价值。', .72, 1.9, 11.5, .45, 17, '6F7B80');
  ['发现机会', '形成方案', '推进落地'].forEach((t, i) => {
    const x = .7 + i * 4.05;
    line(s, x, 3.07, 3.7);
    txt(s, `0${i + 1}`, x, 3.4, 3.7, .75, 37, p.accent);
    txt(s, t, x, 4.42, 3.7, .48, 24, p.ink, { bold: true });
    txt(s, ['写清问题与目标，保留关键背景。', '用事实支撑判断，讲明选择理由。', '明确负责人、节点与验收标准。'][i], x, 5.2, 3.5, .8, 17, '667677');
  });
  // 3: KPI + 原生可编辑条形图；示例数据不冒充真实业绩。
  s = page();
  txt(s, '让关键变化，一目了然', .7, 1.04, 11.7, .65, 30, p.ink, { bold: true });
  [['68%', '目标完成率'], ['+24%', '较基线改善'], ['3 项', '下一阶段重点']].forEach(([v, label], i) => {
    const x = .7 + i * 4.05; rect(s, x, 2.12, 3.7, 1.4, p.tint);
    txt(s, v, x + .22, 2.25, 3.2, .63, 32, p.accent, { bold: true });
    txt(s, label + '（示例）', x + .22, 3.03, 3.2, .25, 12, '63716D');
  });
  txt(s, '阶段进度 / 示例', .72, 3.98, 4, .35, 17, p.ink, { bold: true });
  [42, 58, 68].forEach((v, i) => {
    txt(s, ['阶段一','阶段二','阶段三'][i], .72, 4.65 + i * .53, 1.4, .3, 13);
    rect(s, 2.25, 4.65 + i * .53, 8.6, .25, p.tint);
    rect(s, 2.25, 4.65 + i * .53, 8.6 * v / 100, .25, p.accent);
    txt(s, v + '%', 11.35, 4.59 + i * .53, 1, .35, 14, p.accent, { align: 'right' });
  });
  // 4: 证据叙事页，编辑式分栏，图形均可直接改。
  s = page();
  txt(s, '把想法变成\n可执行的方案', .7, 1.32, 6, 1.5, 32, p.ink, { bold: true });
  txt(s, '从具体场景出发，回答三个问题：', .72, 3.22, 5.4, .5, 17, '667677');
  ['谁会使用？明确目标对象。','解决什么？聚焦最重要的需求。','如何验证？设定可衡量的标准。'].forEach((t, i) => {
    line(s, .72, 4.18 + i * .68, 5.1, 'DCE3E0');
    txt(s, t, .72, 4.29 + i * .68, 5.4, .43, 16);
  });
  rect(s, 7.3, 1.2, 5.3, 5.35, p.tint); art(s, 7.92, 1.72, .92);
  txt(s, '用一个清晰的视觉，说明一个关键观点', 7.7, 5.92, 4.5, .35, 12, p.accent, { align: 'center' });
  // 5: 下一步，时间线和明确行动。
  s = page(true);
  txt(s, '下一步，开始创造改变。', .7, 1.5, 11.8, .9, 35, 'FFFFFF', { bold: true });
  txt(s, '每一个好的方案，都从一个明确的行动开始。', .72, 2.65, 11.5, .5, 17, 'D0D5D1');
  line(s, .9, 4.26, 11.5, p.accent);
  ['确认方向','完成验证','持续迭代'].forEach((t, i) => {
    const x = .85 + i * 4.1;
    s.addShape(ppt.ShapeType.ellipse, { x, y: 4.15, w: .21, h: .21, line: { transparency: 100 }, fill: { color: p.accent } });
    txt(s, `0${i + 1}  ${t}`, x, 4.65, 3.6, .55, 23, 'FFFFFF', { bold: true });
    txt(s, '负责人 / 时间节点 / 交付成果', x, 5.45, 3.65, .45, 13, 'D0D5D1');
  });
  const filename = p.id + '.pptx';
  await ppt.writeFile({ fileName: path.join(out, filename) });
  // PptxGenJS 默认建立空 embeddings 目录；本样板不携带嵌入文件，打包时移除空目录。
  const zip = await JSZip.loadAsync(await fs.readFile(path.join(out, filename)));
  if (!Object.keys(zip.files).some(k => k.startsWith('ppt/embeddings/') && !zip.files[k].dir)) zip.remove('ppt/embeddings');
  await fs.writeFile(path.join(out, filename), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const buf = await fs.readFile(path.join(out, filename));
  manifest.push({ id: p.id, name: p.name, scene: p.tag, pages: 5, filename, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), license: 'MIT', source, editable: true });
  execFileSync('soffice', ['-env:UserInstallation=file:///tmp/weiyang-ppt-sources-lo', '--headless', '--convert-to', 'pdf', '--outdir', render, path.join(out, filename)], { timeout: 90000 });
  execFileSync('pdftoppm', ['-jpeg', '-scale-to', '1440', path.join(render, p.id + '.pdf'), path.join(render, p.id)], { timeout: 90000 });
  for (let n = 1; n <= 5; n++) await fs.copyFile(path.join(render, `${p.id}-${n}.jpg`), path.join(out, `${p.id}-${n}.jpg`));
  console.log(`${p.id}: 5 页原生 PPTX → PDF → JPG`);
}
const existing = await fs.readFile(path.join(out, 'catalog.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
await fs.writeFile(path.join(out, 'catalog.json'), JSON.stringify([...existing.filter(t => t.id.startsWith('reference-')), ...manifest], null, 2) + '\n');

/** 六份固定样例：真实PPT→LibreOffice PDF→Poppler PNG；素材为本地构造插画，无模型请求。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { generate, parseFile } from '../src/agent/docs.js';
import { inspectDocument } from '../src/agent/documentQuality.js';
import { renderOffice, officeRenderAvailable } from '../server/officeRender.mjs';
import { rasterizeSvg } from '../server/svgRaster.mjs';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-ppt-image-layout');
await fs.mkdir(output, { recursive: true });
const storage = await fs.mkdtemp('/tmp/weiyang-ppt-image-layout-store-');
useBackend(createFileStore(storage));
const svg = (w, h, color, index) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${color}"/><stop offset="1" stop-color="#e9f2ee"/></linearGradient><linearGradient id="water" x2="0" y2="1"><stop stop-color="#a8c9c6"/><stop offset="1" stop-color="#244b59"/></linearGradient></defs><rect width="1000" height="700" fill="url(#sky)"/><circle cx="${700 - index * 90}" cy="150" r="74" fill="#fff0cd"/><path d="M0 420L180 220 360 355 560 170 820 400 1000 310V700H0Z" fill="#7b9e9b"/><path d="M0 470L210 345 430 475 690 280 1000 440V700H0Z" fill="#375e65"/><path d="M0 520Q260 430 490 530T1000 510V700H0Z" fill="url(#water)"/><path d="M0 600Q280 525 520 625T1000 600" fill="none" stroke="#eaf3e8" stroke-width="5"/><path d="M110 530L170 350 230 530Z M170 460L170 640" fill="#1b414b" stroke="#1b414b" stroke-width="12"/><path d="M810 540L860 390 910 540Z M860 500L860 640" fill="#234953" stroke="#234953" stroke-width="10"/></svg>`;
try {
  assert.ok(await officeRenderAvailable(), '缺LibreOffice不得跳过真实渲染验收');
  const fixtures = [
    ['portrait.png', 900, 1200, '#9ab4c0', 0],
    ['landscape.png', 1600, 900, '#8caab9', 1],
    ['main.png', 1200, 900, '#98b8b2', 2],
    ['second.png', 1600, 900, '#c5c2ac', 3],
    ['third.png', 1600, 900, '#aeb8c8', 4],
    ['fourth.png', 1600, 900, '#b1c4ba', 5]
  ];
  for (const [file, w, h, color, index] of fixtures) await ws.write('images/' + file, await rasterizeSvg(svg(w, h, color, index)));
  const news = (heading, img) =>
    `## ${heading}\n\n- 产业协作：建立需求清单，明确负责人和交付时间。\n- 基础设施：优先排查关键节点，形成可复核记录。\n- 公共服务：围绕高频事项整理办理流程与反馈渠道。\n- 科技应用：先验证实际场景，再逐步扩大试点范围。\n- 风险提示：数据均为演示样本，不作为真实新闻结论。\n\n![概念插画](images/${img})`;
  const samples = [
    {
      id: '01-news',
      title: '两页新闻简报',
      content: news('协作与服务的五项观察', 'portrait.png') + '\n\n---\n\n' + news('试点与治理的五项观察', 'portrait.png'),
      pages: 2,
      expected: ['split-wide', 'split-wide'],
      terms: ['产业协作', '风险提示']
    },
    {
      id: '02-table',
      title: '图片与表格',
      content:
        '## 工作清单：职责与交付一目了然\n版式：表格\n\n| 工作事项 | 责任团队 | 交付内容 |\n|--|--|--|\n|需求梳理|业务组|需求确认单|\n|样本核对|研究组|核对记录|\n|资料归档|运营组|归档目录|\n\n![项目概念](images/portrait.png)',
      pages: 1,
      expected: ['split-wide'],
      terms: ['需求确认单', '归档目录']
    },
    {
      id: '03-hero',
      title: '一句话与横图',
      content: '## 把复杂的协作，变成清晰的下一步\n\n让每一项行动都有目标、有负责人，也有可追溯的结果。\n\n![山水概念](images/landscape.png)',
      pages: 1,
      expected: ['hero'],
      terms: ['可追溯的结果']
    },
    {
      id: '04-portrait',
      title: '要点与竖图',
      content:
        '## 从今天开始，让工作更有条理\n\n- 先确认目标，再安排工作顺序。\n- 每件事明确负责人和交付时间。\n- 把变化写进清单，保持协作透明。\n- 完成后回看结果，留下可复用经验。\n\n![竖幅插画](images/portrait.png)',
      pages: 1,
      expected: ['split'],
      terms: ['协作透明', '可复用经验']
    },
    {
      id: '05-gallery3',
      title: '三张图片',
      content: '## 三处视角，形成一组完整叙事\n\n![主视角](images/main.png)\n\n![近景](images/second.png)\n\n![远景](images/third.png)',
      pages: 1,
      expected: ['gallery-3'],
      terms: ['三处视角']
    },
    {
      id: '06-gallery4',
      title: '四张图片',
      content:
        '## 四季视角：保持统一的视觉节奏\n\n![春](images/landscape.png)\n\n![夏](images/second.png)\n\n![秋](images/third.png)\n\n![冬](images/fourth.png)',
      pages: 1,
      expected: ['gallery-4'],
      terms: ['四季视角']
    }
  ];
  const records = [];
  for (const sample of samples) {
    const out = await generate('pptx', {
      title: sample.title,
      content: sample.content,
      forbidCover: true,
      expectedSlides: sample.pages,
      style: 'minimal',
      pictureLayout: 'aesthetic',
      loadImage: async (src) => new Uint8Array(await (await ws.readBlob(src)).arrayBuffer())
    });
    const report = await inspectDocument(out.blob, sample.id + '.pptx', { info: out.info, requirements: `做${sample.pages}页含图片的PPT，每页都要图` });
    assert.equal(report.errors, 0, JSON.stringify(report));
    assert.equal(report.slides, sample.pages);
    assert.deepEqual(
      out.info.imageLayouts.map((p) => p.name),
      sample.expected
    );
    for (const p of report.presentation.pages) {
      assert.equal(p.outside, false);
      assert.ok(p.imageAreaRatio >= 0.08);
      assert.ok(p.maxCropRatio <= 0.25 + 1e-5);
      if (p.minBodyFont != null) assert.ok(p.minBodyFont >= 14);
      if (p.minTableFont != null) assert.ok(p.minTableFont >= 14);
      if (p.contentImages > 1)
        for (const i of p.images) {
          assert.ok(i.areaRatio >= 0.125 - 1e-5);
          assert.ok(i.shortSide >= 1.8);
        }
    }
    if (sample.id === '01-news')
      assert.deepEqual(
        out.info.imageLayouts.map((p) => p.imageSide),
        ['right', 'left']
      );
    const converted = await renderOffice(out.blob, 'pptx');
    assert.ok(converted.available, converted.reason);
    const pdf = converted.blob;
    await fs.writeFile(path.join(output, sample.id + '.pptx'), new Uint8Array(await out.blob.arrayBuffer()));
    await fs.writeFile(path.join(output, sample.id + '.pdf'), new Uint8Array(await pdf.arrayBuffer()));
    const pageInfo = await promisify(execFile)('pdfinfo', [path.join(output, sample.id + '.pdf')], { timeout: 15000 });
    assert.equal(Number(pageInfo.stdout.match(/Pages:\s+(\d+)/)?.[1]), sample.pages);
    const text = (await parseFile(pdf, sample.id + '.pdf', { limit: Infinity })).text.replace(/\s/g, '');
    for (const term of sample.terms) assert.ok(text.includes(term), `${sample.id}真实PDF缺少正文：${term}`);
    await promisify(execFile)('pdftoppm', ['-scale-to', '1600', '-png', sample.id + '.pdf', sample.id], { cwd: output, timeout: 30000 });
    records.push({
      id: sample.id,
      title: sample.title,
      pages: sample.pages,
      layouts: out.info.imageLayouts,
      receipt: report.presentation,
      images: (await fs.readdir(output)).filter((f) => f.startsWith(sample.id + '-') && f.endsWith('.png'))
    });
    console.log(`${sample.id}：${sample.pages}页，${sample.expected.join(' / ')}，已实际转PDF并截图`);
  }
  await fs.writeFile(
    path.join(output, '验收.json'),
    JSON.stringify({ records, modelRequested: false, scope: '固定内容/本地构造插画的真实LibreOffice渲染；不是用户服务器真实模型验收' }, null, 2)
  );
  console.log('六份样例真实渲染完成，须逐张人工看图后记录美学结论。');
} finally {
  useBackend(null);
  await fs.rm(storage, { recursive: true, force: true });
}

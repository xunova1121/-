import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { planLayerDesign } from '../src/agent/layeredDesignLayout.js';
import { normalizeLayerDesign, fitDesignText } from '../src/agent/layeredDesignInput.js';
import { composeLayeredSvg } from '../src/agent/layeredDesignSvg.js';
import { composeLayeredPptx } from '../src/agent/layeredDesignPptx.js';
import { checkLayerCopy, checkLayerOverlap, reviewLayeredDesign, applyDesignState } from '../src/agent/layeredDesignQuality.js';
import { createLayeredHtml } from '../src/agent/layeredDesignHtml.js';
import { loadLayerDesign, layerOutputBase, availableLayerOutputBase, releaseLayerOutputBase, claimLayerOutputBase } from '../src/agent/layeredDesignSource.js';
import { useBackend } from '../src/agent/store.js';
import { createPosterTool } from '../src/agent/posterTool.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import { posterReceipt, POSTER_GUIDANCE } from '../src/agent/posterRouting.js';
import { visualSceneReceipt, visualSceneRequest } from '../src/agent/visualSceneRouting.js';
import { imageFingerprint } from '../src/agent/visualEvidence.js';
import { taskToolCore } from '../src/agent/taskToolProfile.js';
import * as ws from '../src/agent/workspace.js';

const input = { title: '每一个字，都认真呈现', subtitle: '面向内容，而非锁死的模板', footer: '用户提供文案', design: { layout: 'editorial', sections: [
  { title: '绿色发展的新答案', body: '以更清楚的信息层级，呈现有依据的内容。', icon: 'leaf', category: '城市' },
  { title: '阅读，成为日常', body: '给每一条信息留出呼吸空间。', icon: 'news', category: '文化' },
  { title: '把复杂留给设计', body: '图片、文字和图表保持独立。', icon: 'chart', category: '设计' }
] } };
const parse = xml => new DOMParser().parseFromString(xml, 'text/xml');
const titleNode = { id: 'title', type: 'text', x: 24, y: 30, w: 900, h: 100, text: '自由构图', fontSize: 56 };
const free = (layers = [titleNode]) => ({ title: '自由构图', width: 960, height: 540, design: { layout: 'free', layers } });
const PNG = new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), ch => ch.charCodeAt(0))], { type: 'image/png' });

describe('分层设计内容与自由构图', () => {
  it('所有文案保持独立文字，图标和卡片不再是标题列表上的装饰贴图', () => {
    const d = planLayerDesign(input), svg = composeLayeredSvg(d);
    expect(d.layers.filter(n => n.type === 'icon')).toHaveLength(3);
    for (const section of input.design.sections) expect(d.layers.some(n => n.text === section.title)).toBe(true);
    expect(checkLayerCopy(d, svg)).toEqual({ status: 'passed', failed: [] });
    expect(checkLayerCopy(d, svg.replace('绿色', '错字'))).toMatchObject({ status: 'failed' });
    expect(checkLayerOverlap(d).status).toBe('passed');
    expect(normalizeLayerDesign(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });
  it('允许完全自由图层，不需要套起稿的固定底部文字区', () => {
    const layers = [titleNode, { id: 'aside', type: 'text', x: 550, y: 240, w: 300, h: 180, text: '自由分栏\n保留原文', fontSize: 40 },
      { id: 'badge', type: 'icon', x: 100, y: 200, w: 120, h: 120, icon: 'heart', color: '#962F1B' }];
    const d = planLayerDesign(free(layers)), svg = composeLayeredSvg(d);
    expect(d.layers.map(n => [n.id, n.x, n.y])).toEqual(layers.map(n => [n.id, n.x, n.y]));
    expect(svg).toContain('layer-badge');
    expect(svg).not.toContain('<image');
    expect(checkLayerCopy(d, svg).status).toBe('passed');
  });
  it('文字过长、越界、重复id和不支持的复杂字形均拒绝，不能截字或压扁字形', () => {
    for (const change of [{ text: '完整文字'.repeat(1000) }, { x: -1 }, { h: 1000 }, { text: '复杂\u093f' }, { fontSize: 0 }]) expect(() => planLayerDesign(free([{ ...titleNode, ...change }]))).toThrow();
    expect(() => planLayerDesign(free([titleNode, titleNode]))).toThrow(/重复/);
    const d = planLayerDesign(free([{ ...titleNode, w: 400, h: 220, text: '包含全角，标点和数字123.45', fontSize: 52 }]));
    expect(fitDesignText(d.layers[0]).rows.join('')).toBe(d.layers[0].text);
  });
  it('不制造图表/实时/地理数据，provided必须来源，过多说明不静默丢掉', () => {
    expect(() => planLayerDesign({ ...input, dataMode: 'provided' })).toThrow(/来源/);
    const d = planLayerDesign({ ...input, dataMode: 'provided', source: '用户提供文案' });
    expect(d.source).toBe('用户提供文案');
    expect(d.layers.filter(n => n.type === 'chart')).toHaveLength(0);
    expect(() => planLayerDesign({ title: '经营中心', design: { layout: 'dashboard', sections: [{ title: '说明一' }, { title: '说明二' }] } }, [3840, 2160])).toThrow(/未删除文案/);
  });
  it('原metrics/series可映射到独立图层，不能与sections混传后漏掉数据', () => {
    const args = { title: '经营指标', width: 3840, height: 2160, metrics: [{ label: '订单', value: '1,234', unit: '件' }], seriesLabel: '近两日', series: [{ label: '昨日', value: 12 }, { label: '今日', value: 18 }], design: { layout: 'dashboard' } };
    const d = planLayerDesign(args);
    expect(d.layers.some(n => n.text === '1,234件')).toBe(true);
    expect(d.layers.find(n => n.type === 'chart').points).toEqual(args.series);
    expect(() => planLayerDesign({ ...args, design: { ...args.design, sections: [{ title: '不能忽略原指标' }] } })).toThrow(/未忽略/);
  });
  it('高精度正负原值及快照保持，不被绘图坐标的三位小数舍入改变', () => {
    const points = [{ label: '昨日', value: 12.345678901 }, { label: '今日', value: -0.000123456789 }];
    const input = free([titleNode, { id: 'trend', type: 'chart', x: 60, y: 210, w: 820, h: 220, points }]);
    input.design.states = [{ label: '另一组精确原值', changes: [{ id: 'trend', points: [{ label: '昨日', value: 0.123456789012 }, { label: '今日', value: -123.456789012 }] }] }];
    const d = planLayerDesign(input);
    expect(d.layers.find(n => n.id === 'trend').points).toEqual(points);
    expect(applyDesignState(d, d.states[0]).layers.find(n => n.id === 'trend').points).toEqual(input.design.states[0].changes[0].points);
    expect(JSON.parse(JSON.stringify(d)).layers.find(n => n.id === 'trend').points).toEqual(points);
    expect(() => planLayerDesign({ ...input, width: 960.0001 })).toThrow(/原始整数/);
    expect(checkLayerCopy(d, composeLayeredSvg(d)).status).toBe('passed');
  });
  it('黑体/宋体来自真实字体白名单，GPT明确直接绘字仍保留其请求路线', async () => {
    const d = planLayerDesign({ ...input, font_family: 'serif' });
    expect(composeLayeredSvg(d)).toContain('font-family="Noto Serif CJK SC');
    const pptx = await JSZip.loadAsync(await (await composeLayeredPptx(d, new Map())).arrayBuffer());
    expect(await pptx.file('ppt/slides/slide1.xml').async('string')).toContain('Noto Serif CJK SC');
    const { textPosterRequest } = await import('../src/agent/posterRouting.js');
    expect(textPosterRequest('制作一张海报，用GPT 2.6直接画整张带字海报')).toBe(false);
    expect(textPosterRequest('制作一张海报，GPT画无字素材，然后加上准确标题')).toBe(true);
  });
  it('不接受远程素材、任意SVG/HTML图层或超量资源', () => {
    for (const layer of [{ ...titleNode, type: 'html', text: '<script>alert(1)</script>' }, { ...titleNode, type: 'path', d: 'M0 0' }]) expect(() => planLayerDesign(free([layer]))).toThrow();
    expect(() => planLayerDesign({ ...input, design: { ...input.design, assets: [{ id: 'hero', path: 'https://host/a.png' }] } })).toThrow(/工作区/);
    const d = planLayerDesign(free([{ ...titleNode, h: 240, text: '</script><img src=x onerror=alert(1)>' }]));
    expect(composeLayeredSvg(d)).toContain('&lt;/script&gt;');
  });
});

describe('各格式同源和真实编辑', () => {
  it('PPTX的文字、图标和卡片是独立对象，文案和SVG一致', async () => {
    const d = planLayerDesign(input), pptx = await composeLayeredPptx(d, new Map());
    const zip = await JSZip.loadAsync(await pptx.arrayBuffer()), xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const text = Array.from(parse(xml).getElementsByTagName('a:t')).map(n => n.textContent).join('');
    for (const node of d.layers.filter(n => n.type === 'text')) expect(text).toContain(fitDesignText(node).rows.join(''));
    expect(xml).toContain('layer-section-1-card');
    expect(xml).toContain('layer-section-1-icon');
    expect(Object.keys(zip.files).some(p => /ppt\/media\/.*\.svg$/.test(p))).toBe(true);
  });
  it('修改另存并保留原源稿、矢量图标和坐标；源图片摘要绑定路径别名', async () => {
    await ws.write('分层回归/asset.png', PNG);
    const loaded = await loadLayerDesign({ ...input, design: { ...input.design, assets: [{ id: 'hero', path: '分层回归/asset.png' }] } });
    await ws.write('分层回归/first.design.json', JSON.stringify(loaded.design));
    const sourceBefore = await ws.readText('分层回归/first.design.json');
    const revised = await loadLayerDesign({ source_path: '分层回归/first.design.json', changes: [{ id: 'title', text: '修改标题，仍是同一份设计' }] });
    expect(revised.design.title).toBe('修改标题，仍是同一份设计');
    expect(revised.design.layers.filter(n => n.type === 'icon')).toEqual(loaded.design.layers.filter(n => n.type === 'icon'));
    expect(await ws.readText('分层回归/first.design.json')).toBe(sourceBefore);
    expect(layerOutputBase({ source_path: '分层回归/first.design.json' }, revised.design)).not.toBe('分层回归/first');
    await expect(loadLayerDesign({ source_path: '分层回归/first.design.json', changes: [{ id: 'missing', text: '不能凭空改' }] })).rejects.toThrow(/存在/);
    loaded.design.assets[0].path = './分层回归/asset.png';
    loaded.design.assets[0].hash = 'a'.repeat(64);
    await ws.write('分层回归/bad.design.json', JSON.stringify(loaded.design));
    await expect(loadLayerDesign({ source_path: '分层回归/bad.design.json' })).rejects.toMatchObject({ code: 'DESIGN_ASSET_CHANGED' });
  });
  it('原稿和素材不能成为输出名，源稿过大/未知版本和任意拼接字段不通过', async () => {
    const d = planLayerDesign(input);
    expect(() => layerOutputBase({ source_path: '设计/test.design.json', path: '设计/test.png' }, d)).toThrow(/覆盖/);
    d.assets = [{ id: 'hero', path: '设计/test.png' }];
    expect(() => layerOutputBase({ path: '设计/test.png' }, d)).toThrow(/覆盖/);
    await ws.write('分层回归/invalid.design.json', JSON.stringify({ ...d, version: 2 }));
    await expect(loadLayerDesign({ source_path: '分层回归/invalid.design.json' })).rejects.toThrow(/支持/);
  });
  it('重新构图复用完整栏目与原图片，不把竖稿拉伸到横稿', async () => {
    const d = planLayerDesign(input);
    await ws.write('分层回归/reflow.design.json', JSON.stringify(d));
    const changed = await loadLayerDesign({ source_path: '分层回归/reflow.design.json', width: 1920, height: 1080, design: { layout: 'editorial' } });
    for (const section of input.design.sections) expect(changed.design.layers.some(n => n.text === section.title)).toBe(true);
    expect(changed.design.layers.find(n => n.id === 'title').fontSize).toBeGreaterThan(48);
    expect(changed.design.layers.find(n => n.id === 'section-2-card').x).not.toBe(d.layers.find(n => n.id === 'section-2-card').x);
    expect(await ws.readText('分层回归/reflow.design.json')).toBe(JSON.stringify(d));
  });
  it('海报真实入口支持size横版重新构图，不能忽略尺寸名称', async () => {
    await ws.write('分层回归/named-size.design.json', JSON.stringify(planLayerDesign(input)));
    const result = JSON.parse(await createPosterTool({ renderVisualScene: async () => { throw new Error('协议验收不使用替身像素'); } }).run({ source_path: '分层回归/named-size.design.json', size: '横版', design: { layout: 'editorial' }, path: '分层回归/named-size-wide.png' }));
    expect(result).toMatchObject({ width: 1920, height: 1080 });
    const d = JSON.parse(await ws.readText(result.designPath));
    expect(d.width).toBe(1920); expect(d.height).toBe(1080);
    for (const section of input.design.sections) expect(d.layers.some(n => n.text === section.title)).toBe(true);
  });
  it('同名新稿整组另存，源稿后缀可复用且旧文件字节不变', async () => {
    const tool = createPosterTool({ renderVisualScene: async () => { throw new Error('协议验收不代造像素'); } });
    const first = JSON.parse(await tool.run({ ...input, path: '分层回归/same-name.png' }));
    const before = await ws.readText(first.designPath), svg = await ws.readText(first.files.find(f => f.format === 'svg').path);
    const next = JSON.parse(await tool.run({ ...input, title: '第二张新稿', path: '分层回归/same-name.png' }));
    expect(next.designPath).not.toBe(first.designPath); expect(next.designPath).toMatch(/\.design\.json$/);
    expect(await ws.readText(first.designPath)).toBe(before);
    expect(await ws.readText(first.files.find(f => f.format === 'svg').path)).toBe(svg);
    expect((await loadLayerDesign({ source_path: next.designPath })).design.title).toBe('第二张新稿');
  });
  it('并发同名导出在异步检查后仍互斥，并在结束后可释放', async () => {
    const d = planLayerDesign(input), args = { path: '分层回归/concurrent.png' };
    const [a, b] = await Promise.all([availableLayerOutputBase(args, d), availableLayerOutputBase(args, d)]);
    expect(a).not.toBe(b);
    releaseLayerOutputBase(a); releaseLayerOutputBase(b);
    const again = await availableLayerOutputBase(args, d);
    expect(again).toBe('分层回归/concurrent'); releaseLayerOutputBase(again);
  });
  it('输出名预留按账号后端隔离，切换后释放仍绑定原作用域', async () => {
    const d = planLayerDesign(input), args = { path: '分层回归/scope.png' };
    const aStore = { get: async () => null }, bStore = { get: async () => null };
    let a, b;
    try {
      useBackend(aStore); a = await claimLayerOutputBase(args, d);
      useBackend(bStore); b = await claimLayerOutputBase(args, d);
      expect(a.base).toBe(b.base);
      a.release();
      const extra = await claimLayerOutputBase(args, d);
      expect(extra.base).not.toBe(b.base); extra.release();
      useBackend(aStore);
      const again = await claimLayerOutputBase(args, d);
      expect(again.base).toBe(a.base); again.release();
    } finally { a?.release(); b?.release(); useBackend(null); }
  });
  it('快照只更新明确提供的值，不能换素材/位置；改过文字不会从旧快照恢复', async () => {
    const spec = free([{ ...titleNode, text: '自由构图' }, { ...titleNode, id: 'count', y: 230, text: '128', fontSize: 64 }]);
    spec.design.states = [{ label: '下一日', changes: [{ id: 'count', text: '127' }] }];
    const d = planLayerDesign(spec), after = applyDesignState(d, d.states[0]);
    expect(after.layers.find(n => n.id === 'count').text).toBe('127');
    expect(d.layers.find(n => n.id === 'count').text).toBe('128');
    await ws.write('分层回归/state.design.json', JSON.stringify(d));
    const revised = await loadLayerDesign({ source_path: '分层回归/state.design.json', changes: [{ id: 'count', text: '120' }] });
    expect(revised.design.states[0].changes).toEqual([]);
    const recolored = await loadLayerDesign({ source_path: '分层回归/state.design.json', changes: [{ id: 'count', color: '#962F1B' }] });
    expect(recolored.design.states[0].changes).toEqual(d.states[0].changes);
    expect(() => normalizeLayerDesign({ ...d, states: [{ label: '错误', changes: [{ id: 'count', x: 10 }] }] })).toThrow(/不可修改/);
  });
  it('HTML安全内嵌原文，手机是语义文字，工具schema仅在相关任务加载', async () => {
    const d = planLayerDesign(free([{ ...titleNode, h: 240, text: '</script><img src=x onerror=alert(1)>' }]));
    const html = await createLayeredHtml({ design: d, assets: new Map() });
    expect(html).not.toContain('</script><img'); expect(html).toContain('\\u003c');
    expect(html).toContain('design-mobile'); expect(html).toContain('mobile-title');
    expect(taskToolCore({}, '今天几点').has('make_poster')).toBe(false);
    expect(taskToolCore({}, '做图文海报').has('make_poster')).toBe(true);
    expect(POSTER_GUIDANCE).toContain('不手改SVG后遗漏PPTX/JSON');
    expect(visualSceneRequest('给设计/样稿.design.json补同稿Demo')).toBe(true);
  });
});

describe('成品检查的证据与失败边界', () => {
  it('配置视觉时只核验一次实际PNG、预扣预算、禁联网/重试；不配置不冒充通过', async () => {
    const d = planLayerDesign(input), consume = vi.fn();
    expect((await reviewLayeredDesign({}, d, PNG)).status).toBe('not_checked');
    const visionLlm = vi.fn(async () => JSON.stringify({ copyMatches: true, readable: true, noOverlap: true, issues: [] }));
    expect((await reviewLayeredDesign({ visionLlm }, d, PNG, { retrieval: { consume } })).status).toBe('passed');
    expect(consume).toHaveBeenCalledWith('model'); expect(visionLlm).toHaveBeenCalledTimes(1);
    expect(visionLlm.mock.calls[0][0]).toMatchObject({ images: [expect.objectContaining({ data: expect.any(String) })], allowWebSearch: false, maxTransientRetries: 0, maxPartialRetries: 0 });
    for (const value of ['不是JSON', '{"issues":[]}', '{"copyMatches":true,"readable":null,"noOverlap":true,"issues":[]}', '{"copyMatches":true,"readable":true,"noOverlap":true,"issues":[42]}']) expect((await reviewLayeredDesign({ visionLlm: async () => value }, d, PNG)).status).toBe('not_checked');
    expect((await reviewLayeredDesign({ visionLlm: async () => '{"copyMatches":false,"readable":true,"noOverlap":true,"issues":["缺字"]}' }, d, PNG)).status).toBe('failed');
  });
  it('停止/费用预算异常向上传递；导出失败不宣称图像已完成', async () => {
    const abort = new DOMException('停止', 'AbortError');
    await expect(reviewLayeredDesign({ visionLlm: async () => { throw abort; } }, planLayerDesign(input), PNG)).rejects.toBe(abort);
    const error = Object.assign(new Error('费用边界'), { code: 'RETRIEVAL_BUDGET' });
    await expect(reviewLayeredDesign({ visionLlm: vi.fn() }, planLayerDesign(input), PNG, { retrieval: { consume() { throw error; } } })).rejects.toBe(error);
    const result = JSON.parse(await createPosterTool({ renderVisualScene: async () => { throw new Error('不能泄漏内部地址'); } }).run({ ...input, path: '分层回归/partial.png' }));
    expect(result.status).toBe('partial'); expect(result.files.map(f => f.format)).toEqual(['svg', 'pptx']);
    expect(JSON.stringify(result)).not.toContain('不能泄漏内部地址');
    expect(posterReceipt(true, JSON.stringify(result)).designPath).toBe(result.designPath);
  });
  it('Demo实际调用新分层链，原图不被改动、ZIP保持原始素材摘要', async () => {
    await ws.write('分层回归/raw.png', PNG);
    const result = JSON.parse(await createVisualDemoTool({ renderVisualScene: async () => { throw new Error('测试无真实像素'); } }).run({ ...free(), design: { ...free().design, assets: [{ id: 'photo', path: '分层回归/raw.png' }] }, path: '分层回归/demo.html' }));
    expect(result.designVersion).toBe('layered-1');
    expect(result.files.map(f => f.format)).toEqual(['svg', 'pptx', 'html', 'zip']);
    const zip = await JSZip.loadAsync(await (await ws.readBlob(result.files.find(f => f.format === 'zip').path)).arrayBuffer());
    const source = JSON.parse(await zip.file('design.design.json').async('string'));
    expect(source.assets[0].path).toBe('assets/photo.png');
    expect(await imageFingerprint(new Blob([await zip.file('assets/photo.png').async('uint8array')]))).toBe(source.assets[0].hash);
    expect(visualSceneReceipt(true, JSON.stringify(result))).toMatchObject({ state: 'partial', designPath: result.designPath });
  });
});

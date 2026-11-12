import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createVisualSceneHtml, visualSceneSelection } from '../src/agent/visualSceneHtml.js';

const design = { version: 1, kind: 'visual_scene', preset: 'weather', theme: 'midnight', width: 960, height: 540, title: '区域气象观测中心', subtitle: '中文矢量界面', dataMode: 'demo', source: '未央演示数据', asOf: '演示时刻 14:30', metrics: [{ label: '气温', value: '23.6', unit: '℃', detail: '演示读数' }], alerts: [], markers: [{ name: '北京', lon: 116.4, lat: 39.9, value: '22℃' }], series: [{ label: '09:00', value: 24 }, { label: '12:00', value: 27 }] };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" id="visual-scene" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#07121e"/><g data-viz="metric" data-index="0" data-label="气温"><text x="40" y="80" font-size="32" font-family="Noto Sans CJK SC" fill="#ffffff">气温 23.6℃</text></g><g data-viz="radar"><circle cx="400" cy="200" r="80" fill="#77dfd3"/></g><g data-viz="grid"><path d="M 0 270 L 960 270" stroke="#294051"/></g></svg>';
const decode = value => value.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const content = html => JSON.parse(/<script id="scene-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);

// 完整容器和实际压缩像素，避免靠伪造 PNG 头证明可下载图片。
function pngBlob(width = 960, height = 540) {
  const crc32 = buffer => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind, bytes) => {
    const result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length, 0);
    result.write(kind, 4, 'ascii');
    bytes.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))], { type: 'image/png' });
}

describe('同设计离线交互 HTML', () => {
  it('快照时间不冒充首个趋势读数，也不会改动已有时段选择', () => {
    for (const input of [design, { ...design, series: [] }]) {
      const time = visualSceneSelection(input, 'time-label', 0);
      expect(time.label).toBe('数据时间');
      expect(time.observation).toBeUndefined();
      expect(time.details.some(([label]) => ['时段', '观测值'].includes(label))).toBe(false);
      expect(JSON.stringify(time)).not.toContain('09:00');
    }
    const observation = visualSceneSelection(design, 'series-point', 1);
    expect(observation).toMatchObject({ label: '12:00', observation: '1' });
    expect(observation.details).toContainEqual(['观测值', 27]);
  });

  it('保留原 SVG 和中文矢量文字，嵌入完整数据，不依赖外部资源', async () => {
    const html = await createVisualSceneHtml({ design, svg });
    expect(html).toContain(svg);
    expect(content(html)).toEqual(design);
    expect(html).toContain('演示数据，不用于业务或气象决策');
    expect(html).toContain('时段观察仅选中已有趋势点，其他指标保持原始快照');
    expect(html).not.toMatch(/<(?:script|link|iframe)[^>]+(?:src|href)=/);
    expect(html).not.toContain('workspace:');
    expect(html).not.toContain('id="download-png"');
    expect(html).toContain('未附初始 PNG');
    for (const id of ['scene-detail-title', 'scene-detail-content', 'scene-date', 'layer-radar', 'layer-grid', 'download-svg', 'scene-reset', 'scene-status', 'scene-zoom']) expect(html).toContain(`id="${id}"`);
  });

  it('固定脚本和样式逐字节匹配 CSP 摘要，拒绝联网、外源、eval 和事件属性', async () => {
    const html = await createVisualSceneHtml({ design, svg });
    const csp = decode(/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1]);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
    for (const [type, text] of [['script', script], ['style', css]]) expect(csp).toContain(`${type}-src 'sha256-${createHash('sha256').update(text).digest('base64')}'`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    expect(script).not.toMatch(/\b(?:fetch|eval)\s*\(|innerHTML\s*=/);
    expect(() => new Function(script)).not.toThrow();
  });

  it('标题、来源、详情和脚本闭合字符串只能作为文本，程序摘要保持固定', async () => {
    const attack = '</script><script>globalThis.pwned=1</script><img src=x onerror=alert(1)>&\u2028\u2029';
    const input = { ...design, title: attack, source: attack, subtitle: '<style>body{display:none}</style>', metrics: [{ label: attack, value: attack, unit: '', detail: attack }] };
    const html = await createVisualSceneHtml({ design: input, svg });
    const original = await createVisualSceneHtml({ design, svg });
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html).not.toContain('<script>globalThis.pwned=1');
    expect(html).not.toContain('<img src=x');
    expect(content(html)).toEqual(input);
    expect(/<script>([\s\S]*?)<\/script>/.exec(html)[1]).toBe(/<script>([\s\S]*?)<\/script>/.exec(original)[1]);
  });

  it('仅嵌入真实原尺寸 PNG 字节，明确初始视图与当前 SVG 的区别', async () => {
    const png = pngBlob();
    const html = await createVisualSceneHtml({ design, svg, pngBlob: png });
    const encoded = /id="download-png" href="data:image\/png;base64,([^"]+)"/.exec(html)[1];
    expect(Buffer.from(encoded, 'base64')).toEqual(Buffer.from(await png.arrayBuffer()));
    expect(html).toContain('下载初始 PNG · 960×540');
    expect(html).toContain('PNG 保存初始视图，SVG 保存当前图层与选中状态');
    await expect(createVisualSceneHtml({ design, svg, pngBlob: pngBlob(480, 270) })).rejects.toMatchObject({ code: 'VISUAL_HTML_INPUT' });
    await expect(createVisualSceneHtml({ design, svg, pngBlob: new Blob(['not a png'], { type: 'image/png' }) })).rejects.toMatchObject({ code: 'VISUAL_HTML_INPUT' });
    const truncated = new Blob([await png.slice(0, 48).arrayBuffer()], { type: 'image/png' });
    await expect(createVisualSceneHtml({ design, svg, pngBlob: truncated })).rejects.toMatchObject({ code: 'VISUAL_HTML_INPUT' });
  });

  it('海报补根 id 并仅使用原稿文字，空趋势不会生成演示数值', async () => {
    const poster = { ...design, preset: 'poster', theme: 'light', dataMode: 'provided', source: '用户提供的海报设计', metrics: [], alerts: [], markers: [], series: [] };
    const original = svg.replace(' id="visual-scene"', '');
    const html = await createVisualSceneHtml({ design: poster, svg: original });
    expect(html).toContain('<svg id="visual-scene"');
    expect(html).toContain('点选原稿文字查看详情');
    expect(html).toContain('id="scene-copy-text"');
    expect(content(html).series).toEqual([]);
    expect(content(html).metrics).toEqual([]);
    expect(html).toContain('离线数据快照，未连接实时数据接口');
  });

  it('对 SVG 进行真实白名单验证，拒绝事件、外链和 DOM 编号冲突', async () => {
    for (const bad of [svg.replace('<svg ', '<svg onload="alert(1)" '), svg.replace('</svg>', '<script>alert(1)</script></svg>'), svg.replace('</svg>', '<image href="https://example.com/a.png" width="1" height="1"/></svg>')]) await expect(createVisualSceneHtml({ design, svg: bad })).rejects.toBeTruthy();
    await expect(createVisualSceneHtml({ design, svg: svg.replace('data-viz="metric"', 'id="scene-data" data-viz="metric"') })).rejects.toMatchObject({ code: 'VISUAL_HTML_INPUT' });
    await expect(createVisualSceneHtml({ design: { ...design, width: 1920 }, svg })).rejects.toMatchObject({ code: 'VISUAL_HTML_INPUT' });
  });

  it('限制设计数据和尺寸，拒绝函数、getter、循环及过量元数据', async () => {
    const cyclic = { ...design };
    cyclic.loop = cyclic;
    for (const input of [{ ...design, width: 4097 }, { ...design, dataMode: 'live' }, { ...design, source: () => '联网' }, { ...design, get extra() { throw new Error('不应执行getter'); } }, cyclic, { ...design, source: 'a'.repeat(16001) }]) await expect(createVisualSceneHtml({ design: input, svg })).rejects.toMatchObject({ code: 'VISUAL_HTML_INPUT' });
  });
});

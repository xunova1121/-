/** 同一设计交付高清PNG、可编辑SVG和离线交互HTML；不调用模型补画、不把mock当实测。 */
import JSZip from 'jszip';
import * as ws from './workspace.js';
import { composeVisualScene } from './visualScene.js';
import { composePoster } from './posterComposition.js';
import { renderVisualScene } from './visualSceneRaster.js';
import { createVisualSceneHtml } from './visualSceneHtml.js';
import { loadVisualDesign, visualOutputBase, visualDesignBlob } from './visualDesignSource.js';
import { normalizePosterBackground } from './posterCompositionInput.js';
import { assertPosterPng } from './posterDeliveryTool.js';
import { throwControl } from '../core/networkRequest.js';
import { themeById } from './themes.js';

async function save(path, blob, ctx, signal) {
  throwControl(null, signal);
  const result = await ws.write(path, blob);
  const a = new Uint8Array(await blob.arrayBuffer());
  const b = new Uint8Array(await (await ws.readBlob(result.path)).arrayBuffer());
  if (a.length !== b.length || !a.every((byte, index) => byte === b[index])) throw Object.assign(new Error('文件写入读回不一致'), { code: 'VISUAL_READBACK' });
  throwControl(null, signal);
  ctx.onFileChanged?.(result.path);
  return result.path;
}

const properties = {
  title: { type: 'string', description: '准确标题；保留用户提供的中文' }, subtitle: { type: 'string' },
  preset: { type: 'string', enum: ['weather', 'operations'], description: 'weather地理气象大屏；operations经营指标图表' },
  width: { type: 'integer', description: '输出实际像素宽，默认3840' }, height: { type: 'integer', description: '默认2160' },
  theme: { type: 'string', enum: ['midnight', 'light'] },
  dataMode: { type: 'string', enum: ['demo', 'provided'], description: '默认demo明确演示数据；provided必须提供真实来源与数据，不自动查询天气' },
  source: { type: 'string', description: '数据来源说明；不能将演示值标成实测' }, asOf: { type: 'string', description: '数据对应时间，原样展示，不冒充当前时间' },
  metrics: { type: 'array', maxItems: 4, items: { type: 'object', properties: { label: { type: 'string' }, value: { type: ['string', 'number'] }, unit: { type: 'string' }, detail: { type: 'string' } }, required: ['label', 'value'] } },
  series: { type: 'array', maxItems: 24, items: { type: 'object', properties: { label: { type: 'string' }, value: { type: ['number', 'string'] } }, required: ['label', 'value'] } },
  seriesLabel: { type: 'string', description: '趋势曲线代表的指标，如气温；提供数据时不自动猜测' },
  seriesUnit: { type: 'string', description: '趋势单位，如℃、万元；未提供则不猜' },
  alerts: { type: 'array', maxItems: 3, items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, time: { type: 'string' }, level: { type: 'string', description: 'info提示、warning关注、critical紧急；也接受蓝色、黄色、橙色、红色等别名' } }, required: ['title'] } },
  markers: { type: 'array', maxItems: 12, items: { type: 'object', properties: { name: { type: 'string' }, lon: { type: 'number' }, lat: { type: 'number' }, value: { type: ['string', 'number'] } }, required: ['name', 'lon', 'lat'] } },
  background_path: { type: 'string', description: '可选工作区无字底图，真实PNG/JPEG/WebP。不要传已带错字的截图作为底图' },
  source_path: { type: 'string', description: '复用上次.visual.json改数据；已有海报用make_poster返回的.poster.json，同版式补可交互Demo，无需重画底图' },
  text_style: { type: 'string', enum: ['panel', 'gradient'], description: '仅复用海报源稿：实色或底部连续渐变；切换gradient默认底部35%居中' },
  text_position: { type: 'string', enum: ['top', 'bottom', 'left', 'right', 'center'], description: '仅海报源稿；gradient目前只支持bottom' },
  text_fraction: { type: 'number', description: '仅海报源稿：文字区比例0.15–1；原渐变稿修改保留旧比例' },
  text_align: { type: 'string', enum: ['left', 'center'], description: '仅海报源稿：文字对齐' },
  gradient_opacity: { type: 'number', description: '仅渐变海报：底端不透明度0–1，默认0.85' },
  path: { type: 'string', description: '工作区输出名称，.html/.png/.svg/.zip；默认另存不覆盖旧稿' }
};

export function createVisualDemoTool(ctx = {}) {
  return {
    name: 'create_visual_demo',
    description: '制作高清数据大屏、气象/经营驾驶舱及同设计交互Demo：中文、数字、图表和地图标注由程序绘制；交付原尺寸PNG、可编辑SVG、自包含离线HTML和打包文件。已有中文海报用source_path复用.poster.json。图层/指标/城市/预警可点击查看；不自动接实时数据。支持4K画布但如实标底图放大倍率；不声称原生4K细节或视觉已验收。',
    input_schema: { type: 'object', properties, additionalProperties: false },
    run: async (input = {}, { signal, progress, checkpoint } = {}) => {
      const loaded = await loadVisualDesign(input, signal);
      const { design, background, backgroundPath, posterOptions } = loaded;
      progress?.('正在用同一份设计排版中文、指标与图表…');
      const palette = posterOptions?.theme ? themeById(posterOptions.theme)?.colors : null;
      const defaults = palette ? { background_color: '#' + palette.primary, ...(!posterOptions.text_color && { panel_color: '#' + palette.primary }) } : {};
      const composed = posterOptions ? await composePoster({ ...defaults, ...posterOptions, background }) : await composeVisualScene(design, { background });
      const { svg, width, height } = composed;
      Object.assign(design, { width, height });
      const base = visualOutputBase(input, design, backgroundPath);
      const receipt = { kind: 'visual_demo', status: 'partial', width, height, files: [], textRendering: 'program', fontCheck: 'not_checked', visual: 'not_checked', interaction: 'not_checked', dataMode: design.dataMode, notes: [design.dataMode === 'demo' ? '明确演示数据，不是实时天气或业务数据' : `数据来源：${design.source}`, 'PNG与Demo共用设计；文字内容和视觉仍需核对', 'HTML可离线打开；没有接入实时后端'], errors: [] };
      if (background) {
        const info = normalizePosterBackground(background);
        const placement = composed.backgroundPlacement;
        const scale = Math.max((placement?.width || width) / info.width, (placement?.height || height) / info.height);
        receipt.background = { width: info.width, height: info.height, scale: Math.round(scale * 1000) / 1000, upscaled: scale > 1, ...(placement && { placement }), verification: 'container_metadata' };
        if (scale > 1) receipt.notes.push(`底图${info.width}×${info.height}放大${scale.toFixed(2)}倍；输出尺寸不代表底图有原生4K细节`);
      }
      const artifacts = new Map();
      const failed = (error, phase) => {
        throwControl(error, signal);
        const code = /^(?:POSTER|VISUAL)_[A-Z_]+$/.test(error?.code || '') ? error.code : `VISUAL_${phase.toUpperCase()}_FAILED`;
        receipt.errors.push({ code, phase, message: phase === 'render' ? '高清图片未通过渲染、尺寸或字体检查；已保存源文件仍可使用' : '该文件未成功保存并读回' });
      };
      const deliver = async (format, blob, render = 'not_checked') => {
        const path = await save(`${base}.${format}`, blob, ctx, signal);
        artifacts.set(format, blob);
        receipt.files.push({ format, path, readback: 'passed', structure: 'passed', render });
      };
      try { await deliver('svg', new Blob([svg], { type: 'image/svg+xml' })); } catch (error) { failed(error, 'svg'); }
      const designBlob = visualDesignBlob(loaded);
      try {
        receipt.designPath = await save(`${base}.visual.json`, designBlob, ctx, signal);
        if (posterOptions) receipt.posterSource = input.source_path;
      } catch (error) { failed(error, 'design'); }
      let pngBlob;
      try {
        progress?.('正在检查中文字体并导出原尺寸PNG…');
        const rendered = await (ctx.renderVisualScene || renderVisualScene)(svg, { signal });
        await assertPosterPng(rendered.blob, width, height);
        if (rendered.fontCheck?.status !== 'passed') throw Object.assign(new Error('字体未验证'), { code: 'POSTER_FONT_CHECK_UNAVAILABLE' });
        pngBlob = rendered.blob;
        await deliver('png', pngBlob, 'passed');
        receipt.fontCheck = 'passed';
        ctx.onImage?.(URL.createObjectURL(pngBlob), receipt.files.find(file => file.format === 'png').path);
      } catch (error) { pngBlob = undefined; failed(error, 'render'); }
      try {
        progress?.('正在生成可离线打开的同设计Demo…');
        const html = await createVisualSceneHtml({ design, svg, pngBlob });
        await deliver('html', new Blob([html], { type: 'text/html' }));
      } catch (error) { failed(error, 'html'); }
      try {
        const archive = new JSZip();
        for (const [format, blob] of artifacts) archive.file(`design.${format}`, await blob.arrayBuffer());
        archive.file('design.visual.json', await designBlob.text());
        if (background) archive.file('assets/background.' + (background.mime === 'image/jpeg' ? 'jpg' : background.mime.split('/')[1]), background.bytes);
        archive.file('README.txt', `${artifacts.has('html') ? '打开design.html即可离线演示。' : 'HTML未生成。'}${artifacts.has('png') ? `PNG是初始视图${width}×${height}原图。` : 'PNG未通过检查，未交付。'}${artifacts.has('svg') ? 'SVG保留程序文字。' : 'SVG未交付。'}\n实际文件：${[...artifacts.keys()].map(format => `design.${format}`).join('、')}\n${receipt.notes.join('\n')}\nJSON记录设计参数，重新编辑需将源文件与底图放入未央工作区，并核对background_path。\n检查：字体${receipt.fontCheck}，视觉未验收，交互未实测。`);
        const bytes = await archive.generateAsync({ type: 'uint8array', compression: 'STORE' });
        throwControl(null, signal);
        if (bytes.length > 80e6) throw Object.assign(new Error('打包超过80MB'), { code: 'VISUAL_PACKAGE_SIZE' });
        await deliver('zip', new Blob([bytes], { type: 'application/zip' }));
      } catch (error) { failed(error, 'zip'); }
      receipt.status = !receipt.errors.length && receipt.designPath && ['png', 'svg', 'html'].every(format => receipt.files.some(file => file.format === format)) ? 'complete' : 'partial';
      await checkpoint?.({ type: 'artifact_validation', path: receipt.designPath || `${base}.svg`, validation: { kind: 'visual_demo', readback: receipt.files.length ? 'passed' : 'failed', render: receipt.fontCheck === 'passed' ? 'passed' : 'failed', visual: 'not_checked', business: 'not_checked', errors: receipt.errors.length } });
      return JSON.stringify(receipt);
    }
  };
}

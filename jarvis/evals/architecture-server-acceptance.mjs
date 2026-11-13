/** 实测验收只认本次目录和实际文件，不把任务done、旧图或展示PPT当完成。 */
import * as workspace from '../src/agent/workspace.js';
import { loadArchitecture } from '../src/agent/architectureProjection.js';
import { diagramDigest } from '../src/agent/diagramExport.js';
import { inspectNativeDiagram } from '../src/agent/diagramPptxStructure.js';
import { sceneElements, validateScene } from '../src/agent/diagramScene.js';
import { imageFormat } from '../src/agent/imageFormat.js';
import { throwControl } from '../src/core/networkRequest.js';
const requiredViews = ['overview', 'workflow', 'dataflow'];
const fail = (code, field) => Object.assign(new Error(code), { code, field });
const safe = value => typeof value === 'string' && value.length <= 600 && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');
const isHash = value => typeof value === 'string' && /^(sha256|checksum):[a-f0-9]{8,64}$/.test(value);

export async function architectureServerAcceptance(directory, options = {}) {
  const readBlob = options.readBlob || workspace.readBlob;
  const loadPlan = options.loadPlan || loadArchitecture;
  const inspectPpt = options.inspectPpt || inspectNativeDiagram;
  let manifest;
  const result = {
    state: 'failed', manifestPath: directory + '/交付清单.json', views: [], modelBusinessReview: 'not_checked',
    customerBusiness: 'not_reviewed', customerVisual: 'not_reviewed',
    note: '核对当前底稿、来源摘要、同稿文件和原生PPT实际字节及既有真实渲染回执；不是人工业务或视觉验收，也不是独立重渲染。'
  };
  const blobAt = async (target, max = 20e6) => {
    throwControl(null, options.signal);
    if (!safe(target)) throw fail('ARCHITECTURE_ACCEPTANCE_PATH', 'path');
    const blob = await readBlob(target);
    if (!blob?.size || blob.size > max) throw fail('ARCHITECTURE_ACCEPTANCE_SIZE', target);
    return blob;
  };
  const jsonAt = async (target, max) => {
    const blob = await blobAt(target, max);
    try { return JSON.parse(await blob.text()); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; throw fail('ARCHITECTURE_ACCEPTANCE_JSON', target); }
  };
  try {
    if (!safe(directory)) throw fail('ARCHITECTURE_ACCEPTANCE_PATH', 'directory');
    manifest = await jsonAt(result.manifestPath, 100000);
    if (manifest.version !== 1 || manifest.status !== 'complete') throw fail('ARCHITECTURE_ACCEPTANCE_INCOMPLETE', 'manifest.status');
    if (!Array.isArray(manifest.selectedViews) || manifest.selectedViews.length !== 3 || new Set(manifest.selectedViews).size !== 3 || requiredViews.some(view => !manifest.selectedViews.includes(view)))
      throw fail('ARCHITECTURE_ACCEPTANCE_VIEWS', 'manifest.selectedViews');
    if (!Array.isArray(manifest.completedViews) || manifest.completedViews.length !== 3 || new Set(manifest.completedViews.map(view => view.view)).size !== 3)
      throw fail('ARCHITECTURE_ACCEPTANCE_VIEWS', 'manifest.completedViews');
    if (!safe(manifest.architecturePath) || !manifest.architecturePath.startsWith('文档检查/架构底稿/') || !manifest.architecturePath.endsWith('.architecture.json') || !isHash(manifest.planHash))
      throw fail('ARCHITECTURE_ACCEPTANCE_PLAN', 'manifest.architecturePath');
    const bundle = await loadPlan(manifest.architecturePath, options.signal);
    if (bundle.planHash !== manifest.planHash || bundle.report.planHash !== manifest.planHash || bundle.report.structure !== 'passed' || bundle.report.semantic !== 'passed')
      throw fail('ARCHITECTURE_ACCEPTANCE_REVIEW', 'architecture.review');
    if (!bundle.sourceChecks?.length || bundle.sourceChecks.some(source => !source.matched || source.truncated) || bundle.plan.materialHashes?.length !== bundle.sourceChecks.length)
      throw fail('ARCHITECTURE_ACCEPTANCE_SOURCE', 'architecture.sources');
    result.modelBusinessReview = 'passed';
    result.architecturePath = manifest.architecturePath;
    result.planHash = manifest.planHash;
    result.sourceChecks = bundle.sourceChecks.map(source => ({ matched: source.matched, truncated: source.truncated, scope: source.scope || 'file' }));
    for (const name of requiredViews) result.views.push(await verifyView(name, manifest, directory, { blobAt, jsonAt, inspectPpt }));
    const declared = manifest.files;
    const actual = result.views.flatMap(view => view.files.map(file => file.path));
    if (!Array.isArray(declared) || declared.length !== actual.length || new Set(declared).size !== actual.length || actual.some(file => !declared.includes(file)))
      throw fail('ARCHITECTURE_ACCEPTANCE_FILE_LIST', 'manifest.files');
    result.state = 'complete';
  } catch (error) {
    throwControl(error, options.signal);
    result.state = result.views.length ? 'partial' : 'failed';
    result.failure = { code: String(error.code || error.name || 'ERROR').slice(0, 80), field: String(error.field || '').slice(0, 600) };
  }
  return result;
}

async function verifyView(name, manifest, directory, { blobAt, jsonAt, inspectPpt }) {
  const view = manifest.completedViews.find(item => item.view === name);
  if (!view || view.editable !== true || !isHash(view.designHash) || !Array.isArray(view.files) || view.files.length > 6)
    throw fail('ARCHITECTURE_ACCEPTANCE_VIEW', name);
  const files = new Map();
  for (const file of view.files) {
    if (!safe(file.path) || !file.path.startsWith(directory + '/') || !['svg', 'png', 'pdf', 'pptx'].includes(file.format) || !file.path.endsWith('.' + file.format) || !isHash(file.hash) || files.has(file.path))
      throw fail('ARCHITECTURE_ACCEPTANCE_FILE', name + '.files');
    const blob = await blobAt(file.path);
    if (await diagramDigest(blob) !== file.hash) throw fail('ARCHITECTURE_ACCEPTANCE_HASH', file.path);
    if (file.format === 'png' && (await imageFormat(blob))?.ext !== 'png') throw fail('ARCHITECTURE_ACCEPTANCE_SIGNATURE', file.path);
    if (file.format === 'svg' && (await imageFormat(blob))?.ext !== 'svg') throw fail('ARCHITECTURE_ACCEPTANCE_SIGNATURE', file.path);
    if (file.format === 'pdf' && await blob.slice(0, 5).text() !== '%PDF-') throw fail('ARCHITECTURE_ACCEPTANCE_SIGNATURE', file.path);
    files.set(file.path, { ...file, blob });
  }
  const selected = format => [...files.values()].filter(file => file.format === format);
  if (['svg', 'png', 'pdf'].some(format => selected(format).length !== 1)) throw fail('ARCHITECTURE_ACCEPTANCE_FORMATS', name);
  const native = selected('pptx').filter(file => file.path.endsWith('-可编辑.pptx'));
  const display = selected('pptx').filter(file => file.path.endsWith('-展示.pptx'));
  if (native.length !== 1 || display.length !== 1 || selected('pptx').length !== 2 || view.previewPath !== selected('png')[0].path)
    throw fail('ARCHITECTURE_ACCEPTANCE_EDITABLE', name);
  const svg = selected('svg')[0], png = selected('png')[0];
  await verifyPptBytes(display[0].blob, png.hash);
  await verifyPptBytes(native[0].blob);
  const exports = await jsonAt(svg.path.replace(/\.svg$/, '.exports.json'), 100000);
  if (exports.version !== 1 || exports.designHash !== view.designHash || exports.sourcePath !== svg.path || exports.previewHash !== png.hash || exports.primaryEditablePath !== native[0].path || !Array.isArray(exports.errors) || exports.errors.length || !Array.isArray(exports.artifacts) || exports.artifacts.length !== files.size)
    throw fail('ARCHITECTURE_ACCEPTANCE_EXPORT', name + '.exports');
  for (const file of files.values()) {
    const matching = exports.artifacts.filter(item => item.path === file.path);
    if (matching.length !== 1 || matching[0].format !== file.format || matching[0].hash !== file.hash || matching[0].designHash !== view.designHash)
      throw fail('ARCHITECTURE_ACCEPTANCE_EXPORT_HASH', file.path);
  }
  const nativeReceipt = exports.artifacts.find(item => item.path === native[0].path);
  if (nativeReceipt.editability !== 'editable' || nativeReceipt.consistency !== 'render_compared')
    throw fail('ARCHITECTURE_ACCEPTANCE_EDITABLE', native[0].path);
  const editable = exports.editable;
  if (editable?.passed !== true || editable.state !== 'render_compared' || !Number.isFinite(editable.meanChannelError) || editable.meanChannelError < 0 || editable.meanChannelError > 0.012 || !Number.isFinite(editable.aspectError) || editable.aspectError < 0 || editable.aspectError >= 0.01)
    throw fail('ARCHITECTURE_ACCEPTANCE_COMPARE', name + '.editable');
  const scene = await jsonAt(exports.designPath, 1000000);
  validateScene(scene);
  if (exports.designPath !== svg.path.replace(/\.svg$/, '.diagram.json') || await diagramDigest(JSON.stringify(scene)) !== view.designHash || scene.architecture?.planPath !== manifest.architecturePath || scene.architecture.planHash !== manifest.planHash || scene.architecture.view !== name || scene.architecture.draft || scene.architecture.semantic !== 'passed' || scene.architecture.structure !== 'passed')
    throw fail('ARCHITECTURE_ACCEPTANCE_DESIGN', name + '.scene');
  const elements = sceneElements(scene), structure = await inspectPpt(native[0].blob);
  const textCount = elements.filter(item => item.type === 'text').reduce((sum, item) => sum + item.lines.filter(line => line.text.trim()).length, 0);
  const groups = elements.filter(item => item.type === 'group' && item.nodeId).length;
  const anchors = elements.filter(item => item.type === 'path' && item.from && item.to).length * 2;
  if (!textCount || !groups || structure.textBoxes < textCount || structure.nodeGroups < groups || structure.anchoredEnds < anchors)
    throw fail('ARCHITECTURE_ACCEPTANCE_STRUCTURE', native[0].path);
  return { view: name, state: 'verified', designHash: view.designHash, files: [...files.values()].map(({ blob, ...file }) => ({ ...file, bytes: blob.size })), nativeStructure: structure, comparison: { meanChannelError: editable.meanChannelError, aspectError: editable.aspectError, ...(['pdftocairo', 'pdftoppm'].includes(editable.engine) && { engine: editable.engine }) } };
}

async function verifyPptBytes(blob, sharedPngHash) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const slides = Object.keys(zip.files).filter(target => /^ppt\/slides\/slide\d+\.xml$/.test(target));
  if (!zip.file('ppt/presentation.xml') || slides.length !== 1 || slides[0] !== 'ppt/slides/slide1.xml')
    throw fail('ARCHITECTURE_ACCEPTANCE_PPT_FORMAT', 'pptx');
  if (sharedPngHash) {
    const media = Object.keys(zip.files).filter(target => /^ppt\/media\//.test(target) && !zip.files[target].dir);
    if (media.length !== 1 || zip.files[media[0]]._data?.uncompressedSize > 20e6)
      throw fail('ARCHITECTURE_ACCEPTANCE_DISPLAY_PNG', 'pptx');
    const embedded = new Blob([await zip.files[media[0]].async('uint8array')]);
    if (await diagramDigest(embedded) !== sharedPngHash) throw fail('ARCHITECTURE_ACCEPTANCE_DISPLAY_PNG', 'pptx');
  }
}

import { openOfficePackage } from './officePackage.js';
import { documentError } from './documentPlan.js';

// 底稿随PPT保存，不进入会话/检查点或新增无界缓存。最多300KB；外部编辑后必须重新核对。
const PART = 'weiyang/presentation.json';
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
async function packageDigest(zip) {
  const parts = [];
  for (const key of Object.keys(zip.files).filter(key => key.startsWith('ppt/') && !zip.files[key].dir).sort()) {
    parts.push(key + ':' + await hash(await zip.file(key).async('uint8array')));
  }
  return hash(new TextEncoder().encode(parts.join('\n')));
}
export async function attachPresentationRecipe(blob, recipe) {
  const zip = await openOfficePackage(blob);
  const data = JSON.stringify({ version: 1, digest: await packageDigest(zip), ...recipe });
  if (new TextEncoder().encode(data).length > 300000) return blob;
  zip.file(PART, data);
  const types = await zip.file('[Content_Types].xml').async('string');
  zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/' + PART + '" ContentType="application/json"/></Types>'));
  return new Blob([await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })], { type: blob.type });
}
export async function readPresentationRecipe(blob) {
  const zip = await openOfficePackage(blob);
  const entry = zip.file(PART);
  if (!entry || entry._data?.uncompressedSize > 300000) throw documentError('这份PPT没有可核对的制作底稿；不能直接批量补图，请保留原件并先读取页面内容', 'PRESENTATION_RECIPE');
  let recipe;
  try { recipe = JSON.parse(await entry.async('string')); } catch { throw documentError('PPT制作底稿损坏', 'PRESENTATION_RECIPE'); }
  if (recipe.version !== 1 || typeof recipe.content !== 'string' || recipe.digest !== await packageDigest(zip)) throw documentError('原PPT已在底稿生成后修改，不能用旧底稿覆盖；请先核对现有页面', 'PRESENTATION_RECIPE');
  return recipe;
}

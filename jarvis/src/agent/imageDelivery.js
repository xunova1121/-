/** 生成结果原字节保存并读回；尺寸不足仍交回已有文件，不再次调用收费模型。 */
import * as ws from './workspace.js';
import { assertImageExtension } from './imageFormat.js';
import { imageFormatMatch, imageRequestReceipt, imageSizeMatch, readImageMetadata } from './imageMetadata.js';
import { throwControl } from '../core/networkRequest.js';

export async function deliverGeneratedImage(result, { path, signal, onFileChanged, onImage } = {}) {
  throwControl(null, signal);
  await assertImageExtension(path, result.blob);
  throwControl(null, signal);
  const saved = await ws.write(path, result.blob);
  const readback = await ws.readBlob(saved.path);
  const expected = new Uint8Array(await result.blob.arrayBuffer());
  const actualBytes = new Uint8Array(await readback.arrayBuffer());
  if (expected.length !== actualBytes.length || !expected.every((byte, index) => byte === actualBytes[index]))
    throw Object.assign(new Error('图片写入后读回不一致，未标记交付完成；没有重新生成'), { code: 'IMAGE_READBACK', kind: 'validation' });
  throwControl(null, signal);
  const actual = await readImageMetadata(readback, { signal });
  const requested = imageRequestReceipt(result.model, result.requested);
  const sizeMatch = imageSizeMatch(requested, actual);
  const formatMatch = imageFormatMatch(requested, actual);
  const notes = ['画质参数仅表示请求值；实际像素尺寸不代表细节或视觉验收通过', '工作区保存收到的原字节，未重新编码或自动付费重生成'];
  if (sizeMatch === false) notes.push(`请求${requested.size}，实际返回${actual.width}×${actual.height}，与请求尺寸不一致`);
  if (formatMatch === false) notes.push(`请求${requested.output_format}格式，实际返回${actual.format}；原字节保留，未转码`);
  if (actual.dimensions === 'unknown') notes.push('无法核实实际像素尺寸，不能按请求尺寸宣称4K或高清达标');
  onFileChanged?.(saved.path);
  if (onImage) onImage(URL.createObjectURL(readback), saved.path);
  return { kind: 'image', status: 'saved', message: '已生成图片结果并保存原文件；像素与格式以核验字段为准', path: saved.path, model: requested.model, requested, actual, sizeMatch, formatMatch, readback: 'passed', visual: 'not_checked', notes };
}

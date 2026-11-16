/** 实际工作区读回与文件容器检查；不把可打开容器说成内容、审美或真机分享验收。 */
import * as ws from './workspace.js';
import { throwControl } from '../core/networkRequest.js';
export async function verifyDeliveryAccess(paths, { signal } = {}) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 8) throw Object.assign(new Error('一次检查1–8个最终文件'), { code: 'DELIVERY_INPUT', kind: 'input' });
  const files = [];
  let total = 0;
  for (const path of paths) {
    throwControl(null, signal);
    try {
      const normalized = ws.normalize(path), blob = await ws.readBlob(normalized);
      if (!blob.size || (total += blob.size) > 80e6) throw new Error('文件为空或本轮检查超过80MB');
      const bytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
      const item = { path: normalized, size: blob.size, readback: 'passed', container: 'not_checked' };
      if (/\.png$/i.test(path)) {
        if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) throw new Error('PNG文件头不匹配');
        const view = new DataView(bytes.buffer);
        item.width = view.getUint32(16); item.height = view.getUint32(20);
        if (!item.width || !item.height) throw new Error('PNG尺寸无效');
        item.container = 'passed';
      } else if (/\.(?:pptx|docx|xlsx|zip)$/i.test(path)) {
        if (bytes[0] !== 80 || bytes[1] !== 75) throw new Error('Office/ZIP容器不匹配');
        item.container = 'passed';
      } else if (/\.html?$/i.test(path)) {
        const head = await blob.slice(0, 4096).text();
        if (!/<(?:!doctype\s+html|html|head|body)\b/i.test(head)) throw new Error('HTML入口无效');
        item.container = 'passed';
      }
      files.push(item);
    } catch (error) {
      throwControl(error, signal);
      files.push({ path: String(path).slice(0, 400), readback: 'failed', container: 'failed', code: 'DELIVERY_FILE_UNAVAILABLE' });
    }
  }
  throwControl(null, signal);
  return { status: files.every(f => f.readback === 'passed') ? 'ready' : 'partial', files,
    note: '只验证当前账号工作区真实读回和部分文件容器；未代替实际点击、视觉/交互/事实与微信验收。' };
}
export function createDeliveryAccessTool() {
  return { name: 'verify_delivery', description: '交付前实际读取最终文件，核对存在、字节和PNG尺寸/HTML入口/Office容器；不额外生成文件或调用模型。',
    input_schema: { type: 'object', properties: { paths: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', maxLength: 400 } } }, required: ['paths'], additionalProperties: false },
    run: async ({ paths }, options) => JSON.stringify(await verifyDeliveryAccess(paths, options)) };
}

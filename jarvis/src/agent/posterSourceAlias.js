/** 保留明确指定的可编辑源稿路径；成品/草稿归组不破坏旧入口及已有链接。 */
import * as ws from './workspace.js';
import { claimLayerOutputBase, saveDesignFile } from './layeredDesignSource.js';
import { throwControl } from '../core/networkRequest.js';

export async function preservePosterSource(input, receipt, task, options, assertCurrent) {
  const suffix = receipt.designPath?.match(/\.(design|canvas|poster)\.json$/i)?.[0];
  if (!suffix || typeof input.path !== 'string' || !/\.(?:png|svg|pptx|html|zip)$/i.test(input.path) || ws.normalize(input.path).startsWith('.workflows/')) return;
  const blob = await ws.readBlob(receipt.designPath);
  assertCurrent();
  if (blob.size > 180000) throw Object.assign(new Error('源稿超过复用上限'), { code: 'POSTER_SOURCE_SIZE' });
  let path = input.path;
  for (let i = 0; i < 3; i++) {
    const { base, release } = await claimLayerOutputBase({ path }, { title: input.title || '海报', assets: [] }, options.signal);
    try {
      assertCurrent();
      const alias = base + suffix;
      if (await ws.exists(alias)) {
        path = `${base}-${crypto.randomUUID().slice(0, 8)}.png`;
        continue;
      }
      assertCurrent();
      const saved = await saveDesignFile(alias, blob, {}, options.signal);
      assertCurrent();
      if (!saved.endsWith(suffix)) throw Object.assign(new Error('文件夹并发改名改变了源稿后缀，内部源稿保留'), { code: 'POSTER_SOURCE_NAME' });
      task.sourceAliases.push(saved);
      receipt.designPath = saved;
      return;
    } finally { release(); }
  }
  throwControl(null, options.signal);
  throw Object.assign(new Error('源稿名称已占用，原稿保持；请使用新的文件名'), { code: 'POSTER_SOURCE_NAME' });
}

import { it, expect } from 'vitest';
import * as ws from '../src/agent/workspace.js';
import { posterDesignInput, posterDesignBlob, checkPosterDesignBackground } from '../src/agent/posterDesignSource.js';

it('海报底图路径别名仍绑定原字节摘要，不能绕过旧稿检查', async () => {
  const original = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' };
  await ws.write('路径守护/design.poster.json', await posterDesignBlob({ title: '原稿', background_path: '路径守护/bg.png' }, { width: 1080, height: 1440, background: original }));
  const input = await posterDesignInput({ source_path: '路径守护/design.poster.json', background_path: './路径守护/bg.png', title: '改字' });
  await expect(checkPosterDesignBackground(input, original)).resolves.toBeUndefined();
  await expect(checkPosterDesignBackground(input, { ...original, bytes: new Uint8Array([1, 2, 4]) })).rejects.toMatchObject({ code: 'POSTER_BACKGROUND_CHANGED' });
});

it('缺失摘要的旧稿不能借同一路径别名复用，明确另一份底图仍可使用', async () => {
  await ws.write('路径守护/旧稿.poster.json', JSON.stringify({ kind: 'poster-design', version: 1, options: { title: '旧稿', background_path: '路径守护/bg.png' }, backgroundHash: null }));
  await expect(posterDesignInput({ source_path: '路径守护/旧稿.poster.json', background_path: './路径守护/bg.png' })).rejects.toMatchObject({ code: 'POSTER_BACKGROUND_UNVERIFIED' });
  await expect(posterDesignInput({ source_path: '路径守护/旧稿.poster.json', background_path: '路径守护/另图.png' })).resolves.toMatchObject({ background_path: '路径守护/另图.png' });
});

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createServer } from '../server/server.mjs';

it.each(['mp4','webm'])('工作台 %s 短片支持播放器的探读、定位、缓存和完整下载', async format => {
  const root = await mkdtemp(path.join(tmpdir(), 'workshop-movie-'));
  const server = createServer({ staticDir: root, ollama: null });
  try {
    await mkdir(path.join(root,'assets'));
    await writeFile(path.join(root,'assets/film.' + format), 'abcdefghij');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/assets/film.' + format;
    const response = await fetch(url);
    expect(response.headers.get('Content-Type')).toBe('video/' + format);
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    expect(await response.text()).toBe('abcdefghij');
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.headers.get('Accept-Ranges')).toBe('bytes');
    expect(head.headers.get('Content-Length')).toBe('10');
    expect(await head.text()).toBe('');
    for (const [range, contentRange, body] of [
      ['bytes=0-1','bytes 0-1/10','ab'], ['bytes=7-','bytes 7-9/10','hij'],
      ['bytes=-2','bytes 8-9/10','ij'], ['bytes=8-99','bytes 8-9/10','ij']
    ]) {
      const part = await fetch(url, { headers: { range } });
      expect(part.status).toBe(206);
      expect(part.headers.get('Content-Range')).toBe(contentRange);
      expect(part.headers.get('Content-Length')).toBe(String(body.length));
      expect(await part.text()).toBe(body);
    }
    const outside = await fetch(url, { headers: { range: 'bytes=10-' } });
    expect(outside.status).toBe(416);
    expect(outside.headers.get('Content-Range')).toBe('bytes */10');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive:true, force:true });
  }
});

import { createReadStream, statSync } from 'node:fs';

// 手机播放器会探读文件头，再请求播放位置对应的字节段。文件已由静态资源路由定位。
export function serveStaticVideo(req, res, file, contentType, cacheControl) {
  const { size } = statSync(file);
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl };
  const range = req.method === 'GET' && /^bytes=(\d*)-(\d*)$/i.exec(req.headers.range || '');
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end) {
      res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + size });
      return res.end();
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(headers['Content-Range'] ? 206 : 200, headers);
  if (req.method === 'HEAD' || !size) return res.end();
  const stream = createReadStream(file, { start, end });
  res.once('close', () => stream.destroy());
  stream.on('error', error => res.destroy(error)).pipe(res);
}

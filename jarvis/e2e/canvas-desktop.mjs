/** 真正Electron主进程调用ASAR内渲染器；子进程必须作为Node运行并从unpacked加载原生库。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { canvasFixture, canvasCopy } from './fixtures/canvas-text.mjs';
import { pixelTextRegions } from '../src/agent/imageTextRegions.js';
import { normalizeCanvasDesign, canvasEntries } from '../src/agent/imageTextInput.js';

const root = path.resolve('.'),
  out = path.resolve(process.argv[2] || '/tmp/weiyang-canvas-desktop');
await fs.mkdir(out, { recursive: true });
const fixture = canvasFixture({ width: 600, height: 900 }),
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-canvas-desktop-'));
const original = path.join(temp, 'original.png'),
  jsonPath = path.join(temp, 'design.json'),
  output = path.join(out, 'result.json');
await fs.writeFile(original, fixture.bytes);
const design = normalizeCanvasDesign({
  kind: 'canvas-image-text',
  version: 1,
  title: '桌面原图填字',
  image: { path: 'original.png', hash: 'a'.repeat(64), width: 600, height: 900 },
  width: 600,
  height: 900,
  entries: canvasEntries({ entries: canvasCopy }),
  regions: pixelTextRegions(fixture.frame, 7).regions,
  protected: fixture.protections
});
await fs.writeFile(jsonPath, JSON.stringify(design));
const desktopRequire = createRequire(pathToFileURL(path.join(root, 'desktop/package.json')));
const { createPackageWithOptions } = desktopRequire('@electron/asar'),
  electron = desktopRequire('electron');
// 只打包实际server和实际平台原生模块，复制准备产物，不能用源码替代丢失的安装包入口。
const source = path.join(temp, 'bundle');
await fs.mkdir(source);
for (const dir of ['server', 'node_modules'])
  await fs.cp(path.join(root, 'desktop/bundle', dir), path.join(source, dir), { recursive: true });
const archive = path.join(temp, 'app.asar');
await createPackageWithOptions(source, archive, { unpack: '**/*' });
await fs.access(archive + '.unpacked/server/canvasImageTextWorker.mjs');
const entry = pathToFileURL(archive + '/server/canvasImageText.mjs').href,
  driver = path.join(temp, 'driver.cjs');
await fs.writeFile(
  driver,
  `const {app, BrowserWindow}=require('electron');
const fs=require('node:fs/promises');
app.whenReady().then(async()=>{try{
const {serverCanvasRenderer,renderCanvasSvg}=await import(${JSON.stringify(entry)});
const design=JSON.parse(await fs.readFile(${JSON.stringify(jsonPath)},'utf8'));
const blob=new Blob([await fs.readFile(${JSON.stringify(original)})],{type:'image/png'});
const result=await serverCanvasRenderer.render(blob,design);
if(result.layout.status!=='passed'||result.backgroundCheck.status!=='passed')throw new Error('render checks');
await fs.writeFile(${JSON.stringify(path.join(out, 'desktop.png'))},Buffer.from(await result.blob.arrayBuffer()));
const source=Buffer.from(await blob.arrayBuffer()).toString('base64');
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"><rect width="600" height="1000" fill="#fff"/><image x="0" y="100" width="600" height="900" href="data:image/png;base64,'+source+'"/><text x="20" y="60" font-family="'+result.fontCheck.family+'" font-size="32">高清图文原生渲染</text></svg>';
const hd=await renderCanvasSvg(svg,result.fontCheck.family);
await fs.writeFile(${JSON.stringify(path.join(out, 'desktop-svg.png'))},Buffer.from(hd.bytes));
await fs.writeFile(${JSON.stringify(output)},JSON.stringify({status:'passed',electron:process.versions.electron,background:result.backgroundCheck,font:result.fontCheck,windows:BrowserWindow.getAllWindows().length}));app.exit(0);
}catch(error){console.error(error);app.exit(1)}});`
);
const log = [],
  env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
try {
  await new Promise((resolve, reject) => {
    const child = spawn(electron, ['--no-sandbox', '--disable-dev-shm-usage', driver], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Electron Canvas超时'));
    }, 40000);
    const collect = (data) => {
      if (log.join('').length < 12000) log.push(String(data));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Electron Canvas失败：' + log.join('').slice(-3000)));
    });
  });
  const result = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(result.status, 'passed');
  assert.equal(result.windows, 0);
  assert.equal(result.background.changedOutsideText, 0);
  assert.equal(result.background.changedInProtected, 0);
  assert.equal(result.font.status, 'passed');
  const decoded = createCanvas(600, 1000).getContext('2d');
  decoded.drawImage(await loadImage(await fs.readFile(path.join(out, 'desktop-svg.png'))), 0, 0);
  const originalPixels = createCanvas(600, 900).getContext('2d');
  originalPixels.drawImage(await loadImage(fixture.bytes), 0, 0);
  for (const [x, y] of [[20, 20], [250, 450], [550, 800]])
    assert.deepEqual(decoded.getImageData(x, y + 100, 1, 1).data, originalPixels.getImageData(x, y, 1, 1).data, 'ASAR渲染器必须保留真实配图像素');
  console.log('✓ 真实Electron主进程读取ASAR模块、Node子进程和原生字体可用，无额外窗口，原图零遮挡');
  console.log('✓ ASAR内resvg平台模块可用，真实SVG配图像素保留');
} finally {
  await fs.writeFile(path.join(out, 'electron.log'), log.join(''));
  await fs.rm(temp, { recursive: true, force: true });
}

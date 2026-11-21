import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serverImports } from '../scripts/serverDeps.mjs';

it('服务器打包依赖检查也跟踪fork/Worker的相对JS入口，不因不是import而漏装原生库', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-process-deps-'));
  try {
    fs.mkdirSync(path.join(root, 'server'));
    fs.writeFileSync(path.join(root, 'server/server.mjs'), "import { fork } from 'node:child_process'; fork(new URL('./worker.mjs', import.meta.url));");
    fs.writeFileSync(path.join(root, 'server/worker.mjs'), "import { createCanvas } from '@napi-rs/canvas'; import { foo } from './nested.js';");
    fs.writeFileSync(path.join(root, 'server/nested.js'), "import JSZip from 'jszip'; new URL('./worker.mjs', import.meta.url);");
    expect([...serverImports(root).keys()].sort()).toEqual(['@napi-rs/canvas', 'jszip']);
    expect(serverImports(root).get('@napi-rs/canvas')).toMatch(/worker\.mjs$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

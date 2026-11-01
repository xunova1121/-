import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
// 用户 2026-11-01：服务器上 ghfast.top 连不上，自动更新要换国内备用镜像，最后才直连
const ROOT=path.resolve(import.meta.dirname,'..');
const hasBash=(()=>{try{execFileSync('bash',['-c','true']);return process.platform!=='win32';}catch{return false;}})();
describe.skipIf(!hasBash)('服务器自动更新的下载地址',()=>{
  it('第一个镜像连不上依次换 gh-proxy.com、ghproxy.net，都不行再直连 GitHub',()=>{
    const t=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-upd-'));
    fs.mkdirSync(path.join(t,'bin'));fs.mkdirSync(path.join(t,'base/current'),{recursive:true});fs.mkdirSync(path.join(t,'base/data'));
    fs.writeFileSync(path.join(t,'base/current/VERSION'),'1.0.1\n');
    fs.writeFileSync(path.join(t,'bin/curl'),'#!/bin/bash\nurl="${@: -1}"\necho "$url" >> "$TRIES"\nexit 28\n',{mode:0o755});
    const env={...process.env,PATH:`${path.join(t,'bin')}:${process.env.PATH}`,JARVIS_BASE:path.join(t,'base'),TRIES:path.join(t,'tries')};
    delete env.JARVIS_MIRRORS;
    try{execFileSync('bash',[path.join(ROOT,'deploy/update.sh')],{env,stdio:'ignore'});}catch{}
    const tries=fs.readFileSync(path.join(t,'tries'),'utf8').trim().split('\n').map(u=>u.replace(/https:\/\/github\.com\/.*$/,'')||'直连');
    fs.rmSync(t,{recursive:true,force:true});
    expect(tries).toEqual(['https://ghfast.top/','https://gh-proxy.com/','https://ghproxy.net/','直连']);
  });
});

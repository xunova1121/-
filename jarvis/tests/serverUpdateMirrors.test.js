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
describe.skipIf(!hasBash)('代码仓库改私密后的更新地址',()=>{
  const run=(curlBody)=>{
    const t=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-upd-'));
    fs.mkdirSync(path.join(t,'bin'));fs.mkdirSync(path.join(t,'base/current'),{recursive:true});fs.mkdirSync(path.join(t,'base/data'));
    fs.writeFileSync(path.join(t,'base/current/VERSION'),'1.0.9\n');
    fs.writeFileSync(path.join(t,'bin/curl'),'#!/bin/bash\nurl="${@: -1}"\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\necho "$url" >> "$TRIES"\n'+curlBody,{mode:0o755});
    const env={...process.env,PATH:`${path.join(t,'bin')}:${process.env.PATH}`,JARVIS_BASE:path.join(t,'base'),TRIES:path.join(t,'tries'),JARVIS_MIRRORS:'-'};
    let out='';try{out=execFileSync('bash',[path.join(ROOT,'deploy/update.sh')],{env,encoding:'utf8'});}catch(e){out=String(e.stdout||'');}
    const tries=fs.readFileSync(path.join(t,'tries'),'utf8').trim().split('\n');fs.rmSync(t,{recursive:true,force:true});return {out,tries};
  };
  it('原仓库回404（改私密）时改从安装包仓库读版本',()=>{
    const {out,tries}=run('case "$url" in *weiyang-release*) printf \'{"version":"1.0.9","sha256":"%064d"}\' 0 > "$out"; exit 0;; *) exit 22;; esac\n');
    expect(tries[0]).toContain('github.com/xunova1121/-/releases');expect(tries[1]).toContain('github.com/xunova1121/weiyang-release/releases');
    expect(out).toContain('已经是最新版');
  });
  it('原仓库只是连不上（超时）时不换仓库',()=>{
    const {tries}=run('exit 28\n');
    expect(tries.every(u=>!u.includes('weiyang-release'))).toBe(true);
  });
});

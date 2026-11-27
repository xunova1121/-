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
// 2026-11-18 用户：电脑老是掉线——日志显示三次都是点“立即更新服务器”后马上重启，正在做的任务全断
describe.skipIf(!hasBash)('有任务在做时自动更新先等',()=>{
  const run=({busyAgeSec=null,clearAfterMs=null}={})=>{
    const t=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-upd-'));
    for(const d of ['bin','base/current','base/data','pkg/jarvis-server/deploy'])fs.mkdirSync(path.join(t,d),{recursive:true});
    fs.writeFileSync(path.join(t,'base/current/VERSION'),'1.0.9\n');
    fs.writeFileSync(path.join(t,'pkg/jarvis-server/deploy/install.sh'),'#!/bin/bash\necho INSTALLED >> "$LOG"\n',{mode:0o755});
    const tgz=path.join(t,'p.tar.gz');execFileSync('tar',['-czf',tgz,'-C',path.join(t,'pkg'),'jarvis-server']);
    const sha=execFileSync('sha256sum',[tgz],{encoding:'utf8'}).slice(0,64);
    fs.writeFileSync(path.join(t,'bin/curl'),`#!/bin/bash\nurl="\${@: -1}"\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\ncase "$url" in *latest.json) printf '{"version":"1.0.10","sha256":"${sha}"}' > "$out";; *) cp "${tgz}" "$out";; esac\n`,{mode:0o755});
    const busy=path.join(t,'base/data/tasks-busy');
    if(busyAgeSec!==null){fs.writeFileSync(busy,'2\n');const at=Date.now()/1000-busyAgeSec;fs.utimesSync(busy,at,at);}
    const env={...process.env,PATH:`${path.join(t,'bin')}:${process.env.PATH}`,JARVIS_BASE:path.join(t,'base'),JARVIS_MIRRORS:'-',JARVIS_UPDATE_WAIT:'3',JARVIS_UPDATE_POLL:'1',LOG:path.join(t,'log')};
    if(clearAfterMs)setTimeout(()=>fs.rmSync(busy,{force:true}),clearAfterMs);
    const t0=Date.now();let out='';
    try{out=execFileSync('bash',[path.join(ROOT,'deploy/update.sh')],{env,encoding:'utf8'});}catch(e){out=String(e.stdout||'');}
    const installed=fs.existsSync(path.join(t,'log'));fs.rmSync(t,{recursive:true,force:true});
    return {out,installed,ms:Date.now()-t0};
  };
  it('有任务在做：先等，等满上限照常安装，并说清在等几个任务',()=>{
    const r=run({busyAgeSec:0});
    expect(r.out).toContain('等 2 个正在做的任务完成后再安装');
    expect(r.out).toContain('照常安装');
    expect(r.installed).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(2500);
  },20000);
  it('标记超过30秒没刷新（服务没在跑）不等；没有标记也不等',()=>{
    for(const r of [run({busyAgeSec:120}),run()]){expect(r.out).not.toContain('正在做的任务');expect(r.installed).toBe(true);}
  },20000);
});

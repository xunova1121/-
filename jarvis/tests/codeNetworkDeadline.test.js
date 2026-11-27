import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withCodeNetworkDeadline } from '../server/codeNetworkDeadline.mjs';
import { gitRetry } from '../server/codeGit.mjs';
import { createCodeRepos } from '../server/codeRepos.mjs';
import { codeRepoFixture } from './helpers/codeRepoFixture.mjs';

it('元数据、Git重试等待共享60秒，默认不能把两次操作各等60秒', async () => {
  vi.useFakeTimers();
  try {
    let calls=0;
    const pending=withCodeNetworkDeadline(async signal=>{await new Promise(r=>setTimeout(r,59900));return gitRetry(async()=>{calls++;throw Object.assign(Error('network'),{code:'CODE_GIT_FAILED'});},signal);}).catch(e=>e);
    await vi.advanceTimersByTimeAsync(60000);const result=await pending;
    expect(result).toMatchObject({code:'CODE_GIT_TIMEOUT',kind:'timeout'});expect(result.message).toContain('GitHub');expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);expect(calls).toBe(1);
  } finally {vi.useRealTimers();}
});

it('取消原样上抛；忽略signal的上游也及时返回总时限', async () => {
  const controller=new AbortController();const stop=Object.assign(Error('stop'),{name:'AbortError'});
  const pending=withCodeNetworkDeadline(()=>new Promise(()=>{}),{signal:controller.signal}).catch(e=>e);
  controller.abort(stop);expect(await pending).toBe(stop);
  await expect(withCodeNetworkDeadline(()=>new Promise(()=>{}),{timeoutMs:10})).rejects.toMatchObject({code:'CODE_GIT_TIMEOUT'});
});

it('已有bare只fetch；fetch总超时不覆盖原工作副本、不重克隆，迟到操作不创建新副本', async () => {
  const fixture=await codeRepoFixture({'src/demo.js':'export const original = true;'});
  let service;
  try {
    const first=await fixture.repos.clone({},{sessionId:'s',taskId:'old'});
    await fs.writeFile(path.join(fixture.cwd(first.workspace_id),'untracked.txt'),'keep-me');
    let finish;const calls=[];
    service=createCodeRepos({baseDir:fixture.root,getConfig:async()=>fixture.cfg,networkTimeoutMs:80,hosting:{repository:async()=>({defaultBranch:'main'})},git:async args=>{calls.push(args);return new Promise(r=>{finish=r;});}});
    await expect(service.clone({},{sessionId:'s',taskId:'new'})).rejects.toMatchObject({code:'CODE_GIT_TIMEOUT'});
    expect(calls).toHaveLength(1);expect(calls[0][0]).toBe('fetch');
    finish({stdout:'',exitCode:0});await new Promise(r=>setImmediate(r));
    expect(await fs.readFile(path.join(fixture.cwd(first.workspace_id),'untracked.txt'),'utf8')).toBe('keep-me');
    expect(await fs.readdir(path.join(fixture.root,'demo__sandbox','worktrees'))).toEqual([first.workspace_id]);
    expect(fixture.command(fixture.source,'rev-parse','HEAD')).toBe(fixture.original);
  } finally {service?.abortAll();await fixture.close();}
});

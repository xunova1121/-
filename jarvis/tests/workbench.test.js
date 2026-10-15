import {it,expect} from 'vitest';
import {decide,remember,contextFor,configureMemory} from '../src/agent/memory.js';
import fs from 'node:fs';
it('不同主体与否定陈述不能靠相似度替换',async()=>{
 const old=[{id:'a',content:'用户住在上海',category:'profile'}];
 expect((await decide('用户的朋友住在北京','profile',old)).action).toBe('ADD');
 expect((await decide('用户不住在上海','profile',old)).action).toBe('ADD');
});
it('自动提炼候选有来源，在确认前不进入上下文',async()=>{
 configureMemory({});
 const m=await remember('用户偏好紫色工作台','preference',{source:'会话 test · 待核实',evidence:'我喜欢紫色工作台'});
 expect(m.pending).toBe(true);expect(m.evidence).toContain('紫色');
 expect((await contextFor('紫色工作台')).memories.some(x=>x.id===m.id)).toBe(false);
});
it('工作台调用真实功能入口，原模块和工具全部保留',()=>{
 const ui=fs.readFileSync('src/ui/workbench.js','utf8');
 for(const name of ['skills','system','workspace','mind','knowledge','settings'])expect(ui).toContain(name);
 for(const file of ['src/agent/scheduler.js','src/agent/team.js','src/agent/knowledge.js','src/agent/mcpClient.js','src/agent/desktopTools.js','src/agent/skillPacks.js'])expect(fs.existsSync(file)).toBe(true);
});

it('手机 App 保留自己的界面：工作台只在电脑上启动', () => {
  const src = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  expect(src).toMatch(/if \(!COMPACT\) initWorkbench\(/);
});

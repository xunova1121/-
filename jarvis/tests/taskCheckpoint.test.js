import { describe,it,expect } from 'vitest';
import {checkpointEvent,checkpointNeedsReview,checkpointRecoveryText} from '../shared/taskCheckpoint.js';
describe('任务检查点',()=>{
 it('并行工具分别保留；失败不算成功，结果未知的写操作需要核对',()=>{
  let c={text:'原始要求',steps:[],inFlight:[]};
  c=checkpointEvent(c,{type:'tool_start',id:'a',name:'write_file',args:{path:'x.md'}});
  c=checkpointEvent(c,{type:'tool_start',id:'b',name:'read_file'});
  c=checkpointEvent(c,{type:'tool_end',id:'b',name:'read_file',ok:false,output:'不存在'});
  expect(c.inFlight.map(x=>x.id)).toEqual(['a']);expect(checkpointNeedsReview(c)).toBe(true);
  const text=checkpointRecoveryText(c);expect(text).toContain('失败步骤（不算完成）：read_file');expect(text).toContain('不得自动重放');
  c=checkpointEvent(c,{type:'tool_end',id:'a',name:'write_file',ok:true,output:'已保存'});expect(checkpointNeedsReview(c)).toBe(false);
 });
 it('完整原话与补充都保留，不把任意MCP工具当只读',()=>{
  const original='原话'.repeat(600);let c={text:original};c=checkpointEvent(c,{type:'user_note',text:'最后的补充'});
  c=checkpointEvent(c,{type:'tool_start',id:'m',name:'mcp_send_email'});
  expect(checkpointRecoveryText(c)).toContain(original);expect(checkpointRecoveryText(c)).toContain('最后的补充');expect(checkpointNeedsReview(c)).toBe(true);
 });
});

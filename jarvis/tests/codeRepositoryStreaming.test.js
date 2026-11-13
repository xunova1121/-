import { it, expect } from 'vitest';
import { createExecutionReview } from '../src/agent/executionReview.js';
const id='a'.repeat(24);
function review(){
  const r=createExecutionReview('制作商城网页，不提交不推送');
  r.record({name:'code_write',args:{workspace_id:id,path:'index.html'},ok:true});
  return r;
}
it('写代码后普通进度即时显示，不用等模型结束才可停止',()=>{
  const s=review().repositoryStream();
  expect(s.push('工作副本已保留，正在等待核对。')).toBe('工作副本已保留，正在等待核对。');
  expect(s.push('',true)).toBe('');
});
it('逐字符和所有分块位置均不泄露未推送链接，保留正常文件和其他网址',()=>{
  const text='完成：[商城](https://github.com/demo/repo/blob/weiyang/task-'+id+'/index.html)。文件：[app.js](app.js)。文档：https://example.com/help 。';
  const expected=review().repositoryText(text);
  for(let split=0;split<=text.length;split++){
    const s=review().repositoryStream();
    expect(s.push(text.slice(0,split))+s.push(text.slice(split))+s.push('',true)).toBe(expected);
  }
  const s=review().repositoryStream();let out='';
  for(const char of text){out+=s.push(char);expect(out).not.toContain('https://github.com');}
  expect(out+s.push('',true)).toBe(expected);
});
it('裸链接结束时处理；超长链接有界丢弃，不阻塞后续文字',()=>{
  const r=review(),s=r.repositoryStream();
  const url='https://github.com/demo/repo/blob/weiyang/task-'+id+'/index.html';
  expect(s.push(url)).toBe('');
  expect(s.push('',true)).toBe(r.repositoryText(url));
  const long=r.repositoryStream();
  expect(long.push('https://github.com/'+ 'a'.repeat(9000))).toContain('链接过长');
  expect(long.push('abc')).toBe('');
  expect(long.push(' 完成。')).toBe(' 完成。');
});
it('禁止时间等强约束仍缓冲核对，未写仓库的普通文本不处理链接',()=>{
  const r=createExecutionReview('不要时间');
  r.record({name:'code_write',args:{workspace_id:id,path:'index.html'},ok:true});
  expect(r.guardsAnswer()).toBe(true);
  const normal=createExecutionReview('你好').repositoryStream();
  expect(normal.push('https://example.com')).toBe('https://example.com');
});

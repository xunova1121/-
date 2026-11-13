import {it,expect,vi} from 'vitest';
import {reviewRealPresentation,presentationContentKey} from '../src/agent/presentationVisualReview.js';
const out=()=>({blob:new Blob(['pptx']),info:{slides:1,layoutIssues:[]}});
const rendering=()=>({officeRender:vi.fn(async()=>({available:true,blob:new Blob(['%PDF-1.7'])})),presentationOverview:vi.fn(async()=>({pages:1,sheets:[{pages:[1],blob:new Blob(['png'])}]}))});
it('缺真实能力不冒充Office视觉；无看图保留真实总览',async()=>{
 expect((await reviewRealPresentation({},out(),'##标题')).review.state).toBe('not_checked');
 const result=await reviewRealPresentation(rendering(),out(),'##标题');expect(result.review.state).toBe('rendered_not_visual_reviewed');expect(result.out.officeOverview.pages).toBe(1);
});
it('视觉修复不得删除事实或表格；无问题才标记reviewed',async()=>{
 const content='## 统计\n\n一共有20个参赛队伍，每队报名10人。';
 const ctx={...rendering(),visionLlm:vi.fn(async()=>JSON.stringify({problems:['太挤'],edits:[{find:'一共有20个参赛队伍，每队报名10人。',replace:'一共有20个队。'}]}))};
 const build=vi.fn();const result=await reviewRealPresentation(ctx,out(),content,{build});expect(result.content).toBe(content);expect(build).not.toHaveBeenCalled();expect(result.review.state).toBe('needs_revision');
 const good=await reviewRealPresentation({...rendering(),visionLlm:async()=>'{"problems":[],"edits":[]}'},out(),content);expect(good.review.state).toBe('reviewed');
 expect(presentationContentKey('## 数据\n20 人')).toBe(presentationContentKey('## 数据\n20\n人'));
});
it('用户停止必须传播，不当成普通渲染失败',async()=>{
 const c=new AbortController();c.abort();await expect(reviewRealPresentation(rendering(),out(),'正文',{signal:c.signal})).rejects.toMatchObject({name:'AbortError'});
});

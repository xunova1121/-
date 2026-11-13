import { describe, it, expect } from 'vitest';
import { generate } from '../src/agent/docs.js';
import { inspectPresentation } from '../src/agent/presentationReceipt.js';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { imageSlots } from '../src/agent/presentationImages.js';
const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'));
describe('PPT配图不吞内容版式', () => {
  it('表格/数字卡/步骤各保留版式与真实侧栏图片', async () => {
    const content = '## 赛程\n版式：表格\n\n| 开赛 | 对阵 |\n|--|--|\n|18:00|甲—乙|\n|19:00|丙—丁|\n\n![球场](field.png)\n\n## 重点\n- 20 场：未开赛\n- 7 场：进行中\n\n![球场](field.png)\n\n## 流程\n版式：步骤\n\n- 读取：采集信息\n- 核对：检查内容\n- 制作：生成文件\n- 验收：阅读文件\n\n![球场](field.png)';
    const out = await generate('pptx',{title:'测试',content,forbidCover:true,loadImage:async()=>bytes});
    expect(out.info.layouts).toEqual(['table','stats','steps']);
    expect(out.info.missingImages).toEqual([]);
    const receipt = await inspectPresentation(await openOfficePackage(out.blob));
    expect(receipt.imagePages).toBe(3);
    expect(receipt.pages[0].tables).toBe(1);
    for (const page of out.info.preview) {
      const contentImage = page.items.filter(item=>item.kind==='image').at(-1);
      expect(contentImage.x).toBeCloseTo(10.05);
      expect(contentImage.w).toBeCloseTo(2.65);
    }
  });
  it('多图真实嵌入，超过容量和读取失败明确报出', async () => {
    const out = await generate('pptx',{title:'图片',forbidCover:true,content:'## 图片\n\n'+Array.from({length:5},(_,i)=>`![场地](p${i}.png)`).join('\n\n'),loadImage:async src=>src==='p1.png'?null:bytes});
    expect(out.info.missingImages).toEqual(expect.arrayContaining(['p1.png', expect.stringContaining('p4.png')]));
    expect((await inspectPresentation(await openOfficePackage(out.blob))).pages[0].contentImages).toBe(3);
    expect(imageSlots('image',4)).toHaveLength(4);
  });
});

it('赛程汇总只按明确数据计数，非法时间不造数字', async () => {
  const { summarizeTable, decorationSvg } = await import('../src/agent/presentationLocalVisuals.js');
  const { parseDoc } = await import('../src/agent/docModel.js');
  const table = parseDoc('| 开赛 | 对阵 |\n|--|--|\n|18:00|甲—乙|\n|18:30|丙—丁|\n|19:00|戊—己|')[0];
  expect(summarizeTable(table)).toMatchObject({ labels:['18:00','19:00'],values:[2,1],total:3 });
  table.rows[0][0] = [{text:'待定'}];
  expect(summarizeTable(table)).toBeNull();
  expect(decorationSvg('足球赛程','123456')).toContain('#123456');
  expect(decorationSvg('普通方案','bad')).toContain('#087E8B');
});
it('紧邻正文的独立图片也保留；封面是明确背景，裁切比例来自原图',async()=>{
 const out=await generate('pptx',{title:'球场',content:'# 球场\n![自有](a.png)\n\n## 赛程\n![自有](a.png)\n版式：表格\n\n|开赛|对阵|\n|--|--|\n|18:00|甲乙|\n|19:00|丙丁|',loadImage:async()=>bytes});
 const zip=await openOfficePackage(out.blob);const receipt=await inspectPresentation(zip);
 expect(receipt.imagePages).toBe(2);
 expect(out.info.layoutIssues.filter(issue=>/压到了图片/.test(issue.text))).toEqual([]);
 const xml=await zip.file('ppt/slides/slide2.xml').async('string');
 expect(xml).toMatch(/<a:srcRect l="[1-9]\d*"/);
});
it('无冒号场数支持数字卡，但年份句不误当数字卡',async()=>{
 const stats=await generate('pptx',{title:'赛事',content:'## 概况\n- 20场未开赛\n- 7场进行中',forbidCover:true});expect(stats.info.layouts).toEqual(['stats']);
 const timeline=await generate('pptx',{title:'计划',content:'## 进度\n- 2026年3月：启动建设\n- 2026年4月：完成施工\n- 2026年5月：完成验收',forbidCover:true});expect(timeline.info.layouts).toEqual(['timeline']);
});

import { it, expect, vi } from 'vitest';
import { independentImageQuestion, IMAGE_READING_RULES } from '../src/agent/imageReading.js';
import { createInspectImageTool } from '../src/agent/inspectImage.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { toOpenAIMessages } from '../src/llm/openai.js';
import { toResponsesInput } from '../src/llm/responses.js';
import { followsImage } from '../src/core/imageFollowup.js';
import { visualFields } from '../src/agent/visualFields.js';
import * as workspace from '../src/agent/workspace.js';

it('用户纠正不进入独立读数提示；不同列、重复行和不确定字符保留', () => {
  expect(independentImageQuestion('第一个值是0372，再好好看看')).not.toContain('0372');
  expect(independentImageQuestion('按左到右读取数字')).toContain('按左到右');
  expect(IMAGE_READING_RULES).toContain('保留重复项');
  expect(IMAGE_READING_RULES).toContain('?');
  expect(visualFields('CO2：037? ppm')).toEqual([]);
});
it('多个局部来自原始字节，同一次视觉请求整体加分区，OCR不冒充分区', async () => {
  await workspace.write('fictional-digits.png', new Blob(['fictional-original'], {type:'image/png'}));
  const cropImage = vi.fn(async (blob, region) => { expect(await blob.text()).toBe('fictional-original'); return new Blob([String(region.x)],{type:'image/png'}); });
  const visionLlm = vi.fn(async o => {
    expect(o.images.map(i=>atob(i.data))).toEqual(['fictional-original','0','0.5']);
    expect(o.images.every(i=>i.detail==='high')).toBe(true);
    expect(o.prompt).not.toContain('0372');
    return 'CO2：037? ppm';
  });
  const ocr=vi.fn(async ({blob})=>{expect(await blob.text()).toBe('fictional-original');return {text:'CO2：032 ppm',model:'fixture'};});
  const output=await createInspectImageTool({cropImage,visionLlm,ocr}).run({path:'fictional-digits.png',question:'第一个值是0372，重新看数字',regions:[{x:0,y:0,width:0.5,height:1},{x:0.5,y:0,width:0.5,height:1}]});
  expect(cropImage).toHaveBeenCalledTimes(2);expect(visionLlm).toHaveBeenCalledTimes(1);expect(ocr).toHaveBeenCalledTimes(1);
  expect(output).toContain('OCR候选来自整图');expect(output).toContain('"regionCount":2');
  for(const regions of [[],Array(5).fill({x:0,y:0,width:1,height:1}),[{x:2,y:0,width:1,height:1}]])
    await expect(createInspectImageTool({}).run({path:'fictional-digits.png',question:'读数',regions})).rejects.toMatchObject({code:'IMAGE_REGION'});
});
it('纠正值可注明用户来源，没视觉复核不能声称看清；双通路回执也认可实际视觉执行',()=>{
  const review=createExecutionReview('第一个值是0372，现在能看清？',{visual:true});
  expect(review.checkAnswer('能看清。CO2：0372 ppm')).not.toEqual([]);
  expect(review.checkAnswer('对，是0372 ppm。')).not.toEqual([]);
  expect(review.checkAnswer('按你提供的纠正，数值为0372；我未独立确认。')).toEqual([]);
  review.record({name:'inspect_image',ok:true,output:'【图像识别回执】'+JSON.stringify({kind:'ocr',ok:true,visionOk:true,fields:[]})});
  expect(review.checkAnswer('重新看过本轮原图，局部存在不确定字符。')).toEqual([]);
});
it('高清细节仅在明确标记的复核图片上传递，普通输入保持原协议',()=>{
  const image={mime:'image/png',data:'QQ==',detail:'high'};
  const messages=[{role:'user',content:'read',images:[image]}];
  expect(toOpenAIMessages([],messages)[1].content[1].image_url.detail).toBe('high');
  expect(toResponsesInput(messages)[0].content[1].detail).toBe('high');
});

it('继续看和用户纠正仍携带最近原图，切换话题后不带旧图', () => {
  const history=[{role:'user',ts:1,content:'看看这张图片'},{role:'user',ts:2,content:'继续看'}];
  const cached=new Map([[1,true]]);
  for(const text of ['继续看','再好好看看','第一个值是0372','你现在能看清？']) expect(followsImage(text,history,cached)).toBe(true);
  expect(followsImage('继续看',[...history,{role:'user',ts:3,content:'帮我写封邮件'}],cached)).toBe(false);
});

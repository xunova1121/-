import {describe,it,expect} from 'vitest';
import {pickFinalFiles} from '../src/ui/finalFiles.js';
import {asksForImages,wantsEverySlideImage,requiresEverySlideImage} from '../src/agent/presentationReceipt.js';
// 用户 2026-11-02：“做成含图片的PPT，做成两页就可”交付的PPT没有图；回答末尾一下子列出5个文件分不清哪个是最终版
describe('只摆最终版',()=>{
  const files=['2026年11月2日重点新闻简报.预览.pdf','2026年11月2日重点新闻简报.pptx','2026年11月2日重点新闻简报.总览-1.png','images/Cleanprofessiona-mvylss2z.png','images/Minimalbusinessi-mvylu3gq.png'];
  it('有PPT时只留PPT，预览、总览、配图收进其他文件',()=>{
    const r=pickFinalFiles(files);
    expect(r.final).toEqual(['2026年11月2日重点新闻简报.pptx']);expect(r.extra).toHaveLength(4);
  });
  it('同格式出了两版只留最后一版',()=>{
    expect(pickFinalFiles(['a.pptx','a-v2.pptx']).final).toEqual(['a-v2.pptx']);
  });
  it('Word和PDF都是正式文件时都留；只出图或歌时全部照常列出',()=>{
    expect(pickFinalFiles(['报告.docx','报告.pdf','报告.预览.pdf']).final).toEqual(['报告.docx','报告.pdf']);
    expect(pickFinalFiles(['images/a.png','images/b.png']).final).toHaveLength(2);
    expect(pickFinalFiles(['音乐/歌.mp3']).final).toEqual(['音乐/歌.mp3']);
  });
});
describe('说了含图就配图、就检查',()=>{
  it('含图片/带图/图文并茂都算要图；说不要图片不算',()=>{
    for(const t of ['做成含图片的PPT，做成两页就可','PPT要带图','做个图文并茂的PPT','加几张图片'])expect(asksForImages(t)).toBe(true);
    for(const t of ['做个PPT','PPT不要图片','这页图表不对'])expect(asksForImages(t)).toBe(false);
  });
  it('页数少时含图就是每页都要图；原有每页配图规则不变',()=>{
    expect(requiresEverySlideImage('做成含图片的PPT，做成两页就可')).toBe(false);
    expect(wantsEverySlideImage('做成含图片的PPT，做成两页就可')).toBe(true);
    expect(wantsEverySlideImage('做成含图片的PPT',12)).toBe(false);
    expect(wantsEverySlideImage('每页都要配图',12)).toBe(true);
  });
});

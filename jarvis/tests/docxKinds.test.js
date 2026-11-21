import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { generate } from '../src/agent/docs.js';

const xml = async (blob) => (await JSZip.loadAsync(await blob.arrayBuffer())).file('word/document.xml').async('string');
const MINUTES = '# 第三次推进会会议纪要\n\n时间：2026年10月21日 14:00\n地点：二楼会议室\n主持：张工\n参会：李工、王工\n记录：小陈\n\n## 一、议定事项\n\n1. 完成电子秤联调\n\n## 二、其他\n\n下次再议。\n\n## 三、附件\n\n无';
const POLICY = '# 结算对账管理办法\n\n## 第一章 总则\n\n第一条 为规范结算，制定本办法。\n\n第二条 本办法适用于试点交易点。\n\n## 第二章 附则\n\n第三条 本办法自印发之日起施行。';

describe('Word 按文种排', () => {
  it('纪要：开头的时间、地点、主持、参会排成会议信息表；不加封面和目录（即使传了 cover）', async () => {
    const r = await generate('docx', { title: '纪要', content: MINUTES, kind: 'minutes', cover: true, theme: 'business' });
    const d = await xml(r.blob);
    expect(d).toMatch(/<w:tbl>[\s\S]*主持[\s\S]*张工[\s\S]*<\/w:tbl>/);
    expect(d).not.toContain('时间：');
    expect(r.info.toc).toBe(false);
    expect(d).not.toMatch(/w:fill="1F3A5F"[^>]*\/>[\s\S]{0,400}纪要/); // 没有深色封面块
  });

  it('制度：“第一条”条号加粗；“第一章”居中', async () => {
    const d = await xml((await generate('docx', { title: '办法', content: POLICY, kind: 'policy', theme: 'business' })).blob);
    expect(d).toMatch(/<w:b\/>[\s\S]{0,300}<w:t[^>]*>第一条　<\/w:t>/);
    const styles = await (await JSZip.loadAsync(await (await generate('docx', { title: '办法', content: POLICY, kind: 'policy', theme: 'business' })).blob.arrayBuffer())).file('word/styles.xml').async('string');
    expect(styles).toMatch(/w:styleId="Heading1"[\s\S]{0,600}<w:jc w:val="center"\/>/);
  });

  it('短报告不加目录和页眉；长方案（3000 字以上）自动加封面和目录', async () => {
    const short = await generate('docx', { title: '周报', content: '# 周报\n\n## 一、完成\n\n联调完成。\n\n## 二、问题\n\n接口未开放。\n\n## 三、计划\n\n确认接口。', kind: 'report', theme: 'business' });
    expect(short.info.toc).toBe(false);
    const sec = (t) => `## ${t}\n\n${'交易点按批次登记称重、检测、结算和对账记录，每一步记录操作人和时间。'.repeat(26)}\n\n`;
    const long = await generate('docx', { title: '建设方案', content: `# 建设方案\n\n${['一、背景', '二、流程', '三、结算', '四、验收'].map(sec).join('')}`, kind: 'proposal', theme: 'business' });
    expect(long.info.toc).toBe(true);
    expect(await xml(long.blob)).toMatch(/w:fill="1F3A5F"/); // 深色封面块
  });
});

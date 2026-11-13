/** 政企汇报风格（用户 2026-11-05 给的参考：运营商政企项目汇报稿）：页框、结论句、关键词标红、原生渐变、指标条、四宫格、竖标签面板、左图右文 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { makePptx, orphanSafeSize } from '../src/agent/pptxWriter.js';
import { styleTokens, STYLE_IDS, ALL_STYLE_IDS } from '../src/agent/pptStyles.js';
import { THEMES, REPORT_THEMES, findTheme } from '../src/agent/themes.js';
import { splitReportTitle, richRuns, KEY_LINE } from '../src/agent/pptReport.js';
import { gradientName, rewriteGradients } from '../src/agent/pptGradient.js';
import { chooseDesign } from '../src/agent/documentDesign.js';
import { presentationRequest } from '../src/agent/presentationDesign.js';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAFCAIAAAD38zoCAAAAFklEQVR4nGNkYPjPwMDAxMDAwMDAAAA0BwIB8p4pqwAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const MD = `# 智慧园区项目汇报

## 一、项目核心痛点

结论：系统分散，**看不全、管不住**

- 1200公顷：园区规划面积
- 386家：入驻企业
- 18套：独立业务系统

## 一、项目核心痛点：四大难题

- 看不全：监控盲区多｜重点区域覆盖率不足60%
- 管不住：事件发现晚｜违规问题平均2小时后才被发现
- 调不动：协同效率低｜三支队伍各自派单
- 算不清：能耗底数不明｜月度统计需要3天

## 二、解决方案：1.智能感知

结论：已完成前端部署，实现**全域覆盖**

![运营驾驶舱](img/a.png)

- 视频感知：新增摄像头420路｜覆盖率提升到98%
- 物联感知：部署传感器2300个
- 能耗感知：接入表计1150块

## 二、解决方案：2.统一调度

### 一屏统管
- 将园区事件全部汇聚到运营驾驶舱
- 实时感知：异常自动告警
- 精准匹配：自动匹配最近处置人员

### 一键调度
- 一键派发：工单自动推送
- 一键跟踪：实时查看处置进度

## 谢谢

以“一网一屏一键”赋能园区运营`;
const load = async () => PNG;
const build = (extra = {}) => makePptx({ title: '智慧园区项目汇报', content: MD, theme: THEMES.business, style: 'report', author: '某某科技有限公司', date: '2026年11月', loadImage: load, ...extra });
const slideXml = async (blob) => { const zip = await JSZip.loadAsync(await blob.arrayBuffer()); return Promise.all(Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map(p => zip.file(p).async('string'))); };
const texts = (page) => page.items.filter(it => it.kind === 'text').map(it => (Array.isArray(it.text) ? it.text.map(r => r.text).join('') : String(it.text)));

describe('政企汇报风格', () => {
  it('第五种风格单独登记：通用四种的清单不变；规范与其他风格不同', () => {
    expect(STYLE_IDS).toHaveLength(4);
    expect(ALL_STYLE_IDS).toContain('report');
    const t = styleTokens('report', REPORT_THEMES['tech-blue']);
    expect(t).toMatchObject({ id: 'report', titleBar: 'report', cover: 'gradient', section: 'gradient', bg: 'FFFFFF' });
    expect(t.gradient).toHaveLength(3);
    expect(styleTokens('report', THEMES.gongwen).id).toBe('business');
    expect(findTheme('政务红').id).toBe('gov-red');
    expect(findTheme('eco-green').name).toBe('生态绿');
  });
  it('标题拆成章节和小标题；结论句、加粗标红、数字标蓝', () => {
    expect(splitReportTitle('二、AI解决方案：1.预警端智能(1/2)')).toEqual({ lead: '二、AI解决方案：', rest: '1.预警端智能(1/2)', section: 'AI解决方案' });
    expect(splitReportTitle('一、项目核心痛点')).toMatchObject({ lead: '一、项目核心痛点', section: '项目核心痛点' });
    expect(splitReportTitle('普通标题').lead).toBe('');
    expect(KEY_LINE.exec('结论：上线识别研判智能体')?.[1]).toBe('上线识别研判智能体');
    const runs = richRuns([{ text: '覆盖率达到98%，' }, { text: '全域覆盖', bold: true }], { color: '111111', hot: 'D9261C', num: '1677D9' });
    expect(runs.find(r => r.text === '98%').options.color).toBe('1677D9');
    expect(runs.find(r => r.text === '全域覆盖').options.color).toBe('D9261C');
  });
  it('原生渐变：按名字把纯色改写成 gradFill，其他形状不动', () => {
    const name = gradientName(['0b4ea2', '1677D9', '5FA8F0'], 35);
    expect(name).toBe('wy-grad-0B4EA2-1677D9-5FA8F0-35');
    const xml = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="${name}"></p:cNvPr></p:nvSpPr><p:spPr><a:solidFill><a:srgbClr val="1677D9"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="1677D9"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="other"></p:cNvPr></p:nvSpPr><p:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:spPr></p:sp>`;
    const out = rewriteGradients(xml);
    expect(out.count).toBe(1);
    expect(out.xml).toContain('<a:gs pos="0"><a:srgbClr val="0B4EA2"/></a:gs>');
    expect(out.xml).toContain('<a:lin ang="2100000" scaled="0"/>');
    expect(out.xml).toContain('<a:ln w="12700"><a:noFill/></a:ln>');
    expect(out.xml).toContain('name="other"></p:cNvPr></p:nvSpPr><p:spPr><a:solidFill>');
  });
  it('整份汇报：封面、提纲、指标条、四宫格、左图右文、竖标签面板、结尾；无排版错误；封面结尾是原生渐变', async () => {
    const { blob, info } = await build();
    expect(info.style).toBe('report');
    expect(info.layouts).toEqual(['cover', 'agenda', 'stats', 'cards', 'imageText', 'panel', 'end']);
    expect(info.layoutIssues.filter(x => x.level === 'error')).toEqual([]);
    expect(info.missingImages).toEqual([]);
    // 结论句在标题下面，“结论：”字样不上屏
    const kpi = info.preview[2];
    expect(texts(kpi)).toContain('系统分散，看不全、管不住');
    expect(texts(kpi).join('')).not.toContain('结论：');
    expect(texts(kpi).join('')).toContain('1200公顷');
    // 提纲按“一、二、”章节名汇总
    expect(texts(info.preview[1]).join('')).toMatch(/项目核心痛点[\s\S]*解决方案/);
    // 痛点四宫格：红色小标题
    expect(texts(info.preview[3])).toContain('监控盲区多');
    const xml = await slideXml(blob);
    expect(xml[0]).toContain('<a:gradFill');
    expect(xml.at(-1)).toContain('<a:gradFill');
    expect(xml.join('')).not.toMatch(/name="wy-grad-[^"]+"[\s\S]{0,200}<a:solidFill>/);
    // 原文的结论句保留在可编辑底稿里
    expect(info.editableContent).toContain('结论：系统分散');
  });
  it('打印友好：不用深色渐变，封面白底', async () => {
    const { blob, info } = await build({ printFriendly: true });
    expect(info.preview[0].background).toBe('FFFFFF');
    expect((await slideXml(blob))[0]).not.toContain('<a:gradFill');
  });
  it('其他风格不受影响：同样内容的商务风格不出现提纲、结论句仍是正文', async () => {
    const { info } = await makePptx({ title: '智慧园区项目汇报', content: MD, theme: THEMES.business, style: 'business', loadImage: load });
    expect(info.layouts).not.toContain('agenda');
    expect(info.layouts).not.toContain('panel');
  });
  it('什么时候自动用政企汇报：说了政企 / 路演才用，普通“汇报风”仍是稳重商务', () => {
    expect(chooseDesign({ format: 'pptx', requirements: '做成政企汇报的风格' }).style).toBe('report');
    expect(chooseDesign({ format: 'pptx', title: '智慧园区项目路演' }).style).toBe('report');
    expect(chooseDesign({ format: 'pptx', requirements: '汇报风，正式一点' }).style).toBe('business');
    expect(chooseDesign({ format: 'pptx', title: '季度工作总结' }).style).toBe('business');
    expect(presentationRequest('按政企风来做').style).toBe('report');
    expect(presentationRequest('按政企汇报风格做成PPT').style).toBe('report');
    expect(presentationRequest('汇报风').style).toBe('business');
  });
  it('防一个字单独成行：最后一行只剩一两个字时减小字号', () => {
    // 样例里“每项任务确认负责人和交付物”在 3.37 寸宽的卡片里按 18 号排，“物”单独掉到第二行
    expect(orphanSafeSize('每项任务确认负责人和交付物', 3.37, 18)).toBeLessThan(18);
    expect(orphanSafeSize('短句', 2.7, 16)).toBe(16);
    expect(orphanSafeSize('一二三四五六七八九十一二', 2.0, 16)).toBe(16);
  });
});

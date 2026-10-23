import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseDesign } from '../src/agent/documentDesign.js';
import { createTools } from '../src/agent/tools.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';

describe('任务决定设计', () => {
  it('PPT：用户明说的优先；其次看内容（剧情 → 叙事，表格多 → 数据，产品 → 留白，汇报 → 商务）', () => {
    expect(chooseDesign({ format: 'pptx', requirements: '仙逆动漫剧情，做一份5页PPT' }).style).toBe('story');
    expect(chooseDesign({ format: 'pptx', requirements: '仙逆剧情，要简约一点' }).style).toBe('minimal');
    expect(chooseDesign({ format: 'pptx', title: '新品发布会' }).style).toBe('minimal');
    expect(chooseDesign({ format: 'pptx', title: '三季度经营分析' }).style).toBe('data');
    expect(chooseDesign({ format: 'pptx', content: '## a\n| x | y |\n|--|--|\n| 1 | 2 |\n## b\n| x | y |\n|--|--|\n| 1 | 2 |' }).style).toBe('data');
    expect(chooseDesign({ format: 'pptx', title: '项目建设方案汇报' }).style).toBe('business');
    expect(chooseDesign({ format: 'pptx', title: '随便', style: 'story' })).toMatchObject({ style: 'story', reason: '按指定的风格' });
  });
  it('Word 看文种，Excel 看用途', () => {
    expect(chooseDesign({ format: 'docx', title: '第三次项目例会会议纪要' }).kind).toBe('minutes');
    expect(chooseDesign({ format: 'docx', title: '关于开展安全检查的通知' }).kind).toBe('notice');
    expect(chooseDesign({ format: 'docx', title: '车辆管理办法' }).kind).toBe('policy');
    expect(chooseDesign({ format: 'docx', title: '水产养殖数字化建设方案' }).kind).toBe('proposal');
    expect(chooseDesign({ format: 'docx', title: '三季度工作总结' }).kind).toBe('report');
    expect(chooseDesign({ format: 'xlsx', title: '养殖户收购结算表' }).kind).toBe('settlement');
    expect(chooseDesign({ format: 'xlsx', title: '设备台账' }).kind).toBe('ledger');
    expect(chooseDesign({ format: 'xlsx', title: '2027年度预算' }).kind).toBe('budget');
    expect(chooseDesign({ format: 'xlsx', title: '月度销售分析' }).kind).toBe('analysis');
  });
});

describe('create_document 按任务选设计并说出来', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-design-')); useBackend(createFileStore(dir)); });
  afterEach(() => { useBackend(null); fs.rmSync(dir, { recursive: true, force: true }); });
  it('仙逆剧情 PPT 自动用叙事氛围和墨玉配色', async () => {
    const tool = createTools({}).find((t) => t.name === 'create_document');
    const r = await tool.run({ format: 'pptx', path: '文件/仙逆.pptx', title: '仙逆动漫131集以后剧情梳理', content: '## 深渊脱困\n- 王林炼化雷龙本源\n- 得到斩罗诀', requirements: '仙逆动漫剧情，做一份PPT' });
    expect(r).toMatch(/设计：叙事氛围/);
    expect(r).toMatch(/主题：墨玉/);
  });
});

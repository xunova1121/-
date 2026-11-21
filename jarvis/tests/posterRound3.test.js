/** 2026-11-18 用户实测（黄仁勋新闻海报、甘特图）：海报还是不达标 */
import { describe, expect, it } from 'vitest';
import { metaReply, rewriteRule } from '../src/agent/agent.js';
import { normalizeLayerDesign } from '../src/agent/layeredDesignInput.js';
import { composeLayeredSvg } from '../src/agent/layeredDesignSvg.js';
import { fixTextContrast } from '../src/agent/layeredDesignScrim.js';
import { checkLayerContrast } from '../src/agent/layeredDesignQuality.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';

describe('收尾核对后的自言自语不给用户看', () => {
  it('英文思考过程、回应系统核对、“无补充”都算；正常中文补充不算', () => {
    const leaked = "The user is asking for a Gantt chart of Jensen Huang's timeline. Let me review what I have and deliver it. Actually looking again — the conversation shows I already produced the chart in my previous turn. I'll output nothing.（无补充）";
    expect(metaReply(leaked)).toBe(true);
    expect(metaReply('（无补充）')).toBe(true);
    expect(metaReply('系统自动核对：没有需要补充的。')).toBe(true);
    expect(metaReply('补充：11/18 董事会已开始遴选新CEO，图里第7行已更新。')).toBe(false);
    expect(metaReply('Q3 revenue grew 19.4% to 5.4 trillion yuan')).toBe(false);
  });
  it('链接名/格式说法对不上归为交付核对（程序直接改正，不让模型重写）', () => {
    expect(rewriteRule('链接文字写的是“x.design.json”，实际指向“y.design.json”')).toBe('delivery_claim');
  });
});

describe('纯色底上看不清的字自动换色', () => {
  it('浅蓝卡片上的浅色标题对比度不够：换成能看清的颜色，原文字号位置不变，复测通过', async () => {
    const design = normalizeLayerDesign({ width: 540, height: 600, title: '黄仁勋最新动态', palette: { background: '#F4F7FB', ink: '#132033' }, layers: [
      { id: 'card', type: 'shape', x: 40, y: 80, w: 460, h: 200, fill: '#7FA6D9' },
      { id: 'title', type: 'text', text: '辞职后首次发声', x: 60, y: 100, w: 420, h: 60, fontSize: 40, weight: 700, color: '#C9DBF2' },
      { id: 'body', type: 'text', text: '愿在董事会邀请下回归', x: 60, y: 180, w: 420, h: 40, fontSize: 26, color: '#132033' }] });
    const raster = (svg, o) => renderVisualScene(svg, o);
    expect((await checkLayerContrast(design, composeLayeredSvg(design), raster)).status).toBe('failed');
    const before = { ...design.layers.find(n => n.id === 'title') };
    const r = await fixTextContrast(design, { compose: d => composeLayeredSvg(d), raster });
    expect(r.status).toBe('passed');
    expect(r.recolored).toEqual([{ id: 'title', from: '#C9DBF2', to: '#132033' }]);
    const after = design.layers.find(n => n.id === 'title');
    expect({ ...after, color: before.color }).toEqual(before);
    expect((await checkLayerContrast(design, composeLayeredSvg(design), raster)).status).toBe('passed');
  }, 60000);
});

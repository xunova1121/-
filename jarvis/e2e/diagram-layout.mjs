/** 实际SVG渲染与文字边界检查；不调用画图模型。 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramSvg } from '../src/agent/diagramSvg.js';
const output = process.argv[2] || '/tmp/weiyang-diagram-e2e';
await fs.mkdir(output, { recursive: true });
const svg = diagramSvg(layoutDiagram({ title: '智慧执法业务架构', layers: [
  { title: '感知设备层', nodes: [{ id: 'radar', title: '雷达' }, { id: 'camera', title: '双光谱云台' }, { id: 'drone', title: '无人机' }, { id: 'ais', title: 'AIS / 北斗' }] },
  { title: '数据与AI中台', nodes: [{ id: 'data', title: '数据治理', detail: '清洗、融合、统一资源' }, { id: 'ai', title: '智能分析', detail: '大模型与算法协同' }] },
  { title: '三大AI端 · 核心能力', emphasis: true, nodes: [{ id: 'warning', title: '预警端', detail: '识别违法、分析轨迹、比对历史' }, { id: 'command', title: '指挥端', detail: '就近派单、跟踪处置闭环' }, { id: 'enforce', title: '执法端', detail: '查询法条、辅助文书与裁量' }] },
  { title: '三端应用', nodes: [{ id: 'screen', title: '大屏驾驶舱' }, { id: 'pc', title: 'PC管理后台' }, { id: 'app', title: '移动执法APP' }] }
], edges: [{ from: 'radar', to: 'data' }, { from: 'data', to: 'warning' }, { from: 'warning', to: 'screen' }] }));
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><body style="margin:0">' + svg + '</body></html>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('g[id^="node-"]')];
    const inBounds = nodes.every(node => {
      const rect = node.querySelector('rect').getBBox();
      return [...node.querySelectorAll('text')].every(text => { const box = text.getBBox(); return box.x >= rect.x && box.y >= rect.y && box.x + box.width <= rect.x + rect.width && box.y + box.height <= rect.y + rect.height; });
    });
    return { allNodes: nodes.length === 12, nativeText: document.querySelectorAll('text').length >= 17, inBounds, noRasterImage: !document.querySelector('image,foreignObject,script'), bottomUp: document.querySelector('[data-layer="感知设备层"]').getBBox().y > document.querySelector('[data-layer="三端应用"]').getBBox().y };
  });
  await page.locator('svg').screenshot({ path: path.join(output, 'editable-architecture.png') });
  for (const [label, passed] of Object.entries(result)) {
    console.log((passed ? '✓ ' : '✗ ') + label);
    if (!passed) throw new Error(label);
  }
  console.log('实际可编辑架构图5/5通过');
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

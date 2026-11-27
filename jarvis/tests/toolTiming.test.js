import { describe, it, expect } from 'vitest';
import { createToolTiming } from '../src/app/toolTiming.js';

const label = (n) => ({ web_search: '联网搜索', read_file: '读文件', run_command: '运行命令' })[n] || n;

describe('回答下面的用时：每个工具用了多久、等确认多久', () => {
  it('没用工具时什么都不写', () => {
    expect(createToolTiming().tag(0, label)).toBe('');
  });

  it('写出花时最多的两个工具（同名合并、写次数）；不到 1 秒的不单列', () => {
    const t = createToolTiming();
    t.add({ name: 'web_search', ms: 8200 });
    t.add({ name: 'web_search', ms: 9800 });
    t.add({ name: 'read_file', ms: 300 });
    t.add({ name: 'run_command', ms: 2500 });
    t.add({ name: 'update_plan', ms: 99999 });
    expect(t.tag(4, label)).toBe(' · 工具 4 次（联网搜索 2 次 18.0s，运行命令 2.5s）');
  });

  it('等用户点确认的时间从工具用时里扣出来单独写', () => {
    const t = createToolTiming();
    t.add({ name: 'run_command', ms: 12000, waitMs: 10500 });
    expect(t.tag(1, label)).toBe(' · 工具 1 次（运行命令 1.5s） · 等确认 10.5s');
  });

  it('智能体没报次数时按收到的工具事件算；坏数据不出错', () => {
    const t = createToolTiming();
    t.add({ name: 'read_file', ms: 'x' });
    t.add(null);
    t.add({ ms: 5 });
    expect(t.tag(0, label)).toBe(' · 工具 1 次');
  });

  it('工具种类有上限（50 种），再多的不再记', () => {
    const t = createToolTiming();
    for (let i = 0; i < 60; i++) t.add({ name: `t${i}`, ms: 1000 + i });
    expect(t.tag(0)).toBe(' · 工具 50 次（t49 1.0s，t48 1.0s）');
  });
});

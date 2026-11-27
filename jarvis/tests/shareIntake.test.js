import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/app/env.js', () => ({ toast: vi.fn() }));
const { createShareIntake } = await import('../src/app/shareIntake.js');

/** 假的原生插件：攒着几批分享，take 一次全给；记录 done 和监听 */
function fakePlugin(batches) {
  const state = { batches: [...batches], done: [], listener: null, takes: 0 };
  return {
    state,
    take: vi.fn(async () => { state.takes++; const b = state.batches; state.batches = []; return { batches: b }; }),
    done: vi.fn(async ({ id }) => { state.done.push(id); }),
    addListener: vi.fn((ev, fn) => { if (ev === 'shared') state.listener = fn; })
  };
}
function fakeApp(text = '') {
  const app = { prompt: { value: text }, added: [], autosize: vi.fn() };
  app.addFiles = vi.fn(async (files) => { app.added.push(...files); });
  return app;
}
const fileStore = { '/cache/share-in/a1/图.jpg': 'JPGDATA', '/cache/share-in/a1/合同.pdf': 'PDFDATA' };
const deps = (plugin, toast = vi.fn()) => ({
  plugin: () => plugin,
  toast,
  fileUrl: (p) => `https://localhost/_capacitor_file_${p}`,
  fetchImpl: async (url) => {
    const body = fileStore[url.replace('https://localhost/_capacitor_file_', '')];
    return body ? new Response(new Blob([body], { type: 'application/octet-stream' })) : new Response('', { status: 404 });
  }
});

describe('安卓“分享 → 未央”', () => {
  it('启动恢复做完前不取；start 后把文件交给原有上传流程，文字接在输入框末尾，读完让原生删缓存', async () => {
    const plugin = fakePlugin([{ id: 'a1', skipped: 0, text: '帮我看看这两个', files: [
      { path: '/cache/share-in/a1/图.jpg', name: '图.jpg', type: 'image/jpeg', size: 7 },
      { path: '/cache/share-in/a1/合同.pdf', name: '合同.pdf', type: 'application/pdf', size: 7 }
    ] }]);
    const app = fakeApp('我想问：');
    const { shareIntake } = createShareIntake(app, deps(plugin));
    expect(await shareIntake.takeShared()).toBe(0);
    expect(plugin.take).not.toHaveBeenCalled();
    shareIntake.start();
    expect(await shareIntake.takeShared()).toBe(2);
    expect(app.added.map((f) => [f.name, f.type])).toEqual([['图.jpg', 'image/jpeg'], ['合同.pdf', 'application/pdf']]);
    expect(await app.added[0].text()).toBe('JPGDATA');
    expect(app.prompt.value).toBe('我想问：\n帮我看看这两个');
    expect(app.autosize).toHaveBeenCalled();
    expect(plugin.state.done).toEqual(['a1']);
  });

  it('App 开着时再分享：收到事件就取；同时触发只取一次', async () => {
    const plugin = fakePlugin([]);
    const app = fakeApp();
    const { shareIntake } = createShareIntake(app, deps(plugin));
    shareIntake.start();
    await shareIntake.takeShared();
    plugin.state.batches.push({ id: 'b2', skipped: 0, text: '只有文字', files: [] });
    plugin.state.listener();
    plugin.state.listener();
    await shareIntake.takeShared();
    expect(app.prompt.value).toBe('只有文字');
    expect(app.addFiles).not.toHaveBeenCalled();
    expect(plugin.state.done).toEqual(['b2']);
    shareIntake.start();
    expect(plugin.addListener).toHaveBeenCalledTimes(1);
  });

  it('太大没收的、读不出来的：提示有几个没放进来，其余照收', async () => {
    const plugin = fakePlugin([{ id: 'c3', skipped: 1, files: [
      { path: '/cache/share-in/a1/图.jpg', name: '图.jpg', type: 'image/jpeg' },
      { path: '/cache/share-in/c3/不见了.png', name: '不见了.png', type: 'image/png' }
    ] }]);
    const app = fakeApp();
    const toast = vi.fn();
    const { shareIntake } = createShareIntake(app, deps(plugin, toast));
    shareIntake.start();
    expect(await shareIntake.takeShared()).toBe(1);
    expect(toast).toHaveBeenCalledWith('有 2 个文件太大（单个最多 32MB）或读不了，没放进来');
    expect(plugin.state.done).toEqual(['c3']);
  });

  it('上传出错不吞掉：提示原因；不在安卓 App 里（没有插件）什么都不做', async () => {
    const plugin = fakePlugin([{ id: 'd4', skipped: 0, files: [{ path: '/cache/share-in/a1/图.jpg', name: '图.jpg' }] }]);
    const app = fakeApp();
    app.addFiles = vi.fn(async () => { throw new Error('服务器连不上'); });
    const toast = vi.fn();
    const { shareIntake } = createShareIntake(app, deps(plugin, toast));
    shareIntake.start();
    await shareIntake.takeShared();
    expect(toast).toHaveBeenCalledWith('分享的内容没放进来：服务器连不上');
    const none = createShareIntake(fakeApp(), { ...deps(null), plugin: () => undefined }).shareIntake;
    none.start();
    expect(await none.takeShared()).toBe(0);
  });
});

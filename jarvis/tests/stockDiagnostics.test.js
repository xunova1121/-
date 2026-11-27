import { it, expect, vi } from 'vitest';
import { createStockImages } from '../server/stockImages.mjs';
import { stockDiagnostic } from '../src/agent/stockImageDiagnostics.js';
import { stockImageTool } from '../src/agent/stockImageTool.js';
import { serverKeysPanel } from '../src/ui/serverKeysPanel.js';
const secret = 'private-pixabay-key-do-not-print';
const health = { get: async () => ({}), record: async () => {} };
const storage = { get: async () => null, put: async () => {} };
const cfg = { pixabayKey: secret, stockVerified: { pixabay: { ok: true } } };
const photo = { id: 1, user: 'Photographer', user_id: 2, pageURL: 'https://pixabay.com/photos/1/', webformatURL: 'https://cdn.pixabay.com/photo/1.jpg' };
const service = (fetchImpl, configuration = cfg) => createStockImages({ getConfig: () => configuration, fetchImpl, health, storage });
for (const [status, body, code] of [
  [400, '[ERROR 400] Invalid API key. ' + secret, 'STOCK_AUTH'],
  [403, 'private-response ' + secret, 'STOCK_FORBIDDEN'],
  [429, secret, 'STOCK_RATE']
])
  it(`API HTTP${status}有明确原因且不回显Key或响应体`, async () => {
    const api = service(async () => new Response(body, { status }));
    let error;
    try {
      await api.probe('pixabay');
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code, status, phase: 'api', provider: 'pixabay' });
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('private-response');
    if (status === 403) expect(error.message).toContain('不能判断Key无效');
  });
it('HTML、DNS和超时分别报告，不一概说Key错误', async () => {
  for (const [fetcher, code] of [
    [async () => new Response('<html>' + secret + '</html>'), 'STOCK_RESPONSE'],
    [
      async () => {
        throw new TypeError(secret, { cause: { code: 'ENOTFOUND' } });
      },
      'STOCK_DNS'
    ],
    [
      async () => {
        throw Object.assign(new Error(secret), { name: 'TimeoutError' });
      },
      'STOCK_TIMEOUT'
    ]
  ]) {
    let error;
    try {
      await service(fetcher).probe('pixabay');
    } catch (e) {
      error = e;
    }
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(secret);
  }
});
it('API通过但图片下载403，标明image阶段，不让用户误换API Key', async () => {
  const api = service(async (url) =>
    String(url).startsWith('https://pixabay.com/api/') ? new Response(JSON.stringify({ hits: [photo] })) : new Response(secret, { status: 403 })
  );
  await expect(api.probe('pixabay')).rejects.toMatchObject({ code: 'STOCK_FORBIDDEN', status: 403, phase: 'image', provider: 'pixabay' });
});
it('未检测的已保存Key保持门禁，但把具体原因告诉调用者；不能伪造已启用', async () => {
  const fetcher = vi.fn();
  const api = service(fetcher, { pixabayKey: secret });
  const diagnostics = [];
  expect(await api.forSlide({ query: 'company office', visionLlm: async () => '{"index":0}', onDiagnostic: (d) => diagnostics.push(d) })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ code: 'STOCK_NOT_VERIFIED', phase: 'configuration', provider: 'pixabay' });
});
it('没有看图线路单独提示，不联网、不盲选第一张；筛图自身失败不冒充图库Key失败', async () => {
  const fetcher = vi.fn();
  const diagnostics = [];
  expect(await service(fetcher).forSlide({ query: 'office', onDiagnostic: (d) => diagnostics.push(d) })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(diagnostics[0].code).toBe('STOCK_VISION_MISSING');
});
it('任意上游错误文本、未知code和URL不会进入公开诊断', () => {
  const error = Object.assign(new Error('https://pixabay.com/api?key=' + secret), { code: secret });
  expect(JSON.stringify(stockDiagnostic(error, { provider: secret, phase: secret }))).not.toContain(secret);
});
it('工具回执显示具体启用条件，不再只返回“没有图片”', async () => {
  const tool = stockImageTool({
    stockImageForSlide: async (o) => {
      o.onDiagnostic(stockDiagnostic({ code: 'STOCK_VISION_MISSING' }, { phase: 'vision' }));
      return null;
    }
  });
  const result = JSON.parse(await tool.run({ query: '办公' }));
  expect(result.note).toContain('看图模型');
  expect(result.diagnostics[0].code).toBe('STOCK_VISION_MISSING');
});
function node(tag, props = {}, ...children) {
  return {
    tag,
    value: '',
    checked: false,
    disabled: false,
    ...props,
    children: children.flat(),
    events: {},
    addEventListener(type, fn) {
      this.events[type] = fn;
    }
  };
}
const flatten = (node) => [node, ...(node.children || []).filter((x) => x && typeof x === 'object').flatMap(flatten)];
it('填新Key直接检测会先保存该Key，不使用旧Key、不改其他服务，显示已启用状态', async () => {
  const order = [],
    configuration = { qweatherKey: 'old-weather-key', qweatherHost: 'host.example', pixabayKey: 'old-pixabay' };
  const workspace = {
    scope: 'server',
    patch: async (change) => {
      order.push('save');
      Object.assign(configuration, change(configuration));
    },
    probeStockImages: async (provider) => {
      order.push('probe');
      expect(provider).toBe('pixabay');
      expect(configuration.pixabayKey).toBe(secret);
      return { width: 640, height: 480 };
    }
  };
  const tree = serverKeysPanel({ cfg: { ...configuration }, workspace, node }),
    rows = flatten(tree);
  rows.find((x) => x.ariaLabel === 'pixabay 图库 Key').value = secret;
  rows.find((x) => x.ariaLabel === '服务器位于国内网络').checked = true;
  await rows.find((x) => x.textContent === '检测 pixabay').events.click();
  expect(order).toEqual(['save', 'probe']);
  expect(configuration.qweatherKey).toBe('old-weather-key');
  expect(configuration.qweatherHost).toBe('host.example');
  expect(rows.some((x) => x.textContent === '连接检测已通过，已启用')).toBe(true);
  expect(rows.find((x) => x.ariaLabel === 'pixabay 图库 Key').value).toBe('');
  expect(JSON.stringify(tree)).not.toContain(secret);
});
it('未确认国内网络不发检测；原已检测状态可见，检查失败后显示真实错误', async () => {
  const probe = vi.fn(async () => {
    throw new Error('pixabay API（HTTP 403）：访问被拒绝');
  });
  const tree = serverKeysPanel({ cfg, workspace: { scope: 'server', probeStockImages: probe }, node }),
    rows = flatten(tree),
    button = rows.find((x) => x.textContent === '检测 pixabay');
  expect(rows.some((x) => x.textContent === '连接检测已通过，已启用')).toBe(true);
  await button.events.click();
  expect(probe).not.toHaveBeenCalled();
  rows.find((x) => x.ariaLabel === '服务器位于国内网络').checked = true;
  await button.events.click();
  expect(rows.some((x) => x.textContent?.includes('HTTP 403'))).toBe(true);
});

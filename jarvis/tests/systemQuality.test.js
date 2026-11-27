import { describe, it, expect, vi } from 'vitest';
import { retryRead } from '../src/core/networkRequest.js';
import { errorKind } from '../src/core/suggest.js';
import { friendlyError } from '../src/core/friendlyError.js';
import { stockSymbol, normalizeBars, summarizeKline, createStockKlineTool } from '../src/agent/stockKline.js';
import { protectedTerms, guardQuery } from '../src/agent/queryGuard.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { taskContract } from '../src/agent/taskContract.js';
import { verifyNumbers } from '../src/agent/verifyNumbers.js';
import { deepResearch, researchEvidenceKey } from '../src/agent/research.js';
import { searchAggregateHints, safeFallbackQuery } from '../src/agent/searchFallback.js';
import { checkpointEvent } from '../shared/taskCheckpoint.js';
import { qualityReport, compareReports } from '../evals/quality-report.mjs';
import { runProject } from '../server/projectExecution.mjs';
import { getWeather } from '../src/agent/weather.js';
import { runPython } from '../src/agent/sandbox.js';
import { createPageReader } from '../src/agent/pageReader.js';
import { runAgent } from '../src/agent/agent.js';

describe('网络与预算的真实分型', () => {
  it.each([
    [{ name: 'TimeoutError' }, 'timeout'],
    [{ name: 'NetworkError' }, 'network'],
    [{ code: 'RETRIEVAL_BUDGET' }, 'budget'],
    [{ status: 429 }, 'api']
  ])('类型不可混淆 %j', (error, kind) => {
    expect(errorKind(error)).toBe(kind);
    if (kind !== 'budget') expect(friendlyError(error)).not.toContain('额度用完');
  });
  it('网络读取只重试一次，每次先扣预算', async () => {
    const order = [];
    const result = await retryRead(
      () => {
        order.push('request');
        if (order.length < 4) throw Object.assign(new Error('断网'), { name: 'NetworkError' });
        return 'ok';
      },
      { delayMs: 1, beforeAttempt: () => order.push('budget') }
    );
    expect(result).toBe('ok');
    expect(order).toEqual(['budget', 'request', 'budget', 'request']);
  });
  it('预算为零时一次请求都不能发出', async () => {
    const work = vi.fn();
    await expect(
      retryRead(work, {
        beforeAttempt: () => {
          throw Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' });
        }
      })
    ).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
    expect(work).not.toHaveBeenCalled();
  });
  it('429和权限错误不会按断网自动重试', async () => {
    const work = vi.fn(() => {
      throw Object.assign(new Error('限流'), { status: 429 });
    });
    await expect(retryRead(work)).rejects.toMatchObject({ status: 429 });
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('停止立即中断，不再重试', async () => {
    const controller = new AbortController();
    const work = vi.fn(() => {
      controller.abort();
      throw Object.assign(new Error('网络'), { name: 'NetworkError' });
    });
    await expect(retryRead(work, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('超时包含正文，不会永久卡住', async () => {
    const work = vi.fn(() => new Promise(() => {}));
    await expect(retryRead(work, { timeoutMs: 5, delayMs: 1 })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(work).toHaveBeenCalledTimes(2);
  });
});

describe('搜索实体和聚合线索', () => {
  it('保护原话中的姓名和代码，不用字形猜测替换', () => {
    expect(protectedTerms('请查“冉某某”和600000')).toEqual(['冉某某', '600000']);
    expect(protectedTerms('用验证码123456登录')).toEqual([]);
    expect(guardQuery('苹果手机参数', { original: '比较“苹果”和“华为”' }).query).toBe('苹果手机参数');
    expect(guardQuery('剑某某资料', { original: '请查“冉某某”' }).query).toContain('冉某某');
  });
  it('网页缓存每条正文有大小上限，明确标注截断', async () => {
    const read = createPageReader({ fetchImpl: async () => new Response('字'.repeat(100000), { headers: { 'content-type': 'text/plain' } }) });
    const result = await read('https://large.example/a');
    expect(result.length).toBeLessThan(60100);
    expect(result).toContain('已截断');
  });
  it('原站失败后的聚合线索明确标明来源', async () => {
    const get = vi.fn(async () => new Response('<li class="res-list"><h3><a href="https://news.example.com/a">报道</a></h3><p class="res-desc">摘要</p></li>'));
    const hints = await searchAggregateHints('原始人名', { get });
    expect(hints.kind).toBe('search_snippets');
    expect(hints.source).toBe('360');
    expect(hints.hits[0].url).toBe('https://news.example.com/a');
  });
  it('降级搜索不泄露URL凭据、参数或私网地址', () => {
    expect(safeFallbackQuery('https://example.com/a?token=secret', '读取 https://example.com/a?token=secret')).not.toContain('secret');
    expect(safeFallbackQuery('https://example.com/a', '密钥abc')).toBe('example.com');
    expect(() => safeFallbackQuery('http://127.0.0.1/a')).toThrow();
    expect(() => safeFallbackQuery('https://user:secret@example.com/a')).toThrow();
  });
  it('聚合预算和取消也不能吞掉', async () => {
    const get = vi.fn();
    await expect(
      searchAggregateHints('名字', {
        get,
        retrieval: {
          consume() {
            throw Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' });
          }
        }
      })
    ).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('结构化日K', () => {
  const rows = [
    ['2026-10-16', '10', '11', '12', '9', '100'],
    ['2026-10-19', '11', '12', '13', '10', '150']
  ];
  it('证券市场明确，含非法代码就拒绝', () => {
    expect(stockSymbol('600000')).toBe('sh600000');
    expect(stockSymbol('sz000001')).toBe('sz000001');
    expect(() => stockSymbol('某公司')).toThrow();
  });
  it('日期排序、区间高低点由程序计算', () => {
    expect(summarizeKline([...rows].reverse())).toMatchObject({ count: 2, highest: 13, lowest: 9, highestDates: ['2026-10-19'] });
  });
  it('拒绝非法行情与不存在日期', () => {
    expect(() => normalizeBars([['2026-02-30', 10, 11, 12, 9, 100]])).toThrow();
    expect(() => normalizeBars([['2026-10-19', 10, 11, 9, 8, 100]])).toThrow();
    expect(() => normalizeBars([...rows, rows[0]])).toThrow();
  });
  it('真实工具解析腾讯响应，带复权与覆盖说明', async () => {
    const get = vi.fn(async () => new Response(JSON.stringify({ data: { sh600000: { day: rows } } })));
    const result = JSON.parse(await createStockKlineTool({ fetchImpl: get }).run({ code: '600000' }));
    expect(result).toMatchObject({ source: '腾讯行情', adjustment: 'none', highest: 13 });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('前复权不能偷偷降级为未复权', async () => {
    const get = vi.fn(async () => new Response(JSON.stringify({ data: { sh600000: { day: rows } } })));
    await expect(createStockKlineTool({ fetchImpl: get }).run({ code: '600000', adjustment: 'qfq' })).rejects.toMatchObject({ code: 'NO_MARKET_DATA' });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('行情请求之前先消耗预算', async () => {
    const get = vi.fn();
    await expect(
      createStockKlineTool({ fetchImpl: get }).run(
        { code: '600000' },
        {
          retrieval: {
            consume() {
              throw Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' });
            }
          }
        }
      )
    ).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('确定性数字和交付回执', () => {
  it('金额按分求和，避免0.1+0.2误差', () => expect(verifyNumbers('money_total', { amounts: [0.1, 0.2] }).total).toBe(0.3));
  it('闰日与自然日期差，不能冒充交易日', () => {
    expect(verifyNumbers('date_add', { date: '2024-02-28', days: 1 }).date).toBe('2024-02-29');
    expect(verifyNumbers('date_difference', { startDate: '2024-02-28', endDate: '2024-03-01' }).days).toBe(2);
  });
  it('实际盈亏计入数量与费用', () => expect(verifyNumbers('pnl', { cost: 20, price: 18, shares: 100, fees: 5 }).pnlAmount).toBe(-205));
  it('无效数值和精度明确拒绝', () => {
    expect(() => verifyNumbers('percentage', { part: 1, total: 0 })).toThrow();
    expect(() => verifyNumbers('money_total', { amounts: [0.001] })).toThrow();
    expect(() => verifyNumbers('pnl', null)).toThrow();
  });
  it('理解“解释PPT”和“生成PPT”是不同任务', () => {
    expect(taskContract('解释PPT怎么做').formats).toEqual([]);
    expect(taskContract('生成PPT和Word').formats).toEqual(['pptx', 'docx']);
    expect(taskContract('生成PPT，补充：不要PPT，只做Word').formats).toEqual(['docx']);
    expect(taskContract('介绍如何制作PPT').formats).toEqual([]);
    expect(taskContract('600000近一个月日K最高价').criteria.join('')).toContain('get_stock_kline');
    expect(taskContract('成本20价格18，盈亏多少').criteria.join('')).toContain('verify_numbers');
  });
  it('任意预览不能证明运行，修改后旧运行记录失效', () => {
    const review = createExecutionReview('写一个网页');
    review.record({ name: 'write_file', args: { path: 'x.js' }, ok: true });
    review.record({ name: 'preview', args: { path: 'x.js' }, ok: true });
    expect(review.report().codeExecution).toBe('not_run');
    review.record({ name: 'run_javascript', ok: true });
    expect(review.report().codeExecution).toBe('executed_scope_needs_review');
    review.record({ name: 'edit_file', args: { path: 'x.js' }, ok: true });
    expect(review.report().codeExecution).toBe('not_run');
  });
  it('数字问题未调用工具时不能标为验证通过', () => {
    const review = createExecutionReview('成本20价格18，盈亏是多少');
    expect(review.guidance()).toContain('确定性数值');
    review.record({ name: 'verify_numbers', ok: true });
    expect(review.guidance()).toBe('');
  });
  it('失败重试成功后可以解除失败状态，不永久惩罚恢复', () => {
    const review = createExecutionReview();
    review.record({ name: 'read_file', args: { path: 'a' }, ok: false });
    review.record({ name: 'read_file', args: { path: 'a' }, ok: true });
    expect(review.report().failures).toEqual([]);
  });
  it('要求的文件没有真实产物回执时，不能靠模型自述完成', () => {
    const review = createExecutionReview('生成PPT和Word');
    expect(review.report().pendingFormats).toEqual(['pptx', 'docx']);
    review.artifact({ path: 'a.pptx', validation: { format: 'pptx', readback: 'passed', errors: 0 } });
    expect(review.report().pendingFormats).toEqual(['docx']);
  });
  it('回执有上限，不存原始大块输出', () => {
    const review = createExecutionReview();
    for (let i = 0; i < 100; i++) review.record({ name: 'read_file', args: { path: String(i) }, ok: false, output: '大'.repeat(10000) });
    expect(review.report().failures.length).toBeLessThanOrEqual(64);
    expect(JSON.stringify(review.report())).not.toContain('大大大');
  });
  it('文档结构、读回、渲染严格区分，检查点仅留16条摘要', () => {
    let checkpoint = {};
    for (let i = 0; i < 30; i++)
      checkpoint = checkpointEvent(checkpoint, {
        type: 'artifact_validation',
        path: i + '.pptx',
        validation: { readback: 'passed', render: 'not_checked', errors: 1, raw: '不要保存' }
      });
    expect(checkpoint.artifacts).toHaveLength(16);
    expect(JSON.stringify(checkpoint)).not.toContain('不要保存');
    const review = createExecutionReview();
    review.artifact({ path: 'x.pptx', validation: { errors: 1 } });
    expect(review.guidance()).toContain('文档');
  });
});

describe('跨层控制与评测', () => {
  it('调研中的预算和停止直接向上交给任务管理器', async () => {
    for (const error of [Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' }), Object.assign(new Error('停止'), { name: 'AbortError' })]) {
      await expect(
        deepResearch({
          question: '测试',
          search: async () => {
            throw error;
          },
          read: async () => ''
        })
      ).rejects.toBe(error);
    }
  });
  it('调研中断前逐页保存证据，精确问题可复用且不再读页', async () => {
    const source = { title: '测试资料', url: 'https://evidence.example/a', snippet: '测试摘要' };
    const saved = [];
    let calls = 0;
    const budgetError = Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' });
    await expect(
      deepResearch({
        question: '测试资料',
        search: async () => [source],
        read: async () => '测试资料原文'.repeat(30),
        llm: async () => {
          if (calls++) throw budgetError;
          return JSON.stringify({ queries: ['测试资料'] });
        },
        onEvidence: (item) => saved.push(item)
      })
    ).rejects.toBe(budgetError);
    expect(saved).toHaveLength(1);
    expect(saved[0].key).toBe(researchEvidenceKey('测试资料'));
    const read = vi.fn();
    await deepResearch({ question: '测试资料', depth: 'quick', search: async () => [source], read, evidence: saved });
    expect(read).not.toHaveBeenCalled();
  });
  it('天气没有城市就不猜北京，停止不会再尝试备用源', async () => {
    const get = vi.fn();
    await expect(getWeather('', { get })).rejects.toMatchObject({ code: 'WEATHER_LOCATION_REQUIRED' });
    const controller = new AbortController();
    controller.abort();
    await expect(getWeather('南京', { get, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(get).not.toHaveBeenCalled();
  });
  it('Python排队和运行中停止都及时返回，不启动已取消任务', async () => {
    const workers = [];
    class FakeWorker {
      constructor() {
        workers.push(this);
      }
      postMessage() {}
      terminate = vi.fn();
    }
    vi.stubGlobal('Worker', FakeWorker);
    const firstController = new AbortController();
    const secondController = new AbortController();
    try {
      const first = runPython('pass', { signal: firstController.signal });
      await Promise.resolve();
      expect(workers).toHaveLength(1);
      const queued = runPython('pass', { signal: secondController.signal });
      secondController.abort();
      await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
      expect(workers).toHaveLength(1);
      firstController.abort();
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      expect(workers[0].terminate).toHaveBeenCalled();
    } finally {
      firstController.abort();
      secondController.abort();
      vi.unstubAllGlobals();
    }
  });
  it('未配置隔离器就不执行宿主机代码', async () => {
    const docker = vi.fn();
    await expect(runProject({ root: 'p', tests: ['x.mjs'] }, { runDocker: docker })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(docker).not.toHaveBeenCalled();
  });
  it('项目路径穿越在执行前被拒绝', async () => {
    await expect(runProject({ root: '../secret', tests: ['x.mjs'] }, { image: 'node:test' })).rejects.toMatchObject({ code: 'INVALID_PROJECT_INPUT' });
  });
  it('任务完成不能冒充准确率，未知token不是零', () => {
    expect(qualityReport({ results: [{ id: 'a', status: 'done', quality: 'not_reviewed' }] })).toMatchObject({ reviewedAccuracy: null, tokens: null });
    const comparison = compareReports(
      { results: [{ id: 'a', quality: 'passed', status: 'done' }] },
      { results: [{ id: 'a', quality: 'failed', status: 'done' }] }
    );
    expect(comparison.regressions).toEqual(['a']);
  });
  it('实际执行器在没有产物时不能无提示交付PPT', async () => {
    let calls = 0;
    const result = await runAgent({
      adapter: {
        stream: async () => {
          calls++;
          return { text: '已完成。', toolCalls: [], stop: 'end_turn' };
        }
      },
      model: 'test',
      history: [],
      userText: '生成PPT',
      context: { dynamic: '' },
      tools: [],
      emit() {}
    });
    expect(calls).toBe(1);
    expect(result.review.pendingFormats).toEqual(['pptx']);
    expect(result.text).toContain('部分完成');
    expect(result.text).not.toContain('交付回执核对');
    expect(result.review.outcome).toBe('partial');
  });
  it('真实执行器不会吞掉用户停止的工具异常', async () => {
    const stopped = Object.assign(new Error('已停止'), { name: 'AbortError' });
    const adapter = { stream: async () => ({ text: '', toolCalls: [{ id: 'a', name: 'read_file', args: {} }], stop: 'tool_use' }) };
    await expect(
      runAgent({
        adapter,
        model: 'test',
        history: [],
        userText: '读文件',
        context: { dynamic: '' },
        tools: [
          {
            name: 'read_file',
            input_schema: { type: 'object' },
            run: async () => {
              throw stopped;
            }
          }
        ],
        emit() {}
      })
    ).rejects.toBe(stopped);
  });
});

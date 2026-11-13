import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('实际适配器请求体与存储大小对照', () => {
  let report;
  beforeAll(() => {
    report = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/benchmark-requirements.mjs', import.meta.url))], { encoding: 'utf8', timeout: 15000 }));
  });
  it('三个场景不再重复发送可见原话，请求体实际字节减少', () => {
    expect(report.rows).toHaveLength(3);
    for (const row of report.rows) {
      expect(row.before.repeatedRequirementChars).toBeGreaterThan(0);
      expect(row.after.repeatedRequirementChars).toBe(0);
      expect(row.after.requestBytes).toBeLessThan(row.before.requestBytes);
    }
    expect(report.rows[0].after.indexChars).toBe(0);
    expect(report.rows[2].after.indexChars).toBe(0);
  });
  it('存储去掉双份正文，900条原话仍可完整读取', () => {
    expect(report.storage.afterBytes).toBeLessThan(report.storage.beforeBytes);
    expect(report.storage.mergedEntries).toBe(900);
    expect(report.storage.archivedEntries).toBe(500);
    expect(report.storage.visibleUserMessages).toBe(400);
  });
  it('离线请求体捕获不能冒充真实首字耗时', () => {
    expect(report.firstVisibleText.status).toBe('not_measured');
    expect(report.firstVisibleText.runs).toBeUndefined();
  });
});

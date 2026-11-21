/** 2026-11-21 用户：手机特别卡。崩过一次或退到后台被提醒内存紧张后，兼容显示/软件绘制不能永久开着 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// 取出首帧前决定兼容显示的那段内联脚本
const snippet = html.slice(html.indexOf("if (document.documentElement.dataset.mode === 'mobile')"), html.indexOf('} catch (e) {}'));
function firstPaint({ native, saved }) {
  const classes = new Set();
  const store = { 'jarvis.renderSafe': saved ?? null };
  const ctx = { window: { ...(native !== undefined && { __jarvisRenderSafe: native }) }, localStorage: { getItem: (k) => store[k] ?? null },
    document: { documentElement: { dataset: { mode: 'mobile' }, classList: { add: (c) => classes.add(c) } } } };
  vm.runInNewContext(snippet, ctx);
  return classes.has('safe-render');
}

describe('兼容显示限时', () => {
  it('首帧：安卓原生给了判断就只认原生，旧版存下的 true 不再让它一直开着', () => {
    expect(firstPaint({ native: false, saved: 'true' })).toBe(false);
    expect(firstPaint({ native: true, saved: 'false' })).toBe(true);
    // 网页版/拿不到原生值时照旧用本机记下的
    expect(firstPaint({ saved: 'true' })).toBe(true);
    expect(firstPaint({ saved: 'false' })).toBe(false);
  });
  it('原生：崩溃和内存提醒不再写永久开关，自动软件绘制限 3 天，手动选择单独保存', () => {
    const main = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/xunova/jarvis/MainActivity.java'), 'utf8');
    const plugin = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/xunova/jarvis/CrashLogPlugin.java'), 'utf8');
    expect(main).not.toContain('putBoolean("safeDisplay",true)');
    expect(main).toContain('RenderRecovery.safeDisplayActive(');
    expect(main).toContain('RenderRecovery.softwareLayerNow(');
    expect(main).toContain('remove("safeDisplay").putBoolean("safeDisplayLimited", true)');
    expect(plugin).toContain('putBoolean("safeDisplayManual",safe)');
    expect(plugin).toContain('putLong("lastTrim",0)');
  });
});

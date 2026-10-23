import { describe, it, expect } from 'vitest';
import { classifyExit, summarizeExits, dropMemoryNotes } from '../src/mobile/exitReasons.js';

// 10-23 用户手机（华为）复制出来的真实记录
const t = (s) => Date.parse(`2026-10-23T${s}+08:00`);
const huawei = [
  { time: t('08:04:41'), reason: 10, pssMB: 205, description: 'stop com.xunova.jarvis due to from pid 1903 iAwareF[SystemManager] 683269ms' },
  { time: t('05:48:07'), reason: 10, pssMB: 224, description: 'stop com.xunova.jarvis due to installPackageLI' },
  { time: t('05:46:42'), reason: 10, pssMB: 192, description: 'stop com.xunova.jarvis due to from pid 1903 iAwareF[SystemManager] 603ms' }
];

describe('系统记下的退出原因', () => {
  it('华为后台管理关掉的、安装更新、自己划掉、真崩溃分得开', () => {
    expect(classifyExit(huawei[0]).kind).toBe('system');
    expect(classifyExit(huawei[1]).kind).toBe('update');
    expect(classifyExit({ reason: 10, description: '' }).kind).toBe('user');
    expect(classifyExit({ reason: 3 }).kind).toBe('memory');
    expect(classifyExit({ reason: 5 }).kind).toBe('crash');
  });
  it('最近一次是被系统关掉的：接回对话；按北京时间列出，不列更新和正常关闭', () => {
    const r = summarizeExits(huawei, t('08:13:00'));
    expect(r.killed).toBe(true);
    expect(r.lines).toEqual(['10-23 05:46 手机系统的后台管理把未央关了（不是闪退）（当时占内存 192MB）', '10-23 08:04 手机系统的后台管理把未央关了（不是闪退）（当时占内存 205MB）']);
  });
  it('最近一次是自己关的、或者被关是 6 小时前的：不接回', () => {
    expect(summarizeExits([...huawei, { time: t('08:10:00'), reason: 10, description: '' }], t('08:13:00')).killed).toBe(false);
    expect(summarizeExits(huawei, t('15:00:00')).killed).toBe(false);
    expect(summarizeExits([], t('08:13:00'))).toEqual({ lines: [], killed: false });
  });
  it('旧版记下的“系统内存压力”只是提醒，显示时去掉', () => {
    expect(dropMemoryNotes('10-23 07:27:13 App=1.0.243 系统内存压力 level=60\n10-23 07:27:13 App=1.0.243 系统内存压力 level=60')).toBe('');
    expect(dropMemoryNotes('a 系统内存压力 level=60\n10-21 19:23:26 App=1.0.226 didCrash=true')).toBe('10-21 19:23:26 App=1.0.226 didCrash=true');
  });
});

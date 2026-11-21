import { describe, it, expect } from 'vitest';
import { canAutoInstall } from '../desktop/updater.mjs';

describe('自动更新：能否自动安装', () => {
  it('Windows 安装版可以，免安装 zip 版只提示', () => {
    const exe = 'C:\\Users\\a\\AppData\\Local\\Programs\\Jarvis\\Jarvis.exe';
    expect(canAutoInstall({ platform: 'win32', execPath: exe, exists: (p) => /Uninstall Jarvis\.exe$/.test(p) })).toBe(true);
    expect(canAutoInstall({ platform: 'win32', execPath: 'D:\\Jarvis\\Jarvis.exe', exists: () => false })).toBe(false);
  });
  it('Linux 只有 AppImage 可以；Mac 只提示', () => {
    expect(canAutoInstall({ platform: 'linux', env: { APPIMAGE: '/home/a/Jarvis.AppImage' } })).toBe(true);
    expect(canAutoInstall({ platform: 'linux', env: {} })).toBe(false);
    expect(canAutoInstall({ platform: 'darwin' })).toBe(false);
  });
});

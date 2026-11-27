/** 仅检测此四格式实测必需的本机依赖；不安装软件，不读取/修改正式配置。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { officeRenderAvailable } from '../server/officeRender.mjs';
const command = async (binary, args) => {
  try { await promisify(execFile)(binary, args, { timeout: 5000, maxBuffer: 64000 }); return true; }
  catch { return false; }
};
export function assertArchitectureRevision(actual, expected) {
  if (!expected) return;
  if (!/^[a-f0-9]{40}$/.test(expected) || actual !== expected)
    throw Object.assign(new Error('测试运行时版本与指定提交不一致，尚未读取生产配置或发起模型请求'), { code: 'ARCHITECTURE_TEST_REVISION' });
}
export async function architectureServerReadiness(options = {}) {
  const probe = options.probe || command;
  const [office, cairo, ppm, rsvg, ffmpeg] = await Promise.all([
    (options.office || officeRenderAvailable)(), probe('pdftocairo', ['-v']), probe('pdftoppm', ['-v']), probe('rsvg-convert', ['--version']), probe('ffmpeg', ['-version'])
  ]);
  const pdfRaster = cairo || ppm;
  return {
    state: office && pdfRaster ? 'dependencies_detected' : 'blocked',
    office: Boolean(office), pdfRaster: Boolean(pdfRaster), pdfRasterEngines: { pdftocairo: Boolean(cairo), pdftoppm: Boolean(ppm) }, svgCandidates: { rsvg: Boolean(rsvg), ffmpeg: Boolean(ffmpeg), office: Boolean(office) },
    fonts: 'not_checked', rendering: 'not_exercised',
    note: '可编辑PPT真实对照使用本机LibreOffice和pdftocairo；仅缺Cairo二进制时兼容pdftoppm。命令可用不等于渲染或对照通过，SVG备用解码也须实际运行验证。'
  };
}

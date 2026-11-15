/** 程序生成的填字编辑器需要用户点击导出；仅添下载能力，不授予父页面/同源数据访问。 */
export function htmlPreviewSandbox(source = '') {
  const base = 'allow-scripts allow-forms allow-modals';
  return /^<!doctype html><html lang="zh-CN" data-weiyang-editor="canvas-image-text-1">/.test(source.slice(0, 160))
    ? base + ' allow-downloads'
    : base;
}

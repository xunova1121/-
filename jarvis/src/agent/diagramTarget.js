/** 用户明确给了图片路径时，不能擅自换成“新版”；无明确路径不假装程序已消歧。 */
export function assertDiagramTarget(path, request = '') {
  if (String(request).includes(String(path).replace(/^\.\//, ''))) return;
  const paths = [...String(request).matchAll(/(?:\]\()?([^\s"'<>()[\]，。；：]+\.(?:svg|png|jpe?g|webp))(?:\))?/gi)].map((match) =>
    match[1].replace(/^\.\//, '')
  );
  if (paths.length && !paths.includes(String(path).replace(/^\.\//, '')))
    throw Object.assign(new Error('本次指定的图形路径与用户明确给出的文件不同，请先核对版本，不要自动替换为最新文件'), {
      code: 'DIAGRAM_TARGET_MISMATCH',
      kind: 'input'
    });
}

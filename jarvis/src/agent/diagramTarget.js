/** 用户明确给了图片路径时，不能擅自换成“新版”；无明确路径不假装程序已消歧。 */
export function assertDiagramTarget(path, request = '') {
  // 明确标记的文件名必须完整相等，不能以“图.svg”是“旧图.svg”的子串冒充同一版本。
  const explicit = [...String(request).matchAll(/`([^`]+\.(?:svg|png|jpe?g|webp))`|\]\(([^)]+\.(?:svg|png|jpe?g|webp))\)/gi)].map(match => (match[1] || match[2]).replace(/^\.\//, ''));
  if (explicit.length && !explicit.includes(String(path).replace(/^\.\//, '')))
    throw Object.assign(new Error('本次指定的图形路径与明确文件名不一致，请读取该版本而非旧预览'), { code: 'DIAGRAM_TARGET_MISMATCH', kind: 'input' });
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

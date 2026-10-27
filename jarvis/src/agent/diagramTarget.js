/** 用户明确给了图片路径时，不能擅自换成“新版”；无明确路径不假装程序已消歧。 */
export function assertDiagramTarget(path, request = '') {
  // 明确标记的文件名必须完整相等，不能以“图.svg”是“旧图.svg”的子串冒充同一版本。
  const references = new Map();
  for (const match of String(request).matchAll(/`([^`]+\.(?:svg|png|jpe?g|webp))`|\]\(([^)]+\.(?:svg|png|jpe?g|webp))\)/gi)) {
    const before = String(request).slice(0, match.index).split(/[，,。；;\n]/).at(-1);
    const excluded = /(?:不要|不用|别|不是|排除)(?:再)?(?:检查|查看|读取|打开|使用|用|看|选用|选)?\s*(?:\[[^\]]*)?$/.test(before);
    const value = (match[1] || match[2]).replace(/^\.\//, '');
    if (value.length > 400 || (!references.has(value) && references.size >= 32)) throw Object.assign(new Error('明确图形引用超过32项或路径过长，请指定本次目标版本'), {code:'DIAGRAM_TARGET_SIZE',kind:'input'});
    references.set(value, excluded);
  }
  const target = String(path).replace(/^\.\//, '');
  if (references.get(target) === true) throw Object.assign(new Error('用户已排除此图形版本，不能读取或检查它'), {code:'DIAGRAM_TARGET_MISMATCH',kind:'input'});
  const explicit = [...references].filter(([, excluded]) => !excluded).map(([value]) => value);
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

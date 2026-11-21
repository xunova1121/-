export const FILE_CATEGORIES = [['all','全部'],['document','文档'],['sheet','表格'],['slides','演示'],['pdf','PDF'],['image','图片'],['media','音视频'],['code','代码'],['other','其他']];
export function fileCategory(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  for (const [type, pattern] of [['document',/^(docx?|txt|md|rtf|odt)$/],['sheet',/^(xlsx?|csv|tsv|ods)$/],['slides',/^(pptx?|odp)$/],['pdf',/^pdf$/],['image',/^(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/],['media',/^(mp[34]|wav|m4a|ogg|webm|mov)$/],['code',/^(html?|css|m?js|cjs|json|py|ts|tsx|jsx|java|kt|sh|ya?ml)$/]]) if (pattern.test(ext)) return type;
  return 'other';
}
export function organizeFiles(files, { category = 'all', query = '' } = {}) {
  const q = query.trim().toLocaleLowerCase();
  return files.filter(f => (category === 'all' || fileCategory(f.path) === category) && (!q || f.path.toLocaleLowerCase().includes(q))).sort((a,b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0) || a.path.localeCompare(b.path));
}

/** 原话出现只证明引用存在；确认偏好还要求主体、对象与否定方向一致。这里不调用模型。 */
const normalize = (text) => String(text || '').replace(/[\s，,。.!！?？；;：:“”"'‘’（）()]/g, '');
const objectOf = (text) => normalize(text).replace(/^(?:喝|饮用|使用|用|种植)/, (word) => word === '种植' ? '种' : '');

export function preferenceClaim(content, category) {
  const match = String(content).match(/^(?:用户(?:的)?|我)?(?:爱好(?:是|为)?|偏好(?:是|为)?|(?:(不)喜欢)|喜欢|讨厌)(.+)$/);
  if (!match) return null;
  if (objectOf(match[2]).length > 80) return null;
  return { object: objectOf(match[2]), negative: Boolean(match[1]) || /讨厌/.test(match[0]), category: category || 'preference' };
}

export function preferenceSupported(content, evidence, category) {
  const claim = preferenceClaim(content, category);
  if (!claim?.object) return false;
  let latest = null;
  for (const part of String(evidence || '').slice(-5000).match(/[^。！!？?；;，,\n]+[？?]?/g) || []) {
    if (/[？?]$|[吗呢]$/.test(part.trim())) continue;
    const clause = part.trim().replace(/^(?:补充|用户最新修正)[:：]\s*/, '');
    const match = clause.match(/^(?:我|本人)(?:现在|又|还是|一直|很|比较|非常|最|更|特别|真的)*(不喜欢|喜欢|讨厌|偏好|爱好是|爱好)(.+)$/);
    if (!match) continue;
    const object = objectOf(match[2]);
    if (object.length < 2 || claim.object.length < 2) continue;
    if (object.includes(claim.object)) latest = { negative: /不喜欢|讨厌/.test(match[1]) };
  }
  return Boolean(latest && latest.negative === claim.negative);
}

export function wasPreferenceRetracted(content, category, existing) {
  const claim = preferenceClaim(content, category);
  if (!claim) return false;
  return existing.some((record) => {
    if (!record.validTo || !/用户.*(?:忘记|删除|移除)|用户要求/.test(record.archivedReason || '')) return false;
    const old = preferenceClaim(record.content, record.category);
    return old && old.object === claim.object && old.negative === claim.negative;
  });
}

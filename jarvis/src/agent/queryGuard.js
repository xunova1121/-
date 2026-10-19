/** 保护原话中的精确实体，不根据字形相似度擅自改人名。 */
export function protectedTerms(text = '') {
  const value = String(text).slice(0, 8000);
  // 凭据或验证码不得因六位数字保护被自动补进公共搜索词。
  if (/验证码|密码|密钥|token|password|api.?key|authorization/i.test(value)) return [];
  const quoted = [...value.matchAll(/[“「『"]([^”」』"\n]{2,40})[”」』"]/g)].map((match) => match[1]);
  const codes = value.match(/\b(?:sh|sz|bj)?\d{6}\b/gi) ?? [];
  return [...new Set([...quoted, ...codes])].slice(0, 12);
}

export function guardQuery(query, { original = '', terms = [] } = {}) {
  const value = String(query ?? '')
    .trim()
    .slice(0, 500);
  if (!value) throw Object.assign(new Error('搜索词为空'), { code: 'INVALID_SEARCH_QUERY' });
  const protectedList = [...new Set([...protectedTerms(original), ...terms].map((term) => String(term).trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
  const present = protectedList.some(term => value.toLowerCase().includes(String(term).toLowerCase()));
  const missing = protectedList.filter((term) => !value.toLowerCase().includes(String(term).toLowerCase()));
  return {
    query: protectedList.length === 1 && missing.length ? (missing.join(' ') + ' ' + value).slice(0, 800) : value,
    protectedTerms: protectedList,
    restored: protectedList.length === 1 ? missing : [],
    needsReview: protectedList.length > 1 && !present
  };
}

export function queryGuardTool() {
  return {
    name: 'check_search_terms',
    description: '搜索前核对原话和搜索词；保护引号实体、六位证券代码以及明确提供的人名。不猜测正确写法。',
    input_schema: {
      type: 'object',
      properties: {
        original: { type: 'string' },
        query: { type: 'string' },
        terms: { type: 'array', items: { type: 'string' }, maxItems: 12 }
      },
      required: ['original', 'query'],
      additionalProperties: false
    },
    run: async ({ query, original, terms }) => JSON.stringify(guardQuery(query, { original, terms }))
  };
}

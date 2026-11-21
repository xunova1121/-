/** 等待假模型后台学习完成；保留原30秒成功条件，网络错误最多3次，避免RAF反复请求。 */
export async function waitForDocumentStyle(page, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let failures = 0;
  const observations = [];
  while (Date.now() < deadline) {
    const result = await page.evaluate(async (remaining) => {
      const settings = JSON.parse(localStorage.getItem('jarvis.server.v1'));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(2000, remaining)));
      try {
        const response = await fetch(settings.url + '/api/server/document-styles', { signal: controller.signal, headers: { Authorization: 'Bearer ' + settings.token } });
        if (!response.ok) return { kind: 'http', httpStatus: response.status };
        const items = await response.json();
        if (!Array.isArray(items)) return { kind: 'format' };
        return { kind: 'response', found: items.some((item) => item.content.includes('黑体')) };
      } catch (error) {
        return { kind: controller.signal.aborted ? 'timeout' : error.name === 'TypeError' ? 'network' : 'format' };
      } finally { clearTimeout(timer); }
    }, deadline - Date.now());
    observations.push(result);
    if (observations.length > 8) observations.shift();
    if (result.kind === 'response' && result.found) return;
    if (result.kind !== 'response' && (!['network', 'timeout'].includes(result.kind) || ++failures >= 3)) {
      throw Object.assign(new Error('写作偏好等待失败：' + JSON.stringify(observations)), { code: 'DOCUMENT_STYLE_WAIT_FAILED', kind: result.kind === 'http' ? 'api' : result.kind, status: result.httpStatus });
    }
    await new Promise((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 125)));
  }
  throw Object.assign(new Error('写作偏好未在30秒内就绪：' + JSON.stringify(observations)), { code: 'DOCUMENT_STYLE_WAIT_TIMEOUT', kind: 'timeout' });
}

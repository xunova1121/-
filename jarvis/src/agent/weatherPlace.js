/** 只消除询问语气，不把“查查/这里/明天”等送去地理编码，也不猜默认城市。 */
export function weatherQueryPlace(text) {
  if (!/天气|气温|空气质量/.test(String(text || ''))) return null;
  const value = String(text || '').trim()
    .replace(/^(?:(?:请问|请|麻烦|帮我|给我|替我|再试一次|再试试|(?:重新|再)查(?:一?下|查)?|重新|再|查询|查一?下|查查|看看|看一?下)\s*)+/, '')
    .replace(/[，,。！？?!\s]+$/, '');
  const place = value.split(/天气|气温|空气质量/)[0]
    .replace(/^(?:今天|今日|明天|后天|现在)\s*/, '')
    .replace(/(?:今天|今日|明天|后天|现在|这周|本周|未来\d+天)?的?$/, '').trim();
  return validWeatherPlace(place) ? place : null;
}

/** 工具入口也校验：模型自己拼的地点不能绕过预取校验。真实完整地名仍可用。 */
export function validWeatherPlace(place) {
  const value = String(place || '').trim();
  return Boolean(value && value.length <= 100
    && !/^(?:请|帮我|给我|查询|查一?下|查查|看看|看一?下|再查|今天|今日|明天|后天|现在|这里|这边|当地|附近|我这|我这边|我这里|我们这|我们这里|所在城市|这个|最近|未来|的|集团年|市|区|县)$/.test(value)
    && !/天气|带伞|下雨|下雪|怎么|什么|请问|这几天|未来|小时|昨天/.test(value));
}

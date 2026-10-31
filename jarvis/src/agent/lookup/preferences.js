import { collection } from '../store.js';

const KEY = 'lookup.preferences.v1';
export const LOOKUP_DEFAULT_PREFERENCES = [{
  phrases: ['今天比赛赛程', '今日比赛赛程', '足彩赛程', '足球赛程', '今天足球赛程', '今日足球赛程'],
  kind: 'sports_live', params: { sport: 'football', period: 'forward_live', window_minutes: 120, states: ['in', 'pre'], policy: 'user_football_forward_two_hours' }
}];

/** 独立于聊天摘要保存查询口径；本机、服务器、隔离评测各用自己的kv。 */
export async function readLookupPreferences(storage = collection('kv')) {
  try {
    const row = await storage.get(KEY);
    if (row?.version === 1 && Array.isArray(row.preferences)) return row.preferences.slice(0, 20);
    await storage.put({ id: KEY, version: 1, preferences: LOOKUP_DEFAULT_PREFERENCES });
  } catch { /* 存储不可用时仍执行用户已经确认的默认口径，不让普通查询失败。 */ }
  return LOOKUP_DEFAULT_PREFERENCES;
}

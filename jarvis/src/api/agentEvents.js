/**
 * 订阅后端推送的情绪注入信号（需求 7.3）。
 * 注入本身由后端内部系统调用 POST /api/agent/emotion 完成，前端界面只“听”，不提供注入入口。
 */
import { API } from '../config.js';

export function subscribeAgentEvents({ onEmotion, url = API.events } = {}) {
  if (typeof EventSource === 'undefined') return () => {};
  const es = new EventSource(url);
  es.addEventListener('emotion', (e) => {
    try {
      const { state, ttl_ms: ttl } = JSON.parse(e.data);
      onEmotion?.(state, ttl);
    } catch {
      /* 忽略格式不对的事件 */
    }
  });
  return () => es.close();
}

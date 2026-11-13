import { getSportsScores } from '../agent/sportsScores.js';
import { sportsQuery } from '../agent/sportsSnapshot.js';

/** 使用点击时的运行位置；云端刷新走认证接口，本机刷新沿用网关。 */
export function sportsCardRefresh(app) {
  return async (query, signal) => {
    if (app.server) return app.server.sportsScores(sportsQuery(query), signal);
    let snapshot;
    await getSportsScores(sportsQuery(query), {
      get: app.fetchViaGateway(),
      signal,
      refresh: true,
      onScores: (value) => {
        snapshot = value;
      }
    });
    return snapshot;
  };
}

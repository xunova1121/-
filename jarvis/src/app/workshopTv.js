import { STANDALONE } from '../config.js';
import { withAbortSignals } from '../core/abortableFetch.js';

export async function getWorkshopTvPlayers(app, signal) {
  if (app.server) return (await app.server.workshopTvPlayers(signal)).players;
  if (STANDALONE || !app.gateway || app.gateway.cors) return {};
  return withAbortSignals(
    [signal],
    async (combined) => {
      const response = await fetch('/api/workshop/tv-players', { headers: { 'x-jarvis-client': '1' }, signal: combined });
      if (!response.ok) throw new Error('无法读取频道配置');
      return (await response.json()).players;
    },
    5000
  );
}

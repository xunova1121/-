import { WORKSHOP_TV_CHANNELS } from '../../shared/workshopTv.js';

const STORAGE_KEY = 'jarvis.workshopTv.channel.v1';
export const workshopChannels = WORKSHOP_TV_CHANNELS.map(channel => ({
  id: channel.id, title: channel.label, label: channel.name, number: channel.id.slice(4), url: channel.url
}));
let current = workshopChannels[0];
const subscribers = new Set();

export function workshopChannel() {
  try {
    const id = globalThis.localStorage?.getItem(STORAGE_KEY);
    current = workshopChannels.find(ch => ch.id === id) || current;
  } catch { /* 无存储权限时仍可在本次打开期间换台。 */ }
  return current;
}

export function selectWorkshopChannel(input) {
  const key = String(input).replace(/^(?:请)?(?:把电视)?(?:切换|切|换|调|转)(?:一下)?(?:到|成|至)?/, '')
    .replace(/(?:频道|台)?[吧。！!]?$/, '').replace(/[\s-]/g, '').toLowerCase();
  const channel = workshopChannels.find(ch => [ch.id, ch.number, ch.title, ch.id + ch.title, '央视' + ch.title, '央视' + ch.number].includes(key));
  if (!channel) return null;
  current = channel;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, channel.id); } catch { /* 仍通知当前房间。 */ }
  for (const notify of subscribers) notify(channel);
  return channel;
}

export function onWorkshopChannel(notify) {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

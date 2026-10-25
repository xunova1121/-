import { LINK_MARKER } from './pageLinks.js';
import { concreteSourceRequirement, channelKinds } from './answerRequirements.js';
import { throwControl } from '../core/networkRequest.js';

/** 申请渠道任务遇到导航页，最多顺读两个同站指南；不把链接标题当已读正文。 */
export async function readGovernmentGuide({ text, url, requestText, read, signal }) {
  if (concreteSourceRequirement(requestText) !== 'channel') return null;
  const [body, links = ''] = String(text).split(LINK_MARKER);
  if (channelKinds(body).length) return null;
  const origin = new URL(url);
  if (!/(?:^|\.)gov\.cn$/.test(origin.hostname)) return null;
  const candidates = [];
  for (const line of links.split('\n').slice(0, 30)) {
    if (!/信息公开指南|依申请公开|申请指南|申请须知|信息公开申请|在线申请|网上申请/.test(line)) continue;
    const match = line.match(/https?:\/\/\S+/);
    if (!match) continue;
    try {
      const target = new URL(match[0]);
      if (target.hostname !== origin.hostname || target.username || target.password || target.href === origin.href || candidates.includes(target.href)) continue;
      candidates.push(target.href);
    } catch { /* 忽略无效导航，不猜测网址。 */ }
    if (candidates.length === 2) break;
  }
  for (const address of candidates) {
    signal?.throwIfAborted();
    try {
      const content = await read(address);
      if (channelKinds(String(content).split(LINK_MARKER)[0]).length) return { url: address, text: content };
    } catch (error) {
      throwControl(error, signal);
    }
  }
  return null;
}

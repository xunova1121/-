import workLit from './assets/nestRoom/work-lit.webp';
import workDark from './assets/nestRoom/work-off.webp';
import newsLit from './assets/nestRoom/news-lit.webp';
import newsDark from './assets/nestRoom/news-off.webp';
import travelLit from './assets/nestRoom/trip-lit.webp';
import travelDark from './assets/nestRoom/trip-off.webp';
import tvLit from './assets/nestRoom/tv-lit.webp';
import tvDark from './assets/nestRoom/tv-off.webp';
import catLit from './assets/nestRoom/cat-lit.webp';
import catDark from './assets/nestRoom/cat-off.webp';
import sleepLit from './assets/nestRoom/sleep-lit.webp';
import sleepDark from './assets/nestRoom/sleep-off.webp';
import seatLit from './assets/nestRoom/mobile/seat-lit.webp';
import seatDark from './assets/nestRoom/mobile/seat-off.webp';
import phoneMascot from './assets/nestRoom/mobile/mascot.webp';
import phoneLoveseat from './assets/nestRoom/mobile/loveseat.webp';
import phoneLife from './assets/nestRoom/mobile/workshop-life.webp';
import { MOBILE } from '../config.js';

const art = {
  work: [workLit, workDark], news: [newsLit, newsDark], trip: [travelLit, travelDark],
  tv: [tvLit, tvDark], cat: [catLit, catDark], sleep: [sleepLit, sleepDark]
};

const phoneArt = MOBILE || import.meta.env.DEV
  ? import.meta.glob('./assets/nestRoom/mobile/{work,news,trip,tv,cat,sleep}-{lit,off}.webp', { eager: true, import: 'default' })
  : {};

export const nestMobileSprites = MOBILE || import.meta.env.DEV
  ? { mascot: phoneMascot, loveseat: phoneLoveseat, life: phoneLife }
  : null;

export function nestArt(pose, dark, mobile = false) {
  const scene = Object.hasOwn(art, pose) ? pose : 'work';
  if (mobile && (MOBILE || import.meta.env.DEV)) {
    return phoneArt[`./assets/nestRoom/mobile/${scene}-${dark ? 'off' : 'lit'}.webp`];
  }
  return art[scene][dark ? 1 : 0];
}

// 原画中的空椅（x 752、y 255、宽 416、高 454）已保留原渐变边缘。
export function nestSeatArt(dark) {
  return dark ? seatDark : seatLit;
}

// 白天的自然光仍能照亮书桌，手动拉灯则切换到可以辨认的熄灯画面。
export function nestIsDark(state) {
  if (state.lightMode === 'off') return true;
  if (state.lampOn) return false;
  return state.night || state.activity === 'sleep' && state.period === 'dawn';
}

export function nestFigure(activity, station, withCat, busy, operation = '') {
  if (busy && ['shred', 'cheer', 'stomp', 'stop'].includes(operation)) return operation;
  if (busy) return station === 'archive' ? 'archive' : station === 'review' ? 'news' : 'work';
  if (withCat) return 'cat';
  switch (activity) {
    case 'trip': case 'tv': case 'sleep': case 'news': return activity;
    case 'study': return 'news';
    case 'tidy': return 'archive';
    case 'cat-visit': return 'tv';
    case 'coffee': case 'eat': case 'sing': case 'shred': case 'rest': case 'think': return activity;
    default: return 'work';
  }
}

export function nestNeedsSprite(pose) {
  return !Object.hasOwn(art, pose);
}

export const nestFurniture = [
  ['folder', '桌上文件夹'], ['draft', '写草稿'], ['trip', '旅行手账'],
  ['window', '窗边'], ['photo', '墙上相框'], ['cat', '去看看橘猫']
];

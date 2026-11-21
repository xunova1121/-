// 竖幅房间只有一组固定家具。工作、睡眠和看电视只替换透明人物，开灯只换同机位的光照。
import { MOBILE } from '../config.js';

const art = MOBILE || import.meta.env.DEV
  ? import.meta.glob('./assets/nestRoom/portrait/*.webp', { eager: true, import: 'default' })
  : {};
export const portraitArt = name => art['./assets/nestRoom/portrait/' + name + '.webp'];

export function portraitActor(pose, viewing) {
  if (viewing === 'news') return 'read';
  if (['tv', 'rest', 'think'].includes(pose)) return 'watch';
  if (pose === 'sleep') return 'sleep';
  if (pose === 'cat') return 'pet';
  if (['work', 'news', 'trip'].includes(pose)) return 'work';
  return ''; // 冲泡、吃饭、唱歌、碎纸等仍由各自带道具的动作图绘制。
}

export function portraitCat(state) {
  if (['asleep', 'listening', 'deep'].includes(state)) return 'cat-sleep';
  if (state === 'groom' || state === 'rest') return 'cat-groom';
  if (['sniff', 'welcome', 'pet'].includes(state)) return 'cat-sniff';
  return 'cat';
}

export function createNestPortrait(floor) {
  const image = part => {
    const el = document.createElement('img');
    el.className = 'ws-nest-portrait-' + part;
    el.alt = '';
    el.hidden = true;
    el.draggable = false;
    el.decoding = 'async';
    floor.append(el);
    return el;
  };
  const actor = image('actor');
  const cat = image('cat');
  const quilt = image('quilt');
  function show(el, name) {
    if (!name) { el.hidden = true; return; }
    if (el.dataset.picture !== name) {
      el.dataset.picture = name;
      el.src = portraitArt(name);
    }
    el.hidden = false;
  }
  return {
    draw(pose, viewing, catState) {
      const person = portraitActor(pose, viewing);
      show(actor, person);
      show(quilt, person === 'watch' || person === 'sleep' ? '' : 'throw');
      show(cat, portraitCat(catState));
    },
    hide() { actor.hidden = cat.hidden = quilt.hidden = true; }
  };
}

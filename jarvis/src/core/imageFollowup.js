/** 最近两条图片仍由调用方缓存；这里只判断连续追问，不保存图片或对话。 */
const IMAGE_REFERENCE = /图|截图|照片|相片|这张|那张|第.张|上面|刚才发的|picture|image|screenshot/i;
const CREATIVE = /描述|描写|场景|发散|联想|构思|创意|灵感|文案|故事|作诗|写诗|脚本/;

export function followsImage(text, messages = [], cached = new Map()) {
  if (IMAGE_REFERENCE.test(String(text))) return true;
  const correction = /(?:重新|再|仔细|放大).{0,8}(?:看|读|识别)|(?:读数|数值|数字|那个值|这个值|CO[₂2]|HCHO|TVOC|OCR)|(?:全|还是|又|都)?(?:不对|错了|错的|有误)/i.test(String(text));
  if (!CREATIVE.test(String(text)) && !correction) return false;
  const recent = messages.filter((message) => message.role === 'user').slice(-8);
  for (let index = recent.length - 1; index >= 0; index--) {
    if (cached.has(recent[index].ts)) return true;
    if (correction && /读数|数值|数字|识别|OCR|看|不对|错|CO[₂2]/i.test(String(recent[index].content))) continue;
    if (!IMAGE_REFERENCE.test(String(recent[index].content)) && !CREATIVE.test(String(recent[index].content))) return false;
  }
  return false;
}

/** 最多4张，当前上传优先；历史保持原顺序和重复项，避免“第几张”指代错乱。 */
export function remoteTurnImages(current = [], messages = []) {
  const selected = [];
  const add = (image) => {
    if (!image?.data || selected.length >= 4) return;
    selected.push(image);
  };
  current.forEach(add);
  for (const message of messages) {
    for (const image of message.images || []) add(image);
    if (selected.length >= 4) break;
  }
  return selected;
}

/** 轻量创作默认不检索；查来源/型号等外部事实、文件制作仍交原任务流程。 */
export function creativeWithoutLookup(text = '') {
  const value = String(text).split('\n\n[已上传到工作区：')[0];
  if (value.length > 2000 || /Word|PPT|Excel|文档|报告|文件|保存|调研|研究/i.test(value)) return false;
  if (!CREATIVE.test(value) && !/这[个张幅]图|图里|图中|照片里|画面/.test(value)) return false;
  if (/不要联网|不用联网|不要搜索|不用搜索|不查资料|仅根据.{0,8}(图|材料)/.test(value)) return true;
  return !/查|搜|联网|核实|核对|考证|出处|来源|型号|品牌|价格|新闻|实时|最新|官网|链接|资料|证据/.test(value);
}

export const CREATIVE_NOTE = '当前是轻量描述或创作：直接依据已提供的图片/材料回答，不自动联网检索。区分可见事实与创意联想；没有图片时说明缺失，不把旧文字描述当亲眼看见。不需要检索结论或未核实警告；明确要求外部核实后再检索。';

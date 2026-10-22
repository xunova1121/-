/** 最近两条图片仍由调用方缓存；这里只判断连续追问，不保存图片或对话。 */
const IMAGE_REFERENCE = /图|截图|照片|相片|这张|那张|第.张|上面|刚才发的|picture|image|screenshot/i;
const CREATIVE = /描述|描写|场景|发散|联想|构思|创意|灵感|文案|故事|作诗|写诗|脚本/;

export function followsImage(text, messages = [], cached = new Map()) {
  if (IMAGE_REFERENCE.test(String(text))) return true;
  if (!CREATIVE.test(String(text))) return false;
  const recent = messages.filter((message) => message.role === 'user').slice(-8);
  for (let index = recent.length - 1; index >= 0; index--) {
    if (cached.has(recent[index].ts)) return true;
    if (!IMAGE_REFERENCE.test(String(recent[index].content)) && !CREATIVE.test(String(recent[index].content))) return false;
  }
  return false;
}

/** 只传当前图片或调用方已选中的追问图片，最多4张，当前上传优先，不重复。 */
export function remoteTurnImages(current = [], messages = []) {
  const selected = [];
  const add = (image) => {
    if (!image?.data || selected.length >= 4) return;
    if (!selected.some((item) => item.mime === image.mime && item.data === image.data)) selected.push(image);
  };
  current.forEach(add);
  for (let index = messages.length - 1; index >= 0 && selected.length < 4; index--) {
    for (const image of messages[index].images || []) add(image);
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

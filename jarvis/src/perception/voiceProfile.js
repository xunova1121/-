/** 优先使用真实童声音色；系统没有时使用温柔中文声音，轻微调高音调。 */
export const GENTLE_VOICES = { 'qwen-realtime': 'Bella', edge: 'zh-CN-XiaoyiNeural', openai: 'shimmer', provider: 'shimmer', azure: 'zh-CN-XiaoshuangNeural', siliconflow: 'claire' };
export const isChildVoice = name => /Yunxia|Xiaoshuang|Xiaoyou|童声|child|kid/i.test(name || '');
export function browserDelivery(voice, { rate = .95, pitch = 1, profile = 'gentle-child' } = {}) {
  if (profile !== 'gentle-child') return { rate, pitch };
  return { rate: rate * .98, pitch: pitch * (isChildVoice(voice?.name) ? 1.02 : 1.16) };
}

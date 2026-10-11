/**
 * 七种情绪状态及其渲染参数（需求 4.2 表格）。
 *
 * 这里的“情绪”是界面的表达风格，不代表模型拥有真实情绪，也不是对用户心理状态的推断。
 */
export const EMOTIONS = ['平静', '专注', '聆听', '亲和', '安抚', '愉悦', '警觉'];

/** 轨道倾角抖动档位 → 弧度振幅 */
export const JITTER = { 极低: 0.0, 低: 0.04, 中: 0.12, 高: 0.32 };

/**
 * hue：主色相（HSL，度）；spin：光环 / 底座转速与扫描速度（rad/s）；
 * glow：轮廓光与眼睛的发光强度；jitter：全息信号的故障强度。
 */
export const EMOTION_PARAMS = {
  平静: { hue: 200, spin: 0.15, glow: 0.6, jitter: JITTER.低 },
  专注: { hue: 220, spin: 0.35, glow: 0.8, jitter: JITTER.中 },
  聆听: { hue: 195, spin: 0.20, glow: 0.7, jitter: JITTER.低 },
  亲和: { hue: 35, spin: 0.18, glow: 0.75, jitter: JITTER.低 },
  安抚: { hue: 160, spin: 0.10, glow: 0.5, jitter: JITTER.极低 },
  愉悦: { hue: 50, spin: 0.40, glow: 0.9, jitter: JITTER.高 },
  警觉: { hue: 0, spin: 0.55, glow: 1.0, jitter: JITTER.高 }
};

/** 文本关键词（需求 4.1 第二层）。“聆听”由输入事件触发，不做关键词匹配。 */
export const EMOTION_KEYWORDS = {
  安抚: ['没关系', '不用担心', '慢慢来', '我理解', '别着急'],
  愉悦: ['太好了', '恭喜', '开心', '棒', '不错'],
  警觉: ['错误', '警告', '失败', '异常', '危险', '注意'],
  专注: ['正在处理', '分析中', '计算', '检索'],
  亲和: ['你好', '欢迎', '很高兴', '谢谢']
};

export function isEmotion(x) {
  return EMOTIONS.includes(x);
}

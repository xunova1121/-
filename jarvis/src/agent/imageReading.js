/** 读字任务保留字符与空间对应；用户提供的答案不进入独立识别提示。 */
export const IMAGE_TEXT_TASK = /数字|读数|数值|仪表|票面|号码|逐列|逐行|识别|提取|抄录|文字|文本|OCR/i;
export const IMAGE_RECHECK = /(?:重新|再|仔细|好好|继续).{0,8}(?:看|读|识别)|看不清|看清|读错|看错|漏看|(?:第.{0,6}(?:值|数)|读数|数值).{0,8}(?:是|应为|不是)|我都能看清/;
export const IMAGE_READING_RULES = '数字和文字逐项抄录，保留前导零、小数点、正负号及单位。多列按左到右、各列上到下，保留重复项，标注行列和截断位置；不串列、不凭数值合理性补位，部分看清就报告部分，不能因边缘模糊把整图一概说看不清。难辨字符用?保留位置，观察与猜测分开。OCR与视觉是独立候选，冲突指出具体字段，不能投票当真值。';
export function independentImageQuestion(question = '') {
  if (!IMAGE_RECHECK.test(String(question))) return String(question).slice(0,1000);
  return '独立重新读取这次提供的原始图片或局部，不采用用户给出的纠正值或此前识别结果。' + (IMAGE_TEXT_TASK.test(question) ? '逐行逐列读取所有可辨文字数字，标出不确定字符。' : '逐项描述可见内容及无法确认部分。');
}

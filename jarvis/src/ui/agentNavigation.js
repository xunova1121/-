/** 安卓返回优先关闭最上层智能体页面，不能把仍有表单的App直接退到后台。 */
export function closeAgentOverlay(doc = document) {
  for (const selector of ['.wy-studio-editor:not([hidden])', '.wy-tpl-library:not([hidden])', '.wy-studio-square:not([hidden])']) {
    const back = doc.querySelector(`${selector} .wy-agents-back`);
    if (back) { back.click(); return true; }
  }
  return false;
}

/** 常见的服务商错误翻译成人话（已经自动重试过仍失败才会走到这里） */
export function friendlyError(msg) {
  const code = Number(msg.match(/模型接口返回 (\d{3})/)?.[1]);
  if (code === 524 || code === 504 || code === 522) return `中转站等模型回复超时（${code}），已自动重试过。可以点“继续”从断开的地方接着写，或在输入框里换一个更快的模型`;
  if (code === 429) return '请求太频繁或额度用完（429），已自动重试过。稍等一会儿再试，或检查中转站余额';
  if (code === 401 || code === 403) return `API Key 不对或没有权限（${code}）：请在“模型”里检查密钥`;
  if (code >= 500) return `服务商临时故障（${code}），已自动重试过。稍后再试，或换一个模型`;
  if (/图片模型|image model|images\/generations/i.test(msg)) return '当前选的是画图模型，不能用来聊天：点输入框里的模型名换一个聊天模型。想画图直接说“画一张…”就行';
  if (/connection reset|econnreset|socket hang up/i.test(msg)) return '网络连接被断开（已自动重试过）。可以点“继续”从断开的地方接着写；手机上可以试试切换 Wi‑Fi / 流量';
  return msg;
}

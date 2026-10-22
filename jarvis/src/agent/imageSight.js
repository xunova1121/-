/**
 * 主模型看不了图（如 DeepSeek 官方的文字模型）时，图片先交给看图模型写成文字，再交给主模型思考、回答。
 *
 *   - 以前图片硬塞给文字模型：接口把图换成一句 “Unsupported Image”，模型就以为图片格式坏了，让用户换 PNG 重发
 *   - 用户发的图、历史里的图、工具读出来的图（read_file、截屏）都按这个处理
 *   - 没有看图模型时图片照旧发过去；已知只认文字的模型（DeepSeek 等）附一句：看不到就如实说、教用户去设看图模型
 */
import { seesImages } from '../llm/router.js';

export const NO_SIGHT_NOTE =
  '（如果你看不到这张图片的内容，或者图片显示成 Unsupported Image：说明当前模型不能看图，不是图片格式的问题。直接告诉用户“当前模型看不了图：请在 模型 页给正在用的那一端（本机或云服务器）添加百炼（通义千问）或 DeepSeek 的 Key，未央会自动用它们的看图模型；也可以在模型分工里指定看图模型”，不要让用户换格式重发。）';

/** 已知只认文字的模型系列：没有看图模型时才提醒它如实说（认不出的名字可能其实能看，不打扰） */
const TEXT_ONLY = /deepseek|kimi|moonshot|glm-4(?!v|\.\dv)|glm-[5-9](?!v)|qwen-(max|plus|turbo|long)|qwen3-(max|coder|\d+b)|minimax|abab|ernie/i;

const SYSTEM = `你是看图助手，替一个看不到图片的模型看图。把图片内容如实、具体地写成文字，让它不看图也能回答用户：
- 先一句话说整体：这是什么图（照片 / 截图 / 表格 / 图表 / 插画……）、什么场景
- 再写主体和细节：人物（动作、表情、穿着）、物体、位置关系、颜色、光线、氛围
- 图里的文字、数字、表格按原样抄录；看不清的写“看不清”，不要猜
- 只写图里有的，不加评论，不替用户回答问题；有多张图时分别标“图1”“图2”`;

/**
 * @param {{ model: string, describe?: ((o: { system: string, prompt: string, images: object[], signal?: AbortSignal }) => Promise<string>) | null, label?: string, emit?: Function }} o
 *   describe：看图模型的单次问答（createHelperLlm 的结果）；label：显示用的看图模型名
 * @returns {(message: object, o?: { hint?: string, signal?: AbortSignal }) => Promise<void>}  就地把消息里的图片换成文字
 */
export function createImageSight({ model, describe = null, label = '看图模型', emit = () => {} }) {
  const blind = !seesImages(model);
  return async function see(message, { hint = '', signal } = {}) {
    if (!blind || !message?.images?.length) return;
    if (!describe) {
      if (TEXT_ONLY.test(String(model)) && !String(message.content ?? '').includes(NO_SIGHT_NOTE)) message.content = `${message.content ?? ''}\n\n${NO_SIGHT_NOTE}`;
      return;
    }
    const images = message.images;
    emit({ type: 'seeing', text: `正在看图（${label}）…`, model: label });
    let text = '';
    try {
      text = String(await describe({ system: SYSTEM, prompt: `${images.length > 1 ? `一共 ${images.length} 张图。` : ''}用户这次说的是：${String(hint).slice(0, 500) || '（没说，按图片本身描述）'}\n请描述图片。`, images, signal })).trim();
    } catch (e) {
      if (signal?.aborted) throw e;
      text = '';
    }
    delete message.images;
    message.content = text
      ? `${message.content ?? ''}\n\n【图片内容：你本身看不到图片，下面是${label}看图后写的描述，按它回答；描述里没有的细节不要编】\n${text}`
      : `${message.content ?? ''}\n\n（这里有 ${images.length} 张图片，但${label}这次没看成功。如实告诉用户没看到图，请他稍后再发一次或检查看图模型的 Key；不要说图片格式有问题，也不要编图片内容。）`;
  };
}

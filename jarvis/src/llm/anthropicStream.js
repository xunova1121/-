/** Claude 原生协议：消息完成与 HTTP 断开不是一回事，不能把 EOF 当作成功条件。 */
export class IncompleteMessageError extends Error {
  constructor() {
    super('模型流未提供完整的消息结束信号，已保留收到的文字');
    this.name = 'IncompleteMessageError';
    this.code = 'MODEL_STREAM_INCOMPLETE';
    this.kind = 'api';
  }
}

function checkedMessage(message) {
  if (!message || !Array.isArray(message.content) || typeof message.stop_reason !== 'string' || !message.stop_reason) {
    throw new IncompleteMessageError();
  }
  return message;
}

/** 只保留本次 SDK 已组装的消息；思考块、签名和工具参数不自行重建。 */
export async function readAnthropicStream(stream, { guard, signal, onText, onServerTool } = {}) {
  let text = '';
  let completedMessage;
  const observeMessage = (message) => {
    completedMessage = message;
  };
  const observesMessages = typeof stream.on === 'function';
  stream.on?.('message', observeMessage);
  const events = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (signal?.aborted) {
        throw Object.assign(new Error('已停止模型输出'), { name: 'AbortError' });
      }
      const { value: event, done } = await guard.race(events.next());
      if (done) {
        // 官方 SDK 在 message_stop 时发出 message；提前 EOF 不能冒充完成。
        if (observesMessages) throw new IncompleteMessageError();
        const message = checkedMessage(await guard.race(stream.finalMessage()));
        return { text, message };
      }
      if (event.type !== 'ping') guard.touch();
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        onText?.(event.delta.text);
      } else if (event.type === 'content_block_start' && event.content_block.type === 'server_tool_use') {
        onServerTool?.(event.content_block.name);
      } else if (event.type === 'message_stop') {
        // SDK 已在同一事件处理中生成完整消息；不再等 finalMessage 的连接结束 Promise。
        const message = checkedMessage(completedMessage);
        return { text, message };
      }
    }
  } catch (error) {
    // SDK 的取消错误名可能不同，向调度层恢复标准控制信号。
    const failure = signal?.aborted
      ? signal.reason?.code === 'RETRIEVAL_BUDGET'
        ? signal.reason
        : Object.assign(new Error('已停止模型输出'), { name: 'AbortError' })
      : error;
    failure.partialText ??= text;
    throw failure;
  } finally {
    stream.off?.('message', observeMessage);
    // 只关闭当前 SDK 请求，不取消整轮任务；SDK 的异步迭代器负责接收 abort 事件。
    stream.abort?.();
  }
}

/**
 * 主模型没反应时同时问备用模型：主模型 hedgeMs 内一点数据都没回（思考内容也算有反应），
 * 就同时请求备用模型，谁先有反应用谁，另一个取消。主模型不会被提前掐掉，所以最慢也和以前一样。
 * 写文档、做 PPT 这类要先在后台写很久的任务不用它（由调用方判断）。
 */
export const HEDGE_MS = 10_000;

/**
 * @param {object} o
 * @param {{ run: Function, abort: Function }} o.primary  主模型的请求（createModelRequest 的结果）
 * @param {(handler: () => void) => void} o.onPrimaryActivity  登记“主模型有反应了”的回调
 * @param {(hooks: { onText: Function, onActivity: Function }) => { run: Function, abort: Function, dispose: Function }} o.makeBackup
 * @param {object} o.input  发给模型的内容（两个模型发一样的）
 * @param {(text: string) => void} o.onText  备用模型胜出后，它的文字从这里显示
 * @param {() => void} [o.onHedge]  开始同时问备用模型时
 * @param {() => void} [o.onSwitch]  备用模型胜出时
 * @returns {Promise<{ result: object, used: 'primary' | 'backup' }>}
 */
export function runHedged({ primary, onPrimaryActivity, makeBackup, input, hedgeMs = HEDGE_MS, onText, onHedge, onSwitch }) {
  return new Promise((resolve, reject) => {
    let winner = null;
    let backup = null;
    let primaryError = null;
    let backupError = null;
    let buffer = [];
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      backup?.dispose();
    };
    const choose = (who) => {
      if (winner) return;
      winner = who;
      clearTimeout(timer);
      if (who === 'primary') backup?.abort();
      else {
        primary.abort();
        onSwitch?.();
        for (const t of buffer) onText(t);
        buffer = null;
      }
    };
    onPrimaryActivity(() => choose('primary'));
    primary.run(input).then(
      (result) => {
        if (winner === 'backup') return;
        choose('primary');
        cleanup();
        resolve({ result, used: 'primary' });
      },
      (error) => {
        if (winner === 'backup') return;
        // 备用模型还在路上：等它；没有备用或备用也失败了，照旧报主模型的错（外面会走原来的换模型流程）
        if (backup && !winner && !backupError) { primaryError = error; return; }
        cleanup();
        reject(error);
      }
    );
    timer = setTimeout(() => {
      if (winner) return;
      onHedge?.();
      backup = makeBackup({
        onText: (t) => {
          if (winner === 'backup') onText(t);
          else if (!winner) buffer.push(t);
        },
        onActivity: () => choose('backup')
      });
      backup.run(input).then(
        (result) => {
          if (winner === 'primary') return;
          choose('backup');
          cleanup();
          resolve({ result, used: 'backup' });
        },
        (error) => {
          if (winner === 'primary') return;
          if (winner === 'backup') { cleanup(); reject(error); return; }
          backupError = error;
          if (primaryError) { cleanup(); reject(primaryError); }
        }
      );
    }, hedgeMs);
  });
}

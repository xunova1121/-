/** 前台服务只覆盖正在执行的任务；引用计数避免一个任务结束时停掉另一个任务。 */
export function createTaskKeeper(plugin, onError = () => {}) {
  let count = 0, serial = Promise.resolve();
  const set = active => { serial = serial.catch(() => {}).then(() => plugin?.set({ active })).catch(onError); };
  return { begin() { if (++count === 1) set(true); let done = false; return () => { if (done) return; done = true; if (--count === 0) set(false); }; }, get count() { return count; } };
}

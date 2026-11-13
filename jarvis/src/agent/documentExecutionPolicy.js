import { taskContract } from './taskContract.js';

/** 单份成稿由文档引擎内部规划，明确先计划或多份任务保留外层计划。 */
export function singleDocumentTask(text) {
  const source = String(text || '');
  return taskContract(source).formats.length === 1 && source.length <= 1600 && !/多份|两份|两个文件|分别|各一份|先.{0,8}(计划|大纲|调研|搜索|研究)|先列|实施.{0,4}代码|编写.{0,4}程序/.test(source);
}

import { diagramScene } from './diagramScene.js';
import { sceneSvg } from './diagramSceneSvg.js';

/** 所有格式共用设计稿；旧调用仍可传已布局模型。 */
export function diagramSvg(model, design = {}) {
  return sceneSvg(model.version === 1 && model.elements ? model : diagramScene(model, design));
}

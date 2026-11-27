import { diagramLines } from './diagramText.js';
const invalid = message => Object.assign(new Error(message), { code: 'DIAGRAM_SECTION', kind: 'input' });
/** 反馈条是同一业务层里的明确文本，不增加虚构业务节点或额外职责层。 */
export function sectionFooterFields(layer) {
  if (layer.footer === undefined) return {};
  const value = layer.footer;
  if (layer.role !== 'application' || !value || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 24 || typeof value.detail !== 'string' || !value.detail.trim() || value.detail.length > 160 || !Array.isArray(value.relationIds) || !value.relationIds.length || value.relationIds.length > 16 || new Set(value.relationIds).size !== value.relationIds.length || value.relationIds.some(id => !/^relation-\d{1,3}$/.test(id)))
    throw invalid('业务反馈条需完整原文、1～16个真实关系编号，说明最多160字');
  return { footer: { title: value.title.trim(), detail: value.detail.trim(), relationIds: [...value.relationIds] } };
}
export function layoutSectionFooter(layer) {
  if (!layer.footer) return layer.height;
  const count = diagramLines(layer.footer.title + ' · ' + layer.footer.detail, (1128 - 32) / 15, 2).length;
  layer.footerBox = { x: 240, y: layer.y + layer.height + 12, width: 1128, height: 18 + count * 21 };
  layer.height += 12 + layer.footerBox.height;
  return layer.height;
}
export function sectionFooterElements(layer, colors, { rect, text }) {
  if (!layer.footerBox) return [];
  const box = layer.footerBox;
  return [rect(box.x, box.y, box.width, box.height, colors.accent, null, 4), text(layer.footer.title + ' · ' + layer.footer.detail, box.x + 16, box.y + 29, box.width - 32, 15, 2, '#ffffff', true)];
}
